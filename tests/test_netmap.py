"""Network-map contracts: FPinger fidelity, unlimited targets, atomic saves and probe lifecycle."""
import asyncio
import base64
from contextlib import closing
import subprocess

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from netmap import netwatch
from netmap.app import create_app
from netmap.import_friendly import convert
from netmap.model import Edge, Graph, Node, Settings
from netmap.monitor import Monitor, node_status, ping
from netmap.password import PasswordFile
from netmap.store import Conflict, Store


async def fake_resolver(target, timeout):
    return target


@pytest.mark.parametrize("count", ["broken", "-1", "999"])
def test_bad_import_label_keeps_nodes_and_records_device(count):
    text = (f"[Device0]\n ID=1\n Address=192.0.2.1\n [Name]\n  Count={count}\n"
            "[Device1]\n ID=2\n Name=Good\n Address=192.0.2.2\n")
    graph = convert({"map": base64.b64encode(text.encode()).decode(), "config": ""})
    assert len(graph.nodes) == 2 and graph.nodes[0].name == "192.0.2.1"
    assert len(graph.import_notes) == 1 and "Device0" in graph.import_notes[0]


def topology(addresses=None):
    return Graph(nodes=[Node(id="server", name="Сервер", x=10, y=20,
                             addresses=addresses if addresses is not None else ["192.0.2.1", "server.example"])])


def test_password_change_requires_https_origin_and_current_password(tmp_path, monkeypatch):
    path = tmp_path / 'netmap.htpasswd'
    monkeypatch.setenv('NETMAP_PASSWORD_FILE', str(path))
    calls = []

    def change(self, current, replacement):
        assert self.path == path
        calls.append((current, replacement))
        return current == b'old-test-password'

    monkeypatch.setattr(PasswordFile, 'change', change)
    with TestClient(create_app(tmp_path / 'map.sqlite', monitoring=False), base_url='https://testserver') as client:
        headers = {'X-Netmap-Request': '1', 'Origin': 'https://testserver'}
        body = {'current': 'old-test-password', 'replacement': 'new-test-password'}
        assert client.get('/api/state').json()['password_change'] is True
        for origin in ('http://testserver', 'https://another.invalid', ''):
            assert client.post('/api/password', headers={**headers, 'Origin': origin}, json=body).status_code == 403
        assert client.post('http://testserver/api/password', headers={**headers, 'Origin': 'http://testserver'},
                           json=body).status_code == 403
        assert client.post('/api/password', headers={'Origin': 'https://testserver'}, json=body).status_code == 403
        for invalid in ('short', 'x' * 73, 'x' * 12 + '\n', 'я' * 37, body['current']):
            response = client.post('/api/password', headers=headers, json={**body, 'replacement': invalid})
            assert response.status_code == 400
            assert 'old-test-password' not in response.text
        assert not calls
        wrong = client.post('/api/password', headers=headers, json={**body, 'current': 'wrong'})
        assert wrong.status_code == 400
        assert client.post('/api/password', headers=headers, json=body).json() == {'changed': True}
        assert calls == [(b'wrong', b'new-test-password'), (b'old-test-password', b'new-test-password')]


def test_password_replacement_preserves_file_if_hashing_fails(tmp_path, monkeypatch):
    path = tmp_path / 'netmap.htpasswd'
    path.write_bytes(b'old hash\n')
    store = PasswordFile(path)

    def htpasswd(flags, filename, supplied, *options):
        if flags == '-vi':
            return subprocess.CompletedProcess([], 0)
        assert filename != path
        assert filename.read_bytes() == b'old hash\n'
        filename.write_bytes(b'partial hash')
        return subprocess.CompletedProcess([], 1)

    monkeypatch.setattr(store, '_htpasswd', htpasswd)
    with pytest.raises(subprocess.CalledProcessError):
        store.change(b'old-test-password', b'new-test-password')
    assert path.read_bytes() == b'old hash\n'
    assert list(tmp_path.iterdir()) == [path]


def netwatch_queue(store):
    return [tuple(row) for row in store.conn.execute(
        "SELECT message_id, subject, body FROM netwatch_outbox ORDER BY id")]


