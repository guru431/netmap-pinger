"""LAN/VPN web application. Run one worker: the ICMP scheduler lives in its lifespan."""
from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager, suppress
from functools import partial
import json
import logging
import os
from pathlib import Path
import subprocess
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field

from .model import Channel, Graph, replacement_preview
from .diagnostics import Diagnostics
from .monitor import Monitor
from .netwatch import send_email
from .password import PasswordFile
from .store import Conflict, Store

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT.parent / "var" / "netmap.sqlite"
MAX_BODY_BYTES = 16 * 1024 * 1024
LOG = logging.getLogger(__name__)


def password_bytes(value: object) -> bytes:
    if not isinstance(value, str) or not value or any(ch in value for ch in "\x00\r\n"):
        raise ValueError
    encoded = value.encode("utf-8")
    if len(encoded) > 72:
        raise ValueError
    return encoded


class DiagnosticRequest(BaseModel):
    node_id: str = Field(min_length=1, max_length=100)
    target: str = Field(min_length=1, max_length=253)
    command: Literal["ping", "trace"]


class BodyLimit:
    """Bound bytes before JSON parsing, including requests without Content-Length."""

    def __init__(self, app, limit=MAX_BODY_BYTES):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in {"GET", "HEAD", "OPTIONS"}:
            return await self.app(scope, receive, send)
        consumed = 0

        async def limited_receive():
            nonlocal consumed
            message = await receive()
            if message["type"] == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > self.limit:
                    raise HTTPException(413, "Размер карты превышает допустимый объём запроса (16 МБ)")
            return message

        await self.app(scope, limited_receive, send)


