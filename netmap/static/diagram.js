'use strict';

// Draw more compactly in the existing map coordinates so both views share the editor.
const diagramScale = .5;
const diagramWidth = 212, diagramLeft = -diagramWidth / 2;
const diagramTop = -23, diagramHeader = 46, diagramRow = 18;

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
  if (/computer|workstation|desktop|laptop|notebook|компьютер|станция/.test(type)) return 'icon-computer';
  if (/cloud|internet|network$|облако|интернет|^сеть$/.test(type)) return 'diagram-cloud';
  return 'diagram-device';
}

function diagramHeight(node) {
  return diagramHeader + node.addresses.length * diagramRow;
}

function diagramBounds(node, [x,y] = [node.x,node.y]) {
  return [x+diagramLeft*diagramScale, y+diagramTop*diagramScale,
    x-diagramLeft*diagramScale, y+(diagramTop+diagramHeight(node))*diagramScale];
}

function diagramText(x, y, width, height, className, ...children) {
  const field = elem('foreignObject',{x,y,width,height,class:'diagram-text','aria-hidden':'true'});
  const line = html('div',className);
  line.append(...children);
  field.append(line);
  return field;
}

function drawDiagramNode(group, node) {
  const content = elem('g',{transform:`scale(${diagramScale})`});
  const box = elem('rect',{class:'node-box',x:diagramLeft,y:diagramTop,width:diagramWidth,height:diagramHeight(node),rx:5});
  const icon = elem('use',{class:'node-icon',href:`#${diagramSymbol(node.kind)}`,x:-96,y:-16,width:32,height:32});
  const dot = elem('circle',{class:'diagram-status',cx:94,cy:-10,r:4});
  const title = elem('title');
  const caption = [node.kind,node.site].filter(Boolean).join(' · ');
  content.append(box, icon, dot,
    diagramText(-55,caption?-19:-10,142,21,'diagram-name',node.name));
  if (caption) content.append(diagramText(-55,2,150,18,'diagram-caption',caption));
  group.append(content,title);
  return {content,icon,dot,title};
}

function drawDiagramAddress(node, target, index) {
  const y = diagramTop + diagramHeader + index*diagramRow;
  const point = elem('g',{class:'address-point diagram-address',transform:`translate(0 ${y})`});
  const hit = elem('rect',{class:'diagram-address-hit',x:diagramLeft+1,y:0,width:diagramWidth-2,height:diagramRow});
  const separator = elem('path',{class:'diagram-address-rule',d:`M${diagramLeft+1} 0H${-diagramLeft-1}`});
  const circle = elem('circle',{cx:-94,cy:diagramRow/2,r:3,fill:colors.unknown});
  const labels = [html('span','diagram-target',target)];
  const channel = channels[node.address_channels?.[target]]?.short;
  if (channel) labels.push(html('span','diagram-channel',channel));
  point.append(hit,separator,circle,diagramText(-85,0,182,diagramRow,'diagram-address-label',...labels));
  return {point,circle};
}

function trimDiagramStart(points, [left,top,right,bottom]) {
  const index = points.findIndex(([x,y])=>x<left||x>right||y<top||y>bottom);
  if (index <= 0) return points;
  const [x,y] = points[index-1], [nextX,nextY] = points[index];
  const dx = nextX-x, dy = nextY-y;
  const tx = dx ? ((dx>0?right:left)-x)/dx : Infinity;
  const ty = dy ? ((dy>0?bottom:top)-y)/dy : Infinity;
  const t = Math.min(tx,ty);
  return [[x+dx*t,y+dy*t],...points.slice(index)];
}

function diagramEdgePoints(points, from, to) {
  const start = from && diagramBounds(from,points[0]);
  const end = to && diagramBounds(to,points.at(-1));
  // Leave the stroke behind overlapping devices to keep the visible segments in order.
  if (start && end && start[0]<=end[2] && end[0]<=start[2] && start[1]<=end[3] && end[1]<=start[3]) return points;
  const route = start ? trimDiagramStart(points,start) : points;
  return end ? trimDiagramStart(route.slice().reverse(),end).reverse() : route;
}
