# Readable network diagram — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the «Схема» rendering with Cisco-style device symbols coloured by status, full interface lists, a deterministic two-level automatic layout grouped by site, and straight topology links.

**Architecture:** `diagram.js` owns symbol choice, label sizing, layout and diagram drawing helpers; `app.js` keeps one render path (`drawGraph`/`updateState`) and switches helpers by `diagramView`. Layout is pure given nodes, edges, measured label sizes and viewport aspect; it runs only in `drawGraph`.

**Tech Stack:** Vanilla JS + SVG, CSS custom properties and `color-mix()`, Playwright browser checks (`tests/layout.browser.cjs`).

**Spec:** `docs/superpowers/specs/2026-11-26-network-diagram-design.md`

## Global Constraints

- Frontend only: `netmap/static/{diagram.js,diagram.css,index.html,app.js,en.js}`, `tests/layout.browser.cjs`, `README.md`. No new runtime dependencies, no build step.
- Classic «Карта» output must not change; existing classic assertions stay as they are.
- Same graph revision + font scale ⇒ identical diagram positions. No `Math.random`, no time-dependent input.
- Layout ≤ ~150 ms for 500 nodes on a desktop; status refresh (every 2 s) never re-runs layout.
- Light/dark theme, RU/EN, 390 px touch layout.
- Synthetic fixtures only in Git (documentation addresses 192.0.2.0/24, 198.51.100.0/24, `*.example`).

## Review Focus

1. Coincident classic coordinates (Friendly Pinger imports stack icons): layout must still separate them deterministically — dense fixture test, Task 2.
2. A site with one node, a site with 40+ nodes, and nodes without a site side by side: groups disjoint, captions unambiguous — dense fixture test, Task 2.
3. A node with 0 addresses and one with 10 long DNS names: footprint grows, no overlap, names truncated — dense fixture test, Task 2.
4. Switching to «Схема» while «Двигать узлы» is active: edit mode ends, nothing is saved — Task 3 test.
5. Dark theme contrast of white marks on pastel status colours — screenshot review, Task 4.

---

### Task 1: Symbols, status colour and interface labels

**Files:**
- Modify: `netmap/static/index.html` (replace `diagram-*` symbols, add `diagram-printer`, `diagram-camera`, `diagram-phone`)
- Modify: `netmap/static/diagram.js` (`diagramSymbol`, `diagramLabelSizes`, `drawDiagramNode`, `drawDiagramAddress`; drop status marks)
- Modify: `netmap/static/diagram.css`, `netmap/static/app.js` (`updateState`, `drawGraph` address loop)
- Test: `tests/layout.browser.cjs` (diagram block after `#view-diagram` click)

**Interfaces:**
- Produces: `diagramSymbol(kind) -> 'diagram-router'|'diagram-switch'|'diagram-firewall'|'diagram-access-point'|'diagram-server'|'diagram-storage'|'diagram-workstation'|'diagram-printer'|'diagram-camera'|'diagram-phone'|'diagram-cloud'|'diagram-device'`; `diagramLabelSizes(node, fontScale, measure) -> {nameWidth,nameHeight,rowHeight,rows:[{target,width,channel}],bounds:[l,t,r,b]}` (bounds relative to the icon centre); `drawDiagramNode(group,node,layout) -> {content,icon,title}`; status colour is the inline custom property `--device` on `.map-node`.

- [ ] **Step 1: Write failing assertions** in the diagram block:
  - hrefs stay `['#diagram-server','#diagram-router','#diagram-switch','#diagram-firewall']`;
  - `.map-node` inline `--device` values are `['var(--up)','var(--down)','var(--partial)','var(--stale)']` for a,b,c,d;
  - computed `fill` of `.diagram-device-icon` differs between node a (up) and b (down) — read via `getComputedStyle(group).getPropertyValue('--device-front')`;
  - `.diagram-status-mark`, `.diagram-state-ring`, `.diagram-more` count 0;
  - node a `.diagram-target` texts `['192.0.2.1','router.example']`, `.diagram-channel` texts `['LAN','WAN']`.
- [ ] **Step 2: Run** `node tests/layout.browser.cjs <playwright> chromium` → FAIL on `--device`.
- [ ] **Step 3: Implement.** Symbols use only `var(--device-top)`, `var(--device-front)`, `var(--device-side)`, `var(--device-mark)`; CSS derives them on `.diagram .map-node` from `--device` with `color-mix(in srgb, …)`. Router: low cylinder with four arrows in an X (two inward, two outward); switch: flat box with two ⇄ pairs on top; firewall: brick wall; storage: tall banded cylinder; server: tower; workstation: monitor; cloud: cloud. `modem` maps to router. All addresses rendered as rows; row width measured with the monospace font. `allow_offline` → dashed outline rect around the icon.
- [ ] **Step 4: Run** chromium check → PASS for this block.
- [ ] **Step 5: Commit** `Draw diagram devices as Cisco-style symbols coloured by status`.

### Task 2: Two-level deterministic layout with site captions

**Files:**
- Modify: `netmap/static/diagram.js` (`layoutDiagram`, new `layoutDiagramGroup`, `layoutDiagramBlocks`, `placeWithoutOverlap`, `drawDiagramSite`)
- Modify: `netmap/static/app.js` (`drawGraph`, `fit`, `focusDiagramSite`, `openNode`, node submit anchor; remove `groupDiagram`, `showAllDiagramLinks`, `groupedDiagram`)
- Modify: `netmap/static/index.html` (remove `#diagram-tools`; `#diagram-site` select moves into the top toolbar, shown only in «Схема»), `diagram.css`, `en.js`
- Test: `tests/layout.browser.cjs` (site caption block and dense block)

