"""Enrich existing map nodes from declared host addresses and forward-confirmed DNS names.

This reads an inventory; it does not discover hosts or change network/network.yaml.
Shared gateway/NAT/service addresses never establish a device's identity.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import re
from pathlib import Path

from .model import Graph, address

SECTIONS = ("routers", "servers-windows", "servers-windows-srv", "servers-windows-hnm",
            "servers-linux", "vpn-servers", "workstations", "vpn-clients", "cameras",
            "printers", "lan-other", "iot", "mobile-devices")
IP_FIELDS = ("ip", "alt_ip", "alt_ips", "wan_ip", "vpn_ip", "alt_vpn_ips", "lan_ip",
             "public_ip", "private_ip", "real_ip", "ipv4", "ipv6", "addresses")
NAME_FIELDS = ("hostname", "domain", "wan_domain", "fqdn", "alias", "aliases")


def values(value):
    return value if isinstance(value, list) else [value]


def ip_value(value) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        ip = ipaddress.ip_interface(value.strip()).ip
    except ValueError:
        return None
    if ip.is_unspecified or ip.is_loopback or ip.is_multicast or ip.is_link_local:
        return None
    return str(ip)


def names(value) -> list[str]:
    result = []
    for item in values(value):
        if not isinstance(item, str) or ip_value(item):
            continue
        try:
            result.append(address(item))
        except ValueError:
            continue
    return result


def records(network: dict) -> list[dict]:
    result = []
    for section in SECTIONS:
        for key, entry in (network.get(section) or {}).items():
            if not isinstance(entry, dict):
                continue
            ips, retired = set(), set()
            for interface in (entry.get("interfaces") or {}).values():
                if not isinstance(interface, dict):
                    continue
                destination = retired if re.search(r"удал[её]н|removed|retired|decommission",
                                                  str(interface.get("note", "")), re.I) else ips
                for field in IP_FIELDS:
                    destination.update(ip for value in values(interface.get(field)) if (ip := ip_value(value)))
            for field in IP_FIELDS:
                ips.update(ip for value in values(entry.get(field)) if (ip := ip_value(value)))
            for vpn in values(entry.get("vpn")):
                if isinstance(vpn, dict):
                    for field in IP_FIELDS:
                        ips.update(ip for value in values(vpn.get(field)) if (ip := ip_value(value)))
            ips -= retired
            aliases = set(names(key))
            for field in NAME_FIELDS:
                aliases.update(names(entry.get(field)))
            result.append({"key": key, "section": section,
                           "primary": ip_value(entry.get("ip")) or ip_value(entry.get("vpn_ip")),
                           "ips": sorted(ips), "names": sorted(aliases)})
    # Only names are taken from web-domain records: a web frontend's IP may be a NAT gateway.
    for domain, entry in (network.get("web-domains") or {}).items():
        if isinstance(entry, dict):
            for record in result:
                if record["key"] == entry.get("hosted_on"):
                    record["names"] = sorted(set(record["names"]) | set(names(domain)))
    return result


def match(node, candidates: list[dict]) -> dict | None:
    primary = ip_value(node.addresses[0]) if node.addresses else None
    known_ips = {ip for a in node.addresses if (ip := ip_value(a))}
    known_names = set(names(node.name)) | {a for a in node.addresses if not ip_value(a)}
    ranked = []
    for record in candidates:
        exact_primary = bool(primary and primary == record["primary"])
        overlap = known_ips.intersection(record["ips"])
        name_match = known_names.intersection(record["names"])
        if exact_primary or overlap or name_match:
            score = 100 * exact_primary + 20 * bool(name_match) + min(len(overlap), 10)
            ranked.append((score, record))
    ranked.sort(key=lambda item: item[0], reverse=True)
    if not ranked or (len(ranked) > 1 and ranked[0][0] == ranked[1][0]):
        return None
    # A domain alone is insufficient: its public IP may belong to a shared frontend.
    return ranked[0][1] if known_ips.intersection(ranked[0][1]["ips"]) else None


def enrich(graph: Graph, network: dict, dns: dict) -> tuple[Graph, dict]:
    updated = graph.model_copy(deep=True)
    candidates = records(network)
    ip_owners, name_owners = {}, {}
    for candidate in candidates:
        for ip in candidate["ips"]:
            ip_owners.setdefault(ip, set()).add(candidate["key"])
        for alias in candidate["names"]:
            name_owners.setdefault(alias, set()).add(candidate["key"])
    changes, unmatched, conflicts, skipped_shared = [], [], [], []
    prepared, map_owners, matched_owners = [], {}, {}
    for node in updated.nodes:
        for target in node.addresses:
            if ip := ip_value(target):
                map_owners.setdefault(ip, set()).add(node.id)
        record = match(node, candidates)
        owned = set(record["ips"] if record else ())
        if record:
            shared = {ip for ip in owned if len(ip_owners[ip]) > 1 and ip not in node.addresses}
            skipped_shared.extend({"node": node.id, "address": ip, "owners": sorted(ip_owners[ip])} for ip in sorted(shared))
            owned -= shared
        proposed = sorted(owned)
        # Domain-only Internet probes represent that endpoint rather than a physical host.
        domain_probe = not record and node.addresses and not any(ip_value(a) for a in node.addresses)
        if domain_probe:
            for alias in node.addresses:
                owned.update(ip for value in dns.get(alias, []) if (ip := ip_value(value)))
            proposed.extend(sorted(owned))
        if not record:
            owned.update(ip for a in node.addresses if (ip := ip_value(a)))
        else:
            for target in node.addresses:
                ip = ip_value(target)
                other = [r["key"] for r in candidates if r is not record and ip in r["ips"]]
                if ip and ip not in owned and other:
                    conflicts.append({"node": node.id, "name": node.name, "address": ip,
                                      "inventory_owners": other})
        prepared.append((node, record, proposed))
        for ip in owned:
            matched_owners.setdefault(ip, set()).add(node.id)
    aliases_by_node, ambiguous_dns = {}, []
    for alias, answers in sorted(dns.items()):
        resolved = {ip for value in answers if (ip := ip_value(value))}
        nodes = {node_id for ip in resolved for node_id in matched_owners.get(ip, ())}
        inventory_owners = {owner for ip in resolved for owner in ip_owners.get(ip, ())}
        declared = name_owners.get(alias, set())
        shared = any(len(map_owners.get(ip, ())) > 1 for ip in resolved)
        if nodes and (len(nodes) > 1 or len(inventory_owners) > 1 or len(declared) > 1 or shared):
            ambiguous_dns.append({"alias": alias, "addresses": sorted(resolved), "nodes": sorted(nodes),
                                  "inventory_owners": sorted(inventory_owners | declared)})
        elif len(nodes) == 1:
            aliases_by_node.setdefault(next(iter(nodes)), []).append(alias)
    for node, record, proposed in prepared:
        proposed.extend(alias for alias in aliases_by_node.get(node.id, ())
                        if not record or alias not in name_owners or record["key"] in name_owners[alias])
        before = list(node.addresses)
        node.addresses = list(dict.fromkeys([*before, *proposed]))
        if node.addresses != before:
            changes.append({"id": node.id, "name": node.name,
                            "record": f"{record['section']}/{record['key']}" if record else None,
                            "added": [a for a in node.addresses if a not in before]})
        if not record:
            unmatched.append({"id": node.id, "name": node.name, "addresses": before})
    # Validate again after constructing the full topology; preserve the original revision for CAS.
    updated = Graph.model_validate(updated.model_dump())
    return updated, {"changed_nodes": changes, "unmatched": unmatched, "conflicts": conflicts,
                     "skipped_shared": skipped_shared, "ambiguous_dns": ambiguous_dns,
                     "before": sum(len(n.addresses) for n in graph.nodes),
                     "after": sum(len(n.addresses) for n in updated.nodes)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", type=Path, required=True)
    parser.add_argument("--map", type=Path, required=True)
    parser.add_argument("--dns", type=Path, required=True, help="Forward-confirmed name -> IP list JSON")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    import yaml
    network = yaml.safe_load(args.network.read_text(encoding="utf-8-sig"))
    graph = Graph.model_validate_json(args.map.read_text(encoding="utf-8-sig"))
    dns = json.loads(args.dns.read_text(encoding="utf-8-sig"))
    updated, report = enrich(graph, network, dns)
    args.output.write_text(updated.model_dump_json(indent=2), encoding="utf-8")
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"nodes": len(updated.nodes), "before": report["before"],
                      "after": report["after"], "changed_nodes": len(report["changed_nodes"])}))


if __name__ == "__main__":
    main()
