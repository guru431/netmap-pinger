"""Atomic topology updates and most recent probe results on a local SQLite disk."""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from .history import History
from .model import Graph
from .netwatch import Netwatch
from .statistics import ProbeStatistics


class Conflict(Exception):
    pass


class Store:
    def __init__(self, path: str | Path, *, clock=time.time):
        self.path = str(path)
        self.clock = clock
        if self.path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS topology (
                id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS probes (
                target TEXT PRIMARY KEY, status TEXT NOT NULL, checked_at REAL NOT NULL,
                rtt_ms REAL, detail TEXT NOT NULL
            );
        """)
        self.history = History(self.conn)
        self.netwatch = Netwatch(self.conn)
        self.statistics = ProbeStatistics(self.conn)
        with self.conn:
            self.conn.execute("INSERT OR IGNORE INTO topology VALUES (1, 0, ?)",
                              (Graph().model_dump_json(),))

    def graph(self) -> Graph:
        row = self.conn.execute("SELECT revision, body FROM topology WHERE id=1").fetchone()
        graph = Graph.model_validate_json(row["body"])
        graph.revision = row["revision"]
        return graph

    def revision(self) -> int:
        return self.conn.execute("SELECT revision FROM topology WHERE id=1").fetchone()[0]

    def save(self, graph: Graph) -> Graph:
        previous = self.graph()
        updated = graph.model_copy(update={"revision": graph.revision + 1})
        with self.conn:
            changed = self.conn.execute(
                "UPDATE topology SET revision=?, body=? WHERE id=1 AND revision=?",
                (updated.revision, updated.model_dump_json(), graph.revision),
            ).rowcount
            if not changed:
                raise Conflict("Карта изменена в другом окне. Обновите страницу и повторите правку.")
            self.history.topology_changed(graph, self.clock())
            self.netwatch.topology_changed(previous, updated)
            targets = {a for n in graph.nodes if n.enabled for a in n.addresses}
            # No variable-length IN expression: address count is not tied to SQLite's parameter limit.
            obsolete = [(row[0],) for row in self.conn.execute("SELECT target FROM probes")
                        if row[0] not in targets]
            self.conn.executemany("DELETE FROM probes WHERE target=?", obsolete)
        return updated

    def result(self, target: str, status: str, checked_at: float,
               rtt_ms: float | None, detail: str = "", *, nodes=(), gap_after=45):
        with self.conn:
            saved = self.conn.execute("""INSERT INTO probes VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(target) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,
                    rtt_ms=excluded.rtt_ms,detail=excluded.detail
                WHERE excluded.checked_at>=probes.checked_at""",
                                      (target, status, checked_at, rtt_ms, detail)).rowcount
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
                if netwatch_minutes is not None and node.netwatch_active:
                    self.netwatch.observe(node, status, checked_at, gap_after, threshold_minutes=netwatch_minutes)

    def results(self) -> dict:
        return {row["target"]: dict(row) for row in self.conn.execute("SELECT * FROM probes")}

    def close(self):
        self.conn.close()
