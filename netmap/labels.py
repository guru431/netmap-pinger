"""Suggest site and ICMP channel labels for an existing Netmap export."""
from __future__ import annotations

import argparse
from collections import defaultdict
import ipaddress
import json
from pathlib import Path
import re

from .inventory import ip_value, match, names, records
from .model import Graph, address

GROUPS = {"Sites": "sites-vpn", "VPN-OVPN": "openvpn", "VPN-WG-My": "wg-my",
          "VPN-WG-Work": "wg-work", "LAN": "lan", "WAN": "wan", "Internet": "internet"}


def smokeping_targets(config: str) -> dict[str, set[str]]:
    """Read the FPing targets of the configured, two-level channel groups."""
    sections = {(0, ""): {}}
    root, group = (0, ""), ""
    section = root
    for raw in config.splitlines():
        line = raw.partition("#")[0].strip()
        if heading := re.fullmatch(r"(\++)\s+(\S+)", line):
            depth, name = len(heading[1]), heading[2]
            if depth == 1:
                group = name
            section = (depth, group) if depth == 1 else (depth, f"{group}/{name}")
            sections[section] = {}
        else:
            name, separator, value = line.partition("=")
            if separator:
                sections[section][name.strip()] = value.strip()
    targets = defaultdict(set)
    for (depth, path), fields in sections.items():
        group, _, _ = path.partition("/")
        if depth != 2 or group not in GROUPS or "host" not in fields:
            continue
        probe = fields.get("probe", sections[1, group].get("probe", sections[root].get("probe")))
        if probe == "FPing":
            try:
                targets[address(fields["host"])].add(GROUPS[group])
            except ValueError:
                continue
    return dict(targets)


def annotate(graph: Graph, network: dict, targets: dict[str, set[str]]) -> tuple[Graph, dict]:
    updated = graph.model_copy(deep=True)
    records_by_node = records(network)
    sites = network.get("sites") or {}
    subnets = {site: [ipaddress.ip_network(cidr) for cidr in entry.get("subnets") or []]
               for site, entry in sites.items()}
    report = {"site_updates": 0, "channel_updates": 0, "unlabeled_sites": [],
              "smokeping_missing": {}, "smokeping_ambiguous": {}}
    present = {target for node in graph.nodes for target in node.addresses}
    for target, channels in sorted(targets.items()):
        if target not in present:
            report["smokeping_missing"][target] = sorted(channels)
        if len(channels) > 1:
            report["smokeping_ambiguous"][target] = sorted(channels)

    for node in updated.nodes:
        device = match(node, records_by_node)
        entry = network[device["section"]][device["key"]] if device else {}
        primary = ip_value(node.addresses[0]) if node.addresses else None
        gateway_sites = [site for site, fields in sites.items() if primary and primary == fields.get("wan_gateway")]
        subnet_sites = [site for site, ranges in subnets.items() if primary and
                        any(ipaddress.ip_address(primary) in subnet for subnet in ranges)]
        inferred = gateway_sites or subnet_sites
        site = entry.get("site") or (inferred[0] if len(inferred) == 1 else "")
        vps = bool(device and device["section"] == "vpn-servers")
        if vps and not site:
            site = device["key"]
        if not node.site and re.fullmatch(r"[a-zA-Z0-9_-]+", site):
            node.site = site.upper()
            report["site_updates"] += 1
        if not node.site:
            report["unlabeled_sites"].append({"id": node.id, "name": node.name})

        site_fields = sites.get(site, {})
        wan = {site_fields.get("wan_gateway")}
        wan_ip = ip_value(site_fields.get("wan_ip"))
        if wan_ip and ipaddress.ip_address(wan_ip).is_global and "CG-NAT" not in str(site_fields.get("wan_ip_note")):
            wan.add(wan_ip)
        if not site_fields.get("wan_domain_stale"):
            wan.update(names(site_fields.get("wan_domain")))
        if vps:
            public_ip = ip_value(entry.get("ip"))
            if public_ip and ipaddress.ip_address(public_ip).is_global:
                wan.add(public_ip)
        for target in node.addresses:
            if target in node.address_channels:
                continue
            configured = targets.get(target, set())
            if len(configured) > 1:
                continue
            channel = next(iter(configured), None)
            if channel is None:
                if target in wan:
                    channel = "wan"
                elif (ip := ip_value(target)) and any(
                    ipaddress.ip_address(ip) in subnet for subnet in subnets.get(site, [])
                ):
                    channel = "lan"
            if channel:
                node.address_channels[target] = channel
                report["channel_updates"] += 1
    return updated, report


def main():
    import yaml

    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("network", "map", "smokeping-targets", "output", "report"):
        parser.add_argument("--" + option, required=True, type=Path)
    args = parser.parse_args()
    paths = [args.network, args.map, args.smokeping_targets, args.output, args.report]
    if len({path.resolve() for path in paths}) != len(paths):
        parser.error("Inputs, output and report must use separate files.")
    graph = Graph.model_validate_json(args.map.read_bytes())
    network = yaml.safe_load(args.network.read_text(encoding="utf-8"))
    targets = smokeping_targets(args.smokeping_targets.read_text(encoding="utf-8"))
    if not targets:
        parser.error("No FPing targets found in the supplied SmokePing groups.")
    updated, report = annotate(graph, network, targets)
    args.output.write_text(updated.model_dump_json(indent=2) + "\n", encoding="utf-8")
    args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
