"""Import FPinger's indented INI format, including nested [Name] arrays and polylines.

Line endpoints in .map are coordinates, not device IDs. Preserve every polyline;
attach endpoints only when a unique icon rectangle is within 8 original pixels.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import re
from pathlib import Path

from .model import Edge, Graph, Node, Settings
from .store import Store


def sections(text: str) -> dict[str, dict]:
    data, current, nested = {}, None, None
    for line in text.splitlines():
        if match := re.fullmatch(r"\[([^]]+)\]", line):
            current = data.setdefault(match[1], {})
            nested = None
        elif current is not None and (match := re.fullmatch(r"\s+\[([^]]+)\]", line)):
            nested = current.setdefault(match[1], {})
        elif current is not None and "=" in line:
            key, value = line.strip().split("=", 1)
            (nested if nested is not None and line.startswith("  ") else current)[key] = value
    return data


COLORS = {"clRed": "#dc5252", "clLime": "#32b98a", "clGreen": "#32b98a",
          "clYellow": "#d7ad39", "clWhite": "#cbd5e1", "clBlue": "#4c8bdf",
          "clAqua": "#29adb5", "clFuchsia": "#c66bd3", "clBlack": "#64748b"}


def color(value: str) -> str:
    if value in COLORS:
        return COLORS[value]
    if re.fullmatch(r"\$[0-9a-fA-F]{8}", value):
        return "#" + value[7:9] + value[5:7] + value[3:5]  # Delphi $00BBGGRR
    return "#7894a5"


def convert(bundle: dict) -> Graph:
    raw = base64.b64decode(bundle["map"], validate=True).decode("cp1251")
    source = sections(raw)
    config = sections(bundle["config"])
    types = {value.get("ID"): value for key, value in config.items()
             if re.fullmatch(r"Device\d+", key)}
    sizes = bundle.get("image_sizes", {})
    nodes, rectangles, notes = [], {}, []
    for key, value in source.items():
        if not re.fullmatch(r"Device\d+", key):
            continue
        device_type = types.get(value.get("Group"), {})
        width, height = sizes.get(device_type.get("MainImage", ""), [32, 32])
        left, top = float(value.get("Left", 0)), float(value.get("Top", 0))
        label = value.get("Name", {})
        if isinstance(label, dict):
            try:
                count = int(label.get("Count", 0))
                if count < 0 or count > len(label):
                    raise ValueError("Count exceeds the available label fields")
                lines = [label.get(f"Item{i}", "") for i in range(count)]
            except ValueError:
                notes.append(f"{key}: некорректный Count в Name; имя заменено адресом устройства.")
                lines = []
        else:
            lines = [label]
        primary = value.get("Address", "").strip()
        extra = re.split(r"[;\s,]+", value.get("Addresses", "").strip())
        targets = [v for v in [primary, *extra] if v]
        name = (lines[0] if lines else primary or key).replace("%Address", primary)
        ident = "fp-" + value["ID"]
        kind = device_type.get("Name", "computer")
        nodes.append(Node(id=ident, name=name or key, addresses=targets,
                          x=left + width / 2, y=top + height / 2, kind=kind,
                          notes="\n".join(line.replace("%Address", primary) for line in lines[1:])))
        rectangles[ident] = (left, top, left + width, top + height)

    def endpoint(point):
        ranked = sorted((math.hypot(max(l - point[0], 0, point[0] - r),
                                   max(t - point[1], 0, point[1] - b)), ident)
                        for ident, (l, t, r, b) in rectangles.items())
        if ranked and ranked[0][0] <= 8 and (len(ranked) == 1 or ranked[1][0] - ranked[0][0] > 1):
            return ranked[0][1]
        return None

    edges = []
    for key, value in source.items():
        if not re.fullmatch(r"Line\d+", key):
            continue
        points = [(float(x), float(y)) for x, y in re.findall(
            r"\[(-?\d+(?:\.\d+)?);(-?\d+(?:\.\d+)?)\]", value.get("Nodes", ""))]
        if len(points) < 2:
            raise ValueError(f"{key}: не удалось прочитать линию")
        start, end = endpoint(points[0]), endpoint(points[-1])
        if not start or not end:
            notes.append(f"{key}: исходная линия сохранена; привязку концов нужно проверить в редакторе.")
        edges.append(Edge(id="fp-" + key.lower(), from_id=start, to_id=end, points=points,
                          color=color(value.get("Color", ""))))
    cfg = config.get("Config", {})
    return Graph(name="Moscow", nodes=nodes, edges=edges,
                 settings=Settings(interval=float(cfg.get("PingPeriod", 15)),
                                   timeout=float(cfg.get("PingTimeOut", 3))),
                 source=bundle.get("source", "Friendly Pinger"), import_notes=notes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="Sanitized Friendly Pinger export JSON")
    parser.add_argument("--db", type=Path, required=True)
    args = parser.parse_args()
    graph = convert(json.loads(args.bundle.read_text(encoding="utf-8-sig")))
    store = Store(args.db)
    try:
        old = store.graph()
        if old.nodes or old.edges or old.revision:
            parser.error("Импорт разрешён только в новую пустую БД; существующая карта не заменена")
        store.save(graph)
    finally:
        store.close()
    print(json.dumps({"nodes": len(graph.nodes), "edges": len(graph.edges),
                      "addresses": sum(len(n.addresses) for n in graph.nodes),
                      "import_notes": graph.import_notes}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