def create_app(db_path=DEFAULT_DB, *, monitoring=True, probe=None, body_limit=MAX_BODY_BYTES,
               diagnostics=None) -> FastAPI:
    password_path = os.environ.get("NETMAP_PASSWORD_FILE")
    password_file = PasswordFile(Path(password_path)) if password_path else None

    @asynccontextmanager
    async def lifespan(app):
        smtp_host = os.environ.get("NETMAP_SMTP_HOST")
        sender = os.environ.get("NETMAP_SMTP_SENDER")
        password = os.environ.get("NETMAP_SMTP_PASSWORD")
        mailer = None
        if monitoring and smtp_host and sender and password:
            port = int(os.environ.get("NETMAP_SMTP_PORT", "587"))
            if not 1 <= port <= 65535:
                raise ValueError("NETMAP_SMTP_PORT must be between 1 and 65535")
            mailer = partial(send_email, host=smtp_host, sender=sender, password=password,
                             port=port)
        store = Store(db_path)
        monitor = Monitor(store, netwatch_mail=mailer is not None, **({"probe": probe} if probe else {}))
        app.state.store, app.state.monitor = store, monitor
        app.state.diagnostics = diagnostics or Diagnostics()
        tasks = [asyncio.create_task(monitor.run())] if monitoring else []
        if mailer is not None:
            tasks.append(asyncio.create_task(store.netwatch.deliver(
                mailer, lambda: store.graph().settings.netwatch_recipient,
            )))
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            try:
                with suppress(asyncio.CancelledError):
                    await asyncio.gather(*tasks)
            finally:
                store.close()

    app = FastAPI(title="Карта сети", lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=None)
    hosts = os.environ.get("NETMAP_HOSTS", "127.0.0.1,localhost").split(",")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[h.strip() for h in hosts])
    app.add_middleware(BodyLimit, limit=body_limit)

    @app.middleware("http")
    async def browser_boundary(request: Request, call_next):
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            try:
                origin_url = urlsplit(origin) if origin else None
            except ValueError:
                return JSONResponse({"detail": "Некорректный Origin"}, status_code=403)
            if (request.headers.get("x-netmap-request") != "1"
                    or request.headers.get("sec-fetch-site") == "cross-site"
                    or (origin_url and (origin_url.netloc != request.headers.get("host")
                                        or origin_url.scheme != request.url.scheme))):
                return JSONResponse({"detail": "Изменения разрешены только из этой веб-карты"}, status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        return response

    @app.get("/")
    async def index():
        return FileResponse(ROOT / "static" / "index.html")

    @app.get("/api/state")
    async def state(request: Request):
        snapshot = request.app.state.monitor.snapshot()
        snapshot["password_change"] = password_file is not None and request.url.scheme == "https"
        return snapshot

    @app.post("/api/password")
    async def change_password(request: Request):
        if password_file is None:
            raise HTTPException(404, "Смена пароля недоступна")
        if (request.url.scheme != "https"
                or request.headers.get("origin") != f"https://{request.headers.get('host')}"):
            raise HTTPException(403, "Смена пароля доступна только из настроек Netmap по HTTPS")
        if request.headers.get("content-type", "").partition(";")[0].strip().lower() != "application/json":
            raise HTTPException(415, "Откройте форму смены пароля в настройках Netmap")

        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > 4096:
                raise HTTPException(413, "Запрос смены пароля слишком большой")
            body.extend(chunk)
        try:
            data = json.loads(body)
            if not isinstance(data, dict):
                raise ValueError
            current = password_bytes(data.get("current"))
            replacement = password_bytes(data.get("replacement"))
        except (ValueError, RecursionError):
            raise HTTPException(400, "Пароль должен занимать до 72 байт и не содержать переносов строк") from None
        if len(data["replacement"]) < 12 or replacement == current:
            raise HTTPException(400, "Введите другой пароль длиной не менее 12 символов")
        try:
            changed = await asyncio.to_thread(password_file.change, current, replacement)
        except (OSError, subprocess.SubprocessError):
            LOG.error("Could not update the Netmap password file")
            raise HTTPException(503, "Не удалось сохранить пароль. Повторите попытку позже") from None
        if not changed:
            raise HTTPException(400, "Текущий пароль неверен")
        return {"changed": True}

    @app.get("/api/health")
    async def health(request: Request):
        monitor = request.app.state.monitor
        info = monitor.health()
        return JSONResponse(info, status_code=200 if info["ready"] else 503)

    @app.get("/api/history")
    async def history(request: Request, since: float | None = None, until: float | None = None,
                      node_id: str | None = Query(None, max_length=100),
                      node_ids: list[str] | None = Query(None, max_length=200),
                      target: str | None = Query(None, max_length=253),
                      level: str = Query("address", pattern="^(node|address)$"),
                      problems: bool = False, cursor: str | None = Query(None, max_length=200),
                      limit: int = Query(200, ge=1, le=500)):
        monitor = request.app.state.monitor
        now = monitor.clock()
        end = until if until is not None else now
        start = since if since is not None else end - 86400
        try:
            return request.app.state.store.history.query(
                since=start, until=end, now=now, stale_after=monitor.stale_after(),
                node_id=node_id, node_ids=node_ids, target=target, level=level, problems=problems,
                cursor=cursor, limit=limit)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/statistics")
    async def statistics(request: Request, period: Literal["3h", "1d", "1w", "1m", "1y"] = "3h",
                         node_id: str | None = Query(None, max_length=100),
                         target: str | None = Query(None, max_length=253),
                         site: str | None = Query(None, max_length=100),
                         channel: Channel | None = None, page: int = Query(1, ge=1, le=1000000)):
        store = request.app.state.store
        return store.statistics.query(store.graph(), period=period, now=request.app.state.monitor.clock(),
                                      node_id=node_id, target=target, site=site, channel=channel, page=page)

    @app.post("/api/map/preview")
    async def preview(graph: Graph, request: Request):
        current = request.app.state.store.graph()
        if graph.revision != current.revision:
            raise HTTPException(409, "Карта изменилась. Выберите JSON-копию заново.")
        return replacement_preview(current, graph)

    @app.put("/api/map")
    async def save(graph: Graph, request: Request):
        try:
            saved = request.app.state.store.save(graph)
        except Conflict as exc:
            raise HTTPException(409, str(exc)) from exc
        request.app.state.monitor.wake.set()
        return saved.model_dump()

    @app.post("/api/poll")
    async def poll(request: Request):
        request.app.state.monitor.wake.set()
        return {"scheduled": True}

    @app.post("/api/diagnostics")
    async def diagnostic(body: DiagnosticRequest, request: Request):
        node = next((n for n in request.app.state.store.graph().nodes if n.id == body.node_id), None)
        if node is None or body.target not in node.addresses:
            raise HTTPException(404, "Адрес не найден у выбранного узла")
        runner = request.app.state.diagnostics
        if not runner.reserve():
            raise HTTPException(429, "Уже выполняются три команды. Дождитесь завершения.")
        return StreamingResponse(runner.stream(body.command, body.target),
                                 media_type="application/x-ndjson",
                                 headers={"X-Accel-Buffering": "no"})

    @app.get("/api/export")
    async def export(request: Request):
        graph = request.app.state.store.graph()
        return Response(json.dumps(graph.model_dump(), ensure_ascii=False, indent=2),
                        media_type="application/json",
                        headers={"Content-Disposition": 'attachment; filename="network-map.json"'})

    app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("NETMAP_DB", DEFAULT_DB)))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--root-path", default="")
    parser.add_argument("--fd", type=int, help="Pre-bound Unix socket from systemd")
    args = parser.parse_args()
    import uvicorn
    # The production socket is accessible to Apache, which sets X-Forwarded-Proto.
    trusted_proxy = "*" if args.fd is not None else "127.0.0.1"
    uvicorn.run(create_app(args.db), host=args.host, port=args.port, fd=args.fd,
                root_path=args.root_path, proxy_headers=True, forwarded_allow_ips=trusted_proxy)


if __name__ == "__main__":
    main()
