'use strict';

let watchNavigation=null,watchNavigationError=false,watchIncidentApplied=false;
let watchIncidentWindow=null;
const watchIncidentNodes=new Set();
const watchQuery=new URLSearchParams(window.location.search);

function readWatchNavigation(data){
  if(![1,2].includes(data?.version)||!data.identities||!data.objects)throw new Error('index version or structure');
  for(const values of Object.values(data.identities))if(!Array.isArray(values)||!values.every(value=>typeof value==='string'))throw new Error('identity structure');
  for(const rows of Object.values(data.objects)){
    if(!Array.isArray(rows)||!rows.every(row=>{
      if(typeof row?.url!=='string'||typeof row.day!=='string'||!Number.isFinite(row.start))return false;
      if(data.version===1)return Number.isFinite(row.end)&&Array.isArray(row.sources)&&row.sources.every(source=>typeof source==='string');
      return typeof row.source==='string'&&(row.end===null||(Number.isFinite(row.end)&&row.end>=row.start))
        &&Number.isFinite(row.observed_from)&&Number.isFinite(row.observed_until)&&row.observed_until>row.observed_from;
    }))throw new Error('episode structure');
  }
  return {version:data.version,identities:Object.assign(Object.create(null),data.identities),objects:Object.assign(Object.create(null),data.objects)};
}

function watchIdentity(node){
  const owners=new Set(),ambiguous=[];
  for(const target of node.addresses){
    const matches=watchNavigation?.identities?.[target.toLowerCase()]||[];
    matches.forEach(value=>owners.add(value));
    if(matches.length>1)ambiguous.push(target);
  }
  return {canonical:owners.size===1&&!ambiguous.length?[...owners][0]:null,owners:[...owners],ambiguous};
}
function watchLinks(navigation,canonical,window){
  const issues=new Map();
  for(const row of navigation.objects[canonical]||[]){
    if(!/^\/watch\/\d{4}-\d{2}-\d{2}\.html#object-[a-f0-9]{16}$/.test(row.url))continue;
    if(window){
      if(navigation.version===1)continue;
      const start=Math.max(row.observed_from,row.start),end=Math.min(row.observed_until,row.end??row.observed_until);
      const overlaps=start<end&&start<window.until&&end>window.since;
      const instant=row.start===row.end&&row.start>=row.observed_from&&row.start<row.observed_until
        &&row.start>=window.since&&row.start<window.until;
      if(!overlaps&&!instant)continue;
    }
    if(!issues.has(row.url))issues.set(row.url,{day:row.day,url:row.url,sources:new Set()});
    const {sources}=issues.get(row.url);
    for(const source of row.sources||[row.source])sources.add(source);
  }
  return [...issues.values()].map(row=>({...row,sources:[...row.sources].sort()}));
}
function drawWatchLinks(node){
  const box=$('watch-links');if(!box)return;box.replaceChildren();
  if(!watchNavigation){box.append(html('p','muted',watchNavigationError?tr("Связи watch недоступны: не удалось получить индекс сводок."):tr("Связи watch загружаются…")));return;}
  const identity=watchIdentity(node);
  if(!identity.canonical){
    box.append(html('p','muted',identity.owners.length?tr("Неоднозначное соответствие: ")+identity.owners.join(', '):tr("Нет подтверждённого соответствия aliases/сетевому реестру.")));return;
  }
  if(watchIncidentWindow&&watchNavigation.version===1){
    box.append(html('p','muted',tr("В старом индексе указаны только даты сводок. Время связанных эпизодов неизвестно.")));return;
  }
  const rows=watchLinks(watchNavigation,identity.canonical,watchIncidentWindow);
  if(!rows.length){box.append(html('p','muted',tr("Связанных эпизодов в опубликованных сводках за выбранное окно нет. Это не подтверждение доступности.")));return;}
  const list=html('ul');
  for(const row of rows.slice(0,10)){
    const item=html('li'),link=html('a','',`${row.day} · ${row.sources.join(', ')}`);link.href=row.url;item.append(link);list.append(item);
  }
  box.append(list);
  if(rows.length>10)box.append(html('p','muted',tr("Ещё сводок: {0}", rows.length-10)));
}
function applyWatchIncident(){
  if(!graph||!watchNavigation)return;
  if(watchIncidentApplied){for(const id of watchIncidentNodes)nodeElements.get(id)?.group.classList.add('incident');return;}
  watchIncidentApplied=true;
  const wanted=[...new Set(watchQuery.getAll('canonical'))];if(!wanted.length)return;
  const since=Number(watchQuery.get('since')),until=Number(watchQuery.get('until'));
  const banner=$('incident-context');banner.hidden=false;
  if(!watchQuery.has('since')||!watchQuery.has('until')||!Number.isFinite(since)||!Number.isFinite(until)||since>=until||wanted.length>200){banner.textContent=tr("Ссылка инцидента содержит некорректный период или список объектов.");return;}
  const requested=new Set(wanted),nodes=[],ambiguous=[],matched=new Set();
  for(const node of graph.nodes){
    const identity=watchIdentity(node);
    if(identity.canonical&&requested.has(identity.canonical)){nodes.push(node.id);matched.add(identity.canonical);}
    else if(identity.owners.some(owner=>requested.has(owner)))ambiguous.push(node.name);
  }
  const missing=wanted.filter(name=>!matched.has(name));
  watchIncidentWindow={since,until};
  banner.textContent=tr("Инцидент watch · {0} → {1} МСК · узлов: {2}", historyTime(since), historyTime(until), nodes.length)
    +(missing.length?tr(" · нет однозначного узла: ")+missing.join(', '):'')+(ambiguous.length?tr(" · неоднозначные узлы: ")+ambiguous.join(', '):'');
  for(const id of nodes){watchIncidentNodes.add(id);nodeElements.get(id)?.group.classList.add('incident');}
  if(!nodes.length||nodes.length>200){if(nodes.length>200)banner.append(document.createTextNode(tr(" · Для истории выберите не больше 200 узлов.")));return;}
  const selectedNodes=graph.nodes.filter(node=>nodes.includes(node.id));
  autoFit=false;
  const xs=selectedNodes.map(node=>node.x),ys=selectedNodes.map(node=>node.y);
  view={x:Math.min(...xs)-110,y:Math.min(...ys)-100,w:Math.max(400,Math.max(...xs)-Math.min(...xs)+220),h:Math.max(300,Math.max(...ys)-Math.min(...ys)+200)};viewChanged();
  openHistory('',null,{nodes,since,until});
}
fetch('../watch/navigation.json',{signal:AbortSignal.timeout(8000),cache:'no-store'})
  .then(response=>{if(!response.ok)throw new Error('index unavailable');return response.json();})
  .then(data=>{watchNavigation=readWatchNavigation(data);applyWatchIncident();if(selected)drawWatchLinks(graph.nodes.find(node=>node.id===selected));})
  .catch(()=>{watchNavigationError=true;if(watchQuery.has('canonical')){$('incident-context').hidden=false;$('incident-context').textContent=tr("Не удалось сопоставить объекты инцидента: индекс watch недоступен.");}if(selected)drawWatchLinks(graph.nodes.find(node=>node.id===selected));});