**Interfaces:**
- Consumes: `diagramLabelSizes` from Task 1.
- Produces: `layoutDiagram(nodes, edges, viewport) -> {positions: Map<id,{x,y,bounds,...labels}>, sites: [{name, bounds:[l,t,r,b], caption:{x,y,width,height}}]}`; `drawDiagramSite(site, onFocus) -> SVGGElement` (caption only, no area rect).

Algorithm (deterministic):
1. Group by `site` (`''` = unlabeled). Sort groups by name with `localeCompare(uiLocale,{numeric:true})`, unlabeled last; nodes inside a group by id.
2. Per group: start at classic `(x,y)` relative to the group centroid ×1.6. Exactly coincident starts get a golden-angle spiral offset by index. 160 iterations of: pairwise repulsion `k²/d` (k = mean footprint diagonal + 24), springs along intra-group edges `(d−k)²/k`, gravity to the centroid, displacement capped by a linearly cooling temperature.
3. `placeWithoutOverlap(items, gap, aspect)`: sort by distance from the centroid (ties by id); keep each item at its simulated point if its rect (+gap) is free, else take the first free point on an elliptical spiral (step 6 px, x radius × aspect). Guarantees zero overlap. Node gap 14 px.
4. Blocks: each group's bbox plus caption height (20 px × font scale + 6). Start at the classic centroid scaled by `sqrt(Σblock area / classic hull area)` (≥1). 120 iterations with repulsion, springs weighted by inter-site edge count, anisotropic gravity (x weaker by viewport aspect), then `placeWithoutOverlap` with gap 56 px.
5. Captions: only when there is more than one group; unlabeled group caption is «Без площадки» (muted).

- [ ] **Step 1: Write failing assertions:**
  - base fixture: 2 captions (`Site B`, `Без площадки`); click on caption `Site B` zooms (`view.w` shrinks), `#diagram-site` = `site:Site B`, new node defaults to `Site B`; picker `''` restores fit width;
  - dense fixture (replace the current one): 5 named sites with 1, 3, 8, 14, 40 nodes plus 6 unlabeled, all classic coordinates equal for half the nodes, addresses 0–10 per node (some 40-char `*.example` names), intra- and inter-site edges and one free-ended edge; assert pairwise node bboxes disjoint, per-site bboxes (nodes + caption) disjoint, transforms identical after `page.reload()`;
  - `await page.evaluate(()=>{const t=performance.now();layoutDiagram(graph.nodes,graph.edges,svg);return performance.now()-t})` < 1000 for a 500-node synthetic graph built in the page.
- [ ] **Step 2: Run** chromium → FAIL.
- [ ] **Step 3: Implement** as above; `fit()` in diagram uses nodes + site bounds only.
- [ ] **Step 4: Run** chromium → PASS.
- [ ] **Step 5: Commit** `Lay out the diagram automatically by site and links`.

### Task 3: Diagram links and editing rules

**Files:**
- Modify: `netmap/static/app.js` (`drawGraph` edge loop, `updateEdgeGeometry`, `updateDiagramLinks`, `cancelMapDrag` guard, edit-layout toggle extracted to `setEditLayout(on)`), `diagram.js` (`diagramEdgePoints(from, to, layout) -> [[x1,y1],[x2,y2]]`), `diagram.css`, `en.js`
- Test: `tests/layout.browser.cjs`

**Interfaces:**
- Consumes: `positions` from Task 2.
- Produces: `setEditLayout(on: boolean)`; class `diagram-link-active` on links of the selected node.

- [ ] **Step 1: Write failing assertions:**
  - in «Схема» `#edge-layer > g` count = 3 (edges with both ends: internal, external, new); each path `d` equals `M${x1} ${y1} L${x2} ${y2}` of the two node transforms;
  - clicking node a symbol marks 2 links `.diagram-link-active`;
  - `#edit-layout` is disabled in «Схема»; with edit mode on in «Карта», switching to «Схема» sets `aria-pressed="false"` and no write happens;
  - classic edit flow (drag, arrows, cancel, conflict rollback) now runs entirely in «Карта» with the same write counts (9 total).
- [ ] **Step 2: Run** chromium → FAIL.
- [ ] **Step 3: Implement.** Free-ended edges are not created in diagram mode. Link label stays at the midpoint.
- [ ] **Step 4: Run** chromium → PASS.
- [ ] **Step 5: Commit** `Draw straight topology links in the diagram and keep editing in the map`.

### Task 4: Docs, translations, realistic preview

**Files:**
- Modify: `README.md` («Виды карты»), `netmap/static/en.js`
- Local only (gitignored `.tmp/`, `var/`): preview script rendering a map generated from the private inventory, light and dark screenshots

- [ ] **Step 1:** Rewrite «Виды карты» for the new behaviour; remove strings for «По площадкам», «Все связи» and their titles; add EN strings for new captions/titles.
- [ ] **Step 2:** Render the realistic preview; inspect for overlaps, colour contrast (dark theme), symbol legibility at overview zoom; adjust sizes/colours.
- [ ] **Step 3:** Send screenshots to the user.
- [ ] **Step 4: Commit** `Describe the readable diagram view`.

### Task 5: Full verification and release

- [ ] **Step 1:** `python -m pytest -q --durations=5` → all pass.
- [ ] **Step 2:** `node tests/layout.browser.cjs <playwright>` (firefox, chromium, webkit; desktop + touch) → all OK, no page errors.
- [ ] **Step 3:** Push `main` to `origin` and `github`.
- [ ] **Step 4:** Deploy with `netmap/deploy/release.py <full-sha>` on the server once access is available; check `/api/health`, the served `diagram.js` hash and a completed poll cycle.
