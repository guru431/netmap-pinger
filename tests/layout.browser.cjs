'use strict';

// Isolated browser checks: real UI with an in-memory API, no probes or production data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium, firefox, webkit} = require(process.argv[2] || 'playwright');
const staticRoot = path.resolve(__dirname, '../netmap/static');
setTimeout(()=>{console.error('Browser layout checks exceeded 90 seconds');process.exit(1);},90000).unref();
const fixture = () => ({revision:1,name:'Layout test',source:'',import_notes:[],
  settings:{interval:15,timeout:1,concurrency:32,netwatch_recipient:'alerts@example.org',netwatch_minutes:10},
  nodes:[['a',100,100],['b',260,100],['c',550,240],['d',100,400]].map(([id,x,y])=>({
    id,name:id,kind:'Server',x,y,addresses:id==='a'?['192.0.2.1','router.example']:[],notes:id==='a'?'Template notes':'',
    enabled:id!=='a',allow_offline:id==='a',site:id==='a'?'Site B':'',
    address_comments:id==='a'?{'192.0.2.1':'LAN','router.example':'DNS'}:{},
    address_channels:id==='a'?{'192.0.2.1':'lan','router.example':'wan'}:{}})),
  edges:[
    {id:'internal',from_id:'a',to_id:'b',points:[[98,119],[180,50],[263,121]],label:'',color:'#7894a5'},
    {id:'external',from_id:'b',to_id:'c',points:[[257,118],[420,120],[552,262]],label:'',color:'#7894a5'},
    {id:'free',from_id:null,to_id:null,points:[[440,350],[500,400]],label:'',color:'#7894a5'},
    {id:'partial-from',from_id:'c',to_id:null,points:[[552,262],[578,286],[620,310]],label:'',color:'#7894a5'},
    {id:'partial-to',from_id:null,to_id:'d',points:[[50,460],[98,421]],label:'',color:'#7894a5'},
    {id:'new',from_id:'a',to_id:'d',points:[],label:'',color:'#7894a5'}
  ]});

