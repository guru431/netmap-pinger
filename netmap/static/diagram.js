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

// Footprint of a device: symbol, name and one row per address; long address lists wrap into
// up to three columns. Bounds are relative to the symbol centre.
function diagramLabelSizes(node, fontScale, measure) {
  const nameWidth = Math.min(diagramLabelLimit,Math.ceil(measure.name(node.name))+8);
  const nameHeight = 16*fontScale, rowHeight = 13*fontScale, columnGap = 8;
  const items = node.addresses.map(target=>{
    const channel = channels[node.address_channels?.[target]]?.short;
    const channelWidth = channel ? 4+Math.ceil(measure.channel(channel)) : 0;
    return {target,channel,width:Math.min(diagramLabelLimit,Math.ceil(measure.address(target))+channelWidth+16)};
  });
  const perColumn = Math.ceil(items.length/Math.min(3,Math.ceil(items.length/6))) || 0;
  const columns = [];
  items.forEach((item,index)=>{ const column = Math.floor(index/perColumn); columns[column] = Math.max(columns[column]||0,item.width); });
  const rowsWidth = columns.reduce((sum,width)=>sum+width,0)+columnGap*Math.max(0,columns.length-1);
  const lefts = columns.map((_,column)=>-rowsWidth/2+columns.slice(0,column).reduce((sum,width)=>sum+width+columnGap,0));
  const rows = items.map((item,index)=>{
    const column = Math.floor(index/perColumn);
    return {...item,x:lefts[column],y:diagramLabelY+nameHeight+(index%perColumn)*rowHeight,width:columns[column]};
  });
  const width = Math.max(diagramIcon.width+12,nameWidth,rowsWidth);
  return {nameWidth,nameHeight,rowHeight,rows,
    bounds:[-width/2,-diagramIcon.height/2-4,width/2,diagramLabelY+nameHeight+perColumn*rowHeight+2]};
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
const diagramGap = {x:22, row:20, bus:16, drop:14, trunk:18};
const diagramCell = 10;
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

// A site: trees grown from its gateways and main network devices; devices without links close the rows.
function diagramSite(name, entries, links, outside, caption) {
  const byId = new Map(entries.map(entry=>[entry.node.id,entry]));
  const adjacent = new Map(entries.map(({node})=>[node.id,[]]));
  for (const edge of links) {
    adjacent.get(edge.from_id).push({other:edge.to_id,edge:edge.id});
    adjacent.get(edge.to_id).push({other:edge.from_id,edge:edge.id});
  }
  const rank = id => diagramRank(byId.get(id).node);
  const starts = [...byId.keys()].sort((a,b)=>rank(a)-rank(b)||(outside.get(b)||0)-(outside.get(a)||0)||
    adjacent.get(b).length-adjacent.get(a).length||diagramByText(a,b));
  const seen = new Set(), tree = new Map(), roots = [], treeEdges = new Set();
  for (const start of starts) {
    if (seen.has(start)) continue;
    roots.push(start); seen.add(start);
    for (const queue=[start]; queue.length;) {
      const id = queue.shift();
      const next = adjacent.get(id).filter(({other})=>!seen.has(other)).sort((a,b)=>rank(a.other)-rank(b.other)||diagramByText(a.other,b.other));
      for (const {other,edge} of next) {
        if (seen.has(other)) continue;
        seen.add(other); treeEdges.add(edge); queue.push(other);
        if (!tree.has(id)) tree.set(id,[]);
        tree.get(id).push({child:other,edge});
      }
    }
  }
  const trees = roots.map(id=>diagramTree(id,tree,byId))
    .sort((a,b)=>b.nodes.length-a.nodes.length||diagramRank(a.node)-diagramRank(b.node)||a.node.name.localeCompare(b.node.name,uiLocale,{numeric:true}));
  const rows = diagramRows(trees,diagramRowLimit(trees,diagramGap.x*2,1.8),diagramGap.x*2);
  const site = {name,count:entries.length,nodes:[],wires:[],treeEdges};
  let y = caption.height;
  for (const row of rows) {
    let x = 0;
    for (const block of row.items) { diagramShift(block,x,y,site); x += block.width+diagramGap.x*2; }
    y += row.height+diagramGap.row*2;
  }
  site.width = Math.max(...rows.map(row=>row.width));
  site.height = y-diagramGap.row*2;
  site.root = {...site.nodes[0]};
  // The caption keeps clear of the line that rises from the main device to the other sites.
  const clear = 10, left = site.root.x-clear, right = site.root.x+clear;
  const captionX = caption.width<=left ? 0 : right;
  site.width = Math.max(site.width,captionX+caption.width);
  site.caption = {x:captionX,width:caption.width,height:caption.height};
  return site;
}

// Bottom-left skyline packing of the site blocks into a sheet with the proportions of the screen.
function diagramPack(blocks, aspect, gap) {
  const order = [...blocks].sort((a,b)=>b.height-a.height||b.width-a.width||diagramByText(a.name,b.name));
  const area = order.reduce((sum,block)=>sum+(block.width+gap)*(block.height+gap),0);
  const limit = Math.max(...order.map(block=>block.width+gap),Math.sqrt(area*aspect));
  let sky = [{x:0,width:limit,y:0}];
  for (const block of order) {
    const need = block.width+gap;
    let best = null;
    for (let i=0; i<sky.length && sky[i].x+need<=limit+.01; i++) {
      let top = 0;
      for (let j=i; j<sky.length && sky[j].x<sky[i].x+need-.01; j++) top = Math.max(top,sky[j].y);
      if (!best || top<best.y) best = {x:sky[i].x,y:top};
    }
    block.x = best.x+gap/2; block.y = best.y+gap/2;
    const end = best.x+need, next = [];
    for (const segment of sky) {
      const segmentEnd = segment.x+segment.width;
      if (segmentEnd<=best.x+.01 || segment.x>=end-.01) { next.push(segment); continue; }
      if (segment.x<best.x) next.push({x:segment.x,width:best.x-segment.x,y:segment.y});
      if (segmentEnd>end) next.push({x:end,width:segmentEnd-end,y:segment.y});
    }
    next.push({x:best.x,width:need,y:best.y+block.height+gap});
    next.sort((a,b)=>a.x-b.x);
    sky = next.reduce((merged,segment)=>{
      const last = merged.at(-1);
      if (last && Math.abs(last.y-segment.y)<.01) last.width += segment.width; else merged.push({...segment});
      return merged;
    },[]);
  }
}

// Every site gets a short bar above its main device; each link to another site leaves the bar from its
// own point and follows the free corridors between sites at right angles, never over a site or another link.
function diagramSiteLinks(links, siteOf, blocks) {
  const pairs = new Map(), blockOf = new Map(blocks.map(block=>[block.name,block]));
  for (const edge of links) {
    const a = siteOf.get(edge.from_id), b = siteOf.get(edge.to_id);
    if (a===b) continue;
    const key = JSON.stringify(a<b?[a,b]:[b,a]);
    if (!pairs.has(key)) pairs.set(key,[]);
    pairs.get(key).push(edge);
  }
  const cell = diagramCell, list = [...pairs].sort(([a],[b])=>diagramByText(a,b)).map(([key,edges])=>{
    const [a,b] = JSON.parse(key).map(name=>blockOf.get(name));
    return {a,b,edges};
  });
  if (!list.length) return {siteLinks:[],siteBars:[]};
  const centre = block => block.x+block.width/2;
  const ports = new Map();
  for (const pair of list) for (const [own,other] of [[pair.a,pair.b],[pair.b,pair.a]]) {
    if (!ports.has(own)) ports.set(own,[]);
    ports.get(own).push({pair,other});
  }
  const bars = [];
  for (const [block,own] of ports) {
    own.sort((p,q)=>centre(p.other)-centre(q.other)||diagramByText(p.other.name,q.other.name));
    // Satellites in the top band connect from below their labels, sites below them from above the main device.
    const side = block.satellite ? 1 : -1, rootX = block.x+block.root.x;
    const row = side>0 ? Math.ceil((block.y+block.height+8)/cell) : Math.floor((block.y-8)/cell);
    // Ports stay over their own site, centred on the main device as far as the site width allows.
    const first = Math.max(Math.ceil(block.x/cell),Math.min(Math.round(rootX/cell)-Math.floor((own.length-1)/2),
      Math.floor((block.x+block.width)/cell)-own.length+1));
    own.forEach((port,index)=>{
      port.column = first+index; port.row = row; port.side = side;
      port.pair[port.pair.a===block?'from':'to'] = port;
    });
    bars.push({block,row,rootX,hub:side>0?block.y+block.height:block.y+block.root.y-diagramIcon.height/2,
      columns:[Math.min(own[0].column,Math.floor(rootX/cell)),Math.max(own.at(-1).column,Math.ceil(rootX/cell))]});
  }
  const margin = 6+Math.ceil(list.length/2);
  const minColumn = Math.floor(Math.min(...blocks.map(block=>block.x))/cell)-margin;
  const minRow = Math.floor(Math.min(...blocks.map(block=>block.y))/cell)-margin;
  const columns = Math.ceil(Math.max(...blocks.map(block=>block.x+block.width))/cell)-minColumn+margin;
  const rows = Math.ceil(Math.max(...blocks.map(block=>block.y+block.height))/cell)-minRow+margin;
  const index = (column,row) => (row-minRow)*columns+(column-minColumn);
  const blocked = new Uint8Array(columns*rows), used = new Uint8Array(columns*rows);
  for (const block of blocks) {
    for (let row=Math.floor((block.y-4)/cell); row<=Math.ceil((block.y+block.height+4)/cell); row++)
      for (let column=Math.floor((block.x-4)/cell); column<=Math.ceil((block.x+block.width+4)/cell); column++) {
        const x = column*cell, y = row*cell;
        if (x>=block.x-4 && x<=block.x+block.width+4 && y>=block.y-4 && y<=block.y+block.height+4) blocked[index(column,row)] = 1;
      }
  }
  for (const bar of bars) for (let column=bar.columns[0]; column<=bar.columns[1]; column++) used[index(column,bar.row)] |= 1;
  // The first step out of every port is reserved for its own link.
  const reserve = port => [index(port.column,port.row),index(port.column,port.row+port.side)];
  for (const pair of list) for (const cellIndex of [...reserve(pair.from),...reserve(pair.to)]) used[cellIndex] |= 2;

  // A* over grid cells with a direction per state: bends cost extra, running along another link is avoided.
  const moves = [[0,-1],[1,0],[0,1],[-1,0]];
  function route(from, to, strict) {
    const own = [...reserve(from),...reserve(to)];
    for (const cellIndex of own) used[cellIndex] &= ~2;
    const start = index(from.column,from.row+from.side), goal = index(to.column,to.row+to.side), total = columns*rows*4;
    // Leave a port away from its site and enter the other port towards its site.
    const away = from.side<0 ? 0 : 2, towards = to.side<0 ? 2 : 0;
    const cost = new Float64Array(total).fill(Infinity), previous = new Int32Array(total).fill(-1), heap = [];
    const push = (state,score) => {
      heap.push([score,state]);
      for (let i=heap.length-1; i>0;) { const parent = (i-1)>>1; if (heap[parent][0]<=heap[i][0]) break; [heap[parent],heap[i]] = [heap[i],heap[parent]]; i = parent; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i=0;;) {
          const l = i*2+1, r = l+1; let smallest = i;
          if (l<heap.length && heap[l][0]<heap[smallest][0]) smallest = l;
          if (r<heap.length && heap[r][0]<heap[smallest][0]) smallest = r;
          if (smallest===i) break;
          [heap[smallest],heap[i]] = [heap[i],heap[smallest]]; i = smallest;
        }
      }
      return top;
    };
    const goalColumn = goal%columns, goalRow = Math.floor(goal/columns);
    const guess = cellIndex => Math.abs(cellIndex%columns-goalColumn)+Math.abs(Math.floor(cellIndex/columns)-goalRow);
    cost[start*4+away] = 0; push(start*4+away,guess(start));
    let found = -1;
    while (heap.length) {
      const [score,state] = pop(), cellIndex = state>>2, direction = state&3;
      if (score-guess(cellIndex)>cost[state]+1e-9) continue;
      if (cellIndex===goal && direction!==(towards+2)%4) { found = state; break; }
      const column = cellIndex%columns, row = Math.floor(cellIndex/columns);
      for (let turn=0; turn<4; turn++) {
        if (turn===(direction+2)%4) continue;
        const nextColumn = column+moves[turn][0], nextRow = row+moves[turn][1];
        if (nextColumn<0 || nextRow<0 || nextColumn>=columns || nextRow>=rows) continue;
        const next = nextRow*columns+nextColumn;
        if (blocked[next]) continue;
        const axis = turn%2 ? 1 : 2;
        if (strict && used[next]&axis) continue;
        const step = 1+(turn!==direction?6:0)+(used[next]&axis?1000:used[next]?3:0)+(next===goal&&turn!==towards?12:0);
        const nextState = next*4+turn;
        if (cost[state]+step<cost[nextState]) {
          cost[nextState] = cost[state]+step; previous[nextState] = state;
          push(nextState,cost[nextState]+guess(next));
        }
      }
    }
    for (const cellIndex of own) used[cellIndex] |= 2;
    if (found<0) return null;
    const cells = [];
    for (let state=found; state>=0; state=previous[state]) cells.push(state>>2);
    cells.reverse();
    cells.forEach((cellIndex,i)=>{
      if (!i) return;
      const before = cells[i-1], axis = Math.abs(cellIndex-before)===1 ? 1 : 2;
      used[before] |= axis; used[cellIndex] |= axis;
    });
    used[start] |= 2; used[goal] |= 2;
    const points = [[from.column*cell,from.row*cell],...cells.map(cellIndex=>
      [(cellIndex%columns+minColumn)*cell,(Math.floor(cellIndex/columns)+minRow)*cell]),[to.column*cell,to.row*cell]];
    return points.filter((point,i)=>i===0||i===points.length-1||
      !((points[i-1][0]===point[0]&&point[0]===points[i+1][0])||(points[i-1][1]===point[1]&&point[1]===points[i+1][1])));
  }
  const distance = pair => Math.abs(pair.from.column-pair.to.column)+Math.abs(pair.from.row-pair.to.row);
  const siteLinks = [...list].sort((p,q)=>distance(p)-distance(q)||diagramByText(p.a.name+p.b.name,q.a.name+q.b.name)).map(pair=>{
    // Overlapping another link is allowed only when no free corridor exists at all.
    const points = route(pair.from,pair.to,true) || route(pair.from,pair.to,false) ||
      [[pair.from.column*cell,pair.from.row*cell],[pair.to.column*cell,pair.to.row*cell]];
    const counts = new Map();
    for (const edge of pair.edges) if (edge.label) counts.set(edge.label,(counts.get(edge.label)||0)+1);
    const label = [...counts].sort((p,q)=>q[1]-p[1]||diagramByText(p[0],q[0]))[0]?.[0] || '';
    return {sites:[pair.a.name,pair.b.name],edges:pair.edges.map(edge=>edge.id),points,
      label:pair.edges.length>1?`${label} ×${pair.edges.length}`.trim():label};
  });
  return {siteLinks,siteBars:bars.map(bar=>({site:bar.block.name,
    points:[[bar.rootX,bar.hub],[bar.rootX,bar.row*cell]],bar:[[bar.columns[0]*cell,bar.row*cell],[bar.columns[1]*cell,bar.row*cell]]}))};
}

