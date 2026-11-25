"""Describe existing addresses from the network registry without adding/removing targets."""
from __future__ import annotations

import argparse
import ipaddress
import json
from pathlib import Path

from .inventory import IP_FIELDS, ip_value, match, records, values
from .model import Graph


def describe(target: str, entry: dict, network: dict) -> str:
    try:
        ip = ipaddress.ip_address(target)
    except ValueError:
        if target in values(entry.get("wan_domain")):
            return "Публичное DNS-имя (WAN)"
        return "Локальное DNS-имя узла" if "." not in target else "DNS-имя узла"
    for name, interface in (entry.get("interfaces") or {}).items():
        if not isinstance(interface, dict):
            continue
        if any(ip_value(v) == target for field in IP_FIELDS for v in values(interface.get(field))):
            purpose = interface.get("role") or interface.get("type") or "Сетевой интерфейс"
            kind = str(purpose).lower()
            if kind == "ethernet" and ip.is_global:
                purpose = f"Публичный IPv{ip.version}"
            elif kind == "bridge":
                purpose = "Локальная сеть (bridge)"
            elif kind == "wireguard":
                purpose = "WireGuard"
            return f"{purpose} · {name}"[:1000]
    for vpn in values(entry.get("vpn")):
        if isinstance(vpn, dict) and any(ip_value(v) == target for field in IP_FIELDS
                                        for v in values(vpn.get(field))):
            purpose = vpn.get("type") or vpn.get("protocol") or "VPN"
            return f"{purpose} · адрес VPN-клиента"
    for site in (network.get("sites") or {}).values():
        if not isinstance(site, dict):
            continue
        if target == site.get("wan_gateway"):
            return f"Шлюз провайдера · {site.get('wan_provider', '')} · {site.get('name', '')}"
        if target == site.get("wan_ip"):
            return f"WAN · {site.get('wan_provider', '')} · {site.get('name', '')}"
        for subnet in site.get("subnets") or []:
            try:
                inside = ip in ipaddress.ip_network(subnet)
            except ValueError:
                continue
            if inside:
                prefix = "Основной адрес" if ip_value(entry.get("ip")) == target else "Адрес сети"
                return f"{prefix} · {site.get('name', subnet)} · {subnet}"
    if ip.is_global:
        return "Публичный IP-адрес узла"
    if ip in ipaddress.ip_network("100.64.0.0/10"):
        return "Адрес в сети провайдера CG-NAT (не публичный)"
    if any(ip_value(v) == target for field in ("vpn_ip", "alt_vpn_ips")
           for v in values(entry.get(field))):
        return "VPN-адрес из сетевого реестра"
    if ip in ipaddress.ip_network("10.0.0.0/8"):
        return "Частный адрес 10.0.0.0/8; назначение интерфейса в реестре не описано"
    return "Частный IP-адрес; назначение интерфейса в реестре не описано"


def annotate(graph: Graph, network: dict) -> tuple[Graph, dict]:
    updated = graph.model_copy(deep=True)
    candidates, changes = records(network), []
    for node in updated.nodes:
        record = match(node, candidates)
        entry = network[record["section"]][record["key"]] if record else {}
        for target in node.addresses:
            if node.address_comments.get(target):
                continue
            comment = describe(target, entry, network)
            node.address_comments[target] = comment
            changes.append({"node_id": node.id, "node": node.name, "address": target,
                            "comment": comment,
                            "record": f"{record['section']}/{record['key']}" if record else None})
    return Graph.model_validate(updated.model_dump()), {"added": len(changes), "changes": changes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", type=Path, required=True)
    parser.add_argument("--map", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    import yaml
    network = yaml.safe_load(args.network.read_text(encoding="utf-8-sig"))
    graph = Graph.model_validate_json(args.map.read_text(encoding="utf-8-sig"))
    updated, report = annotate(graph, network)
    args.output.write_text(updated.model_dump_json(indent=2), encoding="utf-8")
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Nodes: {len(updated.nodes)}, added address comments: {report['added']}")


if __name__ == "__main__":
    main()
