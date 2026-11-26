'use strict';

const diagramIcon = {width:60,height:47};
const diagramLabelY = diagramIcon.height/2+3;
const diagramLabelLimit = 190;

function diagramSymbol(kind) {
  const type = kind.toLowerCase();
  if (/firewall|pfsense|opnsense|межсетев|фа[йе]рвол/.test(type)) return 'diagram-firewall';
  if (/switch|bridge|^hub$|коммутатор/.test(type)) return 'diagram-switch';
  if (/router|gateway|modem|маршрутизатор|шлюз|модем/.test(type)) return 'diagram-router';
  if (/access.?point|wireless ap|^ap$|точка доступа|wi[ -]?fi/.test(type)) return 'diagram-access-point';
  if (/\bnas\b|storage|disk array|хранилище/.test(type)) return 'diagram-storage';
  if (/server|mainframe|hypervisor|^vps$|сервер/.test(type)) return 'diagram-server';
  if (/print|принтер/.test(type)) return 'diagram-printer';
  if (/camera|камер/.test(type)) return 'diagram-camera';
  if (/phone|pda|телефон/.test(type)) return 'diagram-phone';
  if (/computer|workstation|desktop|laptop|notebook|компьютер|станция/.test(type)) return 'diagram-workstation';
  if (/cloud|internet|network$|^vpn$|облако|интернет|^сеть$/.test(type)) return 'diagram-cloud';
  return 'diagram-device';
}

// Footprint of a device: symbol, name and one row per address. Bounds are relative to the symbol centre.
function diagramLabelSizes(node, fontScale, measure) {
  const nameWidth = Math.min(diagramLabelLimit,Math.ceil(measure.name(node.name))+8);
  const nameHeight = 16*fontScale, rowHeight = 13*fontScale;
  let width = Math.max(diagramIcon.width+12,nameWidth);
  const rows = node.addresses.map(target=>{
    const channel = channels[node.address_channels?.[target]]?.short;
    const channelWidth = channel ? 4+Math.ceil(measure.channel(channel)) : 0;
    const rowWidth = Math.min(diagramLabelLimit,Math.ceil(measure.address(target))+channelWidth+16);
    width = Math.max(width,rowWidth);
    return {target,width:rowWidth,channel};
  });
  return {nameWidth,nameHeight,rowHeight,rows,
    bounds:[-width/2,-diagramIcon.height/2-4,width/2,diagramLabelY+nameHeight+rows.length*rowHeight+2]};
}

function diagramMeasure(fontFamily, fontScale) {
  const text = document.createElement('canvas').getContext('2d');
  const width = font => value => { text.font = font; return text.measureText(value).width; };
  return {name:width(`650 ${12*fontScale}px ${fontFamily}`),
    address:width(`${10.5*fontScale}px ui-monospace, Consolas, monospace`),
    channel:width(`650 ${8*fontScale}px ${fontFamily}`),
    caption:(value,scale)=>width(`750 ${19*fontScale*scale}px ${fontFamily}`)(value)};
}

const diagramByText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const diagramMean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const diagramGap = {x:22, row:20, bus:16, drop:14, trunk:18, site:96, band:170};
const diagramRanks = ['diagram-router','diagram-firewall','diagram-cloud','diagram-switch','diagram-access-point',
  'diagram-server','diagram-storage','diagram-workstation'];

// Network gear comes first: it roots a site and leads the rows under its parent.
function diagramRank(node) {
  const rank = diagramRanks.indexOf(diagramSymbol(node.kind));
  return rank < 0 ? diagramRanks.length : rank;
}

function diagramRows(blocks, limit, gap) {
  const rows = [];
  for (const block of blocks) {
    const row = rows.at(-1);
    if (row && row.width+gap+block.width<=limit) { row.items.push(block); row.width+=gap+block.width; row.height=Math.max(row.height,block.height); }
    else rows.push({items:[block],width:block.width,height:block.height});
  }
  return rows;
}

