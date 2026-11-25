"""Account credentials, sessions and per-map access in the local SQLite database."""
from __future__ import annotations

import argparse
from contextlib import closing
from getpass import getpass
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets

import bcrypt

from .model import Graph
from .store import Store

SESSION_AGE = 12 * 60 * 60
LOGIN_PATTERN = r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$"
BCRYPT_PATTERN = r"\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}"
HASH_ROUNDS = 600_000
FAKE_HASH = f"{HASH_ROUNDS}$" + "00" * 48


def password_bytes(password: object, *, new=False) -> bytes:
    if not isinstance(password, str) or not password or any(ch in password for ch in "\x00\r\n"):
        raise ValueError("Пароль должен занимать до 72 байт и не содержать переносов строк")
    try:
        encoded = password.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("Пароль должен занимать до 72 байт и не содержать переносов строк") from None
    if len(encoded) > 72:
        raise ValueError("Пароль должен занимать до 72 байт и не содержать переносов строк")
    if new and len(password) < 12:
        raise ValueError("Введите пароль длиной не менее 12 символов")
    return encoded


def hash_password(password: bytes, salt: bytes | None = None, rounds: int | None = None) -> str:
    salt = secrets.token_bytes(16) if salt is None else salt
    rounds = HASH_ROUNDS if rounds is None else rounds
    digest = hashlib.pbkdf2_hmac("sha256", password, salt, rounds)
    return f"{rounds}${(salt + digest).hex()}"


def verify_password(password: bytes, stored: str) -> bool:
    if stored.startswith("$2"):
        try:
            return bcrypt.checkpw(password, stored.encode("ascii"))
        except ValueError:
            return False
    rounds, packed = stored.split("$", 1)
    return hmac.compare_digest(hash_password(password, bytes.fromhex(packed[:32]), int(rounds)), stored)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def read_htpasswd_hash(path: Path, username: str) -> str:
    matches = []
    for line in path.read_text(encoding="utf-8").splitlines():
        name, separator, digest = line.partition(":")
        if separator and name == username:
            matches.append(digest)
    if len(matches) != 1 or not re.fullmatch(BCRYPT_PATTERN, matches[0]):
        raise ValueError("The htpasswd file must contain one bcrypt entry for the selected username")
    return matches[0]


