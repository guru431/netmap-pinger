"""Address metadata and bounded diagnostics, without touching the real network."""
import asyncio
import json

import pytest
import anyio
from fastapi.testclient import TestClient
from pydantic import ValidationError

from netmap.app import create_app
from netmap.comments import annotate, describe
from netmap.diagnostics import Diagnostics, command
from netmap.model import Graph, Node
from netmap.monitor import Monitor
from netmap.store import Store


def graph():
    return Graph(nodes=[Node(id="one", name="One", x=0, y=0,
                             addresses=["10.0.0.10", "host.example"])])


def test_comments_normalize_persist_and_export_without_changing_targets(tmp_path):
    original = graph()
    data = original.model_dump()
    data["nodes"][0]["address_comments"] = {"HOST.EXAMPLE.": " DNS-имя ", "old.example": "Removed"}
    updated = Graph.model_validate(data)
    assert updated.nodes[0].address_comments == {"host.example": "DNS-имя"}
    path = tmp_path / "map.sqlite"
    store = Store(path)
    store.save(updated)
    store.close()
    with TestClient(create_app(path, monitoring=False)) as client:
        saved = client.get("/api/export").json()["nodes"][0]
        assert saved["addresses"] == original.nodes[0].addresses
        assert saved["address_comments"] == {"host.example": "DNS-имя"}
    data["nodes"][0]["address_comments"] = {"host.example": "x" * 1001}
    with pytest.raises(ValidationError):
        Graph.model_validate(data)


def test_annotations_use_interfaces_preserve_user_comments_and_do_not_guess_vpn():
    original = graph()
    original.nodes[0].addresses += ["10.20.1.1", "10.99.0.1", "100.100.1.1"]
    original.nodes[0].address_comments = {"host.example": "Комментарий владельца"}
    network = {"servers-linux": {"host": {"ip": "10.0.0.10", "interfaces": {
        "tun0": {"ip": "10.20.1.1/24", "type": "OpenVPN TCP server"}}}},
        "sites": {"site-a": {"name": "Площадка A", "subnets": ["10.0.0.0/24"]}}}
    updated, report = annotate(original, network)
    notes = updated.nodes[0].address_comments
    assert notes["host.example"] == "Комментарий владельца"
    assert notes["10.20.1.1"] == "OpenVPN TCP server · tun0"
    assert "Площадка A" in notes["10.0.0.10"]
    assert "не описано" in notes["10.99.0.1"]
    assert "CG-NAT" in notes["100.100.1.1"]
    assert report["added"] == 4
    assert updated.nodes[0].addresses == original.nodes[0].addresses
    assert original.nodes[0].address_comments == {"host.example": "Комментарий владельца"}
    assert annotate(updated, network)[1]["added"] == 0


def test_annotations_accept_null_subnets_and_mixed_case_interface_types():
    network = {"sites": {"empty": {"subnets": None}}}
    assert "не описано" in describe("10.0.0.10", {}, network)
    for kind, expected in (("Bridge", "Локальная сеть (bridge)"), ("WireGuard", "WireGuard")):
        entry = {"interfaces": {"iface": {"ip": "10.0.0.10", "type": kind}}}
        assert describe("10.0.0.10", entry, network) == expected + " · iface"


def test_allow_offline_defaults_for_legacy_maps_and_persists(tmp_path):
    body = graph().model_dump()
    body["nodes"][0].pop("allow_offline")
    assert Graph.model_validate(body).nodes[0].allow_offline is False
    body["nodes"][0]["allow_offline"] = True
    path = tmp_path / "map.sqlite"
    headers = {"X-Netmap-Request": "1"}
    with TestClient(create_app(path, monitoring=False)) as client:
        response = client.put("/api/map", json=body, headers=headers)
        assert response.status_code == 200
        assert response.json()["nodes"][0]["enabled"] is True
    with TestClient(create_app(path, monitoring=False)) as client:
        saved = client.get("/api/export").json()
        assert saved["nodes"][0]["allow_offline"] is True
        assert saved["nodes"][0]["addresses"] == body["nodes"][0]["addresses"]
        saved["nodes"][0]["allow_offline"] = False
        assert client.put("/api/map", json=saved, headers=headers).status_code == 200
        assert client.get("/api/export").json()["nodes"][0]["allow_offline"] is False


