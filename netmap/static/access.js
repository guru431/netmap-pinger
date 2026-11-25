'use strict';

const requestedMap = new URLSearchParams(location.search).get('map');
let activeMapId = Number.isSafeInteger(Number(requestedMap)) && Number(requestedMap)>0 ? Number(requestedMap) : null;
const mapAPIs = /^api\/(state|history|statistics|map(?:\/preview)?|poll|diagnostics|export|watch)(?:\?|$)/;

function mapEndpoint(path){
  if(!activeMapId||!mapAPIs.test(path))return path;
  return `${path}${path.includes('?')?'&':'?'}map_id=${activeMapId}`;
}

function canEditMap(){return !state?.account||state.access==='edit';}

function openMap(id,replace=false){
  const url=new URL(location.pathname,location.href);
  if(id!==null)url.searchParams.set('map',id);
  if(replace)location.replace(url);
  else location.assign(url);
}

function applyAccountState(data){
  const account=data.account;
  if(!account)return;
  activeMapId=data.map_id;
  $('maps-button').hidden=false;
  $('maps-button').title=data.graph?.name||tr('Карты');
  $('account-username').textContent=account.username;
  $('settings-account-tab').hidden=false;
  $('settings-users-tab').hidden=$('settings-groups-tab').hidden=!account.admin;
  $('access-button').hidden=!(account.admin&&data.graph&&!data.personal);
  $('no-maps').hidden=!!data.graph;
  $('settings-map-tab').disabled=!data.graph||!canEditMap();
  $('watch-section').hidden=!data.watch_navigation;
  $('detail-netwatch').hidden=data.map_id!==1;
  document.body.classList.toggle('map-unavailable',!data.graph);
  document.body.classList.toggle('map-readonly',!canEditMap());
  $('map-export').href=mapEndpoint('api/export');
  for(const field of document.querySelectorAll('[data-netwatch-settings]'))field.hidden=!data.netwatch_settings;
  if(!canEditMap()){
    if(editLayout)$('edit-layout').click();
    for(const id of ['node-dialog','edge-dialog','import-dialog','diagnostic-dialog']){
      if($(id).open)$(id).close();
    }
    if($('settings-dialog').open&&!$('settings-form').hidden)showSettingsSection('appearance');
  }
}

function handleSessionError(error){
  if(error.status===404&&activeMapId){openMap(null,true);return true;}
  if(error.status!==401)return false;
  state=graph=null;
  online=false;
  document.body.classList.add('signed-out');
  for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
  $('login-dialog').showModal();
  return true;
}

