import os
import sqlite3
import subprocess
from contextlib import closing
from types import SimpleNamespace

import pytest

from netmap.deploy import release


@pytest.mark.skipif(os.name == "nt", reason="Atomic replacement of directory symlinks requires POSIX semantics")
def test_failed_release_restores_previous_version_and_preserves_backup(tmp_path, monkeypatch):
    previous = tmp_path / "old"
    candidate = tmp_path / "new"
    previous.mkdir()
    candidate.mkdir()
    current = tmp_path / "current"
    current.symlink_to(previous, target_is_directory=True)

    database = tmp_path / "live.sqlite"
    with closing(sqlite3.connect(database)) as connection, connection:
        connection.execute("CREATE TABLE state (revision INTEGER)")
        connection.execute("INSERT INTO state VALUES (42)")

    args = SimpleNamespace(root=tmp_path, sha="example", database=database,
                           backup_dir=tmp_path / "backups", service="netmap-pinger.service")
    started = []
    monkeypatch.setattr(release, "stage_release", lambda root, sha: candidate)

    def restart(*command):
        assert command == ("systemctl", "restart", args.service)
        started.append(current.resolve())

    def failed_health_check(args, path):
        assert current.resolve() == path == candidate
        raise subprocess.CalledProcessError(1, "curl")

    monkeypatch.setattr(release, "command", restart)
    monkeypatch.setattr(release, "verify", failed_health_check)

    with pytest.raises(subprocess.CalledProcessError):
        release.deploy(args)

    assert started == [candidate, previous]
    assert current.resolve() == previous
    backup, = args.backup_dir.glob("*.sqlite")
    with closing(sqlite3.connect(backup)) as connection:
        assert connection.execute("SELECT revision FROM state").fetchone() == (42,)
