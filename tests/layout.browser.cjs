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
    id,name:id,kind:{a:'Server',b:'Router',c:'Switch',d:'Firewall'}[id],x,y,addresses:id==='a'?['192.0.2.1','router.example']:[],notes:id==='a'?'Template notes':'',
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
    await page.addInitScript(() => {
      const schedule = window.setTimeout.bind(window);
      // Keep the initial state load and explicit refreshes. A recurring poll can be
      // cancelled while a test reloads the page and Playwright is fulfilling its route.
      window.setTimeout = (callback, delay, ...args) => {
        if (callback === window.refreshLoop) return 0;
        return schedule(callback, delay, ...args);
      };
    });
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let stored=fixture(),writes=0,rejectSave=false,diagnosticCalls=0,statisticsQuery;
    let account=null;
    const directory={users:[{id:1,username:'fixture-admin',admin:true}],groups:[],members:[]};
    const maps=[{id:1,name:'Initial map',personal:false,access:'edit'},{id:2,name:'Shared map',personal:false,access:'edit'}];
    const grants=new Map();
    await page.route('http://netmap.test/**',async route=>{
      const url=new URL(route.request().url()),name=url.pathname;
      if(name==='/api/state'){
        const map=account&&maps.find(map=>map.id===Number(url.searchParams.get('map_id')||1));
        return route.fulfill({json:{graph:map?{...stored,name:map.name}:stored,nodes:{b:{status:'down'},c:{status:'partial'},d:{status:'stale'},
          a:{status:'up',addresses:[{target:'192.0.2.1',status:'up',checked_at:100,rtt_ms:1}]}},server_time:100,stale_after:45,
          monitor:{last_completed:100,running:true,duration:0,completed:0,targets:0},
          ...(map&&{account,map_id:map.id,personal:map.personal,access:account.admin||map.personal?'edit':'view'})}});
      }
      if(name==='/api/maps'){
        if(route.request().method()==='GET')return route.fulfill({json:{maps}});
        const map={...route.request().postDataJSON(),id:3,access:'edit'};
        maps.push(map);
        return route.fulfill({json:map});
      }
      if(name==='/api/admin/directory')return route.fulfill({json:directory});
      if(name==='/api/admin/users'){
        const user={id:2,username:route.request().postDataJSON().username,admin:false};
        directory.users.push(user);
        return route.fulfill({json:user});
      }
      if(name==='/api/admin/groups'){
        const group={id:1,name:route.request().postDataJSON().name};
        directory.groups.push(group);
        return route.fulfill({json:group});
      }
      if(/^\/api\/admin\/maps\/\d+\/access$/.test(name)){
        const mapId=Number(name.split('/')[4]);
        if(route.request().method()==='GET')return route.fulfill({json:{grants:grants.get(mapId)||[]}});
        const grant=route.request().postDataJSON();
        grants.set(mapId,grant.access?[grant]:[]);
        return route.fulfill({json:{access:grant.access}});
      }
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
        if(diagnosticCalls===1)return route.fulfill({status:502,contentType:'text/html',body:'<h1>Bad gateway</h1>'});
        const detail=diagnosticCalls===2?'Diagnostic unavailable (test)':'Адрес не найден у выбранного узла';
        return route.fulfill({status:503,json:{detail}});
      }
      if(name==='/api/statistics'){
        statisticsQuery=Object.fromEntries(url.searchParams);
        const measurement={sent:3,received:2,errors:1,loss:100/3,rtt_ms:{min:10,median:14,p95:18,max:20,mean:15,stddev:5}};
        const total=statisticsQuery.channel||statisticsQuery.target?1:9;
        return route.fulfill({json:{since:0,until:10000,step:300,total,page_size:8,
          items:[{name:'Router',target:'router.example',site:'Site B',channel:'wan',enabled:true,
            summary:measurement,points:[{...measurement,time:600},{...measurement,time:1200}]}]}});
      }
      const file=name==='/'?'index.html':/^\/static\/(?:[a-z0-9.]+|pwa\/manifest(?:\.en)?\.webmanifest)$/.test(name)?name.slice(8):null;
      if(file)return route.fulfill({body:await fs.readFile(path.join(staticRoot,file)),
        headers:name==='/'?{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"}:{},
        contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':
          file.endsWith('.webmanifest')?'application/manifest+json':'text/html'});
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
    await page.locator('#view-diagram').click();
    assert.equal(await page.locator('#view-diagram').getAttribute('aria-pressed'),'true');
    assert.deepEqual(await page.locator('.map-node .node-icon').evaluateAll(icons=>icons.map(icon=>icon.getAttribute('href'))),
      ['#diagram-server','#diagram-router','#diagram-switch','#diagram-firewall']);
    assert.equal(await page.locator('.diagram .node-box').count(),0);
    assert.equal(await page.locator('.diagram .diagram-symbol-hit').count(),stored.nodes.length);
    // The whole device symbol carries the node state, as the icon does on the classic map.
    assert.deepEqual(await page.locator('.diagram .map-node').evaluateAll(nodes=>nodes.map(node=>node.style.getPropertyValue('--device'))),
      ['var(--up)','var(--down)','var(--partial)','var(--stale)']);
    const deviceFronts=await page.locator('.diagram .map-node').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).getPropertyValue('--device-front')));
    assert.notEqual(deviceFronts[0],deviceFronts[1]);
    assert.equal(await page.locator('.diagram-status-mark, .diagram-state-ring, .diagram-more').count(),0);
    // Sites are captioned groups: no frames and no extra toolbar row.
    assert.equal(await page.locator('#diagram-tools, #diagram-group, #diagram-links, .diagram-site-area').count(),0);
    assert.equal(await page.locator('#diagram-site').isVisible(),true);
    assert.deepEqual(await page.locator('#site-layer .diagram-site').allTextContents(),['Site B','Без площадки']);
    assert.equal(await page.locator('.diagram-site-title[aria-label="Приблизить площадку Site B"]').count(),1);
    const fitWidth=await page.evaluate(()=>view.w);
    await page.locator('.diagram-site-title[aria-label="Приблизить площадку Site B"]').click();
    assert.ok(await page.evaluate(previous=>view.w<previous,fitWidth));
    assert.equal(await page.locator('#diagram-site').inputValue(),'site:Site B');
    await page.locator('#add-node').click();
    assert.equal(await page.locator('#node-site').inputValue(),'Site B');
    await page.locator('#node-dialog').getByRole('button',{name:'Отмена',exact:true}).click();
    await page.locator('#diagram-site').selectOption('');
    assert.equal(await page.evaluate(()=>view.w),fitWidth);
    assert.equal(await page.locator('#edit-layout').isDisabled(),true);
    // Topology links run straight between devices; lines with a free end stay on the classic map.
    const centres=Object.fromEntries(await page.locator('.diagram .map-node').evaluateAll(nodes=>nodes.map(node=>
      [node.dataset.id,/^translate\((\S+) (\S+)\)$/.exec(node.getAttribute('transform')).slice(1).join(' ')])));
    assert.deepEqual(await page.locator('#edge-layer .edge-path').evaluateAll(paths=>paths.map(path=>path.getAttribute('d'))),
      [`M${centres.a} L${centres.b}`,`M${centres.b} L${centres.c}`,`M${centres.a} L${centres.d}`]);
    assert.equal(await page.locator('.edge-open, .edge-end').count(),0);
    assert.deepEqual(await page.locator('.diagram-target').allTextContents(),['192.0.2.1','router.example']);
    assert.deepEqual(await page.locator('.diagram-channel').allTextContents(),['LAN','WAN']);
    await page.locator('.map-node[data-id="a"] .diagram-symbol-hit').click();
    assert.deepEqual(await page.locator('#edge-layer > g.diagram-link-active .edge-path').evaluateAll(paths=>paths.map(path=>path.getAttribute('d'))),
      [`M${centres.a} L${centres.b}`,`M${centres.a} L${centres.d}`]);
    assert.equal(await page.locator('#address-results .address-row').count(),2);
    await page.locator('#address-results button[aria-label="История router.example"]').click();
    assert.equal(await page.locator('#history-target').inputValue(),'router.example');
    await page.locator('#history-dialog [data-close]').first().click();
    await page.locator('#close-details').click();
    await page.locator('.diagram-address[data-target="192.0.2.1"] .diagram-address-hit').click();
    assert.equal(await page.locator('#history-target').inputValue(),'192.0.2.1');
    await page.locator('#history-dialog [data-close]').first().click();
    const arranged=await page.locator('.diagram .map-node').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('transform')));
    await page.reload();await page.locator('.diagram-address').first().waitFor();
    assert.equal(await page.locator('#view-diagram').getAttribute('aria-pressed'),'true');
    assert.deepEqual(await page.locator('.diagram .map-node').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('transform'))),arranged);
    const screenshotDir=process.env.NETMAP_BROWSER_OUTPUT_DIR;
    if(screenshotDir){
      await fs.mkdir(screenshotDir,{recursive:true});
      await page.screenshot({path:path.join(screenshotDir,`${browserType.name()}-${mobile?'touch':'desktop'}-diagram.png`)});
    }
    await page.locator('#view-classic').click();
    assert.equal(await page.locator('#diagram-site').isHidden(),true);
    assert.equal(await page.locator('#edge-layer .edge-path').first().getAttribute('d'),'M100 100 L180 50 L260 100');
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
    await page.locator('.map-node[data-id="a"]').focus();
    await page.keyboard.press('ArrowRight');await waitWrites(2);
    await page.keyboard.press('Shift+ArrowDown');await waitWrites(3);
    assert.deepEqual(stored.nodes.slice(0,2).map(n=>[n.x,n.y]),[[101+dx,110+dy],[261+dx,110+dy]]);
    const {x:ax,y:ay}=stored.nodes[0],{x:bx,y:by}=stored.nodes[1];
    const beforeCancel=structuredClone(stored);
    const movedPath=await page.locator('#edge-layer .edge-path').first().getAttribute('d');
    await dragWorld(ax,ay,20,20,true);
    assert.deepEqual(stored,beforeCancel);assert.equal(writes,3);
    assert.equal(await page.locator('.map-node[data-id="a"]').getAttribute('transform'),`translate(${ax} ${ay})`);
    assert.equal(await page.locator('#edge-layer .edge-path').first().getAttribute('d'),movedPath);
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
    if(screenshotDir){
      await fs.mkdir(screenshotDir,{recursive:true});
      await page.screenshot({path:path.join(screenshotDir,`${browserType.name()}-${mobile?'touch':'desktop'}.png`)});
    }
    // The diagram arranges devices itself: switching to it ends the move mode and saves nothing.
    await page.locator('#view-diagram').click();
    assert.equal(await page.locator('#edit-layout').getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('#edit-layout').isDisabled(),true);
    assert.equal(await page.locator('#group-select').isHidden(),true);
    assert.equal(await page.locator('#map').evaluate(map=>map.classList.contains('editing')),false);
    await page.locator('#view-classic').click();
    assert.equal(await page.locator('#edit-layout').isDisabled(),false);
    assert.equal(writes,3);
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

    const settings=page.locator('#settings-dialog');
    const openAppearance=async()=>{
      await page.locator('#settings-button').click();
      await page.locator('#settings-appearance-tab').click();
      await page.locator('#appearance-scale').locator('option').first().waitFor({state:'attached'});
    };
    const scale=page.locator('#appearance-scale'),font=page.locator('#appearance-font');
    const language=page.locator('#interface-language');
    const readAppearance=()=>page.evaluate(()=>{
      const root=document.documentElement;
      return {language:root.lang,theme:root.dataset.theme,zoom:getComputedStyle(root).zoom,
        font:getComputedStyle(root).fontSize};
    });
    const fitViewport=()=>page.evaluate(()=>{
      const workspace=document.querySelector('.workspace').getBoundingClientRect();
      const header=document.querySelector('.topbar').getBoundingClientRect();
      return workspace.bottom<=innerHeight+1&&workspace.bottom>=innerHeight-1&&header.right<=innerWidth;
    });

    await openAppearance();
    assert.equal(await language.inputValue(),'ru');
    assert.equal(await scale.locator('option[value="50"]').isDisabled(),mobile);
    await settings.locator('[data-preview="dark"]').click();
    await font.press('End');
    assert.equal(await page.locator('#appearance-font-value').textContent(),'150%');
    assert.equal(await fitViewport(),true);
    const scaleValue=mobile?'75':'50';
    await scale.selectOption(scaleValue);
    const preferences={language:'ru',theme:'dark',zoom:mobile?'0.75':'0.5',font:'21px'};
    assert.deepEqual(await readAppearance(),preferences);
    assert.equal(await fitViewport(),true);
    await language.selectOption('en');
    await page.waitForFunction(()=>document.documentElement.lang==='en');
    await page.locator('.map-node').first().waitFor();
    assert.deepEqual(await readAppearance(),{...preferences,language:'en'});
    assert.equal(await page.locator('#settings-button').textContent(),'Settings');
    assert.equal(await page.locator('#search').getAttribute('placeholder'),'Name or any IP…');
    assert.equal(await page.locator('.map-node[data-id="replacement"] .node-name').textContent(),'Новый узел');
    assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'),'static/pwa/manifest.en.webmanifest');
    if(mobile)await page.setViewportSize({width:320,height:640});
    await page.getByRole('button',{name:'Diagram',exact:true}).click();
    assert.equal(await page.locator('.map-node[data-id="replacement"] .diagram-name').textContent(),'Новый узел');
    assert.equal(await fitViewport(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,`${browserType.name()}-${mobile?'touch':'desktop'}-diagram-dark.png`)});

    await page.locator('#statistics-button').click();
    await plot.waitFor();
    assert.equal(await statistics.locator('#statistics-title').textContent(),'ICMP statistics');
    assert.equal(await statistics.locator('#statistics-page').textContent(),'Page 1 of 2');
    assert.deepEqual(await plot.evaluate(canvas=>[...canvas.getContext('2d').getImageData(0,0,1,1).data]),[24,33,42,255]);
    await statistics.getByRole('button',{name:'Close'}).click();
    await page.evaluate(()=>runDiagnostic(graph.nodes[0],'192.0.2.1','ping'));
    assert.equal(await page.locator('#diagnostic-status').textContent(),'The selected node does not have that address');
    await page.locator('#diagnostic-dialog [data-close]').first().click();

    await openAppearance();
    assert.equal(await scale.inputValue(),scaleValue);
    assert.equal(await font.inputValue(),'150');
    assert.equal(await settings.locator('input[value="dark"]').isChecked(),true);
    await page.locator('#appearance-reset').click();
    assert.deepEqual(await readAppearance(),{language:'en',theme:'dark',zoom:'1',font:'14px'});
    await settings.locator('[data-preview="light"]').click();
    await language.selectOption('ru');
    await page.waitForFunction(()=>document.documentElement.lang==='ru');
    await page.locator('.map-node').first().waitFor();
    assert.deepEqual(await readAppearance(),{language:'ru',theme:'light',zoom:'1',font:'14px'});
    assert.equal(writes,9);
    assert.deepEqual(errors,[]);

    // Several sites, stacked imported coordinates, long names and up to ten addresses per device.
    const dense = fixture();
    dense.revision = stored.revision+1;
    dense.nodes = []; dense.edges = [];
    const kinds = ['Router','Switch','Server','WorkStation','Firewall','NAS','Access point','Cloud','Network printer','Camera','Phone','Device'];
    for (const [site,count] of [['North',1],['East',3],['South',8],['West',14],['Core',40],['',6]]) {
      for (let i=0; i<count; i++) {
        const n=dense.nodes.length, id=`n${n}`, kind=kinds[n%kinds.length];
        const addresses=Array.from({length:n%11},(_,k)=>k%3===2?`interface-${k}.device-${n}.long-site-name.example`:`192.0.2.${(n*11+k)%250+1}`);
        dense.nodes.push({id,name:`${site||'Unlabeled'} ${kind} ${i+1}`,kind,site,addresses,notes:'',enabled:true,allow_offline:false,
          x:n%2?200:100+(n%7)*40,y:n%2?170:100+Math.floor(n/7)*35,address_comments:{},
          address_channels:Object.fromEntries(addresses.slice(0,2).map((target,k)=>[target,k?'wan':'lan']))});
      }
    }
    const firstOf = {};
    dense.nodes.forEach((node,index)=>{
      const previous=dense.nodes[index-1];
      if (previous?.site===node.site) dense.edges.push({id:`e${index}`,from_id:previous.id,to_id:node.id,points:[],label:'',color:'#7894a5'});
      firstOf[node.site] ??= node.id;
    });
    for (const site of Object.keys(firstOf)) if (site!=='Core') dense.edges.push({id:`up-${site}`,from_id:firstOf[site],to_id:firstOf.Core,points:[],label:'uplink',color:'#3b82f6'});
    dense.edges.push({id:'loose',from_id:firstOf.North,to_id:null,points:[[100,100],[140,140]],label:'',color:'#7894a5'});
    stored = dense;
    await page.reload();
    await page.locator('.diagram .map-node').first().waitFor();
    const separate=(a,b)=>a[2]<=b[0]||b[2]<=a[0]||a[3]<=b[1]||b[3]<=a[1];
    const diagramBoxes=()=>page.locator('.diagram .map-node').evaluateAll(nodes=>nodes.map(node=>{
      const box=node.getBBox(), {e:x,f:y}=node.transform.baseVal.getItem(0).matrix;
      return {id:node.dataset.id,box:[x+box.x,y+box.y,x+box.x+box.width,y+box.y+box.height]};
    }));
    const placed=await diagramBoxes();
    for (const [i,a] of placed.entries()) for (const b of placed.slice(i+1)) assert.ok(separate(a.box,b.box),`${a.id} and ${b.id} overlap`);
    const groups=await page.evaluate(()=>diagramSites.map(({name,bounds})=>({name,bounds})));
    assert.deepEqual(groups.map(group=>group.name).sort(),['','Core','East','North','South','West']);
    for (const [i,a] of groups.entries()) for (const b of groups.slice(i+1)) assert.ok(separate(a.bounds,b.bounds),`sites ${a.name} and ${b.name} overlap`);
    const siteOf=Object.fromEntries(dense.nodes.map(node=>[node.id,node.site]));
    for (const {id,box} of placed) {
      // getBBox() reports single-precision values.
      const [left,top,right,bottom]=groups.find(group=>group.name===siteOf[id]).bounds.map((value,i)=>value+(i<2?-.01:.01));
      assert.ok(box[0]>=left&&box[1]>=top&&box[2]<=right&&box[3]<=bottom,`${id} lies outside its site group`);
    }
    assert.equal(await page.locator('#site-layer .diagram-site').count(),6);
    assert.equal(await page.locator('#edge-layer > g').count(),dense.edges.filter(edge=>edge.from_id&&edge.to_id).length);
    if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,`${browserType.name()}-${mobile?'touch':'desktop'}-diagram-dense.png`)});
    await page.reload();
    await page.locator('.diagram .map-node').first().waitFor();
    assert.deepEqual(await diagramBoxes(),placed);
    const layoutTime=await page.evaluate(()=>{
      const nodes=Array.from({length:500},(_,i)=>({id:`p${i}`,name:`Perf node ${i}`,kind:'Server',site:`Site ${i%8}`,
        x:(i%25)*40,y:Math.floor(i/25)*40,addresses:['192.0.2.1','192.0.2.2'],address_channels:{}}));
      const edges=nodes.slice(1).map((node,i)=>({id:`pe${i}`,from_id:nodes[i].id,to_id:node.id,points:[]}));
      const started=performance.now();layoutDiagram(nodes,edges,svg);return performance.now()-started;
    });
    console.log(`  diagram layout of 500 nodes: ${Math.round(layoutTime)} ms`);
    assert.ok(layoutTime<1500,`diagram layout took ${layoutTime} ms`);
    await page.locator('#view-classic').click();
    assert.deepEqual(await page.locator('.map-node').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('transform'))),
      dense.nodes.map(node=>`translate(${node.x} ${node.y})`));
    assert.equal(writes,9);

    account=directory.users[0];
    await page.goto('http://netmap.test/?map=2');
    await page.locator('#maps-button').waitFor();
    await page.locator('#settings-button').click();
    await settings.getByRole('button',{name:'Пользователи',exact:true}).click();
    await settings.getByLabel('Логин',{exact:true}).fill('fixture-viewer');
    await settings.getByLabel('Начальный пароль').fill('synthetic-passphrase');
    await settings.getByRole('button',{name:'Создать аккаунт'}).click();
    await settings.locator('#account-list').getByText('fixture-viewer').waitFor();
    await settings.getByRole('button',{name:'Группы',exact:true}).click();
    await settings.getByLabel('Название новой группы').fill('Operators');
    await settings.getByRole('button',{name:'Создать группу'}).click();
    await settings.locator('#group-members').getByLabel('fixture-viewer').waitFor();
    await settings.locator('[data-close]').first().click();
    await page.locator('#maps-button').click();
    const mapsDialog=page.locator('#maps-dialog');
    await mapsDialog.getByRole('button',{name:'Доступ к текущей карте'}).click();
    const accessDialog=page.getByRole('dialog',{name:'Доступ к текущей карте'});
    assert.equal(await accessDialog.locator('#access-map-name').textContent(),'Shared map');
    for(const [kind,id,name] of [['group',1,'Группа · Operators'],['user',2,'Пользователь · fixture-viewer']]){
      await accessDialog.getByLabel('Пользователь или группа').selectOption(`${kind}:${id}`);
      await accessDialog.getByRole('button',{name:'Сохранить доступ'}).click();
      await accessDialog.getByText(`${name} · Просмотр`,{exact:true}).waitFor();
      assert.deepEqual([...grants],[[2,[{kind,principal_id:id,access:'view'}]]]);
      await accessDialog.getByRole('button',{name:'Отозвать'}).click();
      await accessDialog.getByText(`${name} · Просмотр`,{exact:true}).waitFor({state:'hidden'});
      assert.deepEqual(grants.get(2),[]);
    }
    await accessDialog.locator('[data-close]').click();
    await page.locator('#maps-button').click();
    await mapsDialog.getByLabel('Название новой карты').fill('My map');
    await mapsDialog.getByRole('button',{name:'Создать карту'}).click();
    await page.waitForURL('**/?map=3');
    assert.equal(maps[2].personal,true);
    await page.locator('#maps-button').click();
    assert.equal(await mapsDialog.getByRole('button',{name:'Доступ к текущей карте'}).count(),0);
    await mapsDialog.locator('[data-close]').click();

    account=directory.users[1];
    await page.goto('http://netmap.test/?map=2');
    await page.locator('#maps-button').waitFor();
    await page.locator('#settings-button').click();
    assert.equal(await settings.getByRole('button',{name:/^(Пользователи|Группы)$/}).count(),0);
    await settings.getByRole('button',{name:'Аккаунт',exact:true}).click();
    await settings.getByText('fixture-viewer').waitFor();
    await settings.getByRole('button',{name:'Сменить пароль'}).waitFor();
    await settings.locator('[data-close]').first().click();
    await page.locator('#maps-button').click();
    assert.equal(await mapsDialog.getByRole('button',{name:'Доступ к текущей карте'}).count(),0);
    await mapsDialog.getByRole('button',{name:'Создать карту'}).waitFor();
    assert.deepEqual(errors,[]);
    console.log(`${browserType.name()} ${mobile?'390px touch':'1366px'}: layout, appearance, settings and current map access OK`);
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
