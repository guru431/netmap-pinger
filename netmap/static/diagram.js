'use strict';

const diagramIcon = {width:60,height:47};
const diagramLabelY = diagramIcon.height/2+3;
const diagramSpacing = 12;
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

// Spring embedder in the spirit of Fruchterman–Reingold. Items carry x, y (start and result),
// links are [index, index, weight]. No randomness: equal input always gives equal output.
function relaxDiagram(items, links, k, aspect, iterations) {
  if (items.length < 2) return;
  const gx = 2/Math.sqrt(aspect), gy = 2*Math.sqrt(aspect);
  const cx = diagramMean(items.map(item=>item.x)), cy = diagramMean(items.map(item=>item.y));
  for (let step=0; step<iterations; step++) {
    const temperature = k*1.5*(1-step/iterations)+1;
    const moves = items.map(item=>[-(item.x-cx)*gx,-(item.y-cy)*gy]);
    for (let i=0; i<items.length; i++) {
      for (let j=i+1; j<items.length; j++) {
        let dx = items[i].x-items[j].x, dy = items[i].y-items[j].y;
        if (Math.abs(dx)+Math.abs(dy) < .01) { dx = Math.cos(i+j); dy = Math.sin(i+j); }
        const distance2 = dx*dx+dy*dy, force = k*k/distance2;
        moves[i][0]+=dx*force; moves[i][1]+=dy*force;
        moves[j][0]-=dx*force; moves[j][1]-=dy*force;
      }
    }
    for (const [i,j,weight] of links) {
      const dx = items[i].x-items[j].x, dy = items[i].y-items[j].y;
      const distance = Math.hypot(dx,dy) || 1, force = weight*distance/k;
      moves[i][0]-=dx*force; moves[i][1]-=dy*force;
      moves[j][0]+=dx*force; moves[j][1]+=dy*force;
    }
    items.forEach((item,index)=>{
      const [mx,my] = moves[index], length = Math.hypot(mx,my);
      if (!length) return;
      const scale = Math.min(length,temperature)/length;
      item.x += mx*scale; item.y += my*scale;
    });
  }
}

// Greedy pass that guarantees free space: items nearest to the centre keep their place,
// the rest take the first free point on an outward spiral stretched to the screen proportions.
function placeWithoutOverlap(items, gap, aspect) {
  const cx = diagramMean(items.map(item=>item.x)), cy = diagramMean(items.map(item=>item.y));
  const order = [...items].sort((a,b)=>Math.hypot(a.x-cx,a.y-cy)-Math.hypot(b.x-cx,b.y-cy)||diagramByText(a.key,b.key));
  const placed = [], stretch = Math.sqrt(aspect), step = 6;
  const free = ([l,t,r,b]) => placed.every(([pl,pt,pr,pb])=>r+gap<=pl||pr+gap<=l||b+gap<=pt||pb+gap<=t);
  for (const item of order) {
    const [l,t,r,b] = item.bounds;
    search: for (let radius=0;; radius+=step) {
      const count = radius ? Math.ceil(2*Math.PI*radius/step) : 1;
      for (let index=0; index<count; index++) {
        const angle = index/count*2*Math.PI;
        const x = item.x+radius*Math.cos(angle)*stretch, y = item.y+radius*Math.sin(angle)/stretch;
        if (free([l+x,t+y,r+x,b+y])) { item.x=x; item.y=y; break search; }
      }
    }
    placed.push([l+item.x,t+item.y,r+item.x,b+item.y]);
  }
}

// Spread starting points so the group keeps the arrangement from the classic map at diagram scale.
function diagramStart(entries, k) {
  const xs = entries.map(({node})=>node.x), ys = entries.map(({node})=>node.y);
  const cx = diagramMean(xs), cy = diagramMean(ys);
  const spread = Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
  const scale = spread ? Math.min(8,Math.max(.5,k*Math.sqrt(entries.length)/spread)) : 1;
  const taken = new Map();
  return entries.map(({node},index)=>{
    let x = (node.x-cx)*scale, y = (node.y-cy)*scale;
    const key = `${Math.round(x)}:${Math.round(y)}`, repeat = taken.get(key) || 0;
    taken.set(key,repeat+1);
    // Stacked imported icons unfold along a golden-angle spiral, in a stable order.
    if (repeat) { x += Math.cos(repeat*2.39996)*k*.5*Math.sqrt(repeat); y += Math.sin(repeat*2.39996)*k*.5*Math.sqrt(repeat); }
    return {key:node.id,x,y,index};
  });
}

function layoutDiagramGroup(entries, links, aspect) {
  const k = diagramMean(entries.map(({labels:{bounds:[l,t,r,b]}})=>Math.hypot(r-l,b-t)))*.6+diagramSpacing;
  const items = diagramStart(entries,k), index = new Map(entries.map(({node},i)=>[node.id,i]));
  relaxDiagram(items,links.map(edge=>[index.get(edge.from_id),index.get(edge.to_id),1]),k,aspect,160);
  items.forEach((item,i)=>{ item.bounds = entries[i].labels.bounds; });
  placeWithoutOverlap(items,diagramSpacing,aspect);
  return items;
}

