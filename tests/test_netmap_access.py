"""Authentication, authorization and persistence across Netmap maps."""
from contextlib import closing
import sqlite3
from types import SimpleNamespace

import bcrypt
from fastapi.testclient import TestClient
import pytest

from netmap import access, accounts
from netmap.app import create_app
from netmap.model import Graph, Node
from netmap.store import Store

NOW = 100_000
PASSWORD = "synthetic-start-password"
REQUEST = {"X-Netmap-Request": "1", "Origin": "https://testserver"}
TARGET = "192.0.2.7"


@pytest.fixture
def managed_db(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "HASH_ROUNDS", 1000)
    monkeypatch.setattr(access, "time", SimpleNamespace(time=lambda: NOW, monotonic=lambda: NOW))
    path = tmp_path / "netmap.sqlite"
    with closing(Store(path, clock=lambda: NOW)) as store:
        directory = accounts.Accounts(store.conn)
        assert directory.create_initial_admin("admin", accounts.hash_password(PASSWORD.encode()))
        assert not directory.create_initial_admin("other-admin", accounts.hash_password(PASSWORD.encode()))
        store.save(Graph(name="Original map", nodes=[Node(id="same-id", name="Original node", x=0, y=0,
                                                           addresses=[TARGET])]))
    return path


def sign_in(client, username, password=PASSWORD):
    response = client.post("/api/login", headers=REQUEST, json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    cookie = response.cookies[access.COOKIE]
    client.cookies.clear()
    assert "HttpOnly" in response.headers["set-cookie"] and "Secure" in response.headers["set-cookie"]
    return REQUEST | {"Cookie": f"{access.COOKIE}={cookie}"}


def create_user(client, admin, username):
    response = client.post("/api/admin/users", headers=admin, json={"username": username, "password": PASSWORD})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_original_map_opens_for_admin_and_grants_apply_per_map(managed_db):
    with TestClient(create_app(managed_db, monitoring=False), base_url="https://testserver") as client:
        for endpoint in ("state", "export", "history", "statistics", "maps", "admin/directory"):
            assert client.get(f"/api/{endpoint}").status_code == 401
        assert client.put("/api/map", headers=REQUEST, json={}).status_code == 401
        admin = sign_in(client, "admin")
        original = client.get("/api/state", headers=admin).json()
        assert original["map_id"] == 1 and original["graph"]["name"] == "Original map"
        assert original["graph"]["revision"] == 1 and original["access"] == "edit"
        member_id = create_user(client, admin, "member")
        member = sign_in(client, "MEMBER")
        assert client.get("/api/state", headers=member).json()["graph"] is None
        assert client.get("/api/state?map_id=1", headers=member).status_code == 404
        assert client.get("/api/maps", headers=member).json() == {"maps": []}
        assert client.get("/api/admin/directory", headers=member).status_code == 403
        assert client.post("/api/maps", headers=member, json={"name": "Shared", "personal": False}).status_code == 403
        shared = client.post("/api/maps", headers=admin, json={"name": "Shared", "personal": False}).json()["id"]
        assert client.get("/api/state", headers=admin).json()["map_id"] == 1

        group = client.post("/api/admin/groups", headers=admin, json={"name": "Operators"}).json()["id"]
        membership_path = f"/api/admin/groups/{group}/members/{member_id}"
        assert client.put(membership_path, headers=admin, json={"member": True}).status_code == 200
        group_grant = {"kind": "group", "principal_id": group, "access": "edit"}
        user_grant = {"kind": "user", "principal_id": member_id, "access": "view"}
        grants_path = "/api/admin/maps/1/access"
        assert client.put(grants_path, headers=admin, json=user_grant).status_code == 200
        assert client.put(grants_path, headers=admin, json=group_grant).status_code == 200
        assert client.get("/api/state", headers=member).json()["access"] == "edit"
        assert client.get(f"/api/export?map_id={shared}", headers=member).status_code == 404
        assert client.put("/api/map", headers=member, json=original["graph"]).status_code == 200
        assert client.put("/api/map", headers=member, json=original["graph"]).status_code == 409
        assert client.put(membership_path, headers=admin, json={"member": False}).status_code == 200
        assert client.get("/api/state", headers=member).json()["access"] == "view"
        for method, endpoint, body in (
            ("PUT", "map", original["graph"]), ("POST", "map/preview", original["graph"]), ("POST", "poll", {}),
            ("POST", "diagnostics", {"node_id": "same-id", "target": TARGET, "command": "ping"}),
        ):
            assert client.request(method, f"/api/{endpoint}", headers=member, json=body).status_code == 403
        assert client.get("/api/export", headers=member).status_code == 200
        assert client.put(grants_path, headers=admin, json=user_grant | {"access": None}).status_code == 200
        assert client.get("/api/history", headers=member).status_code == 404


def test_personal_map_and_measurements_are_private_even_from_admin(managed_db, monkeypatch):
    watch = managed_db.parent / "navigation.json"
    watch.write_text('{"version":2}', encoding="utf-8")
    monkeypatch.setenv("NETMAP_WATCH_INDEX", str(watch))
    with TestClient(create_app(managed_db, monitoring=False), base_url="https://testserver") as client:
        admin = sign_in(client, "admin")
        create_user(client, admin, "owner")
        owner = sign_in(client, "owner")
        personal = client.post("/api/maps", headers=owner, json={"name": "Private"}).json()["id"]
        path = f"?map_id={personal}"
        state = client.get("/api/state", headers=owner).json()
        assert state["personal"] and state["map_id"] == personal
        node = Node(id="same-id", name="Private node", x=0, y=0, addresses=[TARGET])
        body = Graph(name="Private", nodes=[node]).model_dump()
        assert client.put(f"/api/map{path}", headers=owner, json=body).status_code == 200
        assert client.get(f"/api/watch{path}", headers=owner).status_code == 404
        assert client.get("/api/watch", headers=admin).json() == {"version": 2}
        assert client.get(f"/api/admin/maps/{personal}/access", headers=admin).status_code == 404

    with closing(Store(managed_db)) as store:
        private = store.for_map(personal)
        for scoped, status, rtt in ((store, "up", 4.0), (private, "down", None)):
            scoped.result(TARGET, status, NOW - 2, rtt, nodes=scoped.graph().nodes)
        assert not store.conn.execute("PRAGMA foreign_key_check").fetchall()

    with TestClient(create_app(managed_db, monitoring=False), base_url="https://testserver") as client:
        for monitor in client.app.state.monitors.values():
            monitor.clock = lambda: NOW
        assert client.get(f"/api/export{path}", headers=admin).status_code == 404
        assert client.get("/api/maps", headers=admin).json()["maps"] == [
            {"id": 1, "personal": False, "name": "Original map", "access": "edit"},
        ]
        for headers, suffix, status, name, received in (
            (admin, "?map_id=1", "up", "Original node", 1), (owner, path, "down", "Private node", 0),
        ):
            assert client.get(f"/api/state{suffix}", headers=headers).json()["nodes"]["same-id"]["status"] == status
            history = client.get(f"/api/history{suffix}", headers=headers).json()["items"]
            assert [(row["status"], row["node_name"]) for row in history] == [(status, name)]
            stats = client.get(f"/api/statistics{suffix}", headers=headers).json()["items"]
            assert [(row["summary"]["received"], row["name"]) for row in stats] == [(received, name)]
        assert client.get("/api/statistics?map_id=1", headers=owner).status_code == 404


def test_login_session_boundary_and_password_changes(managed_db, monkeypatch):
    with TestClient(create_app(managed_db, monitoring=False), base_url="https://testserver") as client:
        body = {"username": "admin", "password": PASSWORD}
        assert client.post("/api/login", json=body).status_code == 403
        assert client.post("/api/login", headers=REQUEST | {"Origin": "https://another.example"}, json=body).status_code == 403
        assert client.post("http://testserver/api/login", headers={"X-Netmap-Request": "1"}, json=body).status_code == 403
        response = client.post("/api/login", headers=REQUEST, json=body | {"password": [PASSWORD]})
        assert response.status_code == 422 and PASSWORD not in response.text
        assert client.post("/api/login", headers=REQUEST, json=body | {"password": "wrong"}).status_code == 401
        first = sign_in(client, "admin")
        second = sign_in(client, "admin")
        assert client.post("/api/logout", headers=second).status_code == 200
        assert client.get("/api/state", headers=second).status_code == 401
        second = sign_in(client, "admin")
        change = {"current": PASSWORD, "replacement": "synthetic-new-password"}
        assert client.post("/api/account/password", headers=first, json=change).status_code == 200
        assert client.get("/api/state", headers=first).status_code == 401
        assert client.get("/api/state", headers=second).status_code == 401
        current = sign_in(client, "admin", change["replacement"])
        monkeypatch.setattr(access.time, "time", lambda: NOW + accounts.SESSION_AGE)
        assert client.get("/api/state", headers=current).status_code == 401


def test_account_mode_denies_access_before_admin_provisioning(tmp_path, monkeypatch):
    monkeypatch.setenv("NETMAP_ACCOUNTS", "1")
    with TestClient(create_app(tmp_path / "fresh.sqlite", monitoring=False)) as client:
        assert client.get("/").status_code == 200
        assert client.get("/api/state").status_code == 403  # The direct host is not loopback.
        assert client.get("https://testserver/api/export").status_code == 401


def test_bootstrap_preserves_apache_bcrypt_password(tmp_path, monkeypatch):
    db = tmp_path / "netmap.sqlite"
    source = tmp_path / "old.htpasswd"
    digest = bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt(rounds=4)).decode("ascii").replace("$2b$", "$2y$", 1)
    source.write_text(f"admin:{digest}\n", encoding="utf-8")
    monkeypatch.setattr("sys.argv", ["netmap.accounts", "--db", str(db), "--from-htpasswd", str(source)])
    accounts.main()
    with TestClient(create_app(db, monitoring=False), base_url="https://testserver") as client:
        admin = sign_in(client, "admin")
        assert client.get("/api/state", headers=admin).json()["map_id"] == 1


