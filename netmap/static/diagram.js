'use strict';

const diagramIcon = {width:66,height:52};
const diagramLabelY = 29;
const diagramSpacing = 12;
const diagramLabelLimit = 176;
const diagramStatusMarks = {up:'✓',partial:'!',down:'×',error:'!',paused:'Ⅱ',unmonitored:'–',optional:'–',stale:'?',unknown:'?',gap:'?'};

function diagramSymbol(kind) {
  const type = kind.toLowerCase();
  if (/firewall|pfsense|opnsense|межсетев|фа[йе]рвол/.test(type)) return 'diagram-firewall';
  if (/switch|bridge|^hub$|коммутатор/.test(type)) return 'diagram-switch';
  if (/router|gateway|маршрутизатор|шлюз/.test(type)) return 'diagram-router';
  if (/access.?point|wireless ap|^ap$|точка доступа|wi[ -]?fi/.test(type)) return 'diagram-access-point';
  if (/\bnas\b|storage|disk array|хранилище/.test(type)) return 'diagram-storage';
  if (/server|mainframe|hypervisor|^vps$|сервер/.test(type)) return 'diagram-server';
  if (/print|принтер/.test(type)) return 'icon-printer';
  if (/camera|камер/.test(type)) return 'icon-camera';
  if (/phone|pda|телефон/.test(type)) return 'icon-phone';
  if (/computer|workstation|desktop|laptop|notebook|компьютер|станция/.test(type)) return 'diagram-workstation';
  if (/cloud|internet|network$|^vpn$|облако|интернет|^сеть$/.test(type)) return 'diagram-cloud';
  return 'diagram-device';
}

function diagramLabelSizes(node, fontScale, measureName) {
  const more = node.addresses.length>1 ? `+${node.addresses.length-1}` : '';
  const titleWidth = Math.ceil(measureName(node.name).width)+(more?Math.ceil(measureName(more).width)+12:0);
  const nameWidth = Math.min(diagramLabelLimit,titleWidth+8);
  const nameHeight = 16*fontScale, rowHeight = 13*fontScale;
  let width = Math.max(diagramIcon.width+14,nameWidth);
  const rows = node.addresses.slice(0,1).map(target=>{
    const channel = channels[node.address_channels?.[target]]?.short;
    const rowWidth = Math.min(diagramLabelLimit, Math.ceil((target.length*6.6+(channel?10+channel.length*5.8:0))*fontScale)+15);
    width = Math.max(width,rowWidth);
    return {width:rowWidth,channel};
  });
  return {nameWidth,nameHeight,rowHeight,rows,more,bounds:[-width/2,-31,width/2,diagramLabelY+nameHeight+rows.length*rowHeight]};
}

function closestFreeDiagramCoordinate(position, bounds, placed, axis) {
  const other = 1-axis, intervals = [];
  for (const box of placed) {
    if (position[other]+bounds[other+2]+diagramSpacing<=box[other] ||
        position[other]+bounds[other]>=box[other+2]+diagramSpacing) continue;
    intervals.push([box[axis]-bounds[axis+2]-diagramSpacing,box[axis+2]-bounds[axis]+diagramSpacing]);
  }
  const target = position[axis];
  if (!intervals.some(([start,end])=>start<target&&target<end)) return target;

  // Merge blocked intervals until the full occupied span containing the target is known.
  intervals.sort(([a],[b])=>a-b);
  let left = -Infinity, right = -Infinity;
  for (const [start,end] of intervals) {
    if (start<right) right=Math.max(right,end);
    else {
      if (left<target&&target<right) break;
      left=start; right=end;
    }
  }
  return right-target<=target-left ? right : left;
}

function layoutDiagram(nodes, viewport, grouped) {
  const style = getComputedStyle(viewport);
  const fontScale = Number(style.getPropertyValue('--font-scale')) || 1;
  const text = document.createElement('canvas').getContext('2d');
  text.font = `650 ${12*fontScale}px ${style.fontFamily}`;
  const entries = nodes.map(node=>({node,labels:diagramLabelSizes(node,fontScale,value=>text.measureText(value))}));
  if (grouped) return layoutDiagramSites(entries,fontScale);

  const positions = new Map(), placed = [];
  for (const {node,labels} of entries) {
    const {x,y} = node;
    const bounds = labels.bounds;
    let anchor = [closestFreeDiagramCoordinate([x,y],bounds,placed,0),y];
    let distance = Math.abs(anchor[0]-x);
    if (distance) {
      // Also try moving up/down and fitting in the nearest rows to avoid one long chain.
      const rowStep = bounds[3]-bounds[1]+diagramSpacing;
      const vertical = [x,closestFreeDiagramCoordinate([x,y],bounds,placed,1)];
      const rows = [y-rowStep,y+rowStep].map(row=>[closestFreeDiagramCoordinate([x,row],bounds,placed,0),row]);
      for (const candidate of [vertical,...rows]) {
        const shift = Math.hypot(candidate[0]-x,candidate[1]-y);
        if (shift<distance) { anchor=candidate; distance=shift; }
      }
    }
    const position = diagramPosition(labels,...anchor);
    placed.push(position.bounds);
    positions.set(node.id,position);
  }
  return {positions,sites:[]};
}

function diagramPosition(labels, x, y) {
  const [l,t,r,b] = labels.bounds;
  return {...labels,x,y,bounds:[l+x,t+y,r+x,b+y]};
}

