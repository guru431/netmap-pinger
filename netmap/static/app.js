'use strict';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
const labels = {up:tr("Доступен"), partial:tr("Частично доступен"), down:tr("Недоступен"), unknown:tr("Ещё не проверен"), stale:tr("Данные устарели"), error:tr("Ошибка проверки"), paused:tr("Мониторинг приостановлен"), unmonitored:tr("Без мониторинга"), gap:tr("Нет измерений"), optional:tr("Недоступность допускается")};
const colors = {up:'var(--up)', partial:'var(--partial)', down:'var(--down)', unknown:'var(--quiet)', stale:'var(--stale)', error:'var(--probe-error)', paused:'var(--quiet)', unmonitored:'var(--quiet)', gap:'var(--quiet)', optional:'var(--stale)'};
const channels = {
  wan:{label:tr("Внешний (WAN)"),short:'WAN'}, lan:{label:tr("Локальная сеть (LAN)"),short:'LAN'},
  'sites-vpn':{label:tr("Площадки через VPN"),short:'VPN'}, openvpn:{label:'VPN OpenVPN',short:'OVPN'},
  'wg-my':{label:tr("VPN WireGuard · личные"),short:'WG'}, 'wg-work':{label:tr("VPN WireGuard · рабочие"),short:'WG'},
  internet:{label:tr("Публичный интернет"),short:'INET'}
};
const channelLabels = Object.fromEntries(Object.entries(channels).map(([key,{label}])=>[key,label]));
let state = null, graph = null, selected = null, renderedRevision = -1, editLayout = false, detailsOpen = false;
let view = {x:-50, y:-50, w:1400, h:1000}, drag = null, saving = false, loading = false, online = false;
let nodeElements = new Map(), edgeElements = new Map(), listElements = new Map(), toastTimer;
let addressElements = new Map();
let autoFit = true, diagnosticController = null;
let passwordChanged = false;
const nodeMoveDirections = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
const keyboardMoves = [];
const layoutSelection = new Set();
let groupSelect = false;
let movingWithKeyboard = false;
const touchPointers = new Map();
let pinch = null, blockMapClick = false;
const svg = $('map');
let diagramView = false;
let diagramLayout = new Map(), diagramSites = [], diagramRoutes = new Map();
const mapViewKey = 'netmap-map-view';
const editLayoutTitle = $('edit-layout').title;

