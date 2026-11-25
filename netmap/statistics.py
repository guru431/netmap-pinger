"""Fixed-size time buckets for the ICMP probes already collected by Netmap."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from itertools import islice
import json
import math
import sqlite3

MINUTE = 60
HOUR = 60 * MINUTE
DAY = 24 * HOUR
PERIODS = {"3h": (3 * HOUR, 5 * MINUTE), "1d": (DAY, 5 * MINUTE),
           "1w": (7 * DAY, HOUR), "1m": (30 * DAY, 2 * HOUR),
           "1y": (365 * DAY, DAY)}
# Allow for a partial bucket at either end of a displayed period.
RETENTION = {5 * MINUTE: 2 * DAY, HOUR: 32 * DAY, DAY: 367 * DAY}
PAGE_SIZE = 8
HISTOGRAM_SCALE = 16


def merge_histograms(previous: str, sample: str) -> str:
    counts = json.loads(previous)
    for key, count in json.loads(sample).items():
        counts[key] = counts.get(key, 0) + count
    return json.dumps(counts, separators=(",", ":"))


@dataclass
class Measurements:
    sent: int = 0
    received: int = 0
    errors: int = 0
    timing_count: int = 0
    total: float = 0
    squares: float = 0
    minimum: float | None = None
    maximum: float | None = None
    first_at: float | None = None
    last_at: float | None = None
    histogram: Counter = field(default_factory=Counter)

    def add(self, row: sqlite3.Row, histogram: dict[int, int]):
        self.sent += row["sent"]
        self.received += row["received"]
        self.errors += row["errors"]
        self.timing_count += sum(histogram.values())
        self.total += row["total"]
        self.squares += row["squares"]
        self.histogram.update(histogram)
        if row["minimum"] is not None:
            self.minimum = row["minimum"] if self.minimum is None else min(self.minimum, row["minimum"])
            self.maximum = row["maximum"] if self.maximum is None else max(self.maximum, row["maximum"])
        self.first_at = row["first_at"] if self.first_at is None else min(self.first_at, row["first_at"])
        self.last_at = row["last_at"] if self.last_at is None else max(self.last_at, row["last_at"])

    def summary(self) -> dict:
        timing = None
        if self.timing_count:
            ordered = sorted(self.histogram.items())
            mean = self.total / self.timing_count

            def quantile(fraction):
                rank = (self.timing_count - 1) * fraction
                lower, upper = math.floor(rank), math.ceil(rank)
                lower_value = None
                cumulative = 0
                for code, count in ordered:
                    cumulative += count
                    if cumulative <= lower:
                        continue
                    value = min(self.maximum, max(self.minimum, math.expm1(code / HISTOGRAM_SCALE)))
                    if lower_value is None:
                        lower_value = value
                    if cumulative > upper:
                        return round(lower_value + (value - lower_value) * (rank - lower), 3)

            timing = {"min": self.minimum, "median": quantile(.5), "p95": quantile(.95),
                      "max": self.maximum, "mean": round(mean, 3),
                      "stddev": round(math.sqrt(max(0, self.squares / self.timing_count - mean * mean)), 3)}
        return {"sent": self.sent, "received": self.received, "errors": self.errors,
                "loss": 100 * (self.sent - self.received) / self.sent if self.sent else None,
                "first_at": self.first_at, "last_at": self.last_at, "rtt_ms": timing}


class ProbeStatistics:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.next_prune = 0
        conn.create_function("merge_rtt_histograms", 2, merge_histograms, deterministic=True)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS probe_statistics (
                target TEXT NOT NULL, resolution INTEGER NOT NULL, bucket INTEGER NOT NULL,
                sent INTEGER NOT NULL, received INTEGER NOT NULL, errors INTEGER NOT NULL,
                minimum REAL, maximum REAL, total REAL NOT NULL, squares REAL NOT NULL,
                histogram TEXT NOT NULL, first_at REAL NOT NULL, last_at REAL NOT NULL,
                PRIMARY KEY (target, resolution, bucket)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS probe_statistics_expiry ON probe_statistics(resolution, bucket);
        """)

    def record(self, target: str, status: str, ts: float, rtt: float | None):
        sent = int(status in ("up", "down"))
        received = int(status == "up")
        if not received or rtt is None or not math.isfinite(rtt) or rtt < 0:
            rtt = None
        value = rtt or 0
        histogram = "{}" if rtt is None else '{"%d":1}' % round(math.log1p(value) * HISTOGRAM_SCALE)
        self.conn.executemany("""
            INSERT INTO probe_statistics VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(target,resolution,bucket) DO UPDATE SET
                sent=sent+excluded.sent, received=received+excluded.received, errors=errors+excluded.errors,
                minimum=coalesce(min(minimum,excluded.minimum),minimum,excluded.minimum),
                maximum=coalesce(max(maximum,excluded.maximum),maximum,excluded.maximum),
                total=total+excluded.total, squares=squares+excluded.squares,
                histogram=merge_rtt_histograms(histogram,excluded.histogram), last_at=excluded.last_at
            WHERE excluded.last_at > probe_statistics.last_at
        """, ((target, step, int(ts // step) * step, sent, received, 1 - sent,
               rtt, rtt, value, value * value, histogram, ts, ts) for step in RETENTION))

    def prune(self, now: float):
        if now < self.next_prune:
            return
        batch = 2000
        with self.conn:
            deleted = sum(self.conn.execute("""
                DELETE FROM probe_statistics WHERE (target, resolution, bucket) IN (
                    SELECT target, resolution, bucket FROM probe_statistics
                    WHERE resolution=? AND bucket<? ORDER BY bucket LIMIT ?
                )
            """, (step, int((now - keep) // step) * step, batch)).rowcount
                          for step, keep in RETENTION.items())
        self.next_prune = now + (60 if deleted >= batch else HOUR)

    def series(self, target: str, since: int, until: float, step: int) -> dict:
        resolution = max(value for value in RETENTION if step % value == 0)
        overall = Measurements()
        buckets = {}
        if target:
            for row in self.conn.execute("""
                SELECT * FROM probe_statistics WHERE target=? AND resolution=?
                AND bucket>=? AND bucket<? AND last_at<=? ORDER BY bucket
            """, (target, resolution, since, until, until)):
                histogram = {int(code): count for code, count in json.loads(row["histogram"]).items()}
                bucket = row["bucket"] // step * step
                points = buckets.setdefault(bucket, Measurements())
                points.add(row, histogram)
                overall.add(row, histogram)
        return {"summary": overall.summary(),
                "points": [dict(value.summary(), time=bucket) for bucket, value in buckets.items()]}

    def query(self, graph, *, period: str, now: float, node_id: str | None = None,
              target: str | None = None, site: str | None = None, channel: str | None = None,
              page: int = 1) -> dict:
        duration, step = PERIODS[period]
        since = int((now - duration) // step) * step
        matches = []
        for node in graph.nodes:
            if (node_id is not None and node.id != node_id) or (site is not None and node.site != site):
                continue
            for candidate in node.addresses or [""]:
                kind = node.address_channels.get(candidate)
                if (channel is None or kind == channel) and (target is None or target == candidate):
                    matches.append((node, candidate, kind))
        offset = (page - 1) * PAGE_SIZE
        items = [
            {"node_id": node.id, "name": node.name, "site": node.site, "target": candidate,
             "channel": kind, "enabled": node.enabled, "comment": node.address_comments.get(candidate, ""),
             **self.series(candidate, since, now, step)}
            for node, candidate, kind in islice(matches, offset, offset + PAGE_SIZE)
        ]
        return {"since": since, "until": now, "step": step, "total": len(matches),
                "page": page, "page_size": PAGE_SIZE, "items": items}
