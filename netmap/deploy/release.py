"""Install a pinned Git release for an existing systemd-managed Netmap Pinger."""

import argparse
import io
import json
import os
import re
import sqlite3
import subprocess
import tarfile
import tempfile
import time
from contextlib import closing
from pathlib import Path


def command(*args):
    return subprocess.check_output(args, timeout=90).strip()


def stage_release(root, sha):
    git = ("git", "--git-dir", str(root / "repository.git"))
    subprocess.run((*git, "fetch", "origin", "refs/heads/main:refs/remotes/origin/main"),
                   check=True, timeout=90)
    if command(*git, "cat-file", "-t", sha) != b"commit":
        raise RuntimeError("SHA does not identify a commit")
    command(*git, "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main")
    # Keep the tar stream intact. Its zero padding is part of the archive format.
    archive = subprocess.check_output((*git, "archive", sha), timeout=90)
    release = root / "releases" / sha
    release.parent.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
        files = {Path(item.name): item for item in tree if item.isfile()}
        if not release.exists():
            with tempfile.TemporaryDirectory(dir=release.parent) as scratch:
                staged = Path(scratch) / sha
                staged.mkdir(mode=0o755)
                staged.chmod(0o755)
                tree.extractall(staged, filter="data")
                staged.rename(release)
        installed = {path.relative_to(release) for path in release.rglob("*") if path.is_file()}
        if release.is_symlink() or installed != files.keys() or any(
            (release / path).is_symlink()
            or (release / path).read_bytes() != tree.extractfile(item).read()
            for path, item in files.items()
        ):
            raise RuntimeError(f"Release files differ from Git: {release}")
    return release


def backup_database(database, backup_dir):
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=backup_dir) as scratch:
        temporary = Path(scratch) / "netmap.sqlite"
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=10)) as source:
            with closing(sqlite3.connect(temporary)) as copy:
                source.backup(copy)
                if copy.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise RuntimeError("SQLite backup failed quick_check")
        temporary.chmod(0o600)
        backup = backup_dir / f"netmap-before-{time.time_ns()}.sqlite"
        temporary.rename(backup)
    print(f"Verified SQLite backup: {backup}", flush=True)


def activate(current, release):
    with tempfile.TemporaryDirectory(dir=current.parent) as scratch:
        link = Path(scratch) / "current"
        link.symlink_to(release, target_is_directory=True)
        link.replace(current)


def verify(args, release):
    curl = ("curl", "-fsS", "--max-time", "5", "--unix-socket", str(args.socket),
            "-H", f"Host: {args.host}")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            health = json.loads(command(*curl, "http://localhost/api/health"))
            if health["ready"] and health["last_completed"] is not None:
                break
        except subprocess.CalledProcessError:
            pass
        time.sleep(1)
    else:
        raise RuntimeError("Collector did not complete a healthy round in 60 seconds")
    pid = command("systemctl", "show", args.service, "--property=MainPID", "--value").decode()
    if (Path("/proc") / pid / "cwd").resolve(strict=True) != release:
        raise RuntimeError("Service is running from a different directory")
    index = command(*curl, "http://localhost/")
    if index != (release / "netmap/static/index.html").read_bytes().strip():
        raise RuntimeError("Served page differs from the Git release")


def deploy(args):
    current = args.root / "current"
    release = stage_release(args.root, args.sha)
    previous = current.resolve(strict=True) if current.is_symlink() else None
    if previous == release:
        verify(args, release)
        return
    if current.exists() and previous is None:
        raise RuntimeError("Refusing to replace a non-symlink current path")
    backup_database(args.database, args.backup_dir)
    try:
        activate(current, release)
        command("systemctl", "restart", args.service)
        verify(args, release)
    except BaseException:
        if current.is_symlink() and current.resolve() == release:
            if previous is None:
                current.unlink()
            else:
                activate(current, previous)
                command("systemctl", "restart", args.service)
        raise


def main():
    import fcntl

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sha", help="Full SHA of a commit on origin/main")
    parser.add_argument("--root", type=Path, default=Path("/opt/netmap-pinger"))
    parser.add_argument("--service", default="netmap-pinger.service")
    parser.add_argument("--socket", type=Path, default=Path("/run/netmap-pinger.sock"))
    parser.add_argument("--host", required=True)
    parser.add_argument("--database", type=Path, default=Path("/var/lib/netmap-pinger/netmap.sqlite"))
    parser.add_argument("--backup-dir", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        parser.error("sha must be a full lowercase Git SHA")
    args.root = args.root.resolve(strict=True)
    args.database = args.database.resolve(strict=True)
    with (args.root / ".release.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deploy(args)
    print(f"Release active: {args.sha}")


if __name__ == "__main__":
    main()