def test_netwatch_uses_complete_rounds_and_persists_one_alert_per_transition(tmp_path):
    path = tmp_path / "map.sqlite"
    now, recovered = 1000, False

    async def probe(target, timeout):
        return ("up", 1, "") if recovered and target == "192.0.2.2" else ("down", None, "")

    async def run():
        nonlocal now, recovered
        with closing(Store(path)) as store:
            graph = topology(["192.0.2.1", "192.0.2.2"])
            node = graph.nodes[0]
            graph.nodes += [node.model_copy(update={"id": "optional", "allow_offline": True}),
                            node.model_copy(update={"id": "paused", "enabled": False}),
                            node.model_copy(update={"id": "opt-out", "netwatch": False}),
                            node.model_copy(update={"id": "no-addresses", "addresses": []})]
            store.save(graph)
            monitor = Monitor(store, probe=probe, clock=lambda: now, netwatch_mail=True)
            for now in range(1000, 1600, 15):
                await monitor.round()
            assert netwatch_queue(store) == []
            now = 1600
            await monitor.round()
            pending = netwatch_queue(store)
            assert len(pending) == 1
            assert pending[0][1] == "Netwatch · Сервер · недоступен 10 мин."

        with closing(Store(path)) as store:
            monitor = Monitor(store, probe=probe, clock=lambda: now, netwatch_mail=True)
            now += 15
            await monitor.round()
            assert netwatch_queue(store) == pending
            recovered = True
            for _ in range(2):
                now += 15
                await monitor.round()
            messages = netwatch_queue(store)
            assert len(messages) == 2
            assert messages[0] == pending[0]
            assert messages[1][1] == "Netwatch · Сервер · снова доступен"
            assert monitor.snapshot()["nodes"]["server"]["status"] == "partial"

    asyncio.run(run())


def test_netwatch_applies_changed_threshold_to_an_outage_in_progress():
    now = 1000

    async def probe(target, timeout):
        return "down", None, ""

    async def run():
        nonlocal now
        with closing(Store(":memory:", clock=lambda: now)) as store:
            graph = store.save(topology(["192.0.2.1"]))
            monitor = Monitor(store, probe=probe, clock=lambda: now, netwatch_mail=True)
            for now in range(1000, 1120, 15):
                await monitor.round()
            assert netwatch_queue(store) == []
            graph.settings.netwatch_minutes = 2
            store.save(graph)
            now = 1120
            await monitor.round()
            assert [row[1] for row in netwatch_queue(store)] == ["Netwatch · Сервер · недоступен 2 мин."]

    asyncio.run(run())


@pytest.mark.parametrize("interruption", ["error", "gap", "policy", "addresses", "partial"])
def test_netwatch_restarts_unconfirmed_outage_after_interruption(interruption):
    now = 1000
    with closing(Store(":memory:", clock=lambda: now)) as store:
        graph = store.save(topology())
        node = graph.nodes[0]

        def record(status):
            store.node_results([node], {node.id: status}, now, 45, netwatch_minutes=10)

        for now in range(1000, 1600, 30):
            record("down")
        now = 1585
        if interruption in {"error", "partial"}:
            record(interruption)
        elif interruption == "policy":
            node.allow_offline = True
            graph = store.save(graph)
            node = graph.nodes[0]
            node.allow_offline = False
            store.save(graph)
        elif interruption == "addresses":
            node.addresses = ["192.0.2.3"]
            store.save(graph)

        now = 1630 if interruption == "gap" else 1600
        record("down")
        assert netwatch_queue(store) == []
        for now in range(now + 30, now + 601, 30):
            record("down")
        assert len(netwatch_queue(store)) == 1