def test_allow_offline_does_not_disable_probes_or_rewrite_observed_history():
    async def scenario():
        clock = [100.0]
        store = Store(":memory:", clock=lambda: clock[0])
        marked = Node(id="mobile", name="Mobile", x=0, y=0, allow_offline=True,
                      addresses=["192.0.2.1", "192.0.2.2"])
        critical = Node(id="critical", name="Critical", x=10, y=10, addresses=["192.0.2.3"])
        store.save(Graph(nodes=[marked, critical]))
        seen = []

        async def probe(target, timeout):
            seen.append(target)
            return ("up", 1, "") if clock[0] == 110 and target == "192.0.2.1" else ("down", None, "")

        monitor = Monitor(store, probe=probe, clock=lambda: clock[0], monotonic=lambda: 0)
        try:
            await monitor.round()
            snapshot = monitor.snapshot()
            assert set(seen) == {"192.0.2.1", "192.0.2.2", "192.0.2.3"}
            assert snapshot["nodes"]["mobile"]["status"] == "down"
            assert snapshot["counts"]["down"] == 2
            clock[0] = 110
            await monitor.round()
            snapshot = monitor.snapshot()
            assert snapshot["nodes"]["mobile"]["status"] == "partial"
            assert [x["status"] for x in snapshot["nodes"]["mobile"]["addresses"]] == ["up", "down"]
            assert snapshot["counts"]["partial"] == 1 and snapshot["counts"]["down"] == 1
            observed = [r[0] for r in store.conn.execute(
                "SELECT status FROM history WHERE node_id='mobile' AND target='' ORDER BY id")]
            assert observed == ["down", "partial"]
            results = store.results()
            history = [tuple(r) for r in store.conn.execute("SELECT * FROM history ORDER BY id")]
            saved = store.graph()
            saved.nodes[0].allow_offline = False
            store.save(saved)
            assert store.results() == results
            assert [tuple(r) for r in store.conn.execute("SELECT * FROM history ORDER BY id")] == history
        finally:
            store.close()

    asyncio.run(scenario())


class FakeProcess:
    def __init__(self, *, hang=False):
        self.returncode = None
        self.killed = False
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(b"first reply\nsecond reply\n")
        if not hang:
            self.stdout.feed_eof()

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        await asyncio.sleep(0)
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


def test_commands_are_fixed_argv_and_stream_output_with_browser_boundary(tmp_path):
    calls = []

    async def spawn(*args, **kwargs):
        calls.append((args, kwargs))
        return FakeProcess()

    runner = Diagnostics(spawn=spawn)
    with TestClient(create_app(tmp_path / "map.sqlite", monitoring=False, diagnostics=runner)) as client:
        headers = {"X-Netmap-Request": "1"}
        assert client.put("/api/map", json=graph().model_dump(), headers=headers).status_code == 200
        body = {"node_id": "one", "target": "10.0.0.10", "command": "ping"}
        assert client.post("/api/diagnostics", json=body).status_code == 403
        assert client.post("/api/diagnostics", json=body, headers={**headers, "Origin": "http://evil.example"}).status_code == 403
        for changes in ({"target": "8.8.8.8"}, {"node_id": "missing"}, {"target": "-c100"}):
            assert client.post("/api/diagnostics", json={**body, **changes}, headers=headers).status_code == 404
        assert client.post("/api/diagnostics", json={**body, "command": "shell"}, headers=headers).status_code == 422
        response = client.post("/api/diagnostics", json=body, headers=headers)
        events = [json.loads(line) for line in response.text.splitlines()]
        assert response.status_code == 200
        assert response.headers["x-accel-buffering"] == "no"
        assert [e["type"] for e in events] == ["start", "line", "line", "done"]
        assert events[-1]["returncode"] == 0 and runner.active == 0
        assert calls[0][0][-1] == body["target"] and "shell" not in calls[0][1]
        runner.active = 3
        assert client.post("/api/diagnostics", json=body, headers=headers).status_code == 429
    for kind in ("ping", "trace"):
        args = command(kind, "2001:db8::1")
        assert args[-1] == "2001:db8::1"
        with pytest.raises(ValueError):
            command(kind, "foo;whoami")


def test_diagnostics_disconnect_timeout_and_missing_binary_release_capacity():
    async def scenario():
        processes = []

        async def spawn(*args, **kwargs):
            process = FakeProcess(hang=True)
            processes.append(process)
            return process

        runner = Diagnostics(spawn=spawn, duration=.01)
        assert runner.reserve()
        stream = runner.stream("ping", "10.0.0.10")
        assert json.loads(await anext(stream))["type"] == "start"
        assert json.loads(await anext(stream))["type"] == "line"
        await stream.aclose()
        assert processes[-1].killed and runner.active == 0
        assert runner.reserve()
        events = [json.loads(e) async for e in runner.stream("trace", "10.0.0.10")]
        assert events[-1]["type"] == "error" and processes[-1].killed and runner.active == 0

        async def missing(*args, **kwargs):
            raise FileNotFoundError()

        runner.spawn = missing
        assert runner.reserve()
        events = [json.loads(e) async for e in runner.stream("ping", "10.0.0.10")]
        assert events[-1]["type"] == "error" and runner.active == 0
        assert [runner.reserve() for _ in range(4)] == [True, True, True, False]

    asyncio.run(scenario())


def test_asgi_cancellation_scope_reaps_process_before_releasing_slot():
    async def scenario():
        process = FakeProcess(hang=True)
        started = asyncio.Event()

        async def spawn(*args, **kwargs):
            return process

        runner = Diagnostics(spawn=spawn)

        async def consume():
            assert runner.reserve()
            async for data in runner.stream("ping", "10.0.0.10"):
                if json.loads(data)["type"] == "line":
                    started.set()

        async with anyio.create_task_group() as group:
            group.start_soon(consume)
            await started.wait()
            group.cancel_scope.cancel()
        assert process.killed and runner.active == 0

    asyncio.run(scenario())