function diagramRowLimit(blocks, gap, aspect) {
  const area = blocks.reduce((sum,block)=>sum+(block.width+gap)*(block.height+gap),0);
  return Math.max(...blocks.map(block=>block.width),Math.sqrt(area*aspect));
}

function diagramShift(block, dx, dy, into) {
  for (const node of block.nodes) into.nodes.push({id:node.id,x:node.x+dx,y:node.y+dy});
  for (const wire of block.wires) into.wires.push({edge:wire.edge,points:wire.points.map(([x,y])=>[x+dx,y+dy])});
}

// A device with the devices behind it, drawn the way LAN diagrams usually are: the parent on top,
// a trunk on the left and one bus per row with a drop to every child. Coordinates start at the block's top left.
function diagramTree(id, tree, entries) {
  const {node,labels:{bounds:[l,t,r,b]}} = entries.get(id);
  const kids = (tree.get(id)||[]).map(({child,edge})=>({...diagramTree(child,tree,entries),edge,node:entries.get(child).node}))
    .sort((a,c)=>diagramRank(a.node)-diagramRank(c.node)||c.nodes.length-a.nodes.length||a.node.name.localeCompare(c.node.name,uiLocale,{numeric:true}));
  if (!kids.length) return {width:r-l,height:b-t,nodes:[{id,x:-l,y:-t}],wires:[],root:{x:-l,y:-t},node};
  const rows = diagramRows(kids,diagramRowLimit(kids,diagramGap.x,1.8),diagramGap.x);
  const inner = Math.max(...rows.map(row=>row.width)), pad = diagramGap.trunk, trunk = 6;
  const rootX = r-l>inner ? pad-l : pad+inner/2, rootY = -t;
  const block = {width:pad+Math.max(inner,r-l),nodes:[{id,x:rootX,y:rootY}],wires:[],root:{x:rootX,y:rootY},node};
  const exit = [rootX-diagramIcon.width/2,rootY];
  let y = b-t+diagramGap.bus;
  for (const row of rows) {
    const bus = y, top = y+diagramGap.drop;
    let x = pad;
    for (const kid of row.items) {
      diagramShift(kid,x,top,block);
      const cx = kid.root.x+x, cy = kid.root.y+top-diagramIcon.height/2;
      block.wires.push({edge:kid.edge,points:[exit,[trunk,exit[1]],[trunk,bus],[cx,bus],[cx,cy]]});
      x += kid.width+diagramGap.x;
    }
    y = top+row.height+diagramGap.row;
  }
  block.height = y-diagramGap.row;
  return block;
}

// A site: trees grown from its main network devices; devices without links fill the last rows.
function diagramSite(name, entries, links, caption) {
  const byId = new Map(entries.map(entry=>[entry.node.id,entry]));
  const adjacent = new Map(entries.map(({node})=>[node.id,[]]));
  for (const edge of links) {
    adjacent.get(edge.from_id).push({other:edge.to_id,edge:edge.id});
    adjacent.get(edge.to_id).push({other:edge.from_id,edge:edge.id});
  }
  const rank = id => diagramRank(byId.get(id).node);
  const starts = [...byId.keys()].sort((a,b)=>rank(a)-rank(b)||adjacent.get(b).length-adjacent.get(a).length||diagramByText(a,b));
  const seen = new Set(), tree = new Map(), roots = [], tree_edges = new Set();
  for (const start of starts) {
    if (seen.has(start)) continue;
    roots.push(start); seen.add(start);
    for (const queue=[start]; queue.length;) {
      const id = queue.shift();
      const next = adjacent.get(id).filter(({other})=>!seen.has(other)).sort((a,b)=>rank(a.other)-rank(b.other)||diagramByText(a.other,b.other));
      for (const {other,edge} of next) {
        if (seen.has(other)) continue;
        seen.add(other); tree_edges.add(edge); queue.push(other);
        if (!tree.has(id)) tree.set(id,[]);
        tree.get(id).push({child:other,edge});
      }
    }
  }
  const trees = roots.map(id=>diagramTree(id,tree,byId))
    .sort((a,b)=>b.nodes.length-a.nodes.length||diagramRank(a.node)-diagramRank(b.node)||a.node.name.localeCompare(b.node.name,uiLocale,{numeric:true}));
  const rows = diagramRows(trees,diagramRowLimit(trees,diagramGap.x*2,1.8),diagramGap.x*2);
  const site = {name,count:entries.length,nodes:[],wires:[],treeEdges:tree_edges,captionWidth:caption.width};
  let y = caption.height;
  for (const row of rows) {
    let x = 0;
    for (const block of row.items) { diagramShift(block,x,y,site); x += block.width+diagramGap.x*2; }
    y += row.height+diagramGap.row*2;
  }
  site.width = Math.max(caption.width,...rows.map(row=>row.width));
  site.height = y-diagramGap.row*2;
  site.root = {...site.nodes[0]};
  return site;
}