function jsonOptions(method,body){
  return {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
}

function notice(id,message=''){
  $(id).textContent=message;
  $(id).hidden=!message;
}

function bindAccessForm(id,errorId,action){
  $(id).addEventListener('submit',async event=>{
    event.preventDefault();
    const button=event.currentTarget.querySelector('[type=submit]');
    if(button.disabled)return;
    button.disabled=true;
    notice(errorId);
    try{await action();}
    catch(error){notice(errorId,error.message);}
    finally{button.disabled=false;}
  });
}

$('login-dialog').addEventListener('cancel',event=>event.preventDefault());
bindAccessForm('login-form','login-error',async()=>{
  const password=$('login-password').value;
  $('login-password').value='';
  try{
    await api('api/login',jsonOptions('POST',{username:$('login-username').value.trim(),password}));
    location.reload();
  }catch(error){$('login-password').focus();throw error;}
});

const accessLabel=level=>level==='edit'?tr('Редактирование'):tr('Просмотр');

async function openMaps(){
  if(!state?.account)return;
  $('new-map-type-field').hidden=!state.account.admin;
  $('available-maps').replaceChildren();
  notice('maps-error');
  $('maps-dialog').showModal();
  try{
    const {maps}=await api('api/maps');
    $('available-maps').replaceChildren(...maps.map(map=>{
      const button=html('button','',`${map.name} · ${map.personal?tr('Личная карта'):accessLabel(map.access)}`);
      if(map.id===activeMapId)button.setAttribute('aria-current','page');
      button.addEventListener('click',()=>{
        if(map.id===activeMapId)$('maps-dialog').close();
        else openMap(map.id);
      });
      return button;
    }));
  }catch(error){notice('maps-error',error.message);}
}

$('maps-button').addEventListener('click',openMaps);
$('first-map').addEventListener('click',()=>{openMaps();$('new-map-name').focus();});
$('account-password').addEventListener('click',()=>{$('settings-dialog').close();openPasswordDialog();});
$('logout-button').addEventListener('click',async()=>{
  $('logout-button').disabled=true;
  try{await api('api/logout',{method:'POST'});openMap(null,true);}
  catch(error){notice('account-error',error.message);$('logout-button').disabled=false;}
});
bindAccessForm('create-map-form','maps-error',async()=>{
  const personal=!state.account.admin||$('new-map-type').value==='personal';
  const map=await api('api/maps',jsonOptions('POST',{name:$('new-map-name').value,personal}));
  openMap(map.id);
});

let directoryData=null,directoryLoad=0;

function setOptions(id,options,value=$(id).value){
  const select=$(id);
  select.replaceChildren(...options);
  if(options.some(option=>option.value===String(value)))select.value=value;
  select.disabled=!options.length;
}

function accessRow(label,action){
  const row=html('div','access-row');
  row.append(html('span','',label));
  if(action)row.append(action);
  return row;
}

async function loadDirectory(groupId){
  const generation=++directoryLoad;
  const directory=await api('api/admin/directory');
  if(generation!==directoryLoad)return;
  directoryData=directory;
  $('account-list').replaceChildren(...directory.users.map(user=>
    accessRow(user.username+(user.admin?` · ${tr('Администратор')}`:''))));
  setOptions('group-picker',directory.groups.map(group=>new Option(group.name,group.id)),groupId);
  drawMembers();
}

for(const id of ['settings-users-tab','settings-groups-tab'])$(id).addEventListener('click',()=>{
  if(!directoryData)loadDirectory().catch(error=>notice('directory-error',error.message));
});
$('settings-dialog').addEventListener('close',()=>{
  $('new-user-password').value='';
  directoryData=null;
  directoryLoad++;
  for(const id of ['account-list','group-picker','group-members'])$(id).replaceChildren();
  for(const id of ['directory-error','directory-status','account-error'])notice(id);
});

bindAccessForm('create-user-form','directory-error',async()=>{
  const password=$('new-user-password').value;
  $('new-user-password').value='';
  await api('api/admin/users',jsonOptions('POST',{username:$('new-user-name').value.trim(),password}));
  $('create-user-form').reset();
  notice('directory-status',tr('Аккаунт создан'));
  await loadDirectory();
});

function drawMembers(){
  if(!directoryData)return;
  const groupId=Number($('group-picker').value);
  const members=new Set(directoryData.members.filter(entry=>entry.group_id===groupId).map(entry=>entry.user_id));
  $('group-members').replaceChildren(...(groupId?directoryData.users.map(user=>{
    const label=html('label','check'),checkbox=html('input');
    checkbox.type='checkbox';checkbox.checked=members.has(user.id);
    label.append(checkbox,document.createTextNode(user.username));
    checkbox.addEventListener('change',async()=>{
      checkbox.disabled=true;
      notice('directory-error');
      try{
        await api(`api/admin/groups/${groupId}/members/${user.id}`,jsonOptions('PUT',{member:checkbox.checked}));
        if(!directoryData)return;
        directoryData.members=directoryData.members.filter(entry=>entry.group_id!==groupId||entry.user_id!==user.id);
        if(checkbox.checked)directoryData.members.push({group_id:groupId,user_id:user.id});
        if(Number($('group-picker').value)===groupId&&!checkbox.isConnected)drawMembers();
      }catch(error){checkbox.checked=!checkbox.checked;notice('directory-error',error.message);}
      finally{checkbox.disabled=false;}
    });
    return label;
  }):[]));
}

$('group-picker').addEventListener('change',drawMembers);
bindAccessForm('create-group-form','directory-error',async()=>{
  const group=await api('api/admin/groups',jsonOptions('POST',{name:$('new-group-name').value}));
  $('create-group-form').reset();
  notice('directory-status',tr('Группа создана'));
  await loadDirectory(group.id);
});

let grantLoad=0,grantDirectory=null;
async function loadGrants(mapId){
  const generation=++grantLoad;
  const loadPrincipals=!grantDirectory;
  const [{grants},directory]=await Promise.all([
    api(`api/admin/maps/${mapId}/access`),
    grantDirectory||api('api/admin/directory')
  ]);
  if(generation!==grantLoad)return;
  if(loadPrincipals){
    grantDirectory=directory;
    const users=directory.users.filter(user=>!user.admin).map(user=>new Option(`${tr('Пользователь')} · ${user.username}`,`user:${user.id}`));
    const groups=directory.groups.map(group=>new Option(`${tr('Группа')} · ${group.name}`,`group:${group.id}`));
    setOptions('grant-principal',[...users,...groups]);
    $('grant-empty').hidden=users.length+groups.length>0;
    $('grant-form').hidden=$('grant-principal').disabled;
  }
  $('grant-list').replaceChildren(...grants.map(grant=>{
    const user=grant.kind==='user';
    const label=(user?directory.users:directory.groups).find(row=>row.id===grant.principal_id);
    const name=(user?label?.username:label?.name)??String(grant.principal_id);
    const remove=html('button','text-button',tr('Отозвать'));
    remove.addEventListener('click',async()=>{
      remove.disabled=true;
      try{await putGrant(mapId,grant.kind,grant.principal_id,null);}
      catch(error){notice('access-error',error.message);remove.disabled=false;}
    });
    return accessRow(`${user?tr('Пользователь'):tr('Группа')} · ${name} · ${accessLabel(grant.access)}`,remove);
  }));
}

$('access-button').addEventListener('click',async()=>{
  const mapId=activeMapId;
  if(!state?.account?.admin||!mapId||!graph||state.personal)return;
  $('maps-dialog').close();
  grantDirectory=null;
  $('access-map-name').textContent=graph.name;
  $('grant-list').replaceChildren();
  $('grant-form').hidden=$('grant-empty').hidden=true;
  notice('access-error');
  notice('access-status');
  $('access-dialog').showModal();
  try{await loadGrants(mapId);}
  catch(error){notice('access-error',error.message);}
});

async function putGrant(mapId,kind,principalId,access){
  notice('access-error');
  await api(`api/admin/maps/${mapId}/access`,jsonOptions('PUT',{kind,principal_id:Number(principalId),access}));
  notice('access-status',access?tr('Доступ сохранён'):tr('Доступ отозван'));
  await loadGrants(mapId);
}

bindAccessForm('grant-form','access-error',async()=>{
  const [kind,principalId]=$('grant-principal').value.split(':');
  if(activeMapId&&principalId)await putGrant(activeMapId,kind,principalId,$('grant-level').value);
});

for(const id of ['edit-layout','group-select','edit-node','duplicate-node','import-button','poll-now'])$(id).dataset.mapEdit='';
refreshLoop();
