"""A single bounded ICMP scheduler, independent of open browser tabs."""
from __future__ import annotations

import asyncio
from contextlib import suppress
import ipaddress
import logging
import math
import os
import re
import socket
import time

from .model import Settings, address
from .store import Store

log = logging.getLogger(__name__)


async def resolve_host(target: str, timeout: float) -> str | None:
    """Resolve separately so the shared DNS limit does not serialize slow ICMP probes."""
    if os.name == "nt":
        try:
            answers = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(
                target, None, type=socket.SOCK_DGRAM), timeout)
            return next((a[4][0] for a in answers if a[0] == socket.AF_INET), answers[0][4][0])
        except (OSError, TimeoutError, IndexError):
            return None
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "getent", "ahosts", target, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        output, _ = await asyncio.wait_for(proc.communicate(), timeout)
        ips = [str(ipaddress.ip_address(line.split()[0])) for line in output.decode().splitlines() if line.strip()]
        return next((ip for ip in ips if ":" not in ip), ips[0] if ips else None)
    except (OSError, TimeoutError, ValueError):
        return None
    finally:
        if proc is not None and proc.returncode is None:
            with suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()


async def ping(target: str, timeout: float) -> tuple[str, float | None, str]:
    target = address(target)  # defense in depth: target can never be an option or shell expression
    args = (["ping.exe", "-n", "1", "-w", str(math.ceil(timeout * 1000)), target]
            if os.name == "nt" else
            ["ping", "-n", "-c", "1", "-W", str(math.ceil(timeout)), "--", target])
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        output, _ = await asyncio.wait_for(proc.communicate(), timeout + 1)
        text = output.decode("oem" if os.name == "nt" else "utf-8", errors="replace")
        # The label is localized (time, время, Zeit, temps); the comparison and unit are stable.
        rtt = re.search(r"([=<])\s*([\d.,]+)\s*(?:ms|мс)\b", text, re.I)
        if proc.returncode == 0 and rtt:
            value = float(rtt[2].replace(",", "."))
            return "up", value / 2 if rtt[1] == "<" else value, ""
        if proc.returncode in (0, 1):
            return "down", None, "Нет ответа ICMP"
        return "error", None, "Ошибка ping или разрешения DNS"
    except TimeoutError:
        return "error", None, "Превышено время проверки ICMP/DNS"
    except OSError as exc:
        log.warning("Cannot start ICMP probe: %s", type(exc).__name__)
        return "error", None, "Не удалось запустить ping на сервере"
    finally:
        if proc is not None and proc.returncode is None:
            with suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()


def node_status(node, results: dict, now: float, stale_after: float) -> tuple[str, list[dict]]:
    items = []
    for target in node.addresses:
        sample = results.get(target)
        if not node.enabled:
            item = {"target": target, "status": "paused", "checked_at": None, "rtt_ms": None, "detail": ""}
        elif sample is None:
            item = {"target": target, "status": "unknown", "checked_at": None, "rtt_ms": None, "detail": ""}
        else:
            item = dict(sample)
            if now - sample["checked_at"] > stale_after:
                item["status"] = "stale"
        items.append(item)
    states = [item["status"] for item in items]
    if not node.enabled:
        status = "paused"
    elif not states:
        status = "unmonitored"
    elif all(s == "up" for s in states):
        status = "up"
    elif "up" in states:
        status = "partial"
    elif all(s == "down" for s in states):
        status = "down"
    elif "stale" in states:
        status = "stale"
    elif "error" in states:
        status = "error"
    else:
        status = "unknown"
    return status, items


