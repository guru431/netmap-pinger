'use strict';

// Runs inside the page: lays out synthetic maps of very different shapes and reports every broken rule.
// The rules hold for any map, so the layout is checked on combinations rather than on one network.
function checkDiagramQuality() {
  const random = seed => () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const kinds = ['Router','Switch','Server','WorkStation','Firewall','NAS','Access point','Cloud','Network printer','Camera','Phone','Device'];
  function map(name, seed, build) {
    const next = random(seed), nodes = [], edges = [];
    const node = (site, kind, addresses = 1 + Math.floor(next()*3), label = '') => {
      const id = `${name}-${nodes.length}`;
      nodes.push({id, name: label || `${site || 'node'} ${kind} ${nodes.length}`, kind, site, x: Math.floor(next()*900), y: Math.floor(next()*700),
        addresses: Array.from({length: addresses}, (_, k) => k % 4 === 3 ? `if${k}.${id}.example` : `192.0.2.${(nodes.length*7+k)%250+1}`),
        address_channels: {}, address_comments: {}, enabled: true, allow_offline: false, notes: ''});
      return id;
    };
    const link = (from, to, label = '') => { if (from !== to) edges.push({id: `${name}-e${edges.length}`, from_id: from, to_id: to, points: [], label, color: '#7894a5'}); };
    const pick = list => list[Math.floor(next()*list.length)];
    const lan = (site, count) => {
      const router = node(site, 'Router', 2), ids = [router];
      for (let i = 1; i < count; i++) {
        const id = node(site, i < 3 ? 'Switch' : pick(kinds.slice(2)));
        link(i < 3 ? router : pick(ids.slice(0, Math.min(ids.length, 3))), id);
        ids.push(id);
      }
      return ids;
    };
    build({node, link, pick, lan, next});
    return {name, nodes, edges};
  }
  const families = [
    map('no-sites', 1, ({node, link, pick, next}) => {
      const ids = [node('', 'Router')];
      for (let i = 0; i < 40; i++) { const id = node('', pick(kinds)); link(pick(ids), id); ids.push(id); }
      for (let i = 0; i < 10; i++) link(pick(ids), pick(ids));
    }),
    map('one-big-site', 2, ({lan}) => { lan('Campus', 150); }),
    map('many-singles', 3, ({node, link, pick, lan}) => {
      const hub = lan('Core', 10), singles = [];
      for (let i = 0; i < 30; i++) {
        const id = node(`VPS${i}`, 'Internet server', 4); singles.push(id);
        link(id, hub[0], 'OVPN'); link(id, pick(hub), 'WG');
      }
      for (let i = 0; i < 30; i++) link(singles[i], singles[(i + 7) % 30], 'mesh');
    }),
    map('operator', 4, ({node, link, pick, lan}) => {
      const sites = [['MSK', 70], ['HNM', 12], ['SK', 10], ['OFFICE', 7], ['SI', 4], ['REMOTE', 2]].map(([site, count]) => lan(site, count));
      const internet = lan('', 6);
      for (const ids of sites) link(ids[0], internet[0], 'WAN');
      link(sites[0][0], sites[1][0], 'WG'); link(sites[0][1], sites[2][0], 'WG');
      for (let i = 0; i < 14; i++) {
        const id = node(`VPS${i}`, 'Internet server', 3 + i % 4);
        for (let k = 0; k < 3; k++) link(id, pick(pick(sites).slice(0, 3)), 'OVPN');
      }
    }),
    map('full-mesh', 5, ({link, lan}) => {
      const sites = Array.from({length: 8}, (_, i) => lan(`Site ${i}`, 6));
      for (const ids of sites) { link(ids[3], ids[4]); link(ids[4], ids[5]); link(ids[5], ids[3]); }
      for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) link(sites[a][0], sites[b][0], 'VPN');
    }),
    map('no-links', 6, ({node, pick}) => {
      for (let i = 0; i < 60; i++) node(`Site ${i % 5}`, pick(kinds));
    }),
    map('long-labels', 7, ({node, link, next}) => {
      const ids = [];
      for (let i = 0; i < 24; i++) ids.push(node(`Branch ${i % 3}`, kinds[i % kinds.length], Math.floor(next()*26),
        `a-device-with-a-really-long-name-${i}.branch.example.org`));
      for (let i = 1; i < 24; i++) link(ids[i - (i % 3 ? 1 : 3) < 0 ? 0 : i - (i % 3 ? 1 : 3)], ids[i]);
    }),
  ];

  window.diagramQualityMaps = families;
  const separate = (a, b) => a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
  const crosses = ([x1, y1], [x2, y2], [l, t, r, b]) => {
    const inside = 0.5;
    if (x1 === x2) return x1 > l + inside && x1 < r - inside && Math.max(y1, y2) > t + inside && Math.min(y1, y2) < b - inside;
    return y1 > t + inside && y1 < b - inside && Math.max(x1, x2) > l + inside && Math.min(x1, x2) < r - inside;
  };
  const segments = points => points.slice(1).map((point, i) => [points[i], point]);
  const report = [];
  for (const {name, nodes, edges} of families) {
    const problems = [], started = performance.now();
    const layout = layoutDiagram(nodes, edges, svg);
    const time = performance.now() - started;
    const again = layoutDiagram(nodes, edges, svg);
    const snapshot = value => JSON.stringify({positions: [...value.positions].map(([id, p]) => [id, p.x, p.y]),
      sites: value.sites, links: value.siteLinks.map(link => link.points), routes: [...value.routes]});
    if (snapshot(layout) !== snapshot(again)) problems.push('layout differs between runs');
    const boxes = nodes.map(node => [node.id, layout.positions.get(node.id).bounds]);
    boxes.forEach(([a, boxA], i) => boxes.slice(i + 1).forEach(([b, boxB]) => { if (!separate(boxA, boxB)) problems.push(`devices ${a} and ${b} overlap`); }));
    const sites = layout.sites.map(site => site.bounds);
    sites.forEach((a, i) => sites.slice(i + 1).forEach(b => { if (!separate(a, b)) problems.push('sites overlap'); }));
    const lines = layout.siteLinks.map(link => link.points);
    for (const points of lines) {
      for (const [p, q] of segments(points)) {
        if (p[0] !== q[0] && p[1] !== q[1]) problems.push('a link between sites is not right-angled');
        else if (sites.some(site => crosses(p, q, site))) problems.push('a link between sites runs through a site');
      }
    }
    // Two links must not run on top of each other.
    const runs = lines.flatMap((points, index) => segments(points).map(([p, q]) => ({index, p, q})));
    runs.forEach((a, i) => runs.slice(i + 1).forEach(b => {
      if (a.index === b.index) return;
      const vertical = a.p[0] === a.q[0] && b.p[0] === b.q[0] && a.p[0] === b.p[0];
      const horizontal = a.p[1] === a.q[1] && b.p[1] === b.q[1] && a.p[1] === b.p[1];
      const axis = vertical ? 1 : 0;
      if (!vertical && !horizontal) return;
      const overlap = Math.min(Math.max(a.p[axis], a.q[axis]), Math.max(b.p[axis], b.q[axis])) -
        Math.max(Math.min(a.p[axis], a.q[axis]), Math.min(b.p[axis], b.q[axis]));
      if (overlap > 2) problems.push(`two links between sites overlap at ${a.p} – ${a.q} and ${b.p} – ${b.q}`);
    }));
    const all = [...boxes.map(([, box]) => box), ...sites, ...lines.flat().map(([x, y]) => [x, y, x, y])];
    const width = Math.max(...all.map(box => box[2])) - Math.min(...all.map(box => box[0]));
    const height = Math.max(...all.map(box => box[3])) - Math.min(...all.map(box => box[1]));
    const used = boxes.reduce((sum, [, [l, t, r, b]]) => sum + (r - l) * (b - t), 0) / (width * height);
    const aspect = innerWidth >= innerHeight ? 1.6 : .8;
    if (layout.sites.length > 2 && (width / height > aspect * 3 || width / height < aspect / 3)) problems.push(`diagram is ${Math.round(width)}×${Math.round(height)}`);
    if (used < .12) problems.push(`devices fill only ${Math.round(used * 100)}% of the diagram`);
    if (time > 1500) problems.push(`layout took ${Math.round(time)} ms`);
    report.push({name, problems: [...new Set(problems)], time: Math.round(time), used: Math.round(used * 100)});
  }
  return report;
}

module.exports = {checkDiagramQuality};