function elem(tag, attrs = {}, text = null) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== null) el.textContent = text;
  return el;
}
function html(tag, className = '', text = '') {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
}
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 7000);
}
async function api(path, options = {}) {
  const response = await fetch(mapEndpoint(path), {signal:AbortSignal.timeout(8000), ...options, headers:{'X-Netmap-Request':'1', ...options.headers}});
  if (!response.ok) {
    let message = tr("Ошибка сервера ({0})", response.status);
    try { const data = await response.json(); message = typeof data.detail === 'string' ? serverMessage(data.detail) : tr("Проверьте адреса и значения полей"); } catch (_) { /* HTTP errors without JSON */ }
    throw Object.assign(new Error(message),{status:response.status});
  }
  return response.json();
}
async function change(mutator, revision = graph?.revision) {
  if(!canEditMap())return false;
  if (saving || !graph || !online) { toast(tr("Дождитесь подключения и завершения сохранения")); return false; }
  if (revision !== graph.revision) { toast(tr("Карта изменилась. Закройте редактор и откройте его заново.")); return false; }
  const next = structuredClone(graph); mutator(next); saving = true;
  try {
    const saved = await api('api/map', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(next)});
    graph = saved; if (state) state.graph = saved;
    drawGraph(); updateState(); toast(tr("Карта сохранена")); return true;
  } catch (error) { toast(error.message); return false; }
  finally { saving = false; flushKeyboardMoves(); }
}
function rawStatusFor(id) {
  const value = state?.nodes[id]?.status || 'unknown';
  return !online && ['up','partial','down'].includes(value) ? 'stale' : value;
}
function displayStatus(node,status) {
  return node?.allow_offline&&status!=='up'?'optional':status;
}
function statusFor(id) {
  return displayStatus(graph?.nodes.find(n=>n.id===id),rawStatusFor(id));
}
function nodeStatusLabel(node) {
  return labels[rawStatusFor(node.id)]+(node.allow_offline?tr(" · недоступность допускается"):'');
}
function filteredNodes() {
  const query = $('search').value.trim().toLowerCase(), filter = $('filter').value;
  return (graph?.nodes || []).filter(n => {
    const status = rawStatusFor(n.id);
    return (!query || [n.name, n.kind, n.notes, n.site, ...n.addresses, ...Object.values(n.address_comments||{})].join(' ').toLowerCase().includes(query)) &&
      (filter === 'all' || (filter === 'optional' ? n.allow_offline : filter === 'problem' ? !n.allow_offline&&['down','partial','error','stale'].includes(status) : status === filter));
  });
}
function iconFor(kind) {
  const k = kind.toLowerCase();
  if (/print/.test(k)) return 'printer';
  if (/camera/.test(k)) return 'camera';
  if (/phone|pda/.test(k)) return 'phone';
  if (/router|switch|hub|modem|bridge|multiplex/.test(k)) return 'router';
  if (/internet|city|town|satellite|network$/.test(k)) return 'globe';
  if (/server|mainframe/.test(k)) return 'server';
  return 'computer';
}
function viewChanged() { svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`); }
function fit() {
  if (!graph?.nodes.length) return;
  autoFit = true;
  if (diagramView) {
    $('diagram-site').value='';
    view = diagramViewport(graph.nodes,[],{sites:diagramSites});
    viewChanged();
    return;
  }
  const points = graph.nodes.map(n => [n.x,n.y]).concat(graph.edges.flatMap(e => e.points));
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs)-70, y = Math.min(...ys)-55;
  const w = Math.max(200, Math.max(...xs)-x+90), h = Math.max(150, Math.max(...ys)-y+70);
  view = {x,y,w,h}; viewChanged();
}
function mapNodePosition(node) {
  return diagramLayout.get(node.id) ?? node;
}
function mapNodeTransform(node, dx=0, dy=0) {
  const {x,y}=mapNodePosition(node);
  return `translate(${x+dx} ${y+dy})`;
}
function diagramViewport(nodes, edges = [], {padding=24,minWidth=200,minHeight=150,sites=[]} = {}) {
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  const include=([x1,y1,x2=x1,y2=y1])=>{
    left=Math.min(left,x1);top=Math.min(top,y1);right=Math.max(right,x2);bottom=Math.max(bottom,y2);
  };
  for (const node of nodes) include(diagramLayout.get(node.id).bounds);
  for (const edge of edges) for (const point of edgeElements.get(edge.id).points) include(point);
  for (const site of sites) include(site.bounds);
  const w=Math.max(minWidth,right-left+padding*2),h=Math.max(minHeight,bottom-top+padding*2);
  return {x:(left+right-w)/2,y:(top+bottom-h)/2,w,h};
}
function focusDiagramSite(site) {
  $('diagram-site').value=`site:${site.name}`;
  autoFit=false; view=diagramViewport([],[],{sites:[site]}); viewChanged();
}
function renderMapView(useDiagram) {
  diagramView = useDiagram;
  $('view-classic').setAttribute('aria-pressed',String(!useDiagram));
  $('view-diagram').setAttribute('aria-pressed',String(useDiagram));
  $('diagram-site').hidden=!useDiagram;
  $('edit-layout').disabled=useDiagram;
  $('edit-layout').title=useDiagram?tr("На схеме узлы расставляются автоматически. Двигать узлы можно в режиме «Карта»."):editLayoutTitle;
  svg.parentElement.classList.toggle('diagram',useDiagram);
}
function switchMapView(useDiagram) {
  if (diagramView === useDiagram) return;
  cancelMapGesture();
  if (useDiagram && editLayout) setEditLayout(false);
  renderMapView(useDiagram);
  autoFit=true;
  try { localStorage.setItem(mapViewKey,useDiagram?'diagram':'classic'); } catch { /* Optional preference. */ }
  redrawMapView();
}
function redrawMapView() {
  drawGraph(); updateState();
  if(typeof applyWatchIncident==='function')applyWatchIncident();
}
try { renderMapView(localStorage.getItem(mapViewKey) === 'diagram'); } catch { /* Use the classic view. */ }
document.documentElement.addEventListener('netmap-font-size-change',()=>{
  if(!diagramView||!graph)return;
  cancelMapGesture(); redrawMapView();
});

function edgePoints(edge, overrides = new Map(), from = graph.nodes.find(n=>n.id===edge.from_id), to = graph.nodes.find(n=>n.id===edge.to_id)) {
  if (edge.points.length >= 2) {
    const pts = edge.points.map(p => [...p]);
    const fromMove = overrides.get(edge.from_id), toMove = overrides.get(edge.to_id);
    if(fromMove&&toMove&&fromMove.dx===toMove.dx&&fromMove.dy===toMove.dy){
      for(const point of pts){point[0]+=fromMove.dx;point[1]+=fromMove.dy;}
    }
    for (const [node, index] of [[from,0],[to,pts.length-1]]) {
      if (node) {
        const d = overrides.get(node.id) || {dx:0,dy:0};
        pts[index] = [node.x+d.dx,node.y+d.dy];
      }
    }
    return pts;
  }
  return [from,to].map(n => {
    const d = overrides.get(n.id) || {dx:0,dy:0};
    return [n.x+d.dx,n.y+d.dy];
  });
}
function updateEdgeGeometry(edge, refs, overrides = new Map()) {
  const pts = diagramView ? diagramEdgePoints(edge,refs.from,refs.to,diagramLayout,diagramRoutes) : edgePoints(edge,overrides,refs.from,refs.to);
  const path = pts.map((p,i) => `${i?'L':'M'}${p[0]} ${p[1]}`).join(' ');
  refs.points = pts;
  refs.path.setAttribute('d',path); refs.hit.setAttribute('d',path);
  const middle = pts[Math.floor((pts.length-1)/2)], end = pts[Math.ceil((pts.length-1)/2)];
  refs.label.setAttribute('x',(middle[0]+end[0])/2); refs.label.setAttribute('y',(middle[1]+end[1])/2-4);
}
function drawClassicNode(group, node) {
  const box = elem('rect',{class:'node-box',x:-18,y:-18,width:36,height:36,rx:9});
  const icon = elem('use',{class:'node-icon',href:`#icon-${iconFor(node.kind)}`,x:-11,y:-11,width:22,height:22});
  const dot = elem('circle',{cx:15,cy:-15,r:4,stroke:'#fff','stroke-width':1.4});
  const name = elem('text',{class:'node-name',y:30,'text-anchor':'middle'},node.name.length>24?node.name.slice(0,23)+'…':node.name);
  const address = elem('text',{class:'node-address',y:41,'text-anchor':'middle'},node.addresses[0]||'');
  const title = elem('title'); group.append(box,icon,dot,name,address,title);
  return {content:group,icon,dot,title};
}
function drawClassicAddress(node, index) {
  const columns=Math.min(8,node.addresses.length),column=index%8,row=Math.floor(index/8);
  const point=elem('g',{class:'address-point',transform:`translate(${(column-(columns-1)/2)*8} ${49+row*8})`});
  const hit=elem('rect',{x:-4,y:-4,width:8,height:8,fill:'transparent'});
  const circle=elem('circle',{r:3,fill:colors.unknown,stroke:'#fff','stroke-width':.7});
  point.append(hit,circle);
  return {point,circle};
}
function drawGraph() {
  if (!graph) return;
  const first = renderedRevision < 0;
  $('node-layer').replaceChildren(); $('edge-layer').replaceChildren(); $('site-layer').replaceChildren();
  nodeElements.clear(); edgeElements.clear();
  const layout=diagramView ? layoutDiagram(graph.nodes,graph.edges,svg) : {positions:new Map(),sites:[]};
  diagramLayout=layout.positions; diagramSites=layout.sites; diagramRoutes=layout.routes||new Map();
  const sitePicker=$('diagram-site'), previousSite=sitePicker.value;
  sitePicker.disabled=!diagramSites.length;
  const siteNames=diagramSites.map(({name})=>name).sort((a,b)=>a.localeCompare(b,uiLocale,{numeric:true}));
  sitePicker.replaceChildren(new Option(tr("Все площадки"),''),...siteNames.map(name=>new Option(name||tr("Без площадки"),`site:${name}`)));
  sitePicker.value=previousSite;
  if(sitePicker.selectedIndex<0)sitePicker.selectedIndex=0;
  for(const bar of layout.siteBars||[])$('site-layer').append(drawDiagramSiteBar(bar));
  for(const link of layout.siteLinks||[])$('site-layer').append(drawDiagramSiteLink(link));
  for(const site of diagramSites){
    $('site-layer').append(drawDiagramSite(site,()=>focusDiagramSite(site)));
  }
  const nodes = new Map(graph.nodes.map(node=>[node.id,node]));
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from_id) ?? null, to = nodes.get(edge.to_id) ?? null;
    if (diagramView && (!from || !to)) continue;
    const group = elem('g'), path = elem('path',{class:'edge-path',stroke:edge.color});
    const hit = elem('path',{class:'edge-hit',tabindex:'0',role:'button','data-map-edit':'','aria-label':edge.label || tr("Изменить связь")});
    const label = elem('text',{class:'edge-label','text-anchor':'middle'},edge.label);
    const title = elem('title',{},edge.label || `${from?.name || tr("Свободный конец")} ↔ ${to?.name || tr("Свободный конец")}`);
    hit.append(title); hit.addEventListener('click',()=>openEdge(edge.id));
    hit.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();openEdge(edge.id);}});
    if (diagramView) group.classList.add(diagramRoutes.has(edge.id)?'diagram-wire':(from.site||'')===(to.site||'')?'diagram-link-extra':'diagram-link-remote');
    group.append(path);
    group.append(hit,label); $('edge-layer').append(group);
    const refs = {from,to,group,path,hit,label}; edgeElements.set(edge.id,refs); updateEdgeGeometry(edge,refs);
  }
  for (const node of graph.nodes) {
    const group = elem('g',{class:'map-node',transform:mapNodeTransform(node),tabindex:'0',role:'button','data-id':node.id});
    if(editLayout)group.setAttribute('aria-keyshortcuts',Object.keys(nodeMoveDirections).join(' '));
    const position = diagramLayout.get(node.id);
    const {content,icon,dot,title} = diagramView ? drawDiagramNode(group,node,position) : drawClassicNode(group,node);
    const endpoints = new Map();
    node.addresses.forEach((target,index)=>{
      const {point,circle} = diagramView ? drawDiagramAddress(position,target,index) : drawClassicAddress(node,index);
      point.setAttribute('tabindex','0'); point.setAttribute('role','button'); point.setAttribute('data-target',target);
      const pointTitle=elem('title',{},target);point.append(pointTitle);
      const activate=event=>{event.stopPropagation();selectNode(node.id);openHistory(node.id,target);};
      point.addEventListener('click',activate);
      point.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate(event);}});
      content.append(point);endpoints.set(target,{point,circle,title:pointTitle});
    });
    group.addEventListener('click',event=>selectNode(node.id,editLayout&&(groupSelect||event.ctrlKey||event.metaKey||event.shiftKey)));
    group.addEventListener('keydown',event=>{if(event.target===group&&(event.key==='Enter'||event.key===' ')){event.preventDefault();selectNode(node.id,editLayout&&(groupSelect||event.ctrlKey||event.metaKey||event.shiftKey));}});
    $('node-layer').append(group); nodeElements.set(node.id,{group,icon,dot,title,endpoints});
  }
  $('map-name').textContent = graph.name;
  $('map-empty').hidden = graph.nodes.length > 0; renderedRevision = graph.revision;
  if (first || autoFit) fit();
  if (selected && !graph.nodes.some(n=>n.id===selected)) selected = null;
  for(const id of layoutSelection)if(!nodeElements.has(id))layoutSelection.delete(id);
  drawList(true); drawDetails();
}
function drawList(rebuild = false) {
  if (rebuild) { $('node-list').replaceChildren(); listElements.clear(); }
  const visible = filteredNodes(), visibleIds = new Set(visible.map(n=>n.id));
  for (const node of graph.nodes) {
    let refs = listElements.get(node.id);
    if (!refs) {
      const button = html('button','node-button'), dot = html('i','dot'), text = html('span','node-text');
      const name = html('span','name',node.name), address = html('small','',(node.addresses[0] || tr("Без адресов"))+(node.addresses.length>1?tr(" · ещё {0}", node.addresses.length-1):''));
      text.append(name,address); button.append(dot,text); button.addEventListener('click',event=>selectNode(node.id,editLayout&&(groupSelect||event.ctrlKey||event.metaKey||event.shiftKey)));
      $('node-list').append(button); refs = {button,dot}; listElements.set(node.id,refs);
    }
    const status = statusFor(node.id); refs.button.hidden = !visibleIds.has(node.id);
    refs.button.classList.toggle('active',editLayout?layoutSelection.has(node.id):node.id===selected); refs.dot.className = `dot ${status}`;
    refs.button.setAttribute('aria-pressed',String(editLayout?layoutSelection.has(node.id):node.id===selected));
    refs.button.setAttribute('aria-label',`${node.name}: ${nodeStatusLabel(node)}`);
    refs.button.title = `${node.name}\n${node.addresses.join('\n')}\n${nodeStatusLabel(node)}`;
    const mapNode = nodeElements.get(node.id); mapNode?.group.classList.toggle('dimmed',!visibleIds.has(node.id));
  }
  $('list-count').textContent = tr("{0} из {1} узлов", visible.length, graph.nodes.length);
}
function drawDetails() {
  const node = graph?.nodes.find(n=>n.id===selected); $('details').hidden = !node || !detailsOpen;
  drawLayoutSelection();
  if (!node) return;
  if(!$('watch-section').hidden)drawWatchLinks(node);
  $('detail-name').textContent = node.name; $('detail-kind').textContent = [node.kind,node.site].filter(Boolean).join(' · ');
  $('detail-notes').textContent = node.notes.split(/\r?\n/).filter(line=>!node.addresses.includes(line.trim())).join('\n');
  const status = statusFor(node.id); $('detail-status').textContent = labels[rawStatusFor(node.id)]; $('detail-status').style.color = colors[status];
  $('detail-offline-policy').hidden=!node.allow_offline;
  const netwatchActive=node.netwatch!==false&&node.enabled&&!node.allow_offline&&node.addresses.length>0;
  $('detail-netwatch').textContent=!netwatchActive?tr("Netwatch выключен"):
    state?.netwatch_mail&&graph.settings.netwatch_recipient?tr("Netwatch включён"):tr("Netwatch: почта не настроена");
  $('address-count').textContent = `(${node.addresses.length})`;
  const samples = new Map((state?.nodes[node.id]?.addresses || []).map(a=>[a.target,a]));
  const addressSignature=`${graph.revision}:${selected}`;
  if($('address-results').dataset.signature!==addressSignature){
    addressElements.clear();
    $('address-results').replaceChildren(...node.addresses.map(target=>{
      const row=html('div','address-row'),dot=html('i','dot'),body=html('div'),statusText=html('small');
      const metadata=[channelLabels[node.address_channels?.[target]],node.address_comments?.[target]].filter(Boolean);
      body.append(html('strong','',target),html('span','address-comment',metadata.join(' · ')||tr("Без комментария")),statusText);
      const historyButton=html('button','address-history',tr("История"));
      historyButton.setAttribute('aria-label',tr("История {0}", target));historyButton.addEventListener('click',()=>openHistory(node.id,target));
      const statisticsButton=html('button','',tr("График"));
      statisticsButton.setAttribute('aria-label',tr("График {0}", target));
      statisticsButton.addEventListener('click',()=>openStatistics(node.id,target));
      const actions=html('div','address-actions');
      for(const [kind,label] of [['ping','Ping'],['trace',tr("Трассировка")]]){
        const button=html('button','',label);button.setAttribute('aria-label',`${label}: ${target}`);button.dataset.mapEdit='';
        button.addEventListener('click',()=>runDiagnostic(node,target,kind));actions.append(button);
      }
      actions.append(historyButton,statisticsButton);row.append(dot,body,actions);addressElements.set(target,{dot,statusText});return row;
    }));
    $('address-results').dataset.signature=addressSignature;
  }
  for(const target of node.addresses){
    const sample = samples.get(target) || {status:'unknown'};
    const s = !online && ['up','partial','down'].includes(sample.status)?'stale':sample.status;
    const refs=addressElements.get(target);refs.dot.className=`dot ${displayStatus(node,s)}`;
    const time = sample.checked_at ? new Date(sample.checked_at*1000).toLocaleTimeString(uiLocale,{timeZone:'Europe/Moscow'})+tr(" МСК") : '';
    refs.statusText.textContent=[labels[s],sample.rtt_ms!=null?tr("{0} мс", Number(sample.rtt_ms.toFixed(2))):'',time,serverMessage(sample.detail)].filter(Boolean).join(' · ');
  }
  const edges = graph.edges.filter(e=>e.from_id===node.id||e.to_id===node.id);
  const edgeSignature=`${graph.revision}:${selected}`;
  if($('node-edges').dataset.signature!==edgeSignature){
  $('node-edges').replaceChildren(...edges.map(edge=>{
    const other = graph.nodes.find(n=>n.id===(edge.from_id===node.id?edge.to_id:edge.from_id));
    const button = html('button','edge-button',`${other?.name || tr("Свободный конец")}${edge.label?' · '+edge.label:''}`);
    button.addEventListener('click',()=>openEdge(edge.id));return button;
  }));
  $('node-edges').dataset.signature=edgeSignature;
  }
}
function updateState() {
  if (!graph || !state) return;
  const counts = {}; for (const node of graph.nodes) {const s=statusFor(node.id);counts[s]=(counts[s]||0)+1;}
  const counters = [['',tr("Узлов"),graph.nodes.length],['up',tr("Доступны"),counts.up||0],['partial',tr("Частично"),counts.partial||0],['down',tr("Недоступны"),counts.down||0]];
  $('summary').replaceChildren(...counters.map(([cls,label,count])=>{const item=html('div',`summary-item ${cls}`);item.append(html('strong','',String(count)),document.createTextNode(label));return item;}));
  for (const node of graph.nodes) {
    const refs = nodeElements.get(node.id); if (!refs) continue;
    const status = statusFor(node.id);
    if (diagramView) refs.group.style.setProperty('--device',colors[status]);
    else { refs.dot.setAttribute('fill',colors[status]); refs.icon.style.color = colors[status]; }
    refs.group.classList.toggle('allows-offline',!!node.allow_offline);
    refs.group.setAttribute('aria-label',`${node.name}: ${nodeStatusLabel(node)}`);
    refs.title.textContent = `${node.name}\n${nodeStatusLabel(node)}\n${node.addresses.join('\n')}`;
    const samples=new Map((state.nodes[node.id]?.addresses||[]).map(a=>[a.target,a]));
    for(const [target,endpoint] of refs.endpoints){
      const sample=samples.get(target);let endpointStatus=node.enabled?(sample?.status||'unknown'):'paused';
      if(!online&&['up','partial','down'].includes(endpointStatus))endpointStatus='stale';
      endpoint.circle.setAttribute('fill',colors[displayStatus(node,endpointStatus)]);
      endpoint.point.setAttribute('aria-label',tr("{0}: {1}. Открыть историю", target, labels[endpointStatus]));
      const comment=node.address_comments?.[target];
      const metadata=diagramView?[channelLabels[node.address_channels?.[target]],comment].filter(Boolean).join(' · '):comment||'';
      endpoint.title.textContent=tr("{0}\n{1}\n{2}{3}\nНажмите для истории", target, metadata, labels[endpointStatus], sample?.rtt_ms!=null?' · '+Number(sample.rtt_ms.toFixed(2))+tr(" мс"):'');
    }
  }
  drawList(); drawDetails(); updateEditorAddressStates();
}
function updateDiagramLinks() {
  if(!diagramView)return;
  for(const {from,to,group} of edgeElements.values()){
    group.classList.toggle('diagram-link-active',!!selected&&(from?.id===selected||to?.id===selected));
  }
}
function drawLayoutSelection() {
  for(const [id,refs] of nodeElements){
    const active=editLayout?layoutSelection.has(id):id===selected;
    refs.group.classList.toggle('active',active);refs.group.setAttribute('aria-pressed',String(active));
  }
  updateDiagramLinks();
  $('layout-help').hidden=!editLayout;
  const help=tr("Выбрано: {0}. ", layoutSelection.size)+(groupSelect?tr("Выбирайте узлы нажатием или рамкой; потяните выделенный узел для переноса группы."):tr("Ctrl/⌘ или Shift + клик — выбор узлов; Shift + рамка — выбор группы."))+tr(" Стрелки — сдвиг, Esc — снять выделение.");
  if($('layout-help').textContent!==help)$('layout-help').textContent=help;
}
function selectNode(id, toggle=false, preserve=false) {
  if(toggle&&layoutSelection.has(id))layoutSelection.delete(id);
  else{if(!toggle&&!(preserve&&layoutSelection.has(id)))layoutSelection.clear();layoutSelection.add(id);}
  selected=layoutSelection.has(id)?id:Array.from(layoutSelection).at(-1)||null;
  detailsOpen=!editLayout; $('sidebar').classList.remove('open'); updateListToggle();drawList();drawDetails();
  if(editLayout)nodeElements.get(selected)?.group.focus({preventScroll:true});
}
async function refresh() {
  if (loading || saving) return;
  loading=true;
  try {
    const data=await api('api/state');
    if(saving||(graph&&data.graph&&data.graph.revision<graph.revision))return;
    state=data;online=true;
    applyAccountState(data);
    if(!data.graph)return;
    if (!drag&&!touchPointers.size) {graph=data.graph;if(graph.revision!==renderedRevision)drawGraph();}
    const info=data.monitor, age=info.last_completed?Math.max(0,Math.round(data.server_time-info.last_completed)):null;
    const stale=age!==null&&age>data.stale_after;
    $('connection').classList.toggle('error',!!info.last_error||stale||!info.running);
    $('connection').textContent=serverMessage(info.last_error) || (!info.running?tr("Сборщик остановлен"):
      tr("{0} · {1}/{2} адресов · период {3} с{4}", info.last_completed?tr("Последний цикл: {0} с назад · {1} с", age, info.duration.toFixed(1)):tr("Первый опрос"), info.completed, info.targets, data.graph.settings.interval, stale?tr(" · данные устарели"):''));
    updateState();
    if(!$('watch-section').hidden){loadWatchNavigation();applyWatchIncident();}
  } catch(error) {
    if(handleSessionError(error))return;
    online=false;$('connection').classList.add('error');$('connection').textContent=tr("Нет связи с сервером. Статусы не обновляются.");updateState();
  }
  finally {loading=false;}
}
async function refreshLoop() {
  if(passwordChanged)return;
  if(!$('login-dialog').open)await refresh();
  if(!passwordChanged)setTimeout(refreshLoop,2000);
}