def test_netwatch_retries_outbox_in_order_using_current_recipient(monkeypatch):
    async def run():
        sent = []
        parked = asyncio.Event()
        current_recipient = ""

        async def send_in_test(send, *args, **kwargs):
            send(*args, **kwargs)

        def send(message_id, subject, body, *, recipient):
            nonlocal current_recipient
            sent.append((message_id, recipient))
            if len(sent) == 1:
                current_recipient = "updated@example.org"
                raise OSError("SMTP offline")

        async def empty_queue():
            # Signal after both successful sends have been committed.
            parked.set()
            await asyncio.Future()

        monkeypatch.setattr(netwatch.asyncio, "to_thread", send_in_test)
        monkeypatch.setattr(netwatch, "RETRY_SECONDS", 0)
        with closing(Store(":memory:")) as store:
            node = topology().nodes[0]
            with store.conn:
                store.netwatch.enqueue(node, 1000, 1600, threshold_minutes=10)
                store.netwatch.enqueue(node, 1000, 1660)
            down, up = [row[0] for row in netwatch_queue(store)]
            monkeypatch.setattr(store.netwatch.queued, "wait", empty_queue)
            def get_recipient():
                nonlocal current_recipient
                recipient = current_recipient
                if not recipient:
                    assert sent == [] and len(netwatch_queue(store)) == 2
                    current_recipient = "original@example.org"
                return recipient

            worker = asyncio.create_task(store.netwatch.deliver(send, get_recipient))
            try:
                await asyncio.wait_for(parked.wait(), 1)
                assert sent == [(down, "original@example.org"), (down, "updated@example.org"),
                                (up, "updated@example.org")]
                assert netwatch_queue(store) == []
            finally:
                worker.cancel()
                await asyncio.gather(worker, return_exceptions=True)

    asyncio.run(run())


def test_netwatch_mail_uses_starttls_and_configured_recipient(monkeypatch):
    calls = []

    class SMTP:
        def __init__(self, host, port, *, timeout):
            calls.append((host, port, timeout))

        def starttls(self, *, context):
            calls.append(context.check_hostname)

        def login(self, sender, password):
            calls.append((sender, password))

        def send_message(self, message):
            calls.append((message["From"], message["To"], message["Message-ID"], message.get_content()))

        def close(self):
            calls.append("closed")

    monkeypatch.setattr(netwatch.smtplib, "SMTP", SMTP)
    netwatch.send_email("<event@netmap.invalid>", "Netwatch", "Узел недоступен",
                        recipient="alerts+netmap@example.org", host="smtp.example.org",
                        port=2525, sender="sender@example.org", password="test-secret")
    assert calls == [("smtp.example.org", 2525, 10), True, ("sender@example.org", "test-secret"),
                     ("sender@example.org", "alerts+netmap@example.org", "<event@netmap.invalid>",
                      "Узел недоступен\n"), "closed"]


def test_netwatch_settings_defaults_validation_preview_and_persistence(tmp_path):
    path = tmp_path / "map.sqlite"
    headers = {"X-Netmap-Request": "1"}
    with TestClient(create_app(path, monitoring=False)) as client:
        graph = client.get("/api/state").json()["graph"]
        assert graph["settings"]["netwatch_recipient"] == ""
        assert graph["settings"]["netwatch_minutes"] == 10
        for invalid in ({"netwatch_recipient": "a@example.org, b@example.org"},
                        {"netwatch_recipient": "a@example.org\r\nBcc: b@example.org"},
                        {"netwatch_recipient": "a@example..org"},
                        {"netwatch_minutes": 0}, {"netwatch_minutes": 1.5}, {"netwatch_minutes": True}):
            body = graph | {"settings": graph["settings"] | invalid}
            assert client.put("/api/map", json=body, headers=headers).status_code == 422
        graph["settings"].update(netwatch_recipient="alerts+map@example.org", netwatch_minutes=3)
        preview = client.post("/api/map/preview", json=graph, headers=headers).json()
        assert preview["settings"] == {
            "netwatch_recipient": {"before": "", "after": "alerts+map@example.org"},
            "netwatch_minutes": {"before": 10, "after": 3},
        }
        assert client.put("/api/map", json=graph, headers=headers).status_code == 200
    with TestClient(create_app(path, monitoring=False)) as client:
        assert client.get("/api/export").json()["settings"] == graph["settings"]