// Sites of one device (usually a VPS) are satellites: they stand in a band above the other sites, each
// near the sites it links to. The other sites are packed below with the proportions of the screen.
function diagramArrange(blocks, links, siteOf, aspect, gap) {
  const satellites = blocks.length>1 ? blocks.filter(block=>block.count===1&&block.name) : [];
  const sites = blocks.filter(block=>!satellites.includes(block));
  if (sites.length>1) diagramPack(sites,aspect,gap);
  else for (const block of sites) { block.x = gap/2; block.y = gap/2; }
  for (const block of satellites) block.satellite = true;
  if (!satellites.length) return;
  const width = sites.length ? Math.max(...sites.map(block=>block.x+block.width))+gap/2 : 0;
  const rootX = block => block.x+block.root.x, siteBlock = new Map(sites.map(block=>[block.name,block]));
  const target = new Map(satellites.map(block=>{
    const xs = links.flatMap(edge=>{
      const ends = [siteOf.get(edge.from_id),siteOf.get(edge.to_id)];
      const other = ends[0]===block.name ? ends[1] : ends[1]===block.name ? ends[0] : null;
      return siteBlock.has(other) ? [rootX(siteBlock.get(other))] : [];
    });
    return [block,xs.length ? xs.reduce((sum,x)=>sum+x,0)/xs.length : Infinity];
  }));
  satellites.sort((a,b)=>target.get(a)-target.get(b)||diagramByText(a.name,b.name));
  const rows = diagramRows(satellites,Math.max(width-gap,diagramRowLimit(satellites,gap,aspect*2)),gap);
  let y = gap/2;
  for (const row of rows) {
    let x = Math.max(gap/2,(width-row.width)/2);
    for (const block of row.items) { block.x = x; block.y = y+row.height-block.height; x += block.width+gap; }
    y += row.height+gap;
  }
  // Links fan into the sites below the band; each needs its own track there.
  const band = Math.max(gap,(Math.ceil(Math.max(0,...sites.map(block=>block.ports||0))*.6)+4)*diagramCell);
  for (const block of sites) block.y += y-gap/2+band-gap;
}

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
  const outside = new Map(), pairs = new Set();
  for (const edge of links) {
    const a = siteOf.get(edge.from_id), b = siteOf.get(edge.to_id);
    if (a===b) continue;
    pairs.add(a<b?`${a}\n${b}`:`${b}\n${a}`);
    for (const id of [edge.from_id,edge.to_id]) outside.set(id,(outside.get(id)||0)+1);
  }
  const footprint = [...groups.values()].flat().reduce((sum,{labels:{bounds:[l,t,r,b]}})=>sum+(r-l)*(b-t),0);
  const scale = groups.size>1 ? Math.min(4,Math.max(1,Math.sqrt(footprint)/700)) : 0;
  const captionHeight = 30*fontScale*scale;
  const blocks = [...groups].map(([name,entries])=>diagramSite(name,entries,
    links.filter(edge=>siteOf.get(edge.from_id)===name&&siteOf.get(edge.to_id)===name),outside,
    {height:captionHeight,width:scale?measure.caption(name||tr("Без площадки"),scale)+12:0}));
  // A site is wide enough for a port per link; corridors widen with the number of links between sites.
  for (const block of blocks) {
    const ports = [...pairs].filter(pair=>pair.split('\n').includes(block.name)).length;
    block.width = Math.max(block.width,(ports+1)*diagramCell);
    block.ports = ports;
  }
  const gap = Math.min(160,56+8*Math.ceil(Math.sqrt(pairs.size)));
  diagramArrange(blocks,links,siteOf,aspect,gap);
  const positions = new Map(), routes = new Map(), sites = [];
  const entryOf = new Map([...groups.values()].flat().map(entry=>[entry.node.id,entry]));
  for (const block of blocks) {
    for (const node of block.nodes) positions.set(node.id,diagramPosition(entryOf.get(node.id).labels,node.x+block.x,node.y+block.y));
    for (const wire of block.wires) routes.set(wire.edge,wire.points.map(([px,py])=>[px+block.x,py+block.y]));
    if (scale) sites.push({name:block.name,bounds:[block.x,block.y,block.x+block.width,block.y+block.height],
      caption:{x:block.x+block.caption.x,y:block.y,width:block.caption.width,height:captionHeight,scale}});
  }
  // Captions follow reading order: top to bottom, then left to right.
  sites.sort((a,b)=>a.bounds[1]-b.bounds[1]||a.bounds[0]-b.bounds[0]);
  return {positions,routes,sites,...diagramSiteLinks(links,siteOf,blocks)};
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
  const {rowHeight,rows} = layout, {x,y,width,channel} = rows[index];
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

function drawDiagramSiteBar({points,bar}) {
  const d = `M${points[0].join(' ')} L${points[1].join(' ')} M${bar[0].join(' ')} L${bar[1].join(' ')}`;
  return elem('path',{class:'diagram-site-bar',d});
}

function drawDiagramSiteLink({sites,edges,points,label}) {
  const group = elem('g',{class:'diagram-site-link'});
  const d = points.map(([x,y],i)=>`${i?'L':'M'}${x} ${y}`).join(' ');
  group.append(elem('path',{class:'diagram-site-link-path',d}),
    elem('title',{},`${sites.map(name=>name||tr("Без площадки")).join(' ↔ ')}${label?' · '+label:''}`));
  group.dataset.edges = edges.join(' ');
  return group;
}