def test_legacy_measurements_migrate_to_map_one(tmp_path):
    path = tmp_path / "legacy.sqlite"
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.executescript("""
            CREATE TABLE topology (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER, body TEXT);
            CREATE TABLE probes (target TEXT PRIMARY KEY, status TEXT, checked_at REAL, rtt_ms REAL, detail TEXT);
            CREATE TABLE history (id INTEGER PRIMARY KEY, node_id TEXT, node_name TEXT, target TEXT,
                status TEXT, started_at REAL, last_at REAL, ended_at REAL, initial INTEGER, detail TEXT);
            CREATE UNIQUE INDEX history_open ON history(node_id,target) WHERE ended_at IS NULL;
            CREATE TABLE history_detail (history_id INTEGER, observed_at REAL, detail TEXT,
                PRIMARY KEY (history_id, observed_at));
            CREATE TABLE probe_statistics (target TEXT, resolution INTEGER, bucket INTEGER, sent INTEGER,
                received INTEGER, errors INTEGER, minimum REAL, maximum REAL, total REAL, squares REAL,
                histogram TEXT, first_at REAL, last_at REAL, PRIMARY KEY(target,resolution,bucket));
            INSERT INTO probes VALUES ('192.0.2.7','up',1201,4,'old probe');
            INSERT INTO history VALUES (2,'same-id','Original node','192.0.2.7','up',1200,1201,NULL,1,'old history');
            INSERT INTO history_detail VALUES (2,1200,'old detail');
            INSERT INTO probe_statistics VALUES ('192.0.2.7',300,1200,1,1,0,4,4,4,16,'{"26":1}',1201,1201);
        """)
        conn.execute("INSERT INTO topology VALUES (1,7,?)", (Graph(name="Legacy").model_dump_json(),))
    with closing(Store(path)) as store:
        assert (store.graph().name, store.revision()) == ("Legacy", 7)
        assert store.results()[TARGET]["rtt_ms"] == 4
        history = store.history.query(since=1199, until=1202, now=1202, stale_after=45)["items"]
        assert history[0]["detail"] == "old detail"
        assert store.statistics.series(TARGET, 1200, 1202, 300)["summary"]["received"] == 1
        directory = accounts.Accounts(store.conn)
        new = store.for_map(directory.create_map("Shared", None))
        new.history.record("same-id", "New node", TARGET, "down", 1201, 45)
        assert new.results() == {} and new.statistics.series(TARGET, 1200, 1202, 300)["summary"]["received"] == 0