def test_import_nested_names_scalar_names_and_geometric_links():
    source = """[Device0]
 Left=10
 Top=20
 Group=1
 ID=7
 Address=192.0.2.1
 Addresses=server.example;2001:db8::1
 [Name]
  Count=2
  Item0=Мой сервер
  Item1=%Address
[Device1]
 Left=110
 Top=20
 Group=1
 ID=8
 Name=Router
 Address=192.0.2.2
[Line0]
 Color=$00FFFF80
 Nodes=[42;36][80;45][110;36]
"""
    graph = convert({"map": base64.b64encode(source.encode("cp1251")).decode(),
                     "config": "[Config]\n PingPeriod=15\n PingTimeOut=3\n[Device0]\n ID=1\n Name=Server\n MainImage=server.gif\n",
                     "image_sizes": {"server.gif": [32, 32]}})
    first, second = graph.nodes
    assert (first.name, first.x, first.y, first.notes) == ("Мой сервер", 26, 36, "192.0.2.1")
    assert second.name == "Router"
    assert first.addresses == ["192.0.2.1", "server.example", "2001:db8::1"]
    assert (graph.edges[0].from_id, graph.edges[0].to_id) == ("fp-7", "fp-8")
    assert graph.edges[0].points == [(42, 36), (80, 45), (110, 36)]
    assert graph.edges[0].color == "#80FFFF"
    assert not graph.import_notes


def test_ambiguous_import_keeps_line_and_requests_manual_attachment():
    text = "[Device0]\n ID=1\n Left=0\n Top=0\n[Device1]\n ID=2\n Left=0\n Top=0\n[Line0]\n Nodes=[10;10][900;900]\n"
    graph = convert({"map": base64.b64encode(text.encode()).decode(), "config": ""})
    assert len(graph.edges) == 1
    assert graph.edges[0].from_id is None and graph.edges[0].to_id is None
    assert len(graph.import_notes) == 1


def test_no_address_slots_and_sqlite_parameter_limit(tmp_path):
    values = [f"host{i}.example" for i in range(3000)] + ["HOST0.EXAMPLE.", "2001:0db8::1"]
    graph = topology(values)
    assert len(graph.nodes[0].addresses) == 3001
    with TestClient(create_app(tmp_path / "map.sqlite", monitoring=False)) as client:
        response = client.put("/api/map", json=graph.model_dump(), headers={"X-Netmap-Request": "1"})
        assert response.status_code == 200
        assert len(client.get("/api/state").json()["graph"]["nodes"][0]["addresses"]) == 3001
        assert len(client.get("/api/export").json()["nodes"][0]["addresses"]) == 3001


@pytest.mark.parametrize("value", ["-c100", "foo;whoami", "foo\nbar", "http://host", "host:80", "999.1.1.1", "foo/../../bar", "$(whoami)"])
def test_probe_targets_cannot_be_options_shell_or_urls(value):
    with pytest.raises(ValidationError):
        topology([value])


def test_topology_requires_unique_ids_and_valid_edges():
    graph = topology()
    with pytest.raises(ValidationError):
        Graph(nodes=graph.nodes * 2)
    with pytest.raises(ValidationError):
        Graph(nodes=graph.nodes, edges=[Edge(id="e", from_id="server", to_id="missing")])
    with pytest.raises(ValidationError):
        Graph(edges=[Edge(id="e", points=[(float("nan"), 0), (1, 1)])])


def test_atomic_revisions_preserve_other_window_and_persist(tmp_path):
    path = tmp_path / "map.sqlite"
    first, second = Store(path), Store(path)
    try:
        first.save(topology())
        with pytest.raises(Conflict):
            second.save(topology(["other.example"]))
        assert second.graph().nodes[0].addresses[0] == "192.0.2.1"
        first.result("192.0.2.1", "up", 100, 2)
        updated = first.graph()
        updated.nodes[0].addresses = ["new.example"]
        first.save(updated)
        assert not first.results()
    finally:
        first.close()
        second.close()
    reopened = Store(path)
    try:
        assert reopened.graph().revision == 2
        assert reopened.graph().nodes[0].addresses == ["new.example"]
    finally:
        reopened.close()


def test_browser_write_boundary_and_conflict(tmp_path):
    with TestClient(create_app(tmp_path / "map.sqlite", monitoring=False)) as client:
        body = topology().model_dump()
        assert client.put("/api/map", json=body).status_code == 403
        assert client.put("/api/map", json=body, headers={"X-Netmap-Request": "1", "Origin": "https://evil.example"}).status_code == 403
        assert client.put("/api/map", json=body, headers={"X-Netmap-Request": "1", "Origin": "http://["}).status_code == 403
        assert client.get("/api/state", headers={"Host": "evil.example"}).status_code == 400
        headers = {"X-Netmap-Request": "1", "Origin": "http://testserver"}
        assert client.put("/api/map", json=body, headers=headers).status_code == 200
        assert client.put("/api/map", json=body, headers=headers).status_code == 409
        assert client.post("/api/poll", headers=headers).status_code == 200
        assert client.get("/api/state").headers["cache-control"] == "no-store"


