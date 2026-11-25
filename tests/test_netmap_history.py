"""History survives restarts/edits, separates missing observations, and enriches only known devices."""
import asyncio
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from netmap.app import create_app
from netmap.inventory import enrich
from netmap.model import Graph, Node
from netmap.monitor import Monitor
from netmap.store import Store


def node():
    return Node(id="host", name="Server", x=0, y=0, addresses=["192.0.2.1"])


def sample(store, status, ts, target="192.0.2.1"):
    store.result(target, status, ts, 1 if status == "up" else None, nodes=[node()], gap_after=45)


def query(store, **over):
    return store.history.query(**({"since": 90, "until": 400, "now": 170, "stale_after": 45} | over))


def test_transitions_record_outage_boundaries_and_compress_unchanged_samples():
    store = Store(":memory:")
    try:
        for status, ts in [("up", 100), ("up", 115), ("down", 130), ("down", 145), ("up", 160)]:
            sample(store, status, ts)
        rows = query(store)["items"]
        assert len(rows) == 3
        down = next(r for r in rows if r["status"] == "down")
        assert (down["started_at"], down["ended_at"], down["duration"]) == (130, 160, 30)
        assert not down["initial"]
        assert rows[-1]["initial"] and rows[-1]["started_at"] == 100
        assert store.history.since() == 100
    finally:
        store.close()


def test_closed_interval_keeps_actual_end_and_separately_clips_to_filter():
    store = Store(":memory:")
    try:
        sample(store, "down", 100)
        sample(store, "up", 145)
        row, = query(store, since=112, until=120)["items"]
        assert (row["ended_at"], row["duration"]) == (145, 45)
        assert (row["display_start"], row["display_end"], row["display_duration"]) == (112, 120, 8)
    finally:
        store.close()


def test_dns_and_probe_reason_changes_preserve_detail_at_the_time_of_query():
    async def scenario():
        now = 100
        resolved = "192.0.2.1"
        reason = "Нет ответа ICMP"
        store = Store(":memory:", clock=lambda: now)
        host = node()
        host.addresses = ["host.example"]
        store.save(Graph(nodes=[host]))

        async def resolver(target, timeout):
            return resolved

        async def probe(target, timeout):
            return "down", None, reason

        try:
            monitor = Monitor(store, probe=probe, resolver=resolver, clock=lambda: now)
            await monitor.round()
            now, resolved = 115, "192.0.2.2"
            await monitor.round()
            now, reason = 130, "Сеть недоступна"
            await monitor.round()
            older, = query(store, since=102, until=109, now=135)["items"]
            assert older["detail"] == "DNS → 192.0.2.1; Нет ответа ICMP"
            assert older["detail_changes"] == []
            middle, = query(store, since=116, until=132, now=135)["items"]
            assert middle["detail"] == "DNS → 192.0.2.2; Нет ответа ICMP"
            assert middle["detail_changes"] == [{"observed_at": 130, "detail": "DNS → 192.0.2.2; Сеть недоступна"}]
            assert middle["started_at"] == 100 and middle["ongoing"]
        finally:
            store.close()

    asyncio.run(scenario())


def test_restart_marks_gap_instead_of_extending_outage(tmp_path):
    path = tmp_path / "map.sqlite"
    first = Store(path)
    sample(first, "down", 100)
    sample(first, "down", 115)
    first.close()
    restarted = Store(path)
    try:
        sample(restarted, "up", 300)
        rows = query(restarted, now=310)["items"]
        down = next(r for r in rows if r["status"] == "down")
        gap = next(r for r in rows if r["status"] == "gap")
        assert down["ended_at"] == 115 and down["duration"] == 15
        assert down["next_status"] == "gap"
        assert (gap["started_at"], gap["ended_at"]) == (115, 300)
        assert rows[0]["initial"]  # The actual change during the gap is unknown.
    finally:
        restarted.close()


def test_stale_open_interval_does_not_claim_outage_is_still_observed():
    store = Store(":memory:")
    try:
        sample(store, "down", 100)
        sample(store, "down", 115)
        rows = query(store, now=400)["items"]
        row = next(r for r in rows if r["status"] == "down")
        assert row["stale"] and not row["ongoing"]
        assert row["display_end"] == 115 and row["duration"] == 15
        assert row["next_status"] == "gap"
        gap = next(r for r in rows if r["status"] == "gap")
        assert gap["started_at"] == 115 and gap["display_end"] == 400
        assert [r["status"] for r in query(store, since=200, now=400)["items"]] == ["gap"]
    finally:
        store.close()


