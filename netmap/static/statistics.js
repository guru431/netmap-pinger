'use strict';

let statisticsRequest;
const statNumber=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const statDateOptions={timeZone:'Europe/Moscow',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'};
const statDate=new Intl.DateTimeFormat('ru-RU',statDateOptions);
const statYearDate=new Intl.DateTimeFormat('ru-RU',{...statDateOptions,year:'2-digit'});

function statisticsNodes(nodeId='',target=''){
  const site=$('statistics-site').value,channel=$('statistics-channel').value;
  const nodes=graph.nodes.filter(node=>(!site||'site:'+ (node.site||'')===site)&&
    (!channel||Object.values(node.address_channels||{}).includes(channel)));
  nodes.sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true}));
  const select=$('statistics-node');
  select.replaceChildren(new Option('Все узлы',''),...nodes.map(node=>new Option(node.name+(node.site?' · '+node.site:''),node.id)));
  select.value=nodes.some(node=>node.id===nodeId)?nodeId:'';
  const node=nodes.find(node=>node.id===select.value);
  const addresses=(node?.addresses||[]).filter(address=>!channel||node.address_channels?.[address]===channel);
  const targets=$('statistics-target');
  targets.replaceChildren(new Option('Все адреса',''),...addresses.map(address=>new Option(address,address)));
  targets.value=addresses.includes(target)?target:'';
  targets.disabled=!addresses.length;
}

function openStatistics(nodeId='',target=''){
  if(!graph)return;
  $('statistics-site').replaceChildren(new Option('Все площадки',''),...siteNames().map(site=>new Option(site,'site:'+site)),new Option('Без площадки','site:'));
  $('statistics-channel').replaceChildren(...channelOptions('Все каналы'));
  statisticsNodes(nodeId,target);
  $('statistics-dialog').showModal();
  loadStatistics();
}

function statisticsLoss(value){
  return value===null?'—':statNumber.format(value)+'%';
}

function statisticsChart(item,data){
  const card=html('article','statistics-card');
  const heading=html('h3','',item.name+(item.target?' · '+item.target:''));
  const metadata=[item.site,channelLabels[item.channel],item.enabled?'':'Опрос приостановлен',item.comment].filter(Boolean);
  card.append(heading);
  if(metadata.length)card.append(html('p','muted statistics-meta',metadata.join(' · ')));
  if(!item.points.length){
    card.append(html('p','muted',item.target?'За выбранный период нет замеров.':'У узла нет адресов для опроса.'));
    return card;
  }
  const stats=item.summary,rtt=stats.rtt_ms;
  const metrics=[
    ['Медиана RTT',rtt&&statNumber.format(rtt.median)+' мс'],
    ['P95',rtt&&statNumber.format(rtt.p95)+' мс'],
    ['Средняя RTT',rtt&&statNumber.format(rtt.mean)+' мс'],
    ['Мин.–макс.',rtt&&`${statNumber.format(rtt.min)}–${statNumber.format(rtt.max)} мс`],
    ['Разброс (σ)',rtt&&statNumber.format(rtt.stddev)+' мс'],
    ['Потери',statisticsLoss(stats.loss)],
    ['Ответы / отправлено',`${statNumber.format(stats.received)} / ${statNumber.format(stats.sent)}`],
    ['Ошибки опроса',statNumber.format(stats.errors)]
  ];
  const summary=html('dl','statistics-metrics');
  for(const [label,value] of metrics){
    const metric=html('div');
    metric.append(html('dt','',label),html('dd','',value??'—'));
    summary.append(metric);
  }
  card.append(summary);

  const width=1000, height=144, latencyBottom=93, lossTop=107;
  const plot=html('canvas','statistics-plot');
  plot.width=width;plot.height=height;plot.tabIndex=0;
  plot.setAttribute('role','img');
  plot.setAttribute('aria-label',`Задержка и потери · ${heading.textContent}. Стрелки выбирают интервал.`);
  const ctx=plot.getContext('2d');
  const plotMax=rtt?Math.max(.1,rtt.max)*1.05:1;
  const y=value=>latencyBottom-(latencyBottom-3)*value/plotMax;
  const x=time=>width*(time-data.since)/(data.until-data.since);
  const byTime=new Map(item.points.map(point=>[point.time,point]));
  const lastIndex=Math.ceil((data.until-data.since)/data.step)-1;
  let index=Math.round((item.points.at(-1).time-data.since)/data.step);
  const axes=html('div','statistics-axes'),times=html('div','statistics-times');
  const date=data.step>=86400?statYearDate:statDate;
  axes.append(html('span','',rtt?statNumber.format(plotMax)+' мс':'RTT'),html('span','','0'),
    html('span','','100%'),html('span','','0%'));
  times.append(html('span','',date.format(data.since*1000)),html('span','',date.format(data.until*1000)));
  const figure=html('div','statistics-figure');
  figure.append(axes,plot,times);
  const cursor=html('p','statistics-cursor');
  cursor.setAttribute('aria-live','polite');
  card.append(figure,cursor);

  function render(){
    if(ctx){
      ctx.fillStyle='#edf1f4';ctx.fillRect(0,0,width,height);
      ctx.fillStyle='#d7e0e8';ctx.fillRect(0,latencyBottom,width,1);ctx.fillRect(0,lossTop,width,1);
      let previous=null;
      for(const point of item.points){
        const left=x(point.time),right=Math.min(width,x(point.time+data.step)),center=(left+right)/2;
        const r=point.rtt_ms;
        if(r){
          ctx.fillStyle='#a9c6d9';ctx.fillRect(left,y(r.max),right-left,Math.max(1,y(r.min)-y(r.max)));
          ctx.fillStyle='#0c6371';ctx.fillRect(left,y(r.median)-1,right-left,2);
          if(previous&&previous.time+data.step===point.time){
            ctx.strokeStyle='#0c6371';ctx.lineWidth=1.5;ctx.beginPath();
            ctx.moveTo(previous.x,previous.y);ctx.lineTo(center,y(r.median));ctx.stroke();
          }
          previous={time:point.time,x:center,y:y(r.median)};
        }else previous=null;
        if(point.loss!==null){
          const bar=Math.max(2,(height-lossTop-1)*point.loss/100);
          ctx.fillStyle=point.loss?'#c65142':'#78a79c';ctx.fillRect(left,height-bar,right-left,bar);
        }
        if(point.errors){
          ctx.fillStyle='#9873ac';ctx.fillRect(left,lossTop-6,right-left,4);
        }
      }
    }
    const time=data.since+index*data.step,point=byTime.get(time);
    if(ctx){
      ctx.fillStyle='#172c41';
      const left=x(time),right=Math.min(width,x(time+data.step));
      ctx.fillRect((left+right)/2,0,1.5,height);
    }
    const interval=`${date.format(time*1000)} — ${date.format(Math.min(time+data.step,data.until)*1000)}`;
    const detail=point?[
      point.rtt_ms?`RTT ${statNumber.format(point.rtt_ms.median)} мс`:'',
      point.sent?`потери ${statisticsLoss(point.loss)} · ответы ${point.received}/${point.sent}`:'',
      point.errors?`ошибки опроса ${point.errors}`:''
    ].filter(Boolean).join(' · '):'Нет измерений';
    cursor.textContent=`${interval} · ${detail}`;
  }
  plot.addEventListener('pointermove',event=>{
    const bounds=plot.getBoundingClientRect();
    const time=data.since+(event.clientX-bounds.left)/bounds.width*(data.until-data.since);
    const next=Math.min(lastIndex,Math.max(0,Math.floor((time-data.since)/data.step)));
    if(next!==index){index=next;render();}
  });
  plot.addEventListener('keydown',event=>{
    const choices={ArrowLeft:index-1,ArrowRight:index+1,Home:0,End:lastIndex};
    if(!Object.hasOwn(choices,event.key))return;
    event.preventDefault();index=Math.min(lastIndex,Math.max(0,choices[event.key]));render();
  });
  render();
  return card;
}