function layoutDiagramSites(entries, fontScale) {
  const grouped = new Map(), positions = new Map(), sites = [];
  const pad = 16, gap = 24, header = 28*fontScale;
  for (const entry of entries) {
    const site = entry.node.site || '';
    if (!grouped.has(site)) grouped.set(site,[]);
    grouped.get(site).push(entry);
  }
  const blocks = [...grouped].map(([name,members])=>{
    const columns = Math.min(8,members.length,Math.ceil(Math.sqrt(members.length*1.25)));
    let cellWidth = 104, cellHeight = 100;
    for (const {labels:{bounds:[left,top,right,bottom]}} of members) {
      cellWidth = Math.max(cellWidth,right-left+diagramSpacing);
      cellHeight = Math.max(cellHeight,bottom-top+diagramSpacing);
    }
    members.sort((a,b)=>a.node.name.localeCompare(b.node.name,uiLocale,{numeric:true}));
    return {name,members,columns,cellWidth,cellHeight,width:Math.max(168,columns*cellWidth+2*pad),
      height:header+gap+Math.ceil(members.length/columns)*cellHeight};
  });
  blocks.sort((a,b)=>b.height-a.height||a.name.localeCompare(b.name,uiLocale,{numeric:true}));
  const area=blocks.reduce((sum,b)=>sum+(b.width+gap)*(b.height+gap),0);
  const widest=blocks.reduce((max,b)=>Math.max(max,b.width+gap),0);
  const skyline=Array(Math.ceil(Math.max(widest,Math.sqrt(1.6*area))/gap)).fill(0);
  for (const {name,members,columns,cellWidth,cellHeight,width,height} of blocks) {
    const span=Math.ceil((width+gap)/gap);
    let column=0,y=Infinity;
    for(let i=0;i+span<=skyline.length;i++){
      let top=0;
      for(let j=i;j<i+span;j++)top=Math.max(top,skyline[j]);
      if(top<y){column=i;y=top;}
    }
    const x=column*gap;
    skyline.fill(y+height+gap,column,column+span);
    const bounds = [x,y,x+width,y+height];
    sites.push({name,bounds,header,count:members.length});
    members.forEach(({node,labels},index)=>{
      const nodeX = x+(width-columns*cellWidth)/2+(index%columns+.5)*cellWidth;
      const nodeY = y+header+pad-labels.bounds[1]+Math.floor(index/columns)*cellHeight;
      positions.set(node.id,diagramPosition(labels,nodeX,nodeY));
    });
  }
  return {positions,sites};
}

function diagramText(x, y, width, height, className, ...children) {
  const field = elem('foreignObject',{x,y,width,height,class:'diagram-text','aria-hidden':'true'});
  const line = html('div',className);
  line.append(...children);
  field.append(line);
  return field;
}

function drawDiagramSite({name,bounds:[x,y,right,bottom],header,count}, onFocus) {
  const width=right-x, label=name||tr("Без площадки");
  const group=elem('g',{class:'diagram-site'});
  const title=elem('g',{class:'diagram-site-title',tabindex:'0',role:'button','aria-label':tr("Приблизить площадку {0}", label)});
  title.append(elem('rect',{x,y,width,height:header,rx:7,fill:'transparent'}),elem('title',{},label),
    diagramText(x+10,y,width-20,header,'diagram-site-label',html('span','diagram-ellipsis',label),html('span','diagram-site-count',String(count))));
  title.addEventListener('click',onFocus);
  title.addEventListener('keydown',event=>{
    if(event.key==='Enter'||event.key===' '){event.preventDefault();onFocus();}
  });
  group.append(elem('rect',{class:'diagram-site-area',x,y,width,height:bottom-y,rx:7}),title);
  return group;
}

function drawDiagramNode(group, node, layout) {
  const {width,height} = diagramIcon, symbol = diagramSymbol(node.kind);
  const hit = elem('rect',{class:'diagram-symbol-hit',x:-width/2,y:-height/2,width,height,fill:'transparent'});
  const ring = elem('ellipse',{class:'diagram-selection',rx:width/2+6,ry:height/2+4});
  const stateRing = elem('ellipse',{class:'diagram-state-ring',rx:width/2+2,ry:height/2});
  const iconClass = symbol.startsWith('icon-') ? 'node-icon diagram-outline-icon' : 'node-icon diagram-device-icon';
  const icon = elem('use',{class:iconClass,href:`#${symbol}`,x:-width/2,y:-height/2,width,height});
  const badgeX=width/2-1, badgeY=-height/2+5;
  const dot = elem('circle',{class:'diagram-status',cx:badgeX,cy:badgeY,r:8});
  const mark = elem('text',{class:'diagram-status-mark',x:badgeX,y:badgeY,'text-anchor':'middle','dominant-baseline':'central','aria-hidden':'true'});
  const title = elem('title');
  const {nameWidth,nameHeight,more} = layout;
  const nameHit = elem('rect',{x:-nameWidth/2,y:diagramLabelY,width:nameWidth,height:nameHeight,fill:'transparent'});
  const caption=[html('span','diagram-ellipsis',node.name)];
  if(more)caption.push(html('span','diagram-more',more));
  group.append(hit,ring,stateRing,icon,dot,mark,nameHit,diagramText(-nameWidth/2,diagramLabelY,nameWidth,nameHeight,'diagram-name',...caption),title);
  return {content:group,icon,dot,title,stateRing,mark};
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
