"""The editable topology. Addresses are list entries, never numbered fixed slots."""
from __future__ import annotations

import ipaddress
import math
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Channel = Literal["lan", "sites-vpn", "openvpn", "wg-my", "wg-work", "wan", "internet"]


def address(value: str) -> str:
    value = value.strip()
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        pass
    value = value.rstrip(".").encode("idna").decode("ascii").lower()
    if len(value) > 253 or not value or any(
        not re.fullmatch(r"[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?", part)
        for part in value.split(".")
    ):
        raise ValueError("Нужен IP-адрес или DNS-имя без порта, URL и пробелов")
    if re.fullmatch(r"[0-9.]+", value):
        raise ValueError("Некорректный IP-адрес")
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Node(StrictModel):
    id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    name: str = Field(min_length=1, max_length=500)
    addresses: list[str] = Field(default_factory=list)
    address_comments: dict[str, str] = Field(default_factory=dict)
    site: str = Field(default="", max_length=100)
    address_channels: dict[str, Channel] = Field(default_factory=dict)
    x: float = Field(ge=-1e7, le=1e7)
    y: float = Field(ge=-1e7, le=1e7)
    kind: str = Field(default="computer", max_length=100)
    notes: str = Field(default="", max_length=10000)
    enabled: bool = True
    allow_offline: bool = False
    netwatch: bool = True

    @property
    def netwatch_active(self) -> bool:
        return self.netwatch and self.enabled and not self.allow_offline and bool(self.addresses)

    @field_validator("addresses")
    @classmethod
    def clean_addresses(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(address(value) for value in values))

    @field_validator("site")
    @classmethod
    def clean_site(cls, value: str) -> str:
        return value.strip()

    @field_validator("address_channels")
    @classmethod
    def clean_channels(cls, values: dict[str, Channel]) -> dict[str, Channel]:
        return {address(target): channel for target, channel in values.items()}

    @field_validator("address_comments")
    @classmethod
    def clean_comments(cls, values: dict[str, str]) -> dict[str, str]:
        result = {}
        for target, comment in values.items():
            if len(comment) > 1000:
                raise ValueError("Комментарий к адресу — не более 1000 символов")
            result[address(target)] = comment.strip()
        return result

    @model_validator(mode="after")
    def current_address_metadata(self):
        self.address_comments = {a: c for a, c in self.address_comments.items() if a in self.addresses}
        self.address_channels = {a: c for a, c in self.address_channels.items() if a in self.addresses}
        return self


class Edge(StrictModel):
    id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    from_id: str | None = None
    to_id: str | None = None
    points: list[tuple[float, float]] = Field(default_factory=list)
    color: str = Field(default="#7894a5", pattern=r"^#[0-9a-fA-F]{6}$")
    label: str = Field(default="", max_length=500)

    @field_validator("points")
    @classmethod
    def finite_points(cls, points):
        if any(not math.isfinite(v) or abs(v) > 1e7 for point in points for v in point):
            raise ValueError("Некорректные координаты линии")
        return points


class Settings(StrictModel):
    interval: float = Field(default=15, ge=5, le=3600)
    timeout: float = Field(default=3, ge=0.2, le=30)
    concurrency: int = Field(default=32, ge=1, le=64)
    netwatch_recipient: str = Field(default="", max_length=254)
    netwatch_minutes: int = Field(default=10, ge=1, strict=True)

    @field_validator("netwatch_recipient")
    @classmethod
    def single_mailbox(cls, value: str) -> str:
        value = value.strip(" \t")
        if not value:
            return value
        local, _, domain = value.rpartition("@")
        valid_local = len(local) <= 64 and all(
            re.fullmatch(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+", part) for part in local.split("."))
        valid_domain = all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                           for label in domain.split("."))
        if not (valid_local and valid_domain):
            raise ValueError("Укажите один почтовый адрес без имени и списка получателей")
        return value


class Graph(StrictModel):
    revision: int = Field(default=0, ge=0)
    name: str = Field(default="Карта сети", min_length=1, max_length=200)
    nodes: list[Node] = Field(default_factory=list)
    edges: list[Edge] = Field(default_factory=list)
    settings: Settings = Field(default_factory=Settings)
    source: str = Field(default="", max_length=1000)
    import_notes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_links(self):
        ids = {node.id for node in self.nodes}
        if len(ids) != len(self.nodes) or len({e.id for e in self.edges}) != len(self.edges):
            raise ValueError("Повторяющиеся идентификаторы узлов или связей")
        for edge in self.edges:
            if any(n is not None and n not in ids for n in (edge.from_id, edge.to_id)):
                raise ValueError("Связь ссылается на отсутствующий узел")
            if len(edge.points) < 2 and not (edge.from_id and edge.to_id):
                raise ValueError("У линии нужны два узла или исходные координаты")
        return self


def replacement_preview(current: Graph, proposed: Graph) -> dict:
    def changes(before, after, describe):
        added = [describe(after[id_], proposed) for id_ in after.keys() - before.keys()]
        removed = [describe(before[id_], current) for id_ in before.keys() - after.keys()]
        changed = [{"before": describe(before[id_], current),
                    "after": describe(after[id_], proposed)}
                   for id_ in sorted(before.keys() & after.keys()) if before[id_] != after[id_]]
        return {"added": sorted(added, key=lambda row: row["id"]),
                "removed": sorted(removed, key=lambda row: row["id"]), "changed": changed}

    def node_description(node, graph):
        return node.model_dump(include={"id", "name", "addresses", "enabled", "allow_offline", "netwatch",
                                        "site", "address_channels"})

    current_names, proposed_names = ({node.id: node.name for node in graph.nodes}
                                     for graph in (current, proposed))

    def edge_description(edge, graph):
        names = current_names if graph is current else proposed_names
        return {"id": edge.id, "label": edge.label, "from": names.get(edge.from_id),
                "to": names.get(edge.to_id), "from_id": edge.from_id, "to_id": edge.to_id,
                "color": edge.color}

    current_targets = {target for node in current.nodes if node.enabled for target in node.addresses}
    proposed_targets = {target for node in proposed.nodes if node.enabled for target in node.addresses}
    current_settings, proposed_settings = current.settings.model_dump(), proposed.settings.model_dump()
    return {
        "revision": current.revision,
        "nodes": changes({n.id: n for n in current.nodes}, {n.id: n for n in proposed.nodes}, node_description),
        "edges": changes({e.id: e for e in current.edges}, {e.id: e for e in proposed.edges}, edge_description),
        "settings": {key: {"before": value, "after": proposed_settings[key]}
                     for key, value in current_settings.items() if value != proposed_settings[key]},
        "stopped_targets": sorted(current_targets - proposed_targets),
    }