async function loadStatistics(page=1){
  statisticsRequest?.abort();
  const controller=new AbortController();statisticsRequest=controller;
  const query=new URLSearchParams({period:$('statistics-period').value,page:String(page)});
  for(const [key,id] of [['site','site'],['channel','channel'],['node_id','node'],['target','target']]){
    const value=$('statistics-'+id).value;
    if(value)query.set(key,key==='site'?value.slice(5):value);
  }
  $('statistics-results').replaceChildren();
  $('statistics-status').textContent='Загрузка замеров…';
  $('statistics-pagination').hidden=true;
  try{
    const data=await api('api/statistics?'+query,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])});
    if(controller.signal.aborted)return;
    const pages=Math.ceil(data.total/data.page_size);
    if(data.total&&page>pages){loadStatistics(pages);return;}
    $('statistics-results').replaceChildren(...data.items.map(item=>statisticsChart(item,data)));
    const offset=(page-1)*data.page_size;
    const step=data.step<3600?`${data.step/60} мин`:data.step<86400?`${data.step/3600} ч`:'сутки';
    $('statistics-status').textContent=data.total?`Показано ${offset+1}–${offset+data.items.length} из ${data.total} · интервал графика ${step}`:'Узлы с выбранными метками не найдены.';
    $('statistics-pagination').hidden=pages<=1;
    $('statistics-page').textContent=`Страница ${page} из ${pages}`;
    $('statistics-previous').disabled=page===1;$('statistics-previous').onclick=()=>loadStatistics(page-1);
    $('statistics-next').disabled=page===pages;$('statistics-next').onclick=()=>loadStatistics(page+1);
  }catch(error){
    if(!controller.signal.aborted)$('statistics-status').textContent='Не удалось получить статистику. '+error.message;
  }
}

$('statistics-button').addEventListener('click',()=>openStatistics());
$('node-statistics').addEventListener('click',()=>openStatistics(selected));
$('statistics-filters').addEventListener('submit',event=>{event.preventDefault();loadStatistics();});
for(const id of ['site','channel','node']){
  $('statistics-'+id).addEventListener('change',()=>{
    statisticsNodes($('statistics-node').value,$('statistics-target').value);
    loadStatistics();
  });
}
for(const id of ['period','target'])$('statistics-'+id).addEventListener('change',()=>loadStatistics());
$('statistics-dialog').addEventListener('close',()=>statisticsRequest?.abort());
