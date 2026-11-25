"""Durable observed-state intervals, including gaps in collection (not invented outages)."""
from __future__ import annotations

import base64
import json
import math

STATES = {"up", "down", "partial", "error", "unknown", "stale", "gap", "paused", "unmonitored"}
INACTIVE = {"paused", "unmonitored"}


class History:
    def __init__(self, conn):
        self.conn = conn
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY,
                node_id TEXT NOT NULL, node_name TEXT NOT NULL, target TEXT NOT NULL,
                status TEXT NOT NULL, started_at REAL NOT NULL, last_at REAL NOT NULL,
                ended_at REAL, initial INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '',
                CHECK(last_at >= started_at), CHECK(ended_at IS NULL OR ended_at >= started_at)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS history_open ON history(node_id, target)
                WHERE ended_at IS NULL;
            CREATE INDEX IF NOT EXISTS history_node_time ON history(node_id, target, started_at);
            CREATE INDEX IF NOT EXISTS history_time ON history(started_at, id);
            CREATE INDEX IF NOT EXISTS history_end ON history(ended_at);
            CREATE TABLE IF NOT EXISTS history_detail (
                history_id INTEGER NOT NULL REFERENCES history(id) ON DELETE CASCADE,
                observed_at REAL NOT NULL, detail TEXT NOT NULL,
                PRIMARY KEY (history_id, observed_at)
            );
        """)

    def _insert(self, node_id, name, target, status, started, last, ended, initial, detail):
        self.conn.execute("""INSERT INTO history
            (node_id,node_name,target,status,started_at,last_at,ended_at,initial,detail)
            VALUES (?,?,?,?,?,?,?,?,?)""",
                          (node_id, name, target, status, started, last, ended, int(initial), detail))

    def record(self, node_id: str, name: str, target: str, status: str, ts: float,
               gap_after: float, detail: str = ""):
        """Called inside the transaction that persists the corresponding measurement."""
        if status not in STATES or not math.isfinite(ts):
            raise ValueError("Invalid history state or timestamp")
        previous = self.conn.execute(
            "SELECT * FROM history WHERE node_id=? AND target=? AND ended_at IS NULL",
            (node_id, target),
        ).fetchone()
        if previous is not None and ts < previous["last_at"]:
            return  # A backwards clock must not produce negative/overlapping intervals.
        initial = previous is None or previous["status"] in INACTIVE
        if (previous is not None and previous["status"] not in INACTIVE
                and ts - previous["last_at"] > gap_after):
            self.conn.execute("UPDATE history SET ended_at=last_at WHERE id=?", (previous["id"],))
            self._insert(node_id, name, target, "gap", previous["last_at"], ts, ts, False,
                         "В этот период измерений не было")
            previous, initial = None, True
        if previous is not None and previous["status"] == status:
            ident = previous["id"]
            if detail != previous["detail"]:
                # The history row retains the latest detail. Seed the first change
                # with the baseline so an older window never sees future details.
                self.conn.execute("INSERT OR IGNORE INTO history_detail VALUES (?,?,?)",
                                  (ident, previous["started_at"], previous["detail"]))
                self.conn.execute("""INSERT INTO history_detail VALUES (?,?,?)
                    ON CONFLICT(history_id, observed_at) DO UPDATE SET detail=excluded.detail""",
                                  (ident, ts, detail))
            self.conn.execute("UPDATE history SET last_at=?, node_name=?, detail=? WHERE id=?",
                              (ts, name, detail, ident))
            return
        if previous is not None:
            self.conn.execute("UPDATE history SET ended_at=? WHERE id=?", (ts, previous["id"]))
        self._insert(node_id, name, target, status, ts, ts, None, initial, detail)

    def topology_changed(self, graph, ts: float):
        """Pause/removal closes monitored intervals without erasing earlier observations."""
        nodes = {node.id: node for node in graph.nodes}
        for row in self.conn.execute("SELECT * FROM history WHERE ended_at IS NULL").fetchall():
            node = nodes.get(row["node_id"])
            if node is None or (row["target"] and row["target"] not in node.addresses):
                status = "unmonitored"
            elif not node.enabled:
                status = "paused"
            else:
                continue
            self.record(row["node_id"], node.name if node else row["node_name"], row["target"],
                        status, ts, graph.settings.interval * 3)

    def since(self) -> float | None:
        return self.conn.execute("SELECT MIN(started_at) FROM history").fetchone()[0]

    @staticmethod
    def _cursor(value):
        try:
            ts, ident = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
            if not isinstance(ts, (int, float)) or not math.isfinite(ts) or not isinstance(ident, int) or ident == 0:
                raise ValueError
            return ts, ident
        except (ValueError, TypeError, UnicodeError) as exc:
            raise ValueError("Некорректная страница истории") from exc

    def query(self, *, since: float, until: float, now: float, stale_after: float,
              node_id: str | None = None, target: str | None = None, level="address",
              problems=False, cursor: str | None = None, limit=200, node_ids: list[str] | None = None) -> dict:
        if not all(math.isfinite(v) for v in (since, until, now)) or since >= until:
            raise ValueError("Начало периода должно быть раньше конца")
        where = ["started_at<=?", "COALESCE(ended_at,?)>=?"]
        params = [min(until, now), now, since]
        if node_id:
            where.append("node_id=?"); params.append(node_id)
        elif node_ids is not None:
            if not node_ids or len(node_ids) > 200 or any(len(n) > 100 for n in node_ids):
                raise ValueError("Нужен список от 1 до 200 узлов")
            where.append("node_id IN (" + ",".join("?" for _ in node_ids) + ")")
            params.extend(node_ids)
        if level == "node":
            where.append("target=''")
        else:
            where.append("target<>''")
        if target is not None:
            where.append("target=?"); params.append(target)
        if problems:
            where.append("status IN ('down','partial','error','gap','stale')")
        if cursor:
            before_ts, before_id = self._cursor(cursor)
            where.append("(started_at<? OR (started_at=? AND id<?))")
            params.extend([before_ts, before_ts, before_id])
        # A stopped collector cannot append rows. Project its unobserved tail as a gap,
        # without mutating the database or claiming that the last observed state continued.
        rows = self.conn.execute("""
            WITH observations AS (
                SELECT *, (ended_at IS NULL AND status NOT IN ('paused','unmonitored')
                           AND last_at<?) AS interrupted FROM history
            ), intervals AS (
                SELECT id,node_id,node_name,target,status,started_at,last_at,
                       CASE WHEN interrupted THEN last_at ELSE ended_at END AS ended_at,
                       initial,detail,interrupted FROM observations
                UNION ALL
                SELECT -id,node_id,node_name,target,'gap',last_at,?,NULL,0,
                       'Нет измерений после последнего замера',0 FROM observations WHERE interrupted
            )
            SELECT intervals.*, CASE WHEN interrupted THEN 'gap'
                    WHEN id > 0 AND ended_at IS NOT NULL THEN (
                        SELECT h.status FROM history h WHERE h.node_id=intervals.node_id
                        AND h.target=intervals.target AND h.started_at=intervals.ended_at
                        AND h.id>intervals.id ORDER BY h.id LIMIT 1
                    ) END AS next_status
            FROM intervals WHERE """ + " AND ".join(where)
            + " ORDER BY started_at DESC,id DESC LIMIT ?", [now - stale_after, now, *params, limit + 1],
        ).fetchall()
        items = []
        by_id = {}
        for row in rows[:limit]:
            item = dict(row)
            stale = bool(row["interrupted"])
            end = row["ended_at"] if row["ended_at"] is not None else now
            display_start = max(row["started_at"], since)
            display_end = min(end, until, now)
            item.update(stale=stale, ongoing=row["ended_at"] is None and not stale,
                        duration=max(0, end - row["started_at"]),
                        display_start=display_start, display_end=display_end,
                        display_duration=max(0, display_end - display_start), detail_changes=[])
            items.append(item)
            by_id[row["id"]] = item
        if by_id:
            ids = ",".join("?" for _ in by_id)
            # Load the baseline at the lower filter boundary and only changes in the window.
            changes = self.conn.execute(f"""SELECT history_id, observed_at, detail FROM history_detail d
                WHERE history_id IN ({ids}) AND observed_at <= ?
                AND (observed_at > ? OR observed_at = (SELECT MAX(p.observed_at)
                    FROM history_detail p WHERE p.history_id=d.history_id AND p.observed_at <= ?))
                ORDER BY history_id, observed_at""", [*by_id, min(until, now), since, since])
            for change in changes:
                item = by_id[change["history_id"]]
                ts, detail = change["observed_at"], change["detail"]
                if ts <= item["display_start"]:
                    item["detail"] = detail
                else:
                    item["detail_changes"].append({"observed_at": ts, "detail": detail})
        next_cursor = None
        if len(rows) > limit:
            last = rows[limit - 1]
            next_cursor = base64.urlsafe_b64encode(
                json.dumps([last["started_at"], last["id"]]).encode()).decode().rstrip("=")
        return {"items": items, "next_cursor": next_cursor, "recorded_since": self.since(),
                "since": since, "until": until, "server_time": now}
