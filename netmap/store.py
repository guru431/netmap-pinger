"""Atomic topology updates and most recent probe results on a local SQLite disk."""
from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

from .history import History
from .model import Graph
from .netwatch import Netwatch
from .statistics import ProbeStatistics


class Conflict(Exception):
    pass


class MapStore:
    def __init__(self, conn, clock, map_id, netwatch=None):
        self.conn, self.clock, self.map_id = conn, clock, map_id
        self.history = History(conn, map_id)
        self.statistics = ProbeStatistics(conn, map_id)
        self.netwatch = netwatch

    def graph(self) -> Graph:
        row = self.conn.execute("SELECT revision, body FROM topology WHERE id=?", (self.map_id,)).fetchone()
        graph = Graph.model_validate_json(row["body"])
        graph.revision = row["revision"]
        return graph

    def revision(self) -> int:
        return self.conn.execute("SELECT revision FROM topology WHERE id=?", (self.map_id,)).fetchone()[0]

    def save(self, graph: Graph) -> Graph:
        previous = self.graph() if self.netwatch else None
        updated = graph.model_copy(update={"revision": graph.revision + 1})
        with self.conn:
            changed = self.conn.execute(
                "UPDATE topology SET revision=?, body=? WHERE id=? AND revision=?",
                (updated.revision, updated.model_dump_json(), self.map_id, graph.revision),
            ).rowcount
            if not changed:
                raise Conflict("Карта изменена в другом окне. Обновите страницу и повторите правку.")
            self.history.topology_changed(graph, self.clock())
            if self.netwatch:
                self.netwatch.topology_changed(previous, updated)
            targets = {a for n in graph.nodes if n.enabled for a in n.addresses}
            # No variable-length IN expression: address count is not tied to SQLite's parameter limit.
            obsolete = [(self.map_id, row[0]) for row in self.conn.execute(
                "SELECT target FROM probes WHERE map_id=?", (self.map_id,))
                        if row[0] not in targets]
            self.conn.executemany("DELETE FROM probes WHERE map_id=? AND target=?", obsolete)
        return updated

    def result(self, target: str, status: str, checked_at: float,
               rtt_ms: float | None, detail: str = "", *, nodes=(), gap_after=45):
        with self.conn:
            saved = self.conn.execute("""INSERT INTO probes VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(map_id,target) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,
                    rtt_ms=excluded.rtt_ms,detail=excluded.detail
                WHERE excluded.checked_at>=probes.checked_at""",
                                      (self.map_id, target, status, checked_at, rtt_ms, detail)).rowcount
            if saved:
                self.statistics.record(target, status, checked_at, rtt_ms)
            for node in nodes:
                self.history.record(node.id, node.name, target, status, checked_at, gap_after, detail)

    def node_results(self, nodes, statuses, checked_at: float, gap_after: float, *,
                     netwatch_minutes: int | None = None):
        with self.conn:
            for node in nodes:
                status = statuses[node.id]
                self.history.record(node.id, node.name, "", status, checked_at, gap_after)
                if self.netwatch and netwatch_minutes is not None and node.netwatch_active:
                    self.netwatch.observe(node, status, checked_at, gap_after, threshold_minutes=netwatch_minutes)

    def results(self) -> dict:
        return {row["target"]: dict(row) for row in self.conn.execute(
            "SELECT target,status,checked_at,rtt_ms,detail FROM probes WHERE map_id=?", (self.map_id,))}


class Store(MapStore):
    def __init__(self, path: str | Path, *, clock=time.time):
        self.path = str(path)
        if self.path != ":memory:":
            Path(path).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                os.close(fd)
        conn = sqlite3.connect(self.path)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            with conn:
                conn.execute("BEGIN IMMEDIATE")
                self._schema(conn)
                History.initialize(conn)
                ProbeStatistics.initialize(conn)
            super().__init__(conn, clock, 1, Netwatch(conn))
        except BaseException:
            conn.close()
            raise

    @staticmethod
    def _schema(conn):
        # Old installations kept the only map under id=1.
        topology_sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='topology'").fetchone()
        legacy_topology = topology_sql and "CHECK" in topology_sql[0].upper()
        if legacy_topology:
            conn.execute("ALTER TABLE topology RENAME TO topology_legacy")
        conn.execute("""CREATE TABLE IF NOT EXISTS topology (
            id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL
        )""")
        if legacy_topology:
            conn.execute("INSERT INTO topology SELECT * FROM topology_legacy")
            conn.execute("DROP TABLE topology_legacy")
        conn.execute("INSERT OR IGNORE INTO topology VALUES (1, 0, ?)", (Graph().model_dump_json(),))
        probes = {column[1] for column in conn.execute("PRAGMA table_info(probes)")}
        legacy_probes = probes and "map_id" not in probes
        if legacy_probes:
            conn.execute("ALTER TABLE probes RENAME TO probes_legacy")
        conn.execute("""CREATE TABLE IF NOT EXISTS probes (
            map_id INTEGER NOT NULL REFERENCES topology(id), target TEXT NOT NULL,
            status TEXT NOT NULL, checked_at REAL NOT NULL, rtt_ms REAL, detail TEXT NOT NULL,
            PRIMARY KEY (map_id, target)
        )""")
        if legacy_probes:
            conn.execute("INSERT INTO probes SELECT 1, * FROM probes_legacy")
            conn.execute("DROP TABLE probes_legacy")

    def for_map(self, map_id):
        return self if map_id == 1 else MapStore(self.conn, self.clock, map_id)

    def close(self):
        self.conn.close()