function updateEditorAddressStates() {
  const dialog=$('node-dialog');if(!dialog.open)return;
  const samples=new Map((state?.nodes[dialog.dataset.id]?.addresses||[]).map(sample=>[sample.target,sample]));
  const shortLabels={unknown:tr("Нет данных"),stale:tr("Устарело"),paused:tr("Пауза"),error:tr("Ошибка")};
  for(const row of $('node-addresses').children){
    const target=row.querySelector('.address-input').value.trim().toLowerCase().replace(/\.$/,'');
    const sample=samples.get(target)||{status:'unknown'};
    const status=!online&&['up','down'].includes(sample.status)?'stale':sample.status;
    const visual=displayStatus({allow_offline:$('node-allow-offline').checked},status);
    const badge=row.querySelector('.editor-address-state');badge.className=`editor-address-state ${visual}`;
    badge.querySelector('.dot').className=`dot ${visual}`;
    badge.querySelector('.editor-state-label').textContent=shortLabels[status]||labels[status];
    const checked=sample.checked_at?new Date(sample.checked_at*1000).toLocaleTimeString(uiLocale,{timeZone:'Europe/Moscow'})+tr(" МСК"):'';
    badge.title=[labels[status],sample.rtt_ms!=null?tr("{0} мс", Number(sample.rtt_ms.toFixed(2))):'',checked,serverMessage(sample.detail)].filter(Boolean).join(' · ');
  }
}
function updateAddressOrder() {
  const rows=Array.from($('node-addresses').children);
  rows.forEach((row,index)=>{
    row.setAttribute('aria-label',tr("Адрес {0}{1}", index+1, index===0?tr(" — основной"):''));
    row.querySelector('.address-up').disabled=index===0;
    row.querySelector('.address-down').disabled=index===rows.length-1;
  });
}
function siteNames() {
  return [...new Set((graph?.nodes||[]).map(node=>node.site).filter(Boolean))].sort((a,b)=>a.localeCompare(b,uiLocale,{numeric:true}));
}
function channelOptions(placeholder) {
  return [new Option(placeholder,''),...Object.entries(channelLabels).map(([value,label])=>new Option(label,value))];
}
function addAddress(target='',comment='',channel='') {
  const row=html('div','address-editor'),fields=html('div','address-fields');
  row.setAttribute('role','group');row.tabIndex=-1;
  const addressLabel=html('label','',tr("IP-адрес или DNS-имя")),input=html('input','address-input');
  input.value=target;input.required=true;input.maxLength=253;input.placeholder=tr("192.0.2.10 или server.example");
  const inputLine=html('span','address-input-line'),badge=html('span','editor-address-state');
  badge.append(html('i','dot unknown'),html('span','editor-state-label',tr("Нет данных")));
  inputLine.append(input,badge);addressLabel.append(inputLine);input.addEventListener('input',updateEditorAddressStates);
  const commentLabel=html('label','',tr("Комментарий")),note=html('input','comment-input');
  note.value=comment;note.maxLength=1000;note.placeholder=tr("Например: WireGuard · wg0");commentLabel.append(note);
  const channelLabel=html('label','',tr("Канал")),channelSelect=html('select','address-channel');
  channelSelect.replaceChildren(...channelOptions(tr("Без метки")));channelSelect.value=channel;channelLabel.append(channelSelect);
  const actions=html('div','address-edit-actions');
  for(const [className,label,direction] of [['address-up',tr("Поднять адрес"),-1],['address-down',tr("Опустить адрес"),1]]){
    const button=html('button',className,direction<0?'↑':'↓');button.type='button';button.title=label;button.setAttribute('aria-label',label);
    button.addEventListener('click',()=>{
      const neighbor=direction<0?row.previousElementSibling:row.nextElementSibling;
      if(!neighbor)return;
      if(direction<0)row.parentElement.insertBefore(row,neighbor);
      else row.parentElement.insertBefore(neighbor,row);
      updateAddressOrder();
      (button.disabled?row:button).focus({preventScroll:true});row.scrollIntoView({block:'nearest'});
    });
    actions.append(button);
  }
  const remove=html('button','remove-address','×');remove.type='button';remove.setAttribute('aria-label',tr("Удалить адрес"));remove.addEventListener('click',()=>{row.remove();updateAddressOrder();});
  actions.append(remove);fields.append(addressLabel,commentLabel,channelLabel);row.append(fields,actions);$('node-addresses').append(row);
  return input;
}
function openNode(id=null, duplicate=false) {
  if(!graph||!canEditMap())return;
  const node=graph.nodes.find(n=>n.id===id);if(duplicate&&!node)return;
  const dialog=$('node-dialog');dialog.dataset.id=duplicate?'':id||'';dialog.dataset.revision=graph.revision;
  dialog.dataset.templateId=duplicate?node.id:'';
  $('node-dialog-title').textContent=duplicate?tr("Копия узла"):node?tr("Изменить узел"):tr("Новый узел");$('node-name').value=duplicate?tr("{0} (копия)", node.name.slice(0,492)):node?.name||'';$('node-kind').value=node?.kind||'Server';
  const focusedSite=diagramView?$('diagram-site').value.slice(5):'';
  $('site-options').replaceChildren(...siteNames().map(site=>new Option(site,site)));$('node-site').value=node?.site??focusedSite;
  $('node-addresses').replaceChildren();
  for(const target of node?.addresses||[])addAddress(target,node.address_comments?.[target]||'',node.address_channels?.[target]||'');
  if(!node)addAddress();
  updateAddressOrder();
  $('node-notes').value=node?.notes||'';$('node-enabled').checked=node?.enabled??true;
  $('node-allow-offline').checked=node?.allow_offline??false;
  $('node-netwatch').checked=node?.netwatch??true;
  updateNetwatchControl();
  $('delete-node').hidden=!node||duplicate;dialog.showModal();updateEditorAddressStates();$('node-name').focus();
}
function updateNetwatchControl() {
  $('node-netwatch').disabled=!$('node-enabled').checked||$('node-allow-offline').checked;
}
function openEdge(id=null) {
  if(!graph||!canEditMap())return;
  const dialog=$('edge-dialog'),edge=graph.edges.find(e=>e.id===id);dialog.dataset.id=id||'';dialog.dataset.revision=graph.revision;
  const nodes=[...graph.nodes].sort((a,b)=>a.name.localeCompare(b.name,uiLocale,{sensitivity:'base',numeric:true}));
  for(const select of [$('edge-from'),$('edge-to')]) {
    const hasGeometry=(edge?.points.length||0)>=2;
    select.required=!hasGeometry;
    select.replaceChildren(new Option(hasGeometry?tr("Свободный конец"):tr("Выберите узел"),''),...nodes.map(n=>new Option(n.name,n.id)));
  }
  $('edge-from').value=(edge?edge.from_id:selected)||'';$('edge-to').value=edge?.to_id||'';$('edge-label').value=edge?.label||'';$('edge-color').value=edge?.color||'#7894a5';
  $('delete-edge').hidden=!edge;dialog.showModal();
}
const settingsTabs=document.querySelectorAll('[data-settings-section]');
function showSettingsSection(section) {
  for(const button of settingsTabs){
    const selected=button.dataset.settingsSection===section;
    button.setAttribute('aria-pressed',String(selected));
    $(button.getAttribute('aria-controls')).hidden=!selected;
  }
  $('directory-notices').hidden=section!=='users'&&section!=='groups';
}
function openSettings() {
  const dialog=$('settings-dialog');
  const edit=!!graph&&canEditMap();
  $('settings-map-tab').disabled=!edit;
  showSettingsSection(edit ? 'map' : 'appearance');
  if(!edit){dialog.showModal();return;}
  dialog.dataset.revision=graph.revision;
  $('settings-name').value=graph.name;$('settings-interval').value=graph.settings.interval;$('settings-timeout').value=graph.settings.timeout;
  $('settings-netwatch-recipient').value=graph.settings.netwatch_recipient;
  $('settings-netwatch-minutes').value=graph.settings.netwatch_minutes;
  $('password-button').hidden=!!state?.account||!state?.password_change;
  $('settings-source').textContent=graph.source?tr("Источник: {0}", graph.source):'';$('import-notes').textContent=graph.import_notes.join('\n');dialog.showModal();
}
function stopDiagnostic() {
  if(diagnosticController){diagnosticController.abort();$('diagnostic-status').textContent=tr("Остановлено");}
}
async function runDiagnostic(node,target,kind) {
  if(!canEditMap())return;
  stopDiagnostic();
  const controller=new AbortController();diagnosticController=controller;
  const dialog=$('diagnostic-dialog'),output=$('diagnostic-output');
  $('diagnostic-title').textContent=kind==='ping'?'Ping':tr("Трассировка");
  $('diagnostic-target').textContent=`${node.name} · ${target}${node.address_comments?.[target]?' · '+node.address_comments[target]:''}`;
  output.textContent='';$('diagnostic-status').textContent=tr("Запуск…");$('diagnostic-stop').disabled=false;
  if(!dialog.open)dialog.showModal();
  const timer=setTimeout(()=>{controller.abort();if(diagnosticController===controller)$('diagnostic-status').textContent=tr("Превышено время ожидания ответа сервера");},55000);
  let reader;
  try{
    const response=await fetch(mapEndpoint('api/diagnostics'),{method:'POST',headers:{'X-Netmap-Request':'1','Content-Type':'application/json'},
      body:JSON.stringify({node_id:node.id,target,command:kind}),signal:controller.signal});
    if(!response.ok){let data;try{data=await response.json();}catch{}throw new Error(typeof data?.detail==='string'?serverMessage(data.detail):tr("Не удалось запустить команду (HTTP {0})", response.status));}
    reader=response.body.getReader();const decoder=new TextDecoder();let pending='',finished=false;
    function consume(line){
      if(controller.signal.aborted||diagnosticController!==controller)return;
      if(!line.trim())return;const message=JSON.parse(line);
      if(message.type==='line'){
        const follow=output.scrollHeight-output.scrollTop-output.clientHeight<40;
        output.textContent=(output.textContent+message.text+'\n').slice(-100000);
        if(follow)output.scrollTop=output.scrollHeight;
      }else if(message.type==='done'){finished=true;$('diagnostic-status').textContent=message.returncode===0?tr("Команда завершена"):tr("Команда завершена с кодом {0}", message.returncode);}
      else if(message.type==='error'){finished=true;$('diagnostic-status').textContent=serverMessage(message.text);}
      else if(message.type==='start')$('diagnostic-status').textContent=tr("Выполняется…");
    }
    while(true){
      const {value,done}=await reader.read();pending+=decoder.decode(value||new Uint8Array(),{stream:!done});
      const lines=pending.split('\n');pending=lines.pop();for(const line of lines)consume(line);
      if(done){if(pending)consume(pending);break;}
    }
    if(!finished)throw new Error(tr("Связь прервалась до завершения команды"));
  }catch(error){if(!controller.signal.aborted)$('diagnostic-status').textContent=error.message;}
  finally{
    clearTimeout(timer);if(reader)await reader.cancel().catch(()=>{});
    if(diagnosticController===controller){diagnosticController=null;$('diagnostic-stop').disabled=true;}
  }
}
$('diagnostic-stop').addEventListener('click',stopDiagnostic);
$('diagnostic-dialog').addEventListener('close',stopDiagnostic);
for(const close of document.querySelectorAll('[data-close]'))close.addEventListener('click',()=>close.closest('dialog').close());
$('node-form').addEventListener('submit',async event=>{
  event.preventDefault();const dialog=$('node-dialog'),id=dialog.dataset.id||newId();
  const addresses=[],comments={},channels={};
  for(const row of $('node-addresses').children){
    const target=row.querySelector('.address-input').value.trim(),comment=row.querySelector('.comment-input').value.trim();
    if(!target)continue;
    const key=target.toLowerCase().replace(/\.$/,'');
    if(addresses.some(a=>a.toLowerCase().replace(/\.$/,'')===key)){toast(tr("Этот адрес уже указан"));return;}
    addresses.push(target);comments[target]=comment;
    const channel=row.querySelector('.address-channel').value;
    if(channel)channels[target]=channel;
  }
  const old=graph.nodes.find(n=>n.id===id),template=graph.nodes.find(n=>n.id===dialog.dataset.templateId);
  const site=$('node-site').value.trim();
  const anchor=old||template||(diagramView&&(graph.nodes.find(n=>(n.site||'')===site)||graph.nodes[0]));
  const offset=value=>value+(value>1e7-60?-60:60);
  const node={id,name:$('node-name').value.trim(),kind:$('node-kind').value.trim(),addresses,address_comments:comments,site,address_channels:channels,notes:$('node-notes').value,enabled:$('node-enabled').checked,allow_offline:$('node-allow-offline').checked,
    x:old?.x??(anchor?offset(anchor.x):view.x+view.w/2),y:old?.y??(anchor?offset(anchor.y):view.y+view.h/2)};
  node.netwatch=$('node-netwatch').checked;
  if(await change(g=>{const index=g.nodes.findIndex(n=>n.id===id);if(index<0)g.nodes.push(node);else g.nodes[index]=node;},Number(dialog.dataset.revision))){dialog.close();selectNode(id);}
});
$('add-address').addEventListener('click',()=>{const input=addAddress();updateAddressOrder();updateEditorAddressStates();input.focus();});
$('node-allow-offline').addEventListener('change',updateEditorAddressStates);
$('node-allow-offline').addEventListener('change',updateNetwatchControl);
$('node-enabled').addEventListener('change',updateNetwatchControl);
$('delete-node').addEventListener('click',async()=>{
  const dialog=$('node-dialog'),id=dialog.dataset.id;
  if(confirm(tr("Удалить узел и все привязанные к нему связи?"))&&await change(g=>{g.nodes=g.nodes.filter(n=>n.id!==id);g.edges=g.edges.filter(e=>e.from_id!==id&&e.to_id!==id);},Number(dialog.dataset.revision))){dialog.close();selected=null;drawDetails();}
});
$('edge-form').addEventListener('submit',async event=>{
  event.preventDefault();const dialog=$('edge-dialog'),id=dialog.dataset.id||newId(),old=graph.edges.find(e=>e.id===id);
  const from=$('edge-from').value||null,to=$('edge-to').value||null;
  if(from&&from===to){toast(tr("Выберите два разных узла"));return;}
  const points=structuredClone(old?.points||[]);
  if(points.length>=2){
    for(const [before,after,index] of [[old.from_id,from,0],[old.to_id,to,points.length-1]]){
      if(before===after)continue;
      const node=graph.nodes.find(n=>n.id===(after||before));
      if(node)points[index]=[node.x,node.y];
    }
  }
  const edge={id,from_id:from,to_id:to,label:$('edge-label').value,color:$('edge-color').value,points};
  if(await change(g=>{const i=g.edges.findIndex(e=>e.id===id);if(i<0)g.edges.push(edge);else g.edges[i]=edge;},Number(dialog.dataset.revision)))dialog.close();
});
$('delete-edge').addEventListener('click',async()=>{
  const dialog=$('edge-dialog');if(confirm(tr("Удалить эту связь?"))&&await change(g=>g.edges=g.edges.filter(e=>e.id!==dialog.dataset.id),Number(dialog.dataset.revision)))dialog.close();
});
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();const dialog=$('settings-dialog');
  if(await change(g=>{
    g.name=$('settings-name').value.trim();
    g.settings.interval=Number($('settings-interval').value);
    g.settings.timeout=Number($('settings-timeout').value);
    g.settings.netwatch_recipient=$('settings-netwatch-recipient').value.trim();
    g.settings.netwatch_minutes=$('settings-netwatch-minutes').valueAsNumber;
  },Number(dialog.dataset.revision)))dialog.close();
});
for(const button of settingsTabs){
  button.addEventListener('click',()=>showSettingsSection(button.dataset.settingsSection));
}
const passwordDialog=$('password-dialog'),passwordForm=$('password-form');
const passwordSubmit=$('password-submit'),passwordCancel=$('password-cancel'),passwordError=$('password-error');
function openPasswordDialog(){
  $('password-username').value=state?.account?.username||'admin';
  passwordDialog.showModal();
}
$('password-button').addEventListener('click',openPasswordDialog);
passwordDialog.addEventListener('cancel',event=>{
  if(passwordSubmit.disabled||passwordChanged)event.preventDefault();
});
passwordDialog.addEventListener('close',()=>{
  passwordForm.reset();
  passwordError.hidden=true;
});
passwordForm.addEventListener('submit',async event=>{
  event.preventDefault();
  if(passwordSubmit.disabled||passwordChanged)return;
  const current=$('password-current').value,replacement=$('password-new').value;
  if(replacement!==$('password-confirm').value){
    passwordError.textContent=tr("Новые пароли не совпадают");
    passwordError.hidden=false;
    return;
  }
  passwordError.hidden=true;
  passwordSubmit.disabled=passwordCancel.disabled=true;
  try{
    await api(state?.account?'api/account/password':'api/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current,replacement})});
    passwordChanged=true;
    passwordForm.reset();
    passwordForm.hidden=true;
    $('password-result').hidden=false;
    $('password-relogin').hidden=false;
    $('password-relogin').focus();
  }catch(error){
    passwordError.textContent=error.message;
    passwordError.hidden=false;
  }finally{
    passwordSubmit.disabled=passwordCancel.disabled=false;
  }
});
$('password-relogin').addEventListener('click',()=>location.reload());
$('add-node').addEventListener('click',()=>openNode());$('edit-node').addEventListener('click',()=>openNode(selected));$('add-edge').addEventListener('click',()=>openEdge());$('settings-button').addEventListener('click',openSettings);
$('duplicate-node').addEventListener('click',()=>openNode(selected,true));
$('close-details').addEventListener('click',()=>{selected=null;detailsOpen=false;drawList();drawDetails();});
$('focus-node').addEventListener('click',()=>{
  const node=graph.nodes.find(n=>n.id===selected);
  if(!node)return;
  autoFit=false;
  view=diagramView?diagramViewport([node],[],{minWidth:260,minHeight:180}):{x:node.x-250,y:node.y-200,w:500,h:400};
  viewChanged();
  if(mobileLayout.matches){detailsOpen=false;drawDetails();}
});
$('toggle-list').addEventListener('click',()=>{
  const mobile=mobileLayout.matches;
  const open=mobile?$('sidebar').classList.toggle('open'):!$('sidebar').classList.toggle('collapsed');
  $('toggle-list').setAttribute('aria-expanded',String(open));
  if(open){if(mobile){detailsOpen=false;drawDetails();}$('search').focus();}
});
$('search').addEventListener('input',()=>drawList());$('filter').addEventListener('change',()=>drawList());
$('fit').addEventListener('click',fit);
$('view-classic').addEventListener('click',()=>switchMapView(false));
$('view-diagram').addEventListener('click',()=>switchMapView(true));
$('diagram-site').addEventListener('change',()=>{
  const value=$('diagram-site').value;
  const site=diagramSites.find(item=>`site:${item.name}`===value);
  if(site)focusDiagramSite(site);else fit();
});
function zoom(factor,at={x:view.x+view.w/2,y:view.y+view.h/2}) {
  if(view.w*factor<80||view.w*factor>1e7)return;
  autoFit=false;
  view={x:at.x-(at.x-view.x)*factor,y:at.y-(at.y-view.y)*factor,w:view.w*factor,h:view.h*factor};viewChanged();
}
$('zoom-in').addEventListener('click',()=>zoom(.8));$('zoom-out').addEventListener('click',()=>zoom(1.25));
function world(event) {const point=svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;return point.matrixTransform(svg.getScreenCTM().inverse());}
svg.addEventListener('wheel',event=>{event.preventDefault();zoom(event.deltaY>0?1.12:1/1.12,world(event));},{passive:false});
$('edit-layout').addEventListener('click',()=>{
  if(!editLayout&&(!canEditMap()||diagramView))return;
  setEditLayout(!editLayout);
});
function setEditLayout(on) {
  cancelMapGesture();
  editLayout=on;$('edit-layout').setAttribute('aria-pressed',String(editLayout));svg.classList.toggle('editing',editLayout);
  groupSelect=false;$('group-select').hidden=!editLayout;$('group-select').setAttribute('aria-pressed','false');
  layoutSelection.clear();if(selected)layoutSelection.add(selected);
  if(editLayout)detailsOpen=false;
  for(const refs of nodeElements.values()){
    if(editLayout)refs.group.setAttribute('aria-keyshortcuts',Object.keys(nodeMoveDirections).join(' '));
    else refs.group.removeAttribute('aria-keyshortcuts');
  }
  if(editLayout)nodeElements.get(selected)?.group.focus({preventScroll:true});
  drawList();drawDetails();
}
$('group-select').addEventListener('click',()=>{
  groupSelect=!groupSelect;$('group-select').setAttribute('aria-pressed',String(groupSelect));
  drawLayoutSelection();
});
function moveGraphNodes(g,ids,dx,dy) {
  const moving=new Set(ids),overrides=new Map(ids.map(id=>[id,{dx,dy}]));
  for(const node of g.nodes)if(moving.has(node.id)){node.x+=dx;node.y+=dy;}
  for(const edge of g.edges){
    if(edge.points.length<2)continue;
    if(moving.has(edge.from_id)||moving.has(edge.to_id))edge.points=edgePoints(edge,overrides);
  }
}
async function flushKeyboardMoves() {
  if(movingWithKeyboard||saving||!keyboardMoves.length)return;
  movingWithKeyboard=true;
  try{
    while(keyboardMoves.length){
      const move=keyboardMoves.shift();if(!move.dx&&!move.dy)continue;
      if(!move.ids.every(id=>graph?.nodes.some(n=>n.id===id))){keyboardMoves.length=0;toast(tr("Узел больше не существует"));break;}
      const ok=await change(g=>moveGraphNodes(g,move.ids,move.dx,move.dy));
      if(!ok){keyboardMoves.length=0;await refresh();break;}
      const active=document.activeElement;
      if(editLayout&&!document.querySelector('dialog[open]')&&(active===document.body||svg.contains(active)))nodeElements.get(selected)?.group.focus({preventScroll:true});
    }
  }catch(error){keyboardMoves.length=0;toast(error.message);await refresh();}
  finally{movingWithKeyboard=false;}
}
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&editLayout&&!document.querySelector('dialog[open]')&&!event.target.closest?.('input,textarea,select,[contenteditable]')){
    event.preventDefault();cancelMapGesture();layoutSelection.clear();selected=null;drawList();drawDetails();return;
  }
  const direction=nodeMoveDirections[event.key],group=event.target.closest?.('.map-node');
  if(!direction||!editLayout||drag||touchPointers.size||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||!group||event.target.closest('.address-point')||document.querySelector('dialog[open]'))return;
  event.preventDefault();autoFit=false;
  const id=group.dataset.id,step=event.shiftKey?10:1;
  if(!layoutSelection.has(id))selectNode(id);
  selected=id;const ids=Array.from(layoutSelection).sort();
  let move=keyboardMoves.at(-1);
  if(!move||move.ids.length!==ids.length||!move.ids.every((value,index)=>value===ids[index])){move={ids,dx:0,dy:0};keyboardMoves.push(move);}
  move.dx+=direction[0]*step;move.dy+=direction[1]*step;flushKeyboardMoves();
});
function cancelMapDrag() {
  const done=drag;drag=null;svg.classList.remove('dragging');
  if(done?.id){
    for(const node of graph.nodes)if(done.ids.includes(node.id))nodeElements.get(node.id)?.group.setAttribute('transform',mapNodeTransform(node));
    for(const edge of graph.edges)if(done.ids.includes(edge.from_id)||done.ids.includes(edge.to_id))updateEdgeGeometry(edge,edgeElements.get(edge.id));
  }
  if(done?.box){done.box.remove();layoutSelection.clear();for(const id of done.previousSelection)layoutSelection.add(id);drawList();drawDetails();}
  if(done&&!touchPointers.has(done.pointerId)&&svg.hasPointerCapture(done.pointerId))svg.releasePointerCapture(done.pointerId);
}
function touchGeometry() {
  const [a,b]=Array.from(touchPointers.values());
  return {distance:Math.max(1,Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)),
    center:{clientX:(a.clientX+b.clientX)/2,clientY:(a.clientY+b.clientY)/2}};
}
function startPinch() {
  cancelMapDrag();blockMapClick=true;autoFit=false;
  const pair=touchGeometry();pinch={distance:pair.distance,anchor:world(pair.center),view:{...view}};
  for(const id of touchPointers.keys())if(!svg.hasPointerCapture(id))svg.setPointerCapture(id);
}
function updatePinch() {
  const pair=touchGeometry(),base=pinch.view;
  const width=Math.max(80,Math.min(1e7,base.w*pinch.distance/pair.distance)),factor=width/base.w;
  view={x:pinch.anchor.x-(pinch.anchor.x-base.x)*factor,y:pinch.anchor.y-(pinch.anchor.y-base.y)*factor,w:width,h:base.h*factor};
  viewChanged();
  const underCenter=world(pair.center);
  view.x+=pinch.anchor.x-underCenter.x;view.y+=pinch.anchor.y-underCenter.y;viewChanged();
}
svg.addEventListener('click',event=>{
  if(blockMapClick&&event.detail){event.preventDefault();event.stopImmediatePropagation();}
},true);
svg.addEventListener('pointerdown',event=>{
  if(!graph)return;
  if(event.pointerType==='touch'){
    if(!touchPointers.size)blockMapClick=false;
    touchPointers.set(event.pointerId,{clientX:event.clientX,clientY:event.clientY});
    if(touchPointers.size>=2){
      if(!pinch)startPinch();else svg.setPointerCapture(event.pointerId);
      event.preventDefault();return;
    }
  }else{
    if(touchPointers.size)return;
    blockMapClick=false;
  }
  if(drag||event.button!==0||event.target.closest('.edge-hit,.address-point,.diagram-site-title'))return;
  const node=event.target.closest('.map-node');if(node&&!editLayout)return;
  if(node&&(saving||movingWithKeyboard)){toast(tr("Дождитесь завершения сохранения"));return;}
  const additive=event.ctrlKey||event.metaKey||event.shiftKey;
  if(node&&!additive&&!groupSelect)selectNode(node.dataset.id,false,true);
  drag={pointerId:event.pointerId,start:world(event),clientX:event.clientX,clientY:event.clientY,view:{...view},id:node?.dataset.id||null,dx:0,dy:0,moved:false,revision:graph.revision,additive:additive||groupSelect};
  if(node)drag.ids=Array.from(new Set([...layoutSelection,node.dataset.id]));
  else if(editLayout&&(groupSelect||additive)){
    drag.previousSelection=Array.from(layoutSelection);drag.baseIds=additive?drag.previousSelection:[];
    drag.box=elem('rect',{class:'selection-box',x:drag.start.x,y:drag.start.y,width:0,height:0});svg.append(drag.box);
  }
  svg.setPointerCapture(event.pointerId);svg.classList.add('dragging');
});
svg.addEventListener('pointermove',event=>{
  if(touchPointers.has(event.pointerId))touchPointers.set(event.pointerId,{clientX:event.clientX,clientY:event.clientY});
  if(pinch){event.preventDefault();updatePinch();return;}
  if(!drag||drag.pointerId!==event.pointerId)return;const p=world(event);drag.moved ||= Math.hypot(event.clientX-drag.clientX,event.clientY-drag.clientY)>3;
  if(drag.moved&&touchPointers.has(event.pointerId))blockMapClick=true;
  if(drag.box){
    if(!drag.moved)return;
    const x=Math.min(p.x,drag.start.x),y=Math.min(p.y,drag.start.y),w=Math.abs(p.x-drag.start.x),h=Math.abs(p.y-drag.start.y);
    for(const [key,value] of Object.entries({x,y,width:w,height:h}))drag.box.setAttribute(key,value);
    layoutSelection.clear();for(const id of drag.baseIds)layoutSelection.add(id);
    for(const node of filteredNodes()){
      const position=mapNodePosition(node);
      if(position.x>=x&&position.x<=x+w&&position.y>=y&&position.y<=y+h)layoutSelection.add(node.id);
    }
    drawLayoutSelection();
  }else if(drag.id){
    if(!drag.moved)return;
    drag.dx=p.x-drag.start.x;drag.dy=p.y-drag.start.y;
    layoutSelection.clear();for(const id of drag.ids)layoutSelection.add(id);drawLayoutSelection();
    for(const node of graph.nodes)if(layoutSelection.has(node.id))nodeElements.get(node.id).group.setAttribute('transform',mapNodeTransform(node,drag.dx,drag.dy));
    const overrides=new Map(drag.ids.map(id=>[id,{dx:drag.dx,dy:drag.dy}]));
    for(const edge of graph.edges)if(layoutSelection.has(edge.from_id)||layoutSelection.has(edge.to_id))updateEdgeGeometry(edge,edgeElements.get(edge.id),overrides);
  }else{
    if(drag.moved)autoFit=false;
    const matrix=svg.getScreenCTM();view.x=drag.view.x-(event.clientX-drag.clientX)/matrix.a;view.y=drag.view.y-(event.clientY-drag.clientY)/matrix.d;viewChanged();
  }
});
async function endMapPointer(event,cancelled=false) {
  const touch=touchPointers.delete(event.pointerId);
  if(pinch&&touch){
    if(cancelled){cancelMapGesture();return;}
    if(svg.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);
    if(touchPointers.size>=2)startPinch();
    else{
      pinch=null;drag=null;svg.classList.remove('dragging');
      if(touchPointers.size){
        const [id,point]=touchPointers.entries().next().value;
        if(!svg.hasPointerCapture(id)){cancelMapGesture();return;}
        drag={pointerId:id,start:world(point),clientX:point.clientX,clientY:point.clientY,view:{...view},id:null,dx:0,dy:0,moved:false,revision:graph.revision};
        svg.classList.add('dragging');
      }
    }
    return;
  }
  if(!drag||drag.pointerId!==event.pointerId)return;
  if(cancelled){blockMapClick=true;cancelMapDrag();return;}
  const done=drag;drag=null;svg.classList.remove('dragging');
  blockMapClick=true;
  if(svg.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);
  if(done.box){
    done.box.remove();
    if(!done.moved&&!done.baseIds.length)layoutSelection.clear();
    selected=Array.from(layoutSelection).at(-1)||null;detailsOpen=false;drawList();drawDetails();
    nodeElements.get(selected)?.group.focus({preventScroll:true});
  }else if(done.id&&done.moved){
    autoFit=false;
    selected=done.id;
    const ok=await change(g=>moveGraphNodes(g,done.ids,done.dx,done.dy),done.revision);
    if(!ok){drawGraph();updateState();}
    if(editLayout)nodeElements.get(selected)?.group.focus({preventScroll:true});
  }else if(done.id)selectNode(done.id,done.additive,true);
  else if(editLayout&&!done.moved){layoutSelection.clear();selected=null;drawList();drawDetails();}
}
svg.addEventListener('pointerup',event=>endMapPointer(event));
svg.addEventListener('pointercancel',event=>endMapPointer(event,true));
document.addEventListener('lostpointercapture',event=>{
  if(!svg.hasPointerCapture(event.pointerId)&&(touchPointers.has(event.pointerId)||drag?.pointerId===event.pointerId))endMapPointer(event,true);
});
for(const type of ['pointerup','pointercancel'])document.addEventListener(type,event=>{
  if(!svg.contains(event.target))endMapPointer(event,type==='pointercancel');
},true);
function cancelMapGesture() {
  const ids=Array.from(touchPointers.keys());touchPointers.clear();pinch=null;blockMapClick=true;cancelMapDrag();
  for(const id of ids)if(svg.hasPointerCapture(id))svg.releasePointerCapture(id);
}
window.addEventListener('blur',cancelMapGesture);
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelMapGesture();});
$('poll-now').addEventListener('click',async()=>{try{await api('api/poll',{method:'POST'});toast(tr("Опрос запланирован"));}catch(e){toast(e.message);}});
let pendingImport=null;
function drawImportPreview(preview){
  const body=$('import-changes');
  body.replaceChildren();
  $('import-revision').textContent=tr("Текущая ревизия {0}", preview.revision);
  function list(title,items){
    if(!items.length)return;
    const rows=html('ul');
    for(const item of items)rows.append(html('li','',item));
    body.append(html('h3','',title),rows);
  }
  const nodeLabel=node=>`${node.name} [${node.id}]`;
  const nodeDescription=node=>`${nodeLabel(node)} · ${node.addresses.join(', ')||tr("без адресов")}${node.enabled?'':tr(" · опрос приостановлен")}`;
  list(tr("Новые узлы"),preview.nodes.added.map(nodeDescription));
  list(tr("Удаляемые узлы"),preview.nodes.removed.map(nodeDescription));
  list(tr("Изменения узлов"),preview.nodes.changed.map(({before,after})=>{
    const changes=[];
    if(before.name!==after.name)changes.push(tr("название: {0} → {1}", before.name, after.name));
    if(JSON.stringify(before.addresses)!==JSON.stringify(after.addresses))changes.push(
      tr("адреса: {0} → {1}", before.addresses.join(', ')||tr("нет"), after.addresses.join(', ')||tr("нет")));
    if(before.enabled!==after.enabled)changes.push(after.enabled?tr("опрос возобновится"):tr("опрос приостановится"));
    if(before.allow_offline!==after.allow_offline)changes.push(after.allow_offline?tr("недоступность допускается"):tr("недоступность учитывается"));
    if(before.netwatch!==after.netwatch)changes.push(after.netwatch?tr("Netwatch включён"):tr("Netwatch выключен"));
    if(before.site!==after.site)changes.push(tr("площадка: {0} → {1}", before.site||tr("без метки"), after.site||tr("без метки")));
    for(const target of new Set([...Object.keys(before.address_channels||{}),...Object.keys(after.address_channels||{})])){
      const from=before.address_channels?.[target],to=after.address_channels?.[target];
      if(from!==to)changes.push(`${target}: ${channelLabels[from]||tr("без метки")} → ${channelLabels[to]||tr("без метки")}`);
    }
    return `${nodeLabel(after)} · ${changes.join(' · ')||tr("изменены свойства")}`;
  }));
  const endpoint=(name,id)=>id?`${name} [${id}]`:tr("свободный конец");
  const edgeDescription=edge=>`${endpoint(edge.from,edge.from_id)} → ${endpoint(edge.to,edge.to_id)}${edge.label?' · '+edge.label:''}`;
  list(tr("Новые связи"),preview.edges.added.map(edgeDescription));
  list(tr("Удаляемые связи"),preview.edges.removed.map(edgeDescription));
  list(tr("Изменения связей"),preview.edges.changed.map(({before,after})=>{
    const old=edgeDescription(before),next=edgeDescription(after);
    const text=old!==next?`${old} → ${next}`:next;
    const change=before.color!==after.color?tr(" · цвет: {0} → {1}", before.color, after.color):
      old===next?tr(" · изменена геометрия"):'';
    return text+change;
  }));
  const settings={interval:tr("Период опроса, с"),timeout:tr("Тайм-аут ping, с"),concurrency:tr("Одновременные проверки"),
    netwatch_recipient:tr("Почта Netwatch"),netwatch_minutes:tr("Задержка Netwatch, мин.")};
  list(tr("Настройки карты"),Object.entries(preview.settings).map(([key,{before,after}])=>`${settings[key]}: ${before} → ${after}`));
  list(tr("Адреса, которые перестанут проверяться"),preview.stopped_targets);
  if(!body.children.length)body.append(html('p','muted',tr("Узлы, связи и настройки карты совпадают.")));
}
$('import-button').addEventListener('click',()=>$('import-file').click());
$('import-file').addEventListener('change',async event=>{
  const file=event.target.files[0],current=graph;if(!file||!current)return;
  try{
    if(file.size>16*1024*1024)throw new Error(tr("Размер файла превышает 16 МБ"));
    const source=await file.text();
    let data;
    try{data=JSON.parse(source);}catch{throw new Error(tr("Не удалось прочитать JSON-копию карты"));}
    if(!Array.isArray(data?.nodes)||!Array.isArray(data.edges))throw new Error(tr("Выберите JSON-копию карты"));
    const proposed={...current,...data,revision:current.revision};
    const preview=await api('api/map/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(proposed)});
    if(preview.revision!==graph.revision)throw new Error(tr("Карта изменилась. Выберите JSON-копию заново."));
    pendingImport=proposed;drawImportPreview(preview);
    $('import-error').hidden=true;$('apply-import').disabled=false;
    $('import-dialog').showModal();
  }catch(e){toast(e.message);}finally{event.target.value='';}
});
$('import-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const proposed=pendingImport,button=$('apply-import'),error=$('import-error');
  if(!proposed||button.disabled)return;
  button.disabled=true;
  if(await change(g=>Object.assign(g,proposed),proposed.revision)){
    $('import-dialog').close();fit();
  }else{
    error.textContent=$('toast').textContent;error.hidden=false;
    button.disabled=graph.revision!==proposed.revision;
  }
});
$('import-dialog').addEventListener('close',()=>{pendingImport=null;});
new ResizeObserver(()=>{if(autoFit&&!drag&&!touchPointers.size)fit();}).observe(svg);
const mobileLayout=matchMedia('(max-width:850px)');
function updateListToggle(){ $('toggle-list').setAttribute('aria-expanded',String(mobileLayout.matches?$('sidebar').classList.contains('open'):!$('sidebar').classList.contains('collapsed'))); }
mobileLayout.addEventListener('change',updateListToggle);updateListToggle();
viewChanged();