def test_json_replacement_preview_compares_ids_and_uses_same_revision_as_save(tmp_path):
    with TestClient(create_app(tmp_path / "map.sqlite", monitoring=False)) as client:
        headers = {"X-Netmap-Request": "1"}
        current = topology(["192.0.2.1", "lost.example"]).model_copy(update={
            "nodes": [*topology(["192.0.2.1", "lost.example"]).nodes,
                      Node(id="other", name="Other", x=0, y=0, addresses=["shared.example"])],
            "edges": [Edge(id="link", from_id="server", to_id="other")],
        }).model_dump()
        assert client.put("/api/map", json=current, headers=headers).status_code == 200
        current["revision"] = 1
        updated = Graph.model_validate(current)
        updated.nodes[0].addresses = ["192.0.2.1"]
        updated.nodes[1] = Node(id="new", name="Other", x=0, y=0, addresses=["SHARED.EXAMPLE."])
        updated.edges[0].to_id = "new"
        updated.settings.timeout = 4
        proposed = updated.model_dump()
        response = client.post("/api/map/preview", json=proposed, headers=headers)
        assert response.status_code == 200
        diff = response.json()
        assert diff["revision"] == 1
        assert diff["stopped_targets"] == ["lost.example"]
        assert [node["id"] for node in diff["nodes"]["added"]] == ["new"]
        assert [node["id"] for node in diff["nodes"]["removed"]] == ["other"]
        assert diff["nodes"]["changed"][0]["before"]["addresses"] == ["192.0.2.1", "lost.example"]
        assert diff["nodes"]["changed"][0]["after"]["addresses"] == ["192.0.2.1"]
        assert diff["edges"]["changed"][0]["after"]["to_id"] == "new"
        assert diff["settings"] == {"timeout": {"before": 3, "after": 4}}
        assert client.get("/api/state").json()["graph"] == current
        assert client.post("/api/map/preview", json=proposed).status_code == 403
        assert client.post("/api/map/preview", json=proposed,
                           headers=headers | {"Origin": "https://other.example"}).status_code == 403
        assert client.post("/api/map/preview", json=proposed | {"edges": [{"id": "invalid"}]}, headers=headers).status_code == 422
        assert client.put("/api/map", json=current, headers=headers).status_code == 200
        assert client.post("/api/map/preview", json=proposed, headers=headers).status_code == 409
        assert client.put("/api/map", json=proposed, headers=headers).status_code == 409


def test_address_statuses_are_fresh_and_aggregate_without_false_down():
    node = topology().nodes[0]
    samples = {"192.0.2.1": {"target": "192.0.2.1", "status": "up", "checked_at": 100, "rtt_ms": 1, "detail": ""},
               "server.example": {"target": "server.example", "status": "down", "checked_at": 100, "rtt_ms": None, "detail": ""}}
    assert node_status(node, samples, 101, 45)[0] == "partial"
    assert node_status(node, samples, 146, 45)[0] == "stale"
    assert node_status(node, {}, 101, 45)[0] == "unknown"
    samples["192.0.2.1"]["status"] = "error"
    assert node_status(node, samples, 101, 45)[0] == "error"
    samples["192.0.2.1"]["status"] = "down"
    assert node_status(node, samples, 101, 45)[0] == "down"
    node.enabled = False
    assert node_status(node, samples, 101, 45)[0] == "paused"
    assert node_status(topology([]).nodes[0], {}, 101, 45)[0] == "unmonitored"


