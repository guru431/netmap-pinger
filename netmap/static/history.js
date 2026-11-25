'use strict';

let historyItems=[],historyCursor=null,historyWindow=null,historyRequest=0,historyBusy=false;
let historyIncidentNodes=[];
const historyDate=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
function historyTime(ts){return historyDate.format(new Date(ts*1000));}
function historyDuration(seconds){
  let s=Math.max(0,Math.floor(seconds));const days=Math.floor(s/86400);s%=86400;const hours=Math.floor(s/3600);s%=3600;const minutes=Math.floor(s/60);s%=60;
  return [days?`${days} д`:'',hours?`${hours} ч`:'',minutes?`${minutes} мин`:'',s||(!days&&!hours&&!minutes)?`${s} с`:''].filter(Boolean).join(' ');
}
function moscowInput(ts,seconds=false){return new Date((ts+10800)*1000).toISOString().slice(0,seconds?19:16);}
function historyPeriod(){
  if($('history-period').value==='custom')return;
  const end=state?.server_time??Date.now()/1000;
  // Round the upper boundary up to the next minute so the current measurement is included.
  $('history-from').value=moscowInput(end-Number($('history-period').value));
  $('history-until').value=moscowInput(Math.ceil(end/60)*60);
}
function historyTargets(selectedTarget=''){
  const node=graph?.nodes.find(n=>n.id===$('history-node').value);
  $('history-target').replaceChildren(new Option('Все адреса и имена',''),...(node?.addresses||[]).map(a=>new Option(a,a)));
  if(selectedTarget&&!node?.addresses.includes(selectedTarget))$('history-target').add(new Option(selectedTarget,selectedTarget));
  $('history-target').value=selectedTarget;
  $('history-target-field').hidden=$('history-level').value==='node';
}
function openHistory(nodeId='',target=null,context=null){
  if(!graph)return;
  historyIncidentNodes=context?.nodes||[];
  $('history-node').replaceChildren(new Option('Все узлы',''),...graph.nodes.map(n=>new Option(n.name,n.id)));
  $('history-node').value=nodeId||'';$('history-level').value='address';$('history-problems').checked=target===null;
  $('history-period').value=target?'3600':'86400';historyTargets(target||'');historyPeriod();
  if(context){
    $('history-period').value='custom';$('history-from').value=moscowInput(context.since,true);$('history-until').value=moscowInput(context.until,true);
    $('history-node').add(new Option('Все узлы инцидента','__incident__'));$('history-node').value='__incident__';
    $('history-problems').checked=false;
  }
  $('history-dialog').showModal();loadHistory();
}
function drawHistory(){
  const headers=['Узел','IP / имя','Состояние','Начало, МСК','Конец, МСК','Полная длительность'];
  const rows=historyItems.map(item=>{
    const tr=html('tr');tr.id=`history-event-${item.id}`;tr.tabIndex=-1;
    const cells=[item.node_name,item.target||'Узел целиком','',historyTime(item.started_at),item.ongoing?'Продолжается':historyTime(item.ended_at),historyDuration(item.duration)];
    cells.forEach((value,i)=>{
      const td=html('td','',value);td.dataset.label=headers[i];
      if(i===2){const badge=html('span','history-state');badge.append(html('i',`dot ${item.status}`),document.createTextNode(labels[item.status]||item.status));td.append(badge);}
      if(i===3&&item.initial)td.append(html('small','',['down','partial'].includes(item.status)?'с первого замера; начало фактического обрыва неизвестно':'с первого замера'));
      if(i===4&&(item.stale||item.next_status==='gap'))td.append(html('small','','последний замер перед пропуском измерений'));
      if(i===2&&item.detail)td.append(html('small','',item.detail));
      if(i===2)for(const change of item.detail_changes||[])td.append(html('small','',`${historyTime(change.observed_at)} · ${change.detail||'Без дополнительных сведений'}`));
      tr.append(td);
    });return tr;
  });
  $('history-rows').replaceChildren(...rows);$('history-more').hidden=!historyCursor;
  $('history-empty').hidden=rows.length>0;
  $('history-empty').textContent=$('history-problems').checked?'Обрывов, ошибок и пропусков за выбранный период не найдено.':'Записей за выбранный период нет.';
  drawHistoryTimeline();
}
function drawHistoryTimeline(){
  const timeline=$('history-timeline');
  const oneEntity=!!$('history-node').value&&$('history-node').value!=='__incident__'&&($('history-level').value==='node'||!!$('history-target').value);
  timeline.toggleAttribute('hidden',!oneEntity||!historyWindow);timeline.replaceChildren();if(timeline.hasAttribute('hidden'))return;
  const [start,end]=historyWindow;
  // The unpainted background means no displayed observations, never assumed availability.
  for(const item of [...historyItems].reverse()){
    const left=item.display_start,right=item.display_end;if(right<left)continue;
    const rect=elem('rect',{x:1000*(left-start)/(end-start),y:0,width:Math.max(.7,1000*(right-left)/(end-start)),height:42,fill:colors[item.status]||colors.unknown,tabindex:0,role:'button','aria-label':`${labels[item.status]}, ${historyTime(left)}`});
    rect.append(elem('title',{},`${labels[item.status]}\n${historyTime(left)} — ${historyTime(right)}\nВ выбранном окне: ${historyDuration(item.display_duration)}`));
    const focus=()=>{const row=$(`history-event-${item.id}`);row?.scrollIntoView({block:'nearest'});row?.focus({preventScroll:true});};
    rect.addEventListener('click',focus);rect.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();focus();}});timeline.append(rect);
  }
}
async function loadHistory(more=false){
  if(more&&historyBusy)return;
  const version=++historyRequest;historyBusy=true;$('history-more').disabled=true;
  const since=Date.parse($('history-from').value+'+03:00')/1000,until=Date.parse($('history-until').value+'+03:00')/1000;
  if(!Number.isFinite(since)||!Number.isFinite(until)||since>=until){toast('Укажите корректный период истории');historyBusy=false;return;}
  const query=new URLSearchParams({since:String(since),until:String(until),level:$('history-level').value,problems:String($('history-problems').checked)});
  if($('history-node').value==='__incident__')for(const id of historyIncidentNodes)query.append('node_ids',id);
  else if($('history-node').value)query.set('node_id',$('history-node').value);
  if($('history-level').value==='address'&&$('history-target').value)query.set('target',$('history-target').value);
  if(more&&historyCursor)query.set('cursor',historyCursor);
  $('history-summary').textContent='Загрузка истории…';
  try{
    const data=await api('api/history?'+query);
    if(version!==historyRequest||!$('history-dialog').open)return;
    historyItems=more?[...historyItems,...data.items]:data.items;historyCursor=data.next_cursor;historyWindow=[since,until];
    $('history-summary').textContent=data.recorded_since===null?'История начнётся после первой проверки новым сборщиком.':`История ведётся с ${historyTime(data.recorded_since)} МСК · показано событий: ${historyItems.length}${historyCursor?' · есть ещё':''}`;
    for(const item of data.items){
      if(!Array.from($('history-node').options).some(o=>o.value===item.node_id))$('history-node').add(new Option(item.node_name+' (в истории)',item.node_id));
      if(item.target&&item.node_id===$('history-node').value&&!Array.from($('history-target').options).some(o=>o.value===item.target))$('history-target').add(new Option(item.target+' (в истории)',item.target));
    }
    drawHistory();
  }catch(error){if(version===historyRequest){$('history-summary').textContent='Не удалось получить историю: '+error.message;}}
  finally{if(version===historyRequest){historyBusy=false;$('history-more').disabled=false;}}
}
$('history-button').addEventListener('click',()=>openHistory());
$('node-history').addEventListener('click',()=>openHistory(selected));
$('history-filters').addEventListener('submit',event=>{event.preventDefault();historyPeriod();loadHistory();});
$('history-node').addEventListener('change',()=>{historyTargets();loadHistory();});
$('history-level').addEventListener('change',()=>{historyTargets();loadHistory();});
$('history-target').addEventListener('change',()=>{$('history-problems').checked=false;loadHistory();});
$('history-period').addEventListener('change',()=>{historyPeriod();loadHistory();});
$('history-problems').addEventListener('change',()=>loadHistory());
for(const id of ['history-from','history-until'])$(id).addEventListener('input',()=>$('history-period').value='custom');
$('history-more').addEventListener('click',()=>loadHistory(true));
$('history-dialog').addEventListener('close',()=>{historyRequest++;historyBusy=false;});