// Sites of one device (usually a VPS) stand in a row on top, larger sites below in reading order.
function layoutDiagram(nodes, edges, viewport) {
  const style = getComputedStyle(viewport);
  const fontScale = Number(style.getPropertyValue('--font-scale')) || 1;
  const aspect = innerWidth>=innerHeight ? 1.6 : .8;
  const measure = diagramMeasure(style.fontFamily,fontScale), groups = new Map(), siteOf = new Map();
  for (const node of [...nodes].sort((a,b)=>diagramByText(a.id,b.id))) {
    const site = node.site || '';
    if (!groups.has(site)) groups.set(site,[]);
    groups.get(site).push({node,labels:diagramLabelSizes(node,fontScale,measure)});
    siteOf.set(node.id,site);
  }
  const links = edges.filter(edge=>siteOf.has(edge.from_id)&&siteOf.has(edge.to_id)&&edge.from_id!==edge.to_id);
  const footprint = [...groups.values()].flat().reduce((sum,{labels:{bounds:[l,t,r,b]}})=>sum+(r-l)*(b-t),0);
  const scale = groups.size>1 ? Math.min(4,Math.max(1,Math.sqrt(footprint*4)/1400)) : 0;
  const captionHeight = 30*fontScale*scale;
  const blocks = [...groups].map(([name,entries])=>{
    const caption = {height:captionHeight,width:scale?measure.caption(name||tr("Без площадки"),scale)+12:0};
    const block = diagramSite(name,entries,links.filter(edge=>siteOf.get(edge.from_id)===name&&siteOf.get(edge.to_id)===name),caption);
    block.start = [diagramMean(entries.map(({node})=>node.x)),diagramMean(entries.map(({node})=>node.y))];
    return block;
  });
  const singles = blocks.filter(block=>block.count===1&&block.name), sites = blocks.filter(block=>!singles.includes(block));
  sites.sort((a,b)=>(a.name==='')-(b.name==='')||Math.round(a.start[1]/400)-Math.round(b.start[1]/400)||a.start[0]-b.start[0]||a.name.localeCompare(b.name,uiLocale,{numeric:true}));
  const singlesHeight = singles.length ? Math.max(...singles.map(block=>block.height)) : 0;
  const placed = [];
  const place = (block,x,y) => { block.x = x; block.y = y; placed.push(block); };
  let y = singles.length ? singlesHeight+diagramGap.band : 0, width = 0;
  // One row while it stays reasonably wide, so links from the top row never cross another site.
  for (const row of diagramRows(sites,diagramRowLimit(sites,diagramGap.site,aspect*4),diagramGap.site)) {
    let x = 0;
    for (const block of row.items) { place(block,x,y); x += block.width+diagramGap.site; }
    width = Math.max(width,row.width);
    y += row.height+diagramGap.site;
  }
  // Each single sits above the sites it links to; unlinked ones close the row.
  const rootX = block => block.x+block.root.x;
  const target = new Map(singles.map(block=>{
    const xs = links.filter(edge=>[edge.from_id,edge.to_id].includes(block.nodes[0].id)).map(edge=>{
      const other = siteOf.get(edge.from_id===block.nodes[0].id?edge.to_id:edge.from_id);
      return sites.find(site=>site.name===other);
    }).filter(Boolean).map(rootX);
    return [block,xs.length?diagramMean(xs):Infinity];
  }));
  singles.sort((a,b)=>target.get(a)-target.get(b)||a.name.localeCompare(b.name,uiLocale,{numeric:true}));
  const singlesWidth = singles.reduce((sum,block)=>sum+block.width,0)+diagramGap.x*2*Math.max(0,singles.length-1);
  let x = (width-singlesWidth)/2;
  for (const block of singles) { place(block,x,singlesHeight-block.height); x += block.width+diagramGap.x*2; }

  const positions = new Map(), routes = new Map(), siteBoxes = [], entryOf = new Map([...groups.values()].flat().map(entry=>[entry.node.id,entry]));
  for (const block of placed) {
    for (const node of block.nodes) positions.set(node.id,diagramPosition(entryOf.get(node.id).labels,node.x+block.x,node.y+block.y));
    for (const wire of block.wires) routes.set(wire.edge,wire.points.map(([px,py])=>[px+block.x,py+block.y]));
    if (scale) siteBoxes.push({name:block.name,bounds:[block.x,block.y,block.x+block.width,block.y+block.height],
      caption:{x:block.x,y:block.y,width:block.width,height:captionHeight,scale}});
  }
  // Captions follow reading order: the top row first, then left to right.
  siteBoxes.sort((a,b)=>a.bounds[1]-b.bounds[1]||a.bounds[0]-b.bounds[0]);
  return {positions,routes,sites:siteBoxes,siteLinks:diagramSiteLinks(links,siteOf,placed,singles,singlesHeight)};
}

