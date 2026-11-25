"""Browser authentication and administrator endpoints."""
from __future__ import annotations

import asyncio
from ipaddress import ip_address
import sqlite3
import time
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Path, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field, SecretStr, StringConstraints

from .accounts import FAKE_HASH, LOGIN_PATTERN, SESSION_AGE, hash_password, password_bytes, verify_password

COOKIE = "netmap_session"
MAX_ID = 2**63 - 1
Username = Annotated[str, StringConstraints(pattern=LOGIN_PATTERN)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Identifier = Annotated[int, Path(ge=1, le=MAX_ID)]
LEVELS = {1: "view", 2: "edit"}


class AccountRequest(BaseModel):
    username: Username
    password: SecretStr


class PasswordRequest(BaseModel):
    current: SecretStr
    replacement: SecretStr


class NamedRequest(BaseModel):
    name: Name


class MapRequest(NamedRequest):
    personal: bool = True


class MembershipRequest(BaseModel):
    member: bool


class GrantRequest(BaseModel):
    kind: Literal["user", "group"]
    principal_id: int = Field(ge=1, le=MAX_ID)
    access: Literal["view", "edit"] | None


class PrivateValidationRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def validated(request):
            try:
                return await handler(request)
            except RequestValidationError:
                return JSONResponse({"detail": "Проверьте значения полей"}, status_code=422)

        return validated


router = APIRouter(prefix="/api", route_class=PrivateValidationRoute)


class LoginAttempts:
    """Bound password checks per address and bound the size of the counter table."""

    def __init__(self):
        self.window = 0
        self.counts = {}

    def allow(self, address):
        now = time.monotonic()
        if now >= self.window:
            self.window = now + 60
            self.counts.clear()
        if len(self.counts) >= 2048 and address not in self.counts:
            return False
        count = self.counts.get(address, 0)
        if count >= 10:
            return False
        self.counts[address] = count + 1
        return True


def get_accounts(request):
    if not request.app.state.accounts_mode:
        raise HTTPException(404, "Учётные записи не включены")
    return request.app.state.accounts


def require_transport(request):
    if request.url.scheme == "https":
        return
    try:
        local = request.client and ip_address(request.client.host).is_loopback
    except ValueError:
        local = False
    if not local or request.url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(403, "Вход доступен по HTTPS или с локального компьютера")


def require_user(request):
    accounts = get_accounts(request)
    require_transport(request)
    user = accounts.session_user(request.cookies.get(COOKIE), time.time())
    if user is None:
        raise HTTPException(401, "Войдите в Netmap Pinger")
    return user


def require_admin(request):
    if not require_user(request)["admin"]:
        raise HTTPException(403, "Требуются права администратора")
    return request.app.state.accounts


def cookie_path(request):
    return (request.scope.get("root_path", "").rstrip("/") or "") + "/"


def clear_session(request, response):
    response.delete_cookie(COOKIE, path=cookie_path(request), httponly=True,
                           secure=request.url.scheme == "https", samesite="lax")
    return response


def valid_password(value, *, new=False):
    try:
        return password_bytes(value.get_secret_value(), new=new)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@router.post("/login")
async def login(body: AccountRequest, request: Request):
    accounts = get_accounts(request)
    require_transport(request)
    password = valid_password(body.password)
    client = request.client.host if request.client else "local"
    if not request.app.state.login_attempts.allow(client):
        raise HTTPException(429, "Слишком много попыток входа. Повторите через минуту.")
    user = accounts.user(body.username)
    async with request.app.state.password_workers:
        verified = await asyncio.to_thread(verify_password, password, user["password_hash"] if user else FAKE_HASH)
    token = accounts.start_session(user, time.time()) if user and verified else None
    if token is None:
        raise HTTPException(401, "Неверный логин или пароль")
    accounts.end_session(request.cookies.get(COOKIE))
    response = JSONResponse({"signed_in": True})
    response.set_cookie(COOKIE, token, max_age=SESSION_AGE, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", path=cookie_path(request))
    return response


@router.post("/logout")
async def logout(request: Request):
    accounts = get_accounts(request)
    require_transport(request)
    accounts.end_session(request.cookies.get(COOKIE))
    return clear_session(request, JSONResponse({"signed_out": True}))


@router.post("/account/password")
async def change_password(body: PasswordRequest, request: Request):
    user = require_user(request)
    current = valid_password(body.current)
    replacement = valid_password(body.replacement, new=True)
    if replacement == current:
        raise HTTPException(400, "Введите другой пароль длиной не менее 12 символов")
    async with request.app.state.password_workers:
        verified = await asyncio.to_thread(verify_password, current, user["password_hash"])
        if not verified:
            raise HTTPException(400, "Текущий пароль неверен")
        digest = await asyncio.to_thread(hash_password, replacement)
    if not request.app.state.accounts.change_password(user, digest):
        raise HTTPException(409, "Пароль уже изменён. Войдите снова.")
    return clear_session(request, JSONResponse({"changed": True}))


@router.get("/maps")
async def list_maps(request: Request):
    user = require_user(request)
    return {"maps": [dict(row) | {"access": LEVELS[row["access"]], "personal": bool(row["personal"])}
                     for row in request.app.state.accounts.map_access(user, names=True)]}


@router.post("/maps", status_code=201)
async def create_map(body: MapRequest, request: Request):
    user = require_user(request)
    if not body.personal and not user["admin"]:
        raise HTTPException(403, "Требуются права администратора")
    map_id = request.app.state.accounts.create_map(body.name, user["id"] if body.personal else None)
    request.app.state.start_monitor(map_id)
    return {"id": map_id}


@router.get("/admin/directory")
async def directory(request: Request):
    return require_admin(request).directory()


@router.post("/admin/users", status_code=201)
async def create_user(body: AccountRequest, request: Request):
    require_admin(request)
    password = valid_password(body.password, new=True)
    async with request.app.state.password_workers:
        digest = await asyncio.to_thread(hash_password, password)
    # A password change could have revoked the initiating session during hashing.
    accounts = require_admin(request)
    try:
        return {"id": accounts.create_user(body.username, digest)}
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Такой логин уже существует") from None


@router.post("/admin/groups", status_code=201)
async def create_group(body: NamedRequest, request: Request):
    accounts = require_admin(request)
    try:
        return {"id": accounts.create_group(body.name)}
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Такая группа уже существует") from None


@router.put("/admin/groups/{group_id}/members/{user_id}")
async def membership(group_id: Identifier, user_id: Identifier, body: MembershipRequest, request: Request):
    accounts = require_admin(request)
    try:
        accounts.membership(group_id, user_id, body.member)
    except sqlite3.IntegrityError:
        raise HTTPException(404, "Пользователь или группа не найдены") from None
    return {"member": body.member}


@router.get("/admin/maps/{map_id}/access")
async def list_grants(map_id: Identifier, request: Request):
    accounts = require_admin(request)
    if not accounts.shared(map_id):
        raise HTTPException(404, "Карта не найдена")
    return {"grants": [row | {"access": LEVELS[row["access"]]} for row in accounts.grants(map_id)]}


@router.put("/admin/maps/{map_id}/access")
async def grant(map_id: Identifier, body: GrantRequest, request: Request):
    accounts = require_admin(request)
    if not accounts.shared(map_id):
        raise HTTPException(404, "Карта не найдена")
    try:
        accounts.grant(map_id, body.kind, body.principal_id, {"view": 1, "edit": 2, None: None}[body.access])
    except sqlite3.IntegrityError:
        raise HTTPException(404, "Пользователь или группа не найдены") from None
    return {"access": body.access}