// Two-level layout: devices inside each site, then the sites as blocks with a caption and no frame.
function layoutDiagram(nodes, edges, viewport) {
  const style = getComputedStyle(viewport);
  const fontScale = Number(style.getPropertyValue('--font-scale')) || 1;
  // Only the window orientation shapes the layout: open panels must not move devices around.
  const aspect = innerWidth>=innerHeight ? 1.6 : .8;
  const measure = diagramMeasure(style.fontFamily,fontScale), groups = new Map(), siteOf = new Map();
  for (const node of [...nodes].sort((a,b)=>diagramByText(a.id,b.id))) {
    const site = node.site || '';
    if (!groups.has(site)) groups.set(site,[]);
    groups.get(site).push({node,labels:diagramLabelSizes(node,fontScale,measure)});
    siteOf.set(node.id,site);
  }
  const links = edges.filter(edge=>siteOf.has(edge.from_id)&&siteOf.has(edge.to_id)&&edge.from_id!==edge.to_id);
  const laid = [...groups].sort(([a],[b])=>(a==='')-(b==='')||a.localeCompare(b,uiLocale,{numeric:true})).map(([name,entries])=>{
    const items = layoutDiagramGroup(entries,links.filter(edge=>siteOf.get(edge.from_id)===name&&siteOf.get(edge.to_id)===name),aspect);
    return {name,entries,items,
      left:Math.min(...items.map(item=>item.x+item.bounds[0])),right:Math.max(...items.map(item=>item.x+item.bounds[2])),
      top:Math.min(...items.map(item=>item.y+item.bounds[1])),bottom:Math.max(...items.map(item=>item.y+item.bounds[3]))};
  });
  // Site captions grow with the whole diagram so they stay legible when it is fitted on screen.
  const area = laid.reduce((sum,group)=>sum+(group.right-group.left)*(group.bottom-group.top),0);
  const captionScale = Math.min(4,Math.max(1,Math.sqrt(area*2)/1400));
  const captionHeight = groups.size>1 ? 30*fontScale*captionScale : 0;
  const blocks = laid.map(({name,entries,items,left,right,top,bottom})=>{
    const x = (left+right)/2, captionWidth = captionHeight ? measure.caption(name||tr("Без площадки"),captionScale)+16 : 0;
    const half = Math.max(right-left,captionWidth)/2, y = (top-captionHeight+bottom)/2;
    return {name,entries,items,key:name,local:[x,y],bounds:[-half,top-captionHeight-y,half,bottom-y],
      start:[diagramMean(entries.map(({node})=>node.x)),diagramMean(entries.map(({node})=>node.y))]};
  });
  if (blocks.length>1) {
    const k = diagramMean(blocks.map(({bounds:[l,t,r,b]})=>Math.hypot(r-l,b-t)))*.6;
    const xs = blocks.map(block=>block.start[0]), ys = blocks.map(block=>block.start[1]);
    const spread = Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
    const scale = spread ? Math.max(1,k*Math.sqrt(blocks.length)/spread) : 1;
    blocks.forEach((block,i)=>{ block.x = block.start[0]*scale+Math.cos(i*2.39996); block.y = block.start[1]*scale+Math.sin(i*2.39996); });
    const index = new Map(blocks.map((block,i)=>[block.name,i])), weights = new Map();
    for (const edge of links) {
      const a = index.get(siteOf.get(edge.from_id)), b = index.get(siteOf.get(edge.to_id));
      if (a===b) continue;
      const key = a<b ? `${a}:${b}` : `${b}:${a}`;
      weights.set(key,(weights.get(key)||0)+1);
    }
    const blockLinks = [...weights].map(([key,count])=>[...key.split(':').map(Number),Math.min(3,count)]);
    relaxDiagram(blocks,blockLinks,k,aspect,120);
    placeWithoutOverlap(blocks,56,aspect);
  } else if (blocks.length) { blocks[0].x = blocks[0].local[0]; blocks[0].y = blocks[0].local[1]; }
  const positions = new Map(), sites = [];
  for (const block of blocks) {
    const dx = block.x-block.local[0], dy = block.y-block.local[1];
    block.items.forEach((item,i)=>positions.set(item.key,diagramPosition(block.entries[i].labels,item.x+dx,item.y+dy)));
    const [l,t,r,b] = block.bounds.map((value,i)=>value+(i%2?block.y:block.x));
    if (captionHeight) sites.push({name:block.name,bounds:[l,t,r,b],caption:{x:l,y:t,width:r-l,height:captionHeight,scale:captionScale}});
  }
  return {positions,sites};
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

function diagramEdgePoints(points, from, to, layout, grouped) {
  const fromPoint = layout.get(from?.id), toPoint = layout.get(to?.id);
  if (grouped) {
    if (fromPoint&&toPoint) return [[fromPoint.x,fromPoint.y],[toPoint.x,toPoint.y]];
    const attached=fromPoint||toPoint;
    if (attached) {
      const [px,py]=points[0], [qx,qy]=points.at(-1);
      const length=Math.hypot(qx-px,qy-py);
      const dx=length?(qx-px)*49/length:49, dy=length?(qy-py)*49/length:0;
      const {x,y}=attached;
      return fromPoint?[[x,y],[x+dx,y+dy]]:[[x-dx,y-dy],[x,y]];
    }
  }
  const dx1 = fromPoint ? fromPoint.x-from.x : 0, dy1 = fromPoint ? fromPoint.y-from.y : 0;
  const dx2 = toPoint ? toPoint.x-to.x : 0, dy2 = toPoint ? toPoint.y-to.y : 0;
  if (!dx1&&!dy1&&!dx2&&!dy2) return points;
  // Keep free endpoints fixed and share the displacement across the intervening bends.
  return points.map(([x,y],index)=>{
    const t = index/(points.length-1);
    return [x+dx1*(1-t)+dx2*t, y+dy1*(1-t)+dy2*t];
  });
}