def test_streamed_json_limit_and_proxy_prefix(tmp_path):
    app = create_app(tmp_path / "map.sqlite", monitoring=False, body_limit=1024)
    with TestClient(app, root_path="/netmap") as client:
        assert client.get("/netmap/").status_code == 200
        assert client.get("/netmap/static/app.js").status_code == 200
        assert client.get("/netmap/api/state").status_code == 200
        for method, path in [("PUT", "/api/map"), ("POST", "/api/map/preview")]:
            response = client.request(method, "/netmap" + path, content=iter([b" " * 700, b" " * 700]),
                                      headers={"X-Netmap-Request": "1", "Content-Type": "application/json"})
            assert response.status_code == 413
        assert client.get("/netmap/api/state").json()["graph"]["revision"] == 0


def test_round_deduplicates_addresses_bounds_concurrency_and_skips_paused():
    async def scenario():
        store = Store(":memory:")
        graph = topology([f"host{i}.example" for i in range(12)])
        graph.settings = Settings(concurrency=3)
        graph.nodes += [Node(id="copy", name="Copy", x=0, y=0, addresses=["host0.example"]),
                        Node(id="paused", name="Paused", x=0, y=0, addresses=["paused.example"], enabled=False)]
        store.save(graph)
        active = peak = 0
        seen = []

        async def probe(target, timeout):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            seen.append(target)
            await asyncio.sleep(0)
            active -= 1
            return "up", 1, ""

        monitor = Monitor(store, probe=probe, resolver=fake_resolver, clock=lambda: 100, monotonic=lambda: 20)
        try:
            await monitor.round()
            assert len(seen) == 12 and peak == 3
            snapshot = monitor.snapshot()
            assert snapshot["nodes"]["copy"]["status"] == "up"
            assert snapshot["nodes"]["paused"]["status"] == "paused"
            assert snapshot["monitor"]["completed"] == 12
        finally:
            store.close()
    asyncio.run(scenario())


def test_removed_inflight_address_is_not_resurrected():
    async def scenario():
        store = Store(":memory:")
        store.save(topology(["old.example"]))

        async def probe(target, timeout):
            graph = store.graph()
            graph.nodes[0].addresses = ["new.example"]
            store.save(graph)
            return "up", 1, ""

        try:
            await Monitor(store, probe=probe, resolver=fake_resolver).round()
            assert not store.results()
        finally:
            store.close()
    asyncio.run(scenario())


def test_shared_dns_has_its_own_five_probe_limit():
    async def scenario():
        store = Store(":memory:")
        graph = topology([f"host{i}.example" for i in range(20)])
        graph.settings.concurrency = 32
        store.save(graph)
        active = peak = 0

        async def resolver(target, timeout):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0)
            active -= 1
            return target

        async def probe(target, timeout):
            return "up", 1, ""

        try:
            await Monitor(store, probe=probe, resolver=resolver, clock=lambda: 100, monotonic=lambda: 20).round()
            assert peak == 5 and len(store.results()) == 20
        finally:
            store.close()
    asyncio.run(scenario())


def test_ping_parsing_uses_argv_and_reaps_cancelled_children(monkeypatch):
    class Process:
        def __init__(self, output, code=0):
            self.output, self.code, self.returncode, self.killed, self.waited = output, code, None, False, False

        async def communicate(self):
            if self.output is None:
                raise asyncio.CancelledError
            self.returncode = self.code
            return self.output, None

        def kill(self):
            self.killed = True

        async def wait(self):
            self.waited = True
            self.returncode = -9

    async def scenario():
        process = Process(b"64 bytes from 192.0.2.1: icmp_seq=1 ttl=64 time=1.25 ms")
        args_seen = []

        async def start(*args, **kwargs):
            args_seen.append(args)
            return process

        monkeypatch.setattr(asyncio, "create_subprocess_exec", start)
        assert await ping("server.example", 3) == ("up", 1.25, "")
        assert args_seen[0][-1] == "server.example"
        process = Process(b"Antwort von 192.0.2.1: Bytes=32 Zeit<1ms TTL=64")
        assert await ping("server.example", 3) == ("up", 0.5, "")
        process = Process(b"Destination host unreachable.", 0)
        assert (await ping("server.example", 3))[0] == "down"
        process = Process(b"DNS error", 2)
        assert (await ping("server.example", 3))[0] == "error"
        process = Process(None)
        with pytest.raises(asyncio.CancelledError):
            await ping("server.example", 3)
        assert process.killed and process.waited
    asyncio.run(scenario())