class Monitor:
    def __init__(self, store: Store, *, probe=ping, resolver=resolve_host,
                 clock=time.time, monotonic=time.monotonic, netwatch_mail=False):
        self.store, self.probe, self.clock, self.monotonic = store, probe, clock, monotonic
        self.resolver = resolver
        self.netwatch_mail = netwatch_mail
        self.wake = asyncio.Event()
        self._interval = Settings().interval
        self.info = {"running": False, "round_started": None, "last_completed": None,
                     "last_progress": None, "polling": False,
                     "duration": 0, "last_error": "", "completed": 0, "targets": 0}

    async def round(self):
        # Probe settings (timeout/concurrency) are a snapshot for the whole round.
        # Topology membership and gap attribution are refreshed only to avoid storing
        # an in-flight result against a node/address removed by an editor.
        graph = self.store.graph()
        self._interval = graph.settings.interval
        def membership(current):
            mapping = {}
            for node in current.nodes:
                if node.enabled:
                    for target in node.addresses:
                        mapping.setdefault(target, []).append(node)
            return mapping

        members = membership(graph)
        targets = list(members)
        self.info.update(round_started=self.clock(), last_progress=self.clock(), polling=True,
                         completed=0, targets=len(targets), last_error="")
        started = self.monotonic()
        pending = iter(targets)
        dns_limit = asyncio.Semaphore(5)
        current_revision = graph.revision
        current_targets = set(targets)
        gap_after = self.stale_after(graph.settings)

        async def worker():
            nonlocal current_revision, current_targets, members, gap_after
            for target in pending:
                try:
                    ipaddress.ip_address(target)
                except ValueError:
                    # The LAN resolver is shared with other checks; bound DNS consumers separately.
                    async with dns_limit:
                        resolved = await self.resolver(target, graph.settings.timeout)
                    if resolved is None:
                        status, rtt, detail = "error", None, "Не удалось разрешить DNS-имя"
                    else:
                        status, rtt, detail = await self.probe(resolved, graph.settings.timeout)
                        detail = f"DNS → {resolved}" + (f"; {detail}" if detail else "")
                else:
                    status, rtt, detail = await self.probe(target, graph.settings.timeout)
                # A topology edit may have removed the target while ping was in flight.
                if self.store.revision() != current_revision:
                    current = self.store.graph()
                    current_revision = current.revision
                    members = membership(current)
                    current_targets = set(members)
                    gap_after = self.stale_after(current.settings)
                if target in current_targets:
                    self.store.result(target, status, self.clock(), rtt, detail,
                                      nodes=members[target], gap_after=gap_after)
                self.info["completed"] += 1
                self.info["last_progress"] = self.clock()

        tasks = [asyncio.create_task(worker()) for _ in range(min(graph.settings.concurrency, len(targets)))]
        try:
            if tasks:
                await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        current, now, results = self.store.graph(), self.clock(), self.store.results()
        self._interval = current.settings.interval
        gap_after = self.stale_after(current.settings)
        statuses = {node.id: node_status(node, results, now, gap_after)[0] for node in current.nodes}
        # A topology edit may leave a newly monitored node with samples from older rounds.
        threshold = (current.settings.netwatch_minutes
                     if self.netwatch_mail and current.revision == graph.revision else None)
        self.store.node_results(current.nodes, statuses, now, gap_after, netwatch_minutes=threshold)
        self.store.statistics.prune(now)
        self.info.update(last_completed=now, duration=self.monotonic() - started, polling=False)

    async def run(self):
        self.info["running"] = True
        try:
            while True:
                # Clear before sampling: changes during this round schedule one follow-up round.
                self.wake.clear()
                started = self.monotonic()
                try:
                    await self.round()
                except Exception:
                    self.info.update(last_error="Ошибка сборщика. Проверьте журнал сервиса.", polling=False)
                    log.exception("ICMP round failed")
                    delay = min(self._interval, 5)
                else:
                    delay = max(1, self._interval - (self.monotonic() - started))
                with suppress(TimeoutError):
                    await asyncio.wait_for(self.wake.wait(), delay)
        finally:
            self.info["running"] = False

    def stale_after(self, settings=None) -> float:
        if settings is None:
            settings = self.store.graph().settings
        return max(settings.interval * 3, self.info["duration"] * 2 + settings.timeout)

    def health(self) -> dict:
        """Readiness requires recent results or bounded progress, including the first round.

        A large round can exceed the interval while completing targets continuously.
        DNS plus ping may each consume a timeout before the first result arrives.
        """
        info, now = self.info.copy(), self.clock()
        settings = self.store.graph().settings
        progress_limit = max(settings.interval * 3, settings.timeout * 2 + 2)
        progress = info["last_progress"]
        completed = info["last_completed"]
        progress_age = None if progress is None else max(0, now - progress)
        data_age = None if completed is None else max(0, now - completed)
        alive = bool(info["running"])
        if not alive:
            status = "stopped"
        elif info["last_error"]:
            status = "error"
        elif info["polling"]:
            status = "ready" if progress_age is not None and progress_age <= progress_limit else "stalled"
        elif data_age is None:
            status = "starting"
        else:
            status = "ready" if data_age <= self.stale_after(settings) else "stale"
        return dict(info, alive=alive, ready=status == "ready", status=status,
                    progress_age=progress_age, progress_limit=progress_limit,
                    data_age=data_age, stale_after=self.stale_after(settings))

    def snapshot(self) -> dict:
        graph, results, now = self.store.graph(), self.store.results(), self.clock()
        stale_after = self.stale_after(graph.settings)
        nodes, counts = {}, {}
        for node in graph.nodes:
            status, addresses = node_status(node, results, now, stale_after)
            nodes[node.id] = {"status": status, "addresses": addresses}
            counts[status] = counts.get(status, 0) + 1
        return {"graph": graph.model_dump(), "nodes": nodes, "counts": counts,
                "monitor": self.info.copy(), "server_time": now, "stale_after": stale_after,
                "history_since": self.store.history.since(), "netwatch_mail": self.netwatch_mail}
