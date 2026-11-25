"""Track confirmed node outages and deliver their email notifications in order."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import make_msgid
import logging
import smtplib
import ssl

from .model import Graph, Node

RETRY_SECONDS = 60
MSK = timezone(timedelta(hours=3))
log = logging.getLogger(__name__)


def send_email(message_id: str, subject: str, body: str, *, recipient: str,
               host: str, port: int, sender: str, password: str):
    message = EmailMessage()
    message["From"] = sender
    message["To"] = recipient
    message["Message-ID"] = message_id
    message["Subject"] = subject
    message.set_content(body)
    client = smtplib.SMTP(host, port, timeout=10)
    try:
        client.starttls(context=ssl.create_default_context())
        client.login(sender, password)
        client.send_message(message)
    finally:
        client.close()


class Netwatch:
    def __init__(self, conn):
        self.conn = conn
        self.queued = asyncio.Event()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS netwatch_outages (
                node_id TEXT PRIMARY KEY, started_at REAL NOT NULL, last_down_at REAL NOT NULL,
                announced INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS netwatch_outbox (
                id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL
            );
        """)

    def topology_changed(self, previous: Graph, current: Graph):
        tracked = {node.id: set(node.addresses) for node in current.nodes if node.netwatch_active}
        self.conn.executemany("DELETE FROM netwatch_outages WHERE node_id=?", (
            (node.id,) for node in previous.nodes
            if node.netwatch_active and tracked.get(node.id) != set(node.addresses)
        ))

    def observe(self, node: Node, status: str, now: float, gap_after: float, *, threshold_minutes: int):
        """Update the episode and outbox in the same transaction as the observation."""
        episode = self.conn.execute("SELECT * FROM netwatch_outages WHERE node_id=?", (node.id,)).fetchone()
        if episode is not None and now <= episode["last_down_at"]:
            return
        announced = episode is not None and episode["announced"]
        if status != "down":
            if announced and status in {"up", "partial"}:
                self.enqueue(node, episode["started_at"], now)
            elif episode is None or announced:
                return
            self.conn.execute("DELETE FROM netwatch_outages WHERE node_id=?", (node.id,))
            return

        started = episode["started_at"] if episode is not None else now
        if not announced and episode is not None and now - episode["last_down_at"] > gap_after:
            started = now
        if not announced and now - started >= threshold_minutes * 60:
            self.enqueue(node, started, now, threshold_minutes=threshold_minutes)
            announced = True
        self.conn.execute("""INSERT INTO netwatch_outages VALUES (?, ?, ?, ?)
            ON CONFLICT(node_id) DO UPDATE SET started_at=excluded.started_at,
                last_down_at=excluded.last_down_at, announced=excluded.announced""",
                          (node.id, started, now, int(announced)))

    def enqueue(self, node: Node, started: float, now: float, *, threshold_minutes: int | None = None):
        name = " ".join(node.name.split()) or node.id
        event = "снова доступен" if threshold_minutes is None else f"недоступен {threshold_minutes} мин."
        start_time, event_time = (datetime.fromtimestamp(ts, MSK).strftime("%d.%m.%Y %H:%M:%S")
                                  for ts in (started, now))
        self.conn.execute("INSERT INTO netwatch_outbox (message_id, subject, body) VALUES (?, ?, ?)", (
            make_msgid(domain="netmap.invalid"), f"Netwatch · {name} · {event}",
            f"Узел: {name}\nОсновной адрес: {node.addresses[0]}\n"
            f"Первый замер без ответа: {start_time} МСК\nСобытие: {event_time} МСК\n",
        ))
        self.queued.set()

    async def deliver(self, send, get_recipient):
        """Retries keep the oldest message in SQLite and never delay the ICMP scheduler."""
        while True:
            self.queued.clear()
            pending = self.conn.execute("SELECT * FROM netwatch_outbox ORDER BY id LIMIT 1").fetchone()
            if pending is None:
                await self.queued.wait()
                continue
            recipient = get_recipient()
            if not recipient:
                await asyncio.sleep(RETRY_SECONDS)
                continue
            try:
                await asyncio.to_thread(send, pending["message_id"], pending["subject"], pending["body"],
                                        recipient=recipient)
            except OSError as exc:
                log.warning("Netwatch mail delivery failed (%s). Will retry in %ds.",
                            type(exc).__name__, RETRY_SECONDS)
                await asyncio.sleep(RETRY_SECONDS)
                continue
            with self.conn:
                self.conn.execute("DELETE FROM netwatch_outbox WHERE id=?", (pending["id"],))