def test_pause_remove_and_rename_preserve_address_history():
    clock = [100]
    store = Store(":memory:", clock=lambda: clock[0])
    graph = store.save(Graph(nodes=[node()]))
    try:
        sample(store, "up", 100)
        clock[0] = 115
        graph.nodes[0].enabled = False
        graph = store.save(graph)
        rows = query(store)["items"]
        assert rows[0]["status"] == "paused" and not rows[0]["stale"]
        assert rows[1]["ended_at"] == 115
        clock[0] = 130
        graph.nodes[0].enabled = True
        graph.nodes[0].name = "Renamed"
        graph = store.save(graph)
        store.result("192.0.2.1", "down", 130, None, nodes=graph.nodes)
        assert query(store, now=140)["items"][0]["node_name"] == "Renamed"
        assert query(store, now=140)["items"][0]["initial"]
        clock[0] = 145
        graph.nodes[0].addresses = []
        store.save(graph)
        assert not store.results()
        rows = query(store)["items"]
        assert rows[0]["status"] == "unmonitored"
        assert any(r["status"] == "down" and r["ended_at"] == 145 for r in rows)
    finally:
        store.close()


def test_history_write_is_atomic_with_probe_and_rejects_backwards_clock():
    store = Store(":memory:")
    try:
        sample(store, "up", 100)
        sample(store, "down", 99)
        assert store.results()["192.0.2.1"]["status"] == "up"
        assert len(query(store, now=110)["items"]) == 1
        with pytest.raises(ValueError):
            sample(store, "invalid-state", 115)
        assert store.results()["192.0.2.1"]["status"] == "up"
    finally:
        store.close()


def test_old_database_migrates_without_changing_topology_or_fabricating_history(tmp_path):
    path = tmp_path / "legacy.sqlite"
    conn = sqlite3.connect(path)
    conn.executescript("CREATE TABLE topology(id INTEGER PRIMARY KEY,revision INTEGER,body TEXT);"
                       "CREATE TABLE probes(target TEXT PRIMARY KEY,status TEXT,checked_at REAL,rtt_ms REAL,detail TEXT);")
    graph = Graph(nodes=[node()], revision=8)
    conn.execute("INSERT INTO topology VALUES(1,8,?)", (graph.model_dump_json(),))
    conn.execute("INSERT INTO probes VALUES('192.0.2.1','down',100,NULL,'')")
    conn.commit(); conn.close()
    store = Store(path)
    try:
        assert store.graph().model_dump() == graph.model_dump()
        assert store.results()["192.0.2.1"]["checked_at"] == 100
        assert store.history.since() is None
        sample(store, "up", 300)
        assert store.history.since() == 300
    finally:
        store.close()