class Accounts:
    def __init__(self, conn):
        self.conn = conn
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL, admin INTEGER NOT NULL CHECK(admin IN (0, 1))
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
            CREATE TABLE IF NOT EXISTS user_groups (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE
            );
            CREATE TABLE IF NOT EXISTS group_members (
                group_id INTEGER NOT NULL REFERENCES user_groups(id), user_id INTEGER NOT NULL REFERENCES users(id),
                PRIMARY KEY (group_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id, group_id);
            CREATE TABLE IF NOT EXISTS map_owners (
                map_id INTEGER PRIMARY KEY REFERENCES topology(id), owner_id INTEGER NOT NULL REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS map_users (
                map_id INTEGER NOT NULL REFERENCES topology(id), user_id INTEGER NOT NULL REFERENCES users(id),
                access INTEGER NOT NULL CHECK(access IN (1, 2)), PRIMARY KEY (map_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS map_groups (
                map_id INTEGER NOT NULL REFERENCES topology(id), group_id INTEGER NOT NULL REFERENCES user_groups(id),
                access INTEGER NOT NULL CHECK(access IN (1, 2)), PRIMARY KEY (map_id, group_id)
            );
        """)

    def enabled(self) -> bool:
        return self.conn.execute("SELECT EXISTS(SELECT 1 FROM users WHERE admin=1)").fetchone()[0] == 1

    def user(self, username):
        return self.conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()

    def create_user(self, username, password_hash):
        with self.conn:
            return self.conn.execute("INSERT INTO users(username,password_hash,admin) VALUES (?,?,0)",
                                     (username.lower(), password_hash)).lastrowid

    def create_initial_admin(self, username, password_hash):
        with self.conn:
            return self.conn.execute("""INSERT INTO users(username,password_hash,admin)
                SELECT ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE admin=1)""",
                (username.lower(), password_hash)).rowcount == 1

    def start_session(self, user, now):
        token = secrets.token_urlsafe(32)
        with self.conn:
            self.conn.execute("DELETE FROM sessions WHERE expires_at<=?", (now,))
            created = self.conn.execute("""INSERT INTO sessions
                SELECT ?, id, ? FROM users WHERE id=? AND password_hash=?""",
                (token_digest(token), now + SESSION_AGE, user["id"], user["password_hash"])).rowcount
        return token if created else None

    def session_user(self, token, now):
        if token and len(token) == 43:
            return self.conn.execute("""SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
                WHERE s.token_hash=? AND s.expires_at>?""", (token_digest(token), now)).fetchone()
        return None

    def end_session(self, token):
        if token and len(token) == 43:
            with self.conn:
                self.conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_digest(token),))

    def change_password(self, user, password_hash):
        with self.conn:
            changed = self.conn.execute("UPDATE users SET password_hash=? WHERE id=? AND password_hash=?",
                                        (password_hash, user["id"], user["password_hash"])).rowcount
            if changed:
                self.conn.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
        return changed

    def create_map(self, name, owner_id):
        with self.conn:
            map_id = self.conn.execute("INSERT INTO topology(revision,body) VALUES (0,?)",
                                       (Graph(name=name).model_dump_json(),)).lastrowid
            if owner_id is not None:
                self.conn.execute("INSERT INTO map_owners VALUES (?,?)", (map_id, owner_id))
        return map_id

    def shared(self, map_id):
        return self.conn.execute("""SELECT t.id FROM topology t LEFT JOIN map_owners o ON o.map_id=t.id
            WHERE t.id=? AND o.owner_id IS NULL""", (map_id,)).fetchone() is not None

    def map_access(self, user, map_id=None, *, names=False):
        # An owner is the only principal eligible for a personal map. On a shared
        # map, the strongest direct or inherited grant wins.
        name_column = ", json_extract(t.body, '$.name') AS name" if names else ""
        restrict_map = "WHERE t.id=:map" if map_id is not None else ""
        return self.conn.execute(f"""
            WITH available AS (
                SELECT t.id, o.owner_id IS NOT NULL AS personal,
                    CASE WHEN o.owner_id IS NOT NULL THEN (o.owner_id=:user)*2
                    WHEN :admin THEN 2 ELSE max(coalesce(u.access,0), coalesce((
                        SELECT max(g.access) FROM map_groups g JOIN group_members m USING(group_id)
                        WHERE g.map_id=t.id AND m.user_id=:user),0)) END AS access
                    {name_column}
                FROM topology t LEFT JOIN map_owners o ON o.map_id=t.id
                LEFT JOIN map_users u ON u.map_id=t.id AND u.user_id=:user
                {restrict_map}
            ) SELECT * FROM available WHERE access>0 ORDER BY id
        """, {"user": user["id"], "admin": user["admin"], "map": map_id})

    def directory(self):
        return {
            "users": [dict(row) for row in self.conn.execute(
                "SELECT id, username, admin FROM users ORDER BY username")],
            "groups": [dict(row) for row in self.conn.execute("SELECT id, name FROM user_groups ORDER BY name")],
            "members": [dict(row) for row in self.conn.execute("SELECT group_id, user_id FROM group_members")],
        }

    def create_group(self, name):
        with self.conn:
            return self.conn.execute("INSERT INTO user_groups(name) VALUES (?)", (name,)).lastrowid

    def membership(self, group_id, user_id, member):
        with self.conn:
            if member:
                self.conn.execute("INSERT OR IGNORE INTO group_members VALUES (?,?)", (group_id, user_id))
            else:
                self.conn.execute("DELETE FROM group_members WHERE group_id=? AND user_id=?", (group_id, user_id))

    def grants(self, map_id):
        return [dict(row) for row in self.conn.execute("""
            SELECT 'user' AS kind, user_id AS principal_id, access FROM map_users WHERE map_id=?
            UNION ALL SELECT 'group', group_id, access FROM map_groups WHERE map_id=?
            ORDER BY kind, principal_id
        """, (map_id, map_id))]

    def grant(self, map_id, kind, principal_id, access):
        table, column = ("map_users", "user_id") if kind == "user" else ("map_groups", "group_id")
        with self.conn:
            if access is None:
                self.conn.execute(f"DELETE FROM {table} WHERE map_id=? AND {column}=?", (map_id, principal_id))
            else:
                self.conn.execute(f"""INSERT INTO {table} VALUES (?,?,?)
                    ON CONFLICT(map_id,{column}) DO UPDATE SET access=excluded.access""",
                    (map_id, principal_id, access))


def main():
    parser = argparse.ArgumentParser(description="Create the initial Netmap Pinger administrator")
    default_db = Path(__file__).resolve().parent.parent / "var" / "netmap.sqlite"
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("NETMAP_DB", default_db)))
    parser.add_argument("--username", default="admin")
    parser.add_argument("--from-htpasswd", type=Path, help="Import the existing bcrypt password for this username")
    args = parser.parse_args()
    if not re.fullmatch(LOGIN_PATTERN, args.username):
        parser.error("Use 1–64 ASCII letters, digits, dots, underscores or hyphens for the username")
    with closing(Store(args.db)) as store:
        accounts = Accounts(store.conn)
        if accounts.enabled():
            parser.error("An administrator already exists")
        try:
            if args.from_htpasswd:
                digest = read_htpasswd_hash(args.from_htpasswd, args.username)
            else:
                password = getpass("Password: ")
                if password != getpass("Repeat password: "):
                    parser.error("Passwords do not match")
                digest = hash_password(password_bytes(password, new=True))
        except (OSError, UnicodeError):
            parser.error("Could not read the htpasswd file")
        except ValueError as exc:
            parser.error(str(exc))
        if not accounts.create_initial_admin(args.username, digest):
            parser.error("An administrator already exists")
    print(f"Administrator {args.username.lower()} created. Restart Netmap Pinger to enable accounts.")


if __name__ == "__main__":
    main()