// One line per pair of linked sites, between their main devices, with the number of links.
function diagramSiteLinks(links, siteOf, placed, singles, singlesHeight) {
  const pairs = new Map(), blockOf = new Map(placed.map(block=>[block.name,block]));
  for (const edge of links) {
    const a = siteOf.get(edge.from_id), b = siteOf.get(edge.to_id);
    if (a===b) continue;
    const key = JSON.stringify(a<b?[a,b]:[b,a]);
    if (!pairs.has(key)) pairs.set(key,[]);
    pairs.get(key).push(edge);
  }
  let lane = 0;
  return [...pairs].sort(([a],[b])=>diagramByText(a,b)).map(([key,edges])=>{
    const [a,b] = JSON.parse(key).map(name=>blockOf.get(name)), single = block => singles.includes(block);
    const top = block => [block.x+block.root.x,block.y+block.root.y-diagramIcon.height/2];
    const bottom = block => [block.x+block.root.x,block.y+block.height];
    let points;
    if (single(a)&&single(b)) {
      const band = singlesHeight+24+(lane++%6)*7;
      points = [bottom(a),[bottom(a)[0],band],[bottom(b)[0],band],bottom(b)];
    } else if (single(a)||single(b)) {
      const [s,l] = single(a)?[a,b]:[b,a];
      points = [bottom(s),top(l)];
    } else {
      const band = Math.min(a.y,b.y)-24-(lane++%6)*7;
      points = [top(a),[top(a)[0],band],[top(b)[0],band],top(b)];
    }
    const counts = new Map();
    for (const edge of edges) if (edge.label) counts.set(edge.label,(counts.get(edge.label)||0)+1);
    const label = [...counts].sort((p,q)=>q[1]-p[1]||diagramByText(p[0],q[0]))[0]?.[0] || '';
    return {sites:[a.name,b.name],edges:edges.map(edge=>edge.id),points,
      label:edges.length>1?`${label} ×${edges.length}`.trim():label};
  });
}