def test_history_api_filters_time_node_target_and_pages_without_duplicates(tmp_path):
    path = tmp_path / "map.sqlite"
    store = Store(path)
    try:
        for i in range(5):
            sample(store, "down", 100, f"192.0.2.{i+1}")
        store.node_results([node()], {"host": "down"}, 100, 45)
    finally:
        store.close()
    with TestClient(create_app(path, monitoring=False)) as client:
        client.app.state.monitor.clock = lambda: 120
        base = "/api/history?since=90&until=200&node_id=host&limit=2"
        first = client.get(base).json()
        second = client.get(base + "&cursor=" + first["next_cursor"]).json()
        assert len(first["items"]) == len(second["items"]) == 2
        assert not ({r["id"] for r in first["items"]} & {r["id"] for r in second["items"]})
        assert len(client.get(base + "&target=192.0.2.1").json()["items"]) == 1
        assert client.get(base + "&node_id=other").json()["items"] == []
        assert client.get(base + "&level=node").json()["items"][0]["target"] == ""
        assert client.get(base + "&cursor=invalid").status_code == 400
        assert client.get("/api/history?since=200&until=100").status_code == 400
        assert client.get("/api/history?since=nan").status_code == 400
        client.app.state.monitor.clock = lambda: 400
        identifiers, cursor = [], None
        while True:
            page = client.get(base + ("&cursor=" + cursor if cursor else "")).json()
            identifiers.extend(r["id"] for r in page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        assert len(identifiers) == len(set(identifiers)) == 10
        assert sum(i < 0 for i in identifiers) == 5  # Virtual open gaps have stable cursors too.


def test_dns_failures_are_errors_and_do_not_call_icmp():
    async def scenario():
        store = Store(":memory:", clock=lambda: 100)
        n = node(); n.addresses = ["broken.example"]
        store.save(Graph(nodes=[n]))
        called = []

        async def resolver(target, timeout):
            return None

        async def probe(target, timeout):
            called.append(target)
            return "up", 1, ""

        try:
            monitor = Monitor(store, probe=probe, resolver=resolver, clock=lambda: 100, monotonic=lambda: 10)
            await monitor.round()
            assert not called
            assert monitor.snapshot()["nodes"]["host"]["status"] == "error"
            assert query(store, problems=True, now=110)["items"][0]["status"] == "error"
        finally:
            store.close()
    asyncio.run(scenario())


def test_dns_limit_does_not_serialize_icmp_and_owners_get_their_own_history():
    async def scenario():
        store = Store(":memory:", clock=lambda: 100)
        n = node(); n.addresses = [f"host{i}.example" for i in range(12)]
        store.save(Graph(nodes=[n]))
        active = peak = 0
        release = asyncio.Event()

        async def resolver(target, timeout):
            await asyncio.sleep(0)
            return "192.0.2.1"

        async def probe(target, timeout):
            nonlocal active, peak
            active += 1; peak = max(peak, active)
            if peak >= 8:
                release.set()
            await release.wait()
            active -= 1
            return "up", 1, ""

        try:
            await Monitor(store, probe=probe, resolver=resolver, clock=lambda: 100, monotonic=lambda: 10).round()
            assert peak >= 8
            assert len(query(store, now=110)["items"]) == 12
            assert query(store, level="node", now=110)["items"][0]["status"] == "up"
        finally:
            store.close()
    asyncio.run(scenario())


def test_inventory_adds_interfaces_and_confirmed_names_without_dns_servers_or_peers():
    network = {"servers-linux": {"server": {"ip": "192.0.2.1", "hostname": "server.example",
                "interfaces": {"vpn": {"ip": "10.0.0.1/24", "peer": "10.0.0.2/24"}},
                "dns": {"servers": "192.0.2.53"}}}}
    graph = Graph(nodes=[node()])
    updated, report = enrich(graph, network, {"server.example": ["192.0.2.1"], "unrelated.example": ["192.0.2.9"]})
    assert updated.nodes[0].addresses == ["192.0.2.1", "10.0.0.1", "server.example"]
    assert graph.nodes[0].addresses == ["192.0.2.1"]
    assert report["after"] == 3


def test_shared_nat_names_and_isolated_bridge_addresses_are_not_misattributed():
    network = {"routers": {"router": {"ip": "192.0.2.1", "alt_ip": "198.51.100.1"}},
               "servers-linux": {"backend": {"ip": "192.0.2.2", "alt_ip": "172.17.0.1"},
                                 "other": {"ip": "192.0.2.3", "alt_ip": "172.17.0.1"}},
               "web-domains": {"site.example": {"hosted_on": "backend"}}}
    graph = Graph(nodes=[node(), Node(id="backend", name="Backend", x=0, y=0, addresses=["192.0.2.2"])])
    updated, report = enrich(graph, network, {"site.example": ["198.51.100.1"]})
    assert "site.example" not in updated.nodes[0].addresses
    assert "site.example" not in updated.nodes[1].addresses
    assert "172.17.0.1" not in updated.nodes[1].addresses
    assert report["skipped_shared"]


def test_primary_identity_beats_stale_foreign_address_and_reports_conflict():
    network = {"servers-windows": {"first": {"ip": "192.0.2.1", "vpn_ip": "10.0.0.1"},
                                   "second": {"ip": "192.0.2.2", "vpn_ip": "10.0.0.2"}}}
    n = node(); n.addresses += ["10.0.0.2"]
    updated, report = enrich(Graph(nodes=[n]), network, {"second": ["10.0.0.2"]})
    assert "10.0.0.1" in updated.nodes[0].addresses
    assert "second" not in updated.nodes[0].addresses
    assert report["conflicts"][0]["inventory_owners"] == ["second"]


def test_dns_aliases_need_unique_owner_even_if_shared_ip_is_already_on_map():
    network = {"servers-linux": {"first": {"ip": "192.0.2.1", "alt_ip": "172.17.0.1"},
                                 "second": {"ip": "192.0.2.2", "alt_ip": "172.17.0.1"}}}
    graph = Graph(nodes=[Node(id="first", name="First", x=0, y=0, addresses=["192.0.2.1", "172.17.0.1"]),
                         Node(id="second", name="Second", x=0, y=0, addresses=["192.0.2.2", "172.17.0.1"])])
    updated, report = enrich(graph, network, {"bridge.test": ["172.17.0.1"],
                                              "pool.test": ["192.0.2.1", "192.0.2.2"],
                                              "one.test": ["192.0.2.1"]})
    assert [n.addresses for n in updated.nodes] == [["192.0.2.1", "172.17.0.1", "one.test"],
                                                   ["192.0.2.2", "172.17.0.1"]]
    assert [entry["alias"] for entry in report["ambiguous_dns"]] == ["bridge.test", "pool.test"]