async function check(browserType, mobile=false) {
  console.log(`Checking ${browserType.name()} ${mobile?'touch':'desktop'}...`);
  const browser = await browserType.launch({headless:true});
  try {
    const context = await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1366,height:900},hasTouch:mobile});
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let stored=fixture(),writes=0,rejectSave=false,diagnosticCalls=0,statisticsQuery;
    await page.route('http://netmap.test/**',async route=>{
      const url=new URL(route.request().url()),name=url.pathname;
      if(name==='/api/state')return route.fulfill({json:{graph:stored,nodes:{a:{status:'up',addresses:[{target:'192.0.2.1',status:'up',checked_at:100,rtt_ms:1}]}},server_time:100,stale_after:45,
        monitor:{last_completed:100,running:true,duration:0,completed:0,targets:0}}});
      if(name==='/api/map'){
        if(rejectSave){rejectSave=false;return route.fulfill({status:409,json:{detail:'Test conflict'}});}
        const next=route.request().postDataJSON();
        assert.equal(next.revision,stored.revision);
        stored={...next,revision:next.revision+1};writes++;
        return route.fulfill({json:stored});
      }
      if(name==='/api/map/preview'){
        const next=route.request().postDataJSON(),newNode=next.nodes.find(n=>n.id==='replacement');
        assert.equal(next.revision,stored.revision);
        assert.equal(next.nodes.length,stored.nodes.length);
        assert.equal(next.edges.length,stored.edges.length);
        return route.fulfill({json:{revision:stored.revision,
          nodes:{added:[newNode],removed:[stored.nodes.find(n=>n.id==='d')],changed:[]},
          edges:{added:[],removed:[],changed:[]},
          settings:{interval:{before:stored.settings.interval,after:next.settings.interval}},
          stopped_targets:['192.0.2.2']}});
      }
      if(name==='/api/diagnostics'){
        diagnosticCalls++;
        return diagnosticCalls===1?route.fulfill({status:502,contentType:'text/html',body:'<h1>Bad gateway</h1>'}):
          route.fulfill({status:503,json:{detail:'Diagnostic unavailable (test)'}});
      }
      if(name==='/api/statistics'){
        statisticsQuery=Object.fromEntries(url.searchParams);
        const measurement={sent:3,received:2,errors:1,loss:100/3,rtt_ms:{min:10,median:14,p95:18,max:20,mean:15,stddev:5}};
        const total=statisticsQuery.channel||statisticsQuery.target?1:9;
        return route.fulfill({json:{since:0,until:10000,step:300,total,page_size:8,
          items:[{name:'Router',target:'router.example',site:'Site B',channel:'wan',enabled:true,
            summary:measurement,points:[{...measurement,time:600},{...measurement,time:1200}]}]}});
      }
      const file=name==='/'?'index.html':/^\/static\/[a-z.]+$/.test(name)?name.slice(8):null;
      if(file)return route.fulfill({body:await fs.readFile(path.join(staticRoot,file)),
        contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});
      return route.fulfill({status:404,body:'Not found'});
    });
    const selection=()=>page.locator('.map-node[aria-pressed="true"]').evaluateAll(nodes=>nodes.map(n=>n.dataset.id).sort());
    const point=(x,y)=>page.locator('#map').evaluate((svg,[x,y])=>{
      const p=new DOMPoint(x,y).matrixTransform(svg.getScreenCTM());return {x:p.x,y:p.y};
    },[x,y]);
    async function clickNode(id,modifier=null,touch=false){
      const box=await page.locator(`.map-node[data-id="${id}"] .node-box`).boundingBox();
      if(modifier)await page.keyboard.down(modifier);
      try {if(touch)await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);
        else await page.mouse.click(box.x+box.width/2,box.y+box.height/2);}
      finally {if(modifier)await page.keyboard.up(modifier);}
    }
    async function dragWorld(x,y,dx,dy,cancel=false){
      const from=await point(x,y),to=await point(x+dx,y+dy);
      await page.mouse.move(from.x,from.y);await page.mouse.down();
      await page.mouse.move(to.x,to.y,{steps:5});
      if(cancel)await page.locator('#map').dispatchEvent('pointercancel',{pointerId:await page.evaluate(()=>drag.pointerId),pointerType:'mouse'});
      await page.mouse.up();
    }
    const waitWrites=async count=>{
      await page.waitForFunction(count=>graph?.revision===count+1&&!saving,count);
      assert.equal(writes,count);
    };
    await page.goto('http://netmap.test/');
    await page.locator('.map-node').first().waitFor();
    // Imported endpoints can sit outside today's icons; only attached ends snap to node centers.
    assert.deepEqual(await page.locator('#edge-layer .edge-path').evaluateAll(paths=>paths.map(p=>p.getAttribute('d'))),[
      'M100 100 L180 50 L260 100','M260 100 L420 120 L550 240','M440 350 L500 400',
      'M550 240 L578 286 L620 310','M50 460 L100 400','M100 100 L100 400'
    ]);
    const singleMove=await page.evaluate(()=>{
      const before=JSON.stringify(graph),moved=structuredClone(graph);
      const preview=edgePoints(graph.edges[1],new Map([['c',{dx:15,dy:10}]]));
      moveGraphNodes(moved,['c'],15,10);
      return {preview,external:moved.edges[1].points,partial:moved.edges[3].points,unchanged:JSON.stringify(graph)===before};
    });
    assert.deepEqual(singleMove,{preview:[[260,100],[420,120],[565,250]],
      external:[[260,100],[420,120],[565,250]],partial:[[565,250],[578,286],[620,310]],unchanged:true});
    assert.deepEqual(stored,fixture());assert.equal(writes,0);
    // Invalid report URLs neither consume the ten visible slots nor inflate the remainder.
    await page.waitForFunction(()=>watchNavigationError);
    const watchLinks=await page.evaluate(()=>{
      const valid=Array.from({length:12},(_,i)=>({url:'/watch/2026-11-15.html#object-'+i.toString(16).padStart(16,'0'),day:'2026-11-15',start:1,end:2,sources:['check']}));
      watchNavigation={identities:{'192.0.2.1':['test-router'],'router.example':['test-router']},objects:{'test-router':[{...valid[0],url:'javascript:alert(1)'},...valid]}};
      drawWatchLinks(graph.nodes[0]);
      const box=$('watch-links');
      return {count:box.querySelectorAll('a').length,text:box.textContent};
    });
    assert.equal(watchLinks.count,10);
    assert.ok(watchLinks.text.includes('Ещё сводок: 2'));
    const incidentSources=await page.evaluate(()=>{
      const row={day:'2026-11-15',url:'/watch/2026-11-15.html#object-0000000000000000',observed_from:0,observed_until:86400};
      const index=readWatchNavigation({version:2,identities:{},objects:{host:[
        {...row,source:'zabbix',start:100,end:120},{...row,source:'mikrotik',start:80000,end:80010},
        {...row,source:'checks',start:85000,end:null}
      ]}});
      const old=readWatchNavigation({version:1,identities:{},objects:{host:[{...row,start:0,end:86400,sources:['zabbix']}]}});
      return [
        watchLinks(index,'host',{since:110,until:115}).map(issue=>issue.sources),
        watchLinks(index,'host',{since:300,until:400}).map(issue=>issue.sources),
        watchLinks(index,'host',{since:85010,until:85020}).map(issue=>issue.sources),
        watchLinks(index,'host',{since:86410,until:86420}).map(issue=>issue.sources),
        watchLinks(old,'host',{since:110,until:115}).map(issue=>issue.sources),
        watchLinks(old,'host',null).map(issue=>issue.sources)
      ];
    });
    assert.deepEqual(incidentSources,[[['zabbix']],[],[['checks']],[],[],[['zabbix']]]);
    const historyBounds=await page.evaluate(()=>{
      historyItems=[{id:1,node_name:'a',target:'192.0.2.1',status:'down',started_at:100,ended_at:145,
        duration:45,display_start:112,display_end:120,display_duration:8},
        {id:2,node_name:'a',target:'192.0.2.1',status:'down',started_at:100,ended_at:119,
          duration:19,display_start:112,display_end:119,display_duration:7,next_status:'gap'}];
      historyWindow=[112,120];
      $('history-node').replaceChildren(new Option('a','a'));$('history-target').replaceChildren(new Option('192.0.2.1','192.0.2.1'));
      drawHistory();
      const cells=$('history-rows').querySelector('tr').children;
      const interval=$('history-timeline').lastElementChild;
      return {ended:cells[4].textContent===historyTime(145),duration:cells[5].textContent,
        width:interval.getAttribute('width'),caption:interval.querySelector('title').textContent,
        gapLabel:$('history-event-2').children[4].querySelector('small').textContent};
    });
    assert.equal(historyBounds.ended,true);
    assert.equal(historyBounds.duration,'45 с');
    assert.equal(historyBounds.width,'1000');
    assert.match(historyBounds.caption,/В выбранном окне: 8 с/);
    assert.equal(historyBounds.gapLabel,'последний замер перед пропуском измерений');
    await page.evaluate(()=>runDiagnostic(graph.nodes[0],'192.0.2.1','ping'));
    assert.equal(await page.locator('#diagnostic-status').textContent(),'Не удалось запустить команду (HTTP 502)');
    await page.evaluate(()=>runDiagnostic(graph.nodes[0],'192.0.2.1','ping'));
    assert.equal(await page.locator('#diagnostic-status').textContent(),'Diagnostic unavailable (test)');
    await page.locator('#diagnostic-dialog [data-close]').first().click();
    await page.locator('#diagnostic-dialog').waitFor({state:'hidden'});
    await page.locator('#edit-layout').click();
    if(mobile)await page.locator('#group-select').click();
    await clickNode('a',null,mobile);await clickNode('b',mobile?null:'Control',mobile);
    assert.deepEqual(await selection(),['a','b']);
    await dragWorld(100,100,40,30);await waitWrites(1);
    // Browsers quantize screen coordinates; the whole group must share the exact delta.
    const dx=stored.nodes[0].x-100,dy=stored.nodes[0].y-100;
    assert.ok(Math.abs(dx-40)<1&&Math.abs(dy-30)<1);
    assert.deepEqual(stored.nodes.map(n=>[n.x,n.y]),[[100+dx,100+dy],[260+dx,100+dy],[550,240],[100,400]]);
    assert.deepEqual(stored.edges[0].points,[[100+dx,100+dy],[180+dx,50+dy],[260+dx,100+dy]]);
    assert.deepEqual(stored.edges[1].points,[[260+dx,100+dy],[420,120],[550,240]]);
    assert.deepEqual(stored.edges[2].points,fixture().edges[2].points);
    assert.deepEqual(await selection(),['a','b']);
    const internalPath=await page.locator('#edge-layer .edge-path').first().getAttribute('d');
    assert.equal(internalPath,stored.edges[0].points.map(([x,y],i)=>`${i?'L':'M'}${x} ${y}`).join(' '));
    await page.keyboard.press('ArrowRight');await waitWrites(2);
    await page.keyboard.press('Shift+ArrowDown');await waitWrites(3);
    assert.deepEqual(stored.nodes.slice(0,2).map(n=>[n.x,n.y]),[[101+dx,110+dy],[261+dx,110+dy]]);
    const {x:ax,y:ay}=stored.nodes[0],{x:bx,y:by}=stored.nodes[1];
    const beforeCancel=structuredClone(stored);
    await dragWorld(ax,ay,20,20,true);
    assert.deepEqual(stored,beforeCancel);assert.equal(writes,3);
    assert.equal(await page.locator('.map-node[data-id="a"]').getAttribute('transform'),`translate(${ax} ${ay})`);
    console.log('  move, edges, arrows and pointer cancellation passed');
    rejectSave=true;
    await dragWorld(ax,ay,20,20);
    await page.waitForFunction(()=>!saving);
    await page.locator('#toast').filter({hasText:'Test conflict'}).waitFor();
    assert.deepEqual(stored,beforeCancel);
    assert.equal(await page.locator('.map-node[data-id="a"]').getAttribute('transform'),`translate(${ax} ${ay})`);
    console.log('  conflict rollback passed');
    await page.keyboard.press('Escape');assert.deepEqual(await selection(),[]);
    if(!mobile)await page.keyboard.down('Shift');
    await dragWorld(60,55,300,130);
    if(!mobile)await page.keyboard.up('Shift');
    assert.deepEqual(await selection(),['a','b']);assert.equal(writes,3);
    await clickNode('b',mobile?null:'Shift',mobile);assert.deepEqual(await selection(),['a']);
    await clickNode('b',mobile?null:'Meta',mobile);assert.deepEqual(await selection(),['a','b']);
    if(mobile)await page.locator('#toggle-list').click();
    await page.locator('#search').fill('c');
    await page.keyboard.press('ArrowRight');assert.equal(writes,3);
    await page.locator('#search').fill('');
    if(mobile)await page.locator('#toggle-list').click();
    await page.locator('#settings-button').click();
    await page.locator('#settings-name').press('ArrowRight');assert.equal(writes,3);
    await page.locator('#settings-dialog [data-close]').first().click();
    if(mobile&&browserType===chromium){
      const session=await context.newCDPSession(page);
      const a=await point(ax,ay),b=await point(bx,by);
      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...a,id:1}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x+15,y:a.y+15,id:1}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:a.x+15,y:a.y+15,id:1},{...b,id:2}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x-20,y:a.y+15,id:1},{x:b.x+20,y:b.y,id:2}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      assert.equal(writes,3);assert.deepEqual(stored,beforeCancel);
      assert.equal(await page.locator('.map-node[data-id="a"]').getAttribute('transform'),`translate(${ax} ${ay})`);
    }
    const screenshotDir=process.env.NETMAP_BROWSER_OUTPUT_DIR;
    if(screenshotDir){
      await fs.mkdir(screenshotDir,{recursive:true});
      await page.screenshot({path:path.join(screenshotDir,`${browserType.name()}-${mobile?'touch':'desktop'}.png`)});
    }
    await page.reload();await page.locator('.map-node').first().waitFor();
    assert.equal(await page.locator('.map-node[data-id="b"]').getAttribute('transform'),`translate(${bx} ${by})`);
    assert.equal(await page.locator('#edge-layer .edge-path').first().getAttribute('d'),
      stored.edges[0].points.map(([x,y],i)=>`${i?'L':'M'}${x} ${y}`).join(' '));
    assert.equal(await page.locator('#layout-help').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    const beforeDuplicate=structuredClone(stored),original=beforeDuplicate.nodes[0];
    await clickNode('a',null,mobile);
    const duplicateButton=page.getByRole('button',{name:'Дублировать',exact:true});
    const buttonFits=await duplicateButton.evaluate(button=>{
      const box=button.getBoundingClientRect(),panel=button.closest('aside').getBoundingClientRect();
      return box.x>=panel.x&&box.right<=panel.right&&box.right<=window.innerWidth;
    });
    assert.equal(buttonFits,true);
    await duplicateButton.click();
    assert.equal(await page.locator('#node-dialog-title').textContent(),'Копия узла');
    assert.equal(await page.locator('#node-name').inputValue(),'a (копия)');
    assert.equal(await page.locator('#node-kind').inputValue(),original.kind);
    assert.deepEqual(await page.locator('.address-input').evaluateAll(inputs=>inputs.map(input=>input.value)),original.addresses);
    assert.deepEqual(await page.locator('.comment-input').evaluateAll(inputs=>inputs.map(input=>input.value)),['LAN','DNS']);
    assert.equal(await page.locator('#node-notes').inputValue(),original.notes);
    assert.equal(await page.locator('#node-enabled').isChecked(),false);
    assert.equal(await page.locator('#node-allow-offline').isChecked(),true);
    assert.equal(await page.locator('#node-netwatch').isChecked(),true);
    assert.equal(await page.locator('#node-netwatch').isDisabled(),true);
    assert.equal(await page.locator('#delete-node').isVisible(),false);
    assert.deepEqual(await page.locator('.editor-state-label').allTextContents(),['Нет данных','Нет данных']);
    if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,`${browserType.name()}-${mobile?'touch':'desktop'}-duplicate.png`)});
    await page.locator('#node-dialog').getByRole('button',{name:'Отмена',exact:true}).click();
    assert.deepEqual(stored,beforeDuplicate);assert.equal(writes,3);
    await duplicateButton.click();
    await page.locator('#node-name').fill('New router');
    await page.locator('.address-input').first().fill('192.0.2.2');
    await page.locator('.comment-input').first().fill('New LAN');
    await page.locator('#node-enabled').check();
    assert.equal(await page.locator('#node-netwatch').isDisabled(),true);
    await page.locator('#node-allow-offline').uncheck();
    await page.locator('#node-netwatch').uncheck();
    rejectSave=true;
    await page.locator('#node-dialog button[type="submit"]').click();
    await page.locator('#toast').filter({hasText:'Test conflict'}).waitFor();
    assert.equal(await page.locator('#node-dialog').isVisible(),true);
    assert.equal(await page.locator('#node-name').inputValue(),'New router');
    assert.deepEqual(stored,beforeDuplicate);
    await page.locator('#node-dialog button[type="submit"]').click();await waitWrites(4);
    const copy=stored.nodes.at(-1);
    assert.equal(stored.nodes.length,beforeDuplicate.nodes.length+1);
    assert.notEqual(copy.id,original.id);
    assert.deepEqual(copy,{...original,id:copy.id,name:'New router',addresses:['192.0.2.2','router.example'],
      address_comments:{'192.0.2.2':'New LAN','router.example':'DNS'},address_channels:{'192.0.2.2':'lan','router.example':'wan'},
      enabled:true,allow_offline:false,netwatch:false,x:original.x+60,y:original.y+60});
    assert.deepEqual(stored.nodes.slice(0,-1),beforeDuplicate.nodes);
    assert.deepEqual(stored.edges,beforeDuplicate.edges);
    assert.equal(await page.locator('#detail-name').textContent(),copy.name);
    assert.equal(await page.locator('#detail-status').textContent(),'Ещё не проверен');
    assert.equal(await page.locator('#detail-netwatch').textContent(),'Netwatch выключен');
    await page.reload();await page.locator(`.map-node[data-id="${copy.id}"]`).waitFor();
    await clickNode('a',null,mobile);await page.locator('#edit-node').click();
    assert.equal(await page.locator('#node-name').inputValue(),original.name);
    assert.equal(await page.locator('#delete-node').isVisible(),true);
    await page.locator('#node-name').fill('Original renamed');
    await page.locator('#node-dialog button[type="submit"]').click();await waitWrites(5);
    assert.deepEqual(stored.nodes[0],{...original,name:'Original renamed',netwatch:true});
    assert.deepEqual(stored.nodes.at(-1),copy);
    await page.locator('#add-node').click();
    assert.equal(await page.locator('#node-name').inputValue(),'');
    assert.equal(await page.locator('#node-netwatch').isChecked(),true);
    assert.equal(await page.locator('#node-netwatch').isEnabled(),true);
    assert.equal(await page.locator('#node-dialog').getAttribute('data-template-id'),'');
    assert.equal(await page.locator('.address-input').count(),1);
    assert.equal(await page.locator('.address-input').inputValue(),'');
    await page.locator('#node-dialog').getByRole('button',{name:'Отмена',exact:true}).click();
    const originalEdge=structuredClone(stored.edges.find(edge=>edge.id==='partial-from'));
    const edgeHit=page.locator('#edge-layer .edge-hit').nth(3);
    await edgeHit.press('Enter');
    await page.locator('#edge-label').fill('Ломаная');
    await page.locator('#edge-dialog button[type="submit"]').click();await waitWrites(6);
    assert.deepEqual(stored.edges[3],{...originalEdge,label:'Ломаная'});
    await edgeHit.press('Enter');
    await page.locator('#edge-to').selectOption('d');
    await page.locator('#edge-dialog button[type="submit"]').click();await waitWrites(7);
    const attached=stored.nodes.find(node=>node.id==='d');
    assert.deepEqual(stored.edges[3],{...originalEdge,to_id:'d',label:'Ломаная',
      points:[...originalEdge.points.slice(0,-1),[attached.x,attached.y]]});
    const replacement=structuredClone(stored);
    replacement.nodes.find(n=>n.id==='d').id='replacement';
    replacement.nodes.find(n=>n.id==='replacement').name='Новый узел';
    const revisedCopy=replacement.nodes.find(n=>n.id===copy.id);
    revisedCopy.addresses=revisedCopy.addresses.filter(address=>address!=='192.0.2.2');
    delete revisedCopy.address_comments['192.0.2.2'];
    for(const edge of replacement.edges)for(const end of ['from_id','to_id'])if(edge[end]==='d')edge[end]='replacement';
    replacement.settings.interval=25;
    const upload=()=>page.locator('#import-file').setInputFiles({name:'map.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(replacement))});
    await upload();await page.locator('#import-dialog').waitFor();
    const preview=await page.locator('#import-changes').textContent();
    assert.match(preview,/Новый узел \[replacement\].*d \[d\].*15 → 25.*Адреса, которые перестанут проверяться192\.0\.2\.2/s);
    assert.equal(writes,7);
    await page.locator('#import-dialog').getByRole('button',{name:'Отмена',exact:true}).click();
    assert.equal(writes,7);
    await upload();await page.locator('#import-dialog').waitFor();
    await page.locator('#apply-import').click();await waitWrites(8);
    assert.deepEqual(stored,{...replacement,revision:replacement.revision+1});
    await page.locator('#settings-button').click();
    const recipient=page.getByLabel('Почта для уведомлений');
    const minutes=page.getByLabel('Задержка уведомления об обрыве, минут');
    assert.equal(await recipient.inputValue(),'alerts@example.org');
    assert.equal(await minutes.inputValue(),'10');
    await recipient.fill('alerts+map@example.org');
    await minutes.fill('3');
    await page.locator('#settings-dialog').getByRole('button',{name:'Сохранить'}).click();
    await waitWrites(9);
    await page.reload();await page.locator('.map-node').first().waitFor();
    await page.locator('#settings-button').click();
    assert.equal(await recipient.inputValue(),'alerts+map@example.org');
    assert.equal(await minutes.inputValue(),'3');
    await page.locator('#settings-dialog').getByRole('button',{name:'Отмена'}).click();
    await page.locator('#statistics-button').click();
    const statistics=page.locator('#statistics-dialog');
    const plot=statistics.locator('canvas');
    await plot.waitFor();
    await statistics.getByRole('button',{name:'Далее'}).click();
    await statistics.getByText('Страница 2 из 2').waitFor();
    assert.equal(statisticsQuery.page,'2');
    await statistics.getByLabel('Площадка').selectOption('site:Site B');
    await statistics.getByLabel('Канал').selectOption('wan');
    await statistics.getByLabel('Период').selectOption('1y');
    await plot.waitFor();
    assert.deepEqual(statisticsQuery,{period:'1y',page:'1',site:'Site B',channel:'wan'});
    await plot.press('ArrowLeft');
    assert.match(await statistics.locator('.statistics-cursor').textContent(),/Нет измерений/);
    assert.equal(await statistics.evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth),true);
    if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,`${browserType.name()}-${mobile?'touch':'desktop'}-statistics.png`)});
    await statistics.getByRole('button',{name:'Закрыть'}).click();
    await clickNode('a');
    await page.getByRole('button',{name:'График router.example'}).click();
    await plot.waitFor();
    assert.deepEqual(statisticsQuery,{period:'1y',page:'1',node_id:'a',target:'router.example'});
    await statistics.getByRole('button',{name:'Закрыть'}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    assert.deepEqual(errors,[]);
    console.log(`${browserType.name()} ${mobile?'390px touch':'1366px'}: layout, edge edit, history, statistics, watch links, JSON preview OK`);
    await context.close();
  } finally {await browser.close();}
}
(async()=>{
  const names=(process.argv[3]||'firefox,chromium,webkit').split(',');
  assert.ok(names.every(name=>['firefox','chromium','webkit'].includes(name)));
  const results=await Promise.allSettled([firefox,chromium,webkit].filter(type=>names.includes(type.name())).map(async type=>{
    await check(type);
    if(type!==firefox)await check(type,true);
  }));
  for(const result of results)if(result.status==='rejected')throw result.reason;
})().catch(error=>{console.error(error);process.exitCode=1;});
