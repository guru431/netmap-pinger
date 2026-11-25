"""Change Netmap's Apache Basic Auth password without interrupting readers."""
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import NamedTemporaryFile
from threading import Lock


class PasswordFile:
    def __init__(self, path: Path):
        self.path = path
        self.lock = Lock()

    def change(self, current: bytes, replacement: bytes) -> bool:
        # Netmap runs a single worker. Recheck under the lock so two requests
        # authenticated with the same password cannot both replace it.
        with self.lock:
            verified = self._htpasswd("-vi", self.path, current)
            if verified.returncode:
                if verified.stderr.strip() == b"password verification failed":
                    return False
                verified.check_returncode()

            with NamedTemporaryFile(dir=self.path.parent, prefix=".htpasswd-", delete=False) as temp:
                staged = Path(temp.name)
            try:
                shutil.copyfile(self.path, staged)
                self._htpasswd("-iB", staged, replacement, "-C", "10").check_returncode()
                # The setgid directory assigns the Apache group. Apache opens
                # the new file on its next request without a configuration reload.
                staged.chmod(0o640)
                with staged.open("rb") as file:
                    os.fsync(file.fileno())
                staged.replace(self.path)
            finally:
                staged.unlink(missing_ok=True)
            return True

    def _htpasswd(self, flags, path, password, *options):
        return subprocess.run(
            ["/usr/bin/htpasswd", flags, *options, str(path), "admin"], input=password + b"\n",
            capture_output=True, timeout=3,
            env={"LC_ALL": "C", "TMPDIR": str(self.path.parent)},
        )
