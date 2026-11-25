'use strict';

const diagramIcon = {width:66,height:52};
const diagramLabelY = 29;
const diagramSpacing = 12;
const diagramLabelLimit = 240;

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
  const nameWidth = Math.min(diagramLabelLimit, Math.ceil(measureName(node.name).width)+8);
  const nameHeight = 16*fontScale, rowHeight = 13*fontScale;
  let width = Math.max(diagramIcon.width+10,nameWidth);
  const rows = node.addresses.map(target=>{
    const channel = channels[node.address_channels?.[target]]?.short;
    const rowWidth = Math.min(diagramLabelLimit, Math.ceil((target.length*6.6+(channel?10+channel.length*5.8:0))*fontScale)+15);
    width = Math.max(width,rowWidth);
    return {width:rowWidth,channel};
  });
  return {nameWidth,nameHeight,rowHeight,rows, bounds:[-width/2,-30,width/2,diagramLabelY+nameHeight+rows.length*rowHeight]};
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

function layoutDiagram(nodes, viewport) {
  const layout = new Map(), placed = [];
  const style = getComputedStyle(viewport);
  const fontScale = Number(style.getPropertyValue('--font-scale')) || 1;
  const text = document.createElement('canvas').getContext('2d');
  text.font = `650 ${12*fontScale}px ${style.fontFamily}`;
  for (const node of nodes) {
    const {x,y} = node;
    const labels = diagramLabelSizes(node,fontScale,value=>text.measureText(value));
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
    const [placedX,placedY] = anchor;
    const extent = bounds.map((offset,index)=>offset+anchor[index%2]);
    placed.push(extent);
    layout.set(node.id,{...labels,x:placedX,y:placedY,bounds:extent});
  }
  return layout;
}

function diagramText(x, y, width, height, className, ...children) {
  const field = elem('foreignObject',{x,y,width,height,class:'diagram-text','aria-hidden':'true'});
  const line = html('div',className);
  line.append(...children);
  field.append(line);
  return field;
}

function drawDiagramNode(group, node, layout) {
  const {width,height} = diagramIcon, symbol = diagramSymbol(node.kind);
  const hit = elem('rect',{class:'diagram-symbol-hit',x:-width/2,y:-height/2,width,height,fill:'transparent'});
  const ring = elem('ellipse',{class:'diagram-selection',rx:width/2+4,ry:height/2+3});
  const iconClass = symbol.startsWith('icon-') ? 'node-icon diagram-outline-icon' : 'node-icon diagram-device-icon';
  const icon = elem('use',{class:iconClass,href:`#${symbol}`,x:-width/2,y:-height/2,width,height});
  const dot = elem('circle',{class:'diagram-status',cx:width/2-1,cy:-height/2+5,r:4});
  const title = elem('title');
  const {nameWidth,nameHeight} = layout;
  const nameHit = elem('rect',{x:-nameWidth/2,y:diagramLabelY,width:nameWidth,height:nameHeight,fill:'transparent'});
  group.append(hit,ring,icon,dot,nameHit,diagramText(-nameWidth/2,diagramLabelY,nameWidth,nameHeight,'diagram-name',node.name),title);
  return {content:group,icon,dot,title};
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

function diagramEdgePoints(points, from, to, layout) {
  const fromPoint = layout.get(from?.id), toPoint = layout.get(to?.id);
  const dx1 = fromPoint ? fromPoint.x-from.x : 0, dy1 = fromPoint ? fromPoint.y-from.y : 0;
  const dx2 = toPoint ? toPoint.x-to.x : 0, dy2 = toPoint ? toPoint.y-to.y : 0;
  if (!dx1&&!dy1&&!dx2&&!dy2) return points;
  // Keep free endpoints fixed and share the displacement across the intervening bends.
  return points.map(([x,y],index)=>{
    const t = index/(points.length-1);
    return [x+dx1*(1-t)+dx2*t, y+dy1*(1-t)+dy2*t];
  });
}