function diagramPosition(labels, x, y) {
  const [l,t,r,b] = labels.bounds;
  return {...labels,x,y,bounds:[l+x,t+y,r+x,b+y]};
}

function diagramText(x, y, width, height, className, ...children) {
  const field = elem('foreignObject',{x,y,width,height,class:'diagram-text','aria-hidden':'true'});
  const line = html('div',className);
  line.append(...children);
  field.append(line);
  return field;
}

function drawDiagramSite({name,caption:{x,y,width,height,scale}}, onFocus) {
  const label = name || tr("Без площадки");
  const group = elem('g',{class:`diagram-site${name?'':' unlabeled'}`});
  group.style.setProperty('--caption-scale',scale);
  const title = elem('g',{class:'diagram-site-title',tabindex:'0',role:'button','aria-label':tr("Приблизить площадку {0}", label)});
  title.append(elem('rect',{x,y,width,height,rx:4,fill:'transparent'}),
    diagramText(x,y,width,height,'diagram-site-label',html('span','diagram-ellipsis',label)));
  title.addEventListener('click',onFocus);
  title.addEventListener('keydown',event=>{
    if(event.key==='Enter'||event.key===' '){event.preventDefault();onFocus();}
  });
  group.append(title);
  return group;
}

function drawDiagramNode(group, node, layout) {
  const {width,height} = diagramIcon;
  const hit = elem('rect',{class:'diagram-symbol-hit',x:-width/2,y:-height/2,width,height,fill:'transparent'});
  const outline = elem('rect',{class:'diagram-selection',x:-width/2-4,y:-height/2-4,width:width+8,height:height+8,rx:6});
  const icon = elem('use',{class:'node-icon diagram-device-icon',href:`#${diagramSymbol(node.kind)}`,x:-width/2,y:-height/2,width,height});
  const title = elem('title');
  const {nameWidth,nameHeight} = layout;
  const nameHit = elem('rect',{x:-nameWidth/2,y:diagramLabelY,width:nameWidth,height:nameHeight,fill:'transparent'});
  group.append(hit,outline,icon,nameHit,
    diagramText(-nameWidth/2,diagramLabelY,nameWidth,nameHeight,'diagram-name',html('span','diagram-ellipsis',node.name)),title);
  return {content:group,icon,title};
}

function drawDiagramAddress(layout, target, index) {
  const {nameHeight,rowHeight,rows} = layout, {width,channel} = rows[index];
  const y = diagramLabelY + nameHeight + index*rowHeight;
  const x = -width/2;
  const point = elem('g',{class:'address-point diagram-address',transform:`translate(0 ${y})`});
  const hit = elem('rect',{class:'diagram-address-hit',x,y:0,width,height:rowHeight,rx:3});
  const circle = elem('circle',{class:'diagram-address-status',cx:x+5,cy:rowHeight/2,r:2.8,fill:colors.unknown});
  const labels = [html('span','diagram-target',target)];
  if (channel) labels.push(html('span','diagram-channel',channel));
  point.append(hit,circle,diagramText(x+12,0,width-12,rowHeight,'diagram-address-label',...labels));
  return {point,circle};
}

// Links inside a site follow the drawn tree; any other link is a straight line between the symbols.
function diagramEdgePoints(edge, from, to, layout, routes) {
  if (routes.has(edge.id)) return routes.get(edge.id);
  const start = layout.get(from.id), end = layout.get(to.id);
  return [[start.x,start.y],[end.x,end.y]];
}

function drawDiagramSiteLink({sites,edges,points,label}) {
  const group = elem('g',{class:'diagram-site-link'});
  const d = points.map(([x,y],i)=>`${i?'L':'M'}${x} ${y}`).join(' ');
  group.append(elem('path',{class:'diagram-site-link-path',d}),
    elem('title',{},`${sites.map(name=>name||tr("Без площадки")).join(' ↔ ')}${label?' · '+label:''}`));
  group.dataset.edges = edges.join(' ');
  return group;
}
