"""Bounded, cancellable diagnostics for addresses already present in the map."""
from __future__ import annotations

import asyncio
from contextlib import suppress
import json
import os

from anyio import CancelScope

from .model import address


def command(kind: str, target: str) -> list[str]:
    target = address(target)
    if kind == "ping":
        return (["ping.exe", "-n", "10", "-w", "1000", target] if os.name == "nt" else
                ["ping", "-n", "-c", "10", "-i", "1", "-W", "1", "--", target])
    if kind == "trace":
        return (["tracert.exe", "-d", "-h", "20", "-w", "1000", target] if os.name == "nt" else
                ["stdbuf", "-oL", "traceroute", "-n", "-m", "20", "-q", "1", "-w", "1", "--", target])
    raise ValueError("Неизвестная команда")


def event(**data) -> bytes:
    return (json.dumps(data, ensure_ascii=False) + "\n").encode("utf-8")


class Diagnostics:
    def __init__(self, *, spawn=None, duration=45):
        self.spawn = spawn or asyncio.create_subprocess_exec
        self.duration = duration
        self.active = 0

    def reserve(self) -> bool:
        # Called on the app's event loop, before returning a streaming response.
        if self.active >= 3:
            return False
        self.active += 1
        return True

    async def stream(self, kind: str, target: str):
        proc = None
        try:
            yield event(type="start", command=kind, target=target)
            async with asyncio.timeout(self.duration):
                proc = await self.spawn(*command(kind, target), stdout=asyncio.subprocess.PIPE,
                                        stderr=asyncio.subprocess.STDOUT,
                                        **({"env": {**os.environ, "LC_ALL": "C"}} if os.name != "nt" else {}))
                # Output is streamed as it arrives; the browser renders it as plain text.
                while line := await proc.stdout.readline():
                    yield event(type="line", text=line.decode(
                        "oem" if os.name == "nt" else "utf-8", errors="replace").rstrip("\r\n"))
                code = await proc.wait()
                yield event(type="done", returncode=code)
        except TimeoutError:
            yield event(type="error", text=f"Остановлено по лимиту {self.duration} с")
        except OSError:
            yield event(type="error", text="Не удалось запустить команду на сервере. Проверьте установку ping/traceroute/coreutils.")
        finally:
            try:
                # Starlette cancels the streaming task when the browser disconnects.
                # Shield reaping from its cancellation scope as well as killing the process.
                with CancelScope(shield=True):
                    if proc is not None and proc.returncode is None:
                        with suppress(ProcessLookupError):
                            proc.kill()
                        await proc.wait()
            finally:
                self.active -= 1
