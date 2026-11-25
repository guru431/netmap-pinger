"""ICMP statistics keep real gaps, distinct errors and independently labeled endpoints."""
from contextlib import closing

from fastapi.testclient import TestClient
import pytest

from netmap.app import create_app
from netmap.labels import annotate, smokeping_targets
from netmap.model import Graph, replacement_preview
from netmap.statistics import DAY, HOUR, PERIODS
from netmap.store import Store


def test_statistics_survive_restart_and_exclude_gaps_errors_and_retries(tmp_path):
    path = tmp_path / "map.sqlite"
    with closing(Store(path)) as store:
        store.result("a.example", "down", 5, None)
        store.result("a.example", "up", 10, 10)
        store.result("a.example", "up", 15, 30)
        store.result("a.example", "up", 15, 900)  # identical time is already recorded
        store.result("a.example", "up", 9, 800)  # stale result
        store.result("a.example", "error", 605, None)
        store.result("a.example", "down", 905, None)
    with closing(Store(path)) as store:
        series = store.statistics.series("a.example", 0, 1000, 300)
        assert [point["time"] for point in series["points"]] == [0, 600, 900]
        summary = series["summary"]
        assert (summary["sent"], summary["received"], summary["errors"], summary["loss"]) == (4, 2, 1, 50)
        assert summary["rtt_ms"] == pytest.approx(
            {"min": 10, "max": 30, "median": 20, "p95": 29, "mean": 20, "stddev": 10}, abs=1)
        assert series["points"][1]["loss"] is None
        assert series["points"][2]["loss"] == 100
        assert series["points"][2]["rtt_ms"] is None


def test_resolution_changes_keep_counts_and_only_expire_the_required_buckets():
    now = 400 * DAY + HOUR + 12
    with closing(Store(":memory:")) as store:
        for age, status in [(370 * DAY, "up"), (360 * DAY, "up"), (29 * DAY, "up"),
                            (6 * DAY, "down"), (2 * HOUR, "down"), (1, "up")]:
            store.result("a.example", status, now - age, 40 if status == "up" else None)
        store.statistics.prune(now)
        for name, count in [("3h", 2), ("1d", 2), ("1w", 3), ("1m", 4), ("1y", 5)]:
            period, step = PERIODS[name]
            since = int((now - period) // step) * step
            summary = store.statistics.series("a.example", since, now, step)["summary"]
            assert summary["sent"] == count
        assert dict(store.conn.execute("SELECT resolution, count(*) FROM probe_statistics GROUP BY resolution")) == {
            300: 2, HOUR: 4, DAY: 5,
        }


def test_statistics_api_filters_addresses_and_shows_nodes_without_targets(tmp_path):
    path = tmp_path / "map.sqlite"
    with closing(Store(path)) as store:
        graph = Graph.model_validate({"nodes": [
            {"id": "dual", "name": "Router", "x": 0, "y": 0, "site": "Site A",
             "addresses": ["WAN.example", "192.0.2.1"], "address_channels": {"WAN.EXAMPLE.": "wan", "192.0.2.1": "lan"}},
            {"id": "site-b", "name": "Office", "x": 0, "y": 0, "site": "Site B",
             "addresses": ["wan.example"], "address_channels": {"wan.example": "wan"}, "enabled": False},
            {"id": "empty", "name": "Group", "x": 0, "y": 0},
        ]})
        saved = store.save(graph)
        assert replacement_preview(Graph(), saved)["nodes"]["added"][0]["site"] == "Site A"
        store.result("wan.example", "up", 100, 9)
    with TestClient(create_app(path, monitoring=False)) as client:
        client.app.state.monitor.clock = lambda: 120
        data = client.get("/api/statistics", params={"channel": "wan"}).json()
        assert [(r["node_id"], r["target"], r["enabled"]) for r in data["items"]] == [
            ("dual", "wan.example", True), ("site-b", "wan.example", False),
        ]
        assert all(row["summary"]["sent"] == 1 for row in data["items"])
        data = client.get("/api/statistics", params={"channel": "wan", "site": "Site B"}).json()
        assert data["total"] == 1
        assert data["items"][0]["site"] == "Site B"
        data = client.get("/api/statistics", params={"node_id": "dual", "target": "192.0.2.1"}).json()
        assert data["items"][0]["channel"] == "lan"
        assert not data["items"][0]["points"]
        data = client.get("/api/statistics", params={"site": ""}).json()
        assert [r["node_id"] for r in data["items"]] == ["empty"]
        assert client.get("/api/statistics", params={"period": "15h"}).status_code == 422


def test_label_import_uses_fping_and_network_inventory_without_adding_targets():
    config = """probe = FPing
+ Sites
++ SiteB
host = 10.0.0.1
+ WAN
++ SiteB
host = absent.example
++ DNS
probe = DNS
host = 10.0.0.2
"""
    graph = Graph.model_validate({"nodes": [{
        "id": "site-b", "name": "Site B", "x": 0, "y": 0,
        "addresses": ["10.0.0.1", "10.0.0.2", "wan.example", "198.51.100.1"],
        "address_channels": {"198.51.100.1": "internet"},
    }]})
    inventory = {"sites": {"site-b": {"subnets": ["10.0.0.0/24"], "wan_domain": ["wan.example"]}}}
    updated, report = annotate(graph, inventory, smokeping_targets(config))
    assert updated.nodes[0].site == "SITE-B"
    assert updated.nodes[0].addresses == graph.nodes[0].addresses
    assert updated.nodes[0].address_channels == {
        "10.0.0.1": "sites-vpn", "10.0.0.2": "lan", "wan.example": "wan", "198.51.100.1": "internet",
    }
    assert report["smokeping_missing"] == {"absent.example": ["wan"]}
    assert not graph.nodes[0].site
