import asyncio
import sqlite3

from fastapi.testclient import TestClient

from netmap.app import create_app
from netmap.model import Graph, Node, Settings
from netmap.monitor import Monitor
from netmap.store import Store


def test_collector_keeps_running_until_sqlite_is_available(monkeypatch):
    async def scenario():
        store = Store(":memory:", clock=lambda: 120)
        store.save(Graph(nodes=[Node(id="host", name="Host", x=0, y=0, addresses=["192.0.2.1"])]))
        graph = store.graph
        reads = 0
        measured = asyncio.Event()

        def flaky_graph():
            nonlocal reads
            reads += 1
            if reads < 3:
                monitor.wake.set()
                raise sqlite3.OperationalError("database is locked")
            return graph()

        async def probe(target, timeout):
            measured.set()
            return "up", 1, ""

        monitor = Monitor(store, probe=probe, clock=lambda: 120)
        monkeypatch.setattr(store, "graph", flaky_graph)
        task = asyncio.create_task(monitor.run())
        waiter = asyncio.create_task(measured.wait())
        try:
            done, _ = await asyncio.wait({task, waiter}, timeout=0.5, return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                task.result()
            assert waiter in done
            assert store.results()["192.0.2.1"]["status"] == "up"
            assert monitor.health()["ready"]
        finally:
            task.cancel()
            waiter.cancel()
            await asyncio.gather(task, waiter, return_exceptions=True)
            store.close()

    asyncio.run(scenario())


def test_health_rejects_stale_cycle_but_reports_liveness(tmp_path):
    with TestClient(create_app(tmp_path / "map.sqlite", monitoring=False)) as client:
        monitor = client.app.state.monitor
        monitor.clock = lambda: 10_000
        monitor.info.update(running=True, last_completed=1)
        response = client.get("/api/health")
        assert response.status_code == 503
        assert response.json()["alive"] is True and response.json()["status"] == "stale"
        monitor.info["last_completed"] = 9999
        assert client.get("/api/health").status_code == 200


def test_first_round_and_long_round_need_bounded_progress(tmp_path):
    store = Store(tmp_path / "map.sqlite")
    now = [100]
    try:
        monitor = Monitor(store, clock=lambda: now[0])
        monitor.info["running"] = True
        assert monitor.health()["status"] == "starting"
        monitor.info.update(polling=True, round_started=100, last_progress=100)
        assert monitor.health()["ready"]  # bounded grace before the first DNS/ping result
        now[0] = 1000
        monitor.info.update(last_progress=999, duration=500)
        assert monitor.health()["ready"]  # long rounds with progress remain healthy
        now[0] = 1045
        assert monitor.health()["status"] == "stalled"  # old duration cannot hide a hung probe
        monitor.info["last_error"] = "probe failed"
        assert monitor.health()["status"] == "error"
    finally:
        store.close()


def test_completed_targets_advance_progress_even_before_round_ends(tmp_path):
    store = Store(tmp_path / "map.sqlite")
    now = [100]
    seen = []

    async def probe(target, timeout):
        if seen:
            assert monitor.info["last_progress"] == now[0]
        seen.append(target)
        now[0] += 20
        return "up", 1, ""

    try:
        store.save(Graph(nodes=[Node(id="n", name="N", x=0, y=0, addresses=["192.0.2.1", "192.0.2.2"])],
                         settings=Settings(concurrency=1)))
        monitor = Monitor(store, clock=lambda: now[0], probe=probe)
        asyncio.run(monitor.round())
        assert monitor.info["completed"] == 2 and monitor.info["last_progress"] == 140
        assert monitor.info["polling"] is False
    finally:
        store.close()


def test_incident_history_selects_multiple_nodes_without_other_nodes(tmp_path):
    path = tmp_path / "map.sqlite"
    store = Store(path)
    try:
        nodes = [Node(id=n, name=n, x=0, y=0, addresses=[f"192.0.2.{i}"])
                 for i, n in enumerate(("first", "second", "other"), 1)]
        store.save(Graph(nodes=nodes))
        for n in nodes:
            store.result(n.addresses[0], "error" if n.id == "first" else "down", 100, None, nodes=[n])
    finally:
        store.close()
    with TestClient(create_app(path, monitoring=False)) as client:
        client.app.state.monitor.clock = lambda: 110
        items = client.get("/api/history?since=95&until=109&node_ids=first&node_ids=second").json()["items"]
        assert {item["node_id"] for item in items} == {"first", "second"}
        assert {item["status"] for item in items} == {"error", "down"}
        assert client.get("/api/history?since=95&until=109&node_ids='OR%201=1--").json()["items"] == []
