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
  $('account-username').textContent=state.account.username;
  $('access-button').hidden=$('new-map-type-field').hidden=!state.account.admin;
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
$('account-password').addEventListener('click',()=>{$('maps-dialog').close();openPasswordDialog();});
$('logout-button').addEventListener('click',async()=>{
  $('logout-button').disabled=true;
  try{await api('api/logout',{method:'POST'});openMap(null,true);}
  catch(error){notice('maps-error',error.message);$('logout-button').disabled=false;}
});
bindAccessForm('create-map-form','maps-error',async()=>{
  const personal=!state.account.admin||$('new-map-type').value==='personal';
  const map=await api('api/maps',jsonOptions('POST',{name:$('new-map-name').value,personal}));
  openMap(map.id);
});

let directoryData=null;

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
  const directory=await api('api/admin/directory');
  directoryData=directory;
  $('account-list').replaceChildren(...directory.users.map(user=>
    accessRow(user.username+(user.admin?` · ${tr('Администратор')}`:''))));
  setOptions('group-picker',directory.groups.map(group=>new Option(group.name,group.id)),groupId);
  const users=directory.users.filter(user=>!user.admin).map(user=>new Option(`${tr('Пользователь')} · ${user.username}`,`user:${user.id}`));
  const groups=directory.groups.map(group=>new Option(`${tr('Группа')} · ${group.name}`,`group:${group.id}`));
  setOptions('grant-principal',[...users,...groups]);
  $('grant-form').querySelector('[type=submit]').disabled=!users.length&&!groups.length;
  drawMembers();
}

function showAccessTab(name){
  for(const button of $('access-tabs').querySelectorAll('[data-access-tab]')){
    const selected=button.dataset.accessTab===name;
    button.setAttribute('aria-pressed',String(selected));
    $(button.getAttribute('aria-controls')).hidden=!selected;
  }
  notice('access-error');
  notice('access-status');
  if(name==='grants'&&$('grant-map').value)loadGrants().catch(error=>notice('access-error',error.message));
}

for(const button of $('access-tabs').querySelectorAll('[data-access-tab]')){
  button.addEventListener('click',()=>showAccessTab(button.dataset.accessTab));
}

$('access-button').addEventListener('click',async()=>{
  $('maps-dialog').close();
  $('access-dialog').showModal();
  showAccessTab('users');
  try{
    const [, {maps}]=await Promise.all([loadDirectory(),api('api/maps')]);
    setOptions('grant-map',maps.filter(map=>!map.personal).map(map=>new Option(map.name,map.id)),activeMapId);
    if(!$('access-grants').hidden)await loadGrants();
  }catch(error){notice('access-error',error.message);}
});

bindAccessForm('create-user-form','access-error',async()=>{
  const password=$('new-user-password').value;
  $('new-user-password').value='';
  await api('api/admin/users',jsonOptions('POST',{username:$('new-user-name').value.trim(),password}));
  $('create-user-form').reset();
  notice('access-status',tr('Аккаунт создан'));
  await loadDirectory();
});

function drawMembers(){
  const groupId=Number($('group-picker').value);
  const members=new Set(directoryData.members.filter(entry=>entry.group_id===groupId).map(entry=>entry.user_id));
  $('group-members').replaceChildren(...(groupId?directoryData.users.map(user=>{
    const label=html('label','check'),checkbox=html('input');
    checkbox.type='checkbox';checkbox.checked=members.has(user.id);
    label.append(checkbox,document.createTextNode(user.username));
    checkbox.addEventListener('change',async()=>{
      checkbox.disabled=true;
      notice('access-error');
      try{
        await api(`api/admin/groups/${groupId}/members/${user.id}`,jsonOptions('PUT',{member:checkbox.checked}));
        directoryData.members=directoryData.members.filter(entry=>entry.group_id!==groupId||entry.user_id!==user.id);
        if(checkbox.checked)directoryData.members.push({group_id:groupId,user_id:user.id});
        if(Number($('group-picker').value)===groupId&&!checkbox.isConnected)drawMembers();
      }catch(error){checkbox.checked=!checkbox.checked;notice('access-error',error.message);}
      finally{checkbox.disabled=false;}
    });
    return label;
  }):[]));
}

$('group-picker').addEventListener('change',drawMembers);
bindAccessForm('create-group-form','access-error',async()=>{
  const group=await api('api/admin/groups',jsonOptions('POST',{name:$('new-group-name').value}));
  $('create-group-form').reset();
  notice('access-status',tr('Группа создана'));
  await loadDirectory(group.id);
});

let grantLoad=0;
async function loadGrants(){
  const generation=++grantLoad,mapId=$('grant-map').value;
  $('grant-list').replaceChildren();
  if(!mapId||!directoryData)return;
  const {grants}=await api(`api/admin/maps/${mapId}/access`);
  if(generation!==grantLoad)return;
  $('grant-list').replaceChildren(...grants.map(grant=>{
    const user=grant.kind==='user';
    const label=(user?directoryData.users:directoryData.groups).find(row=>row.id===grant.principal_id);
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

$('grant-map').addEventListener('change',()=>loadGrants().catch(error=>notice('access-error',error.message)));
async function putGrant(mapId,kind,principalId,access){
  notice('access-error');
  await api(`api/admin/maps/${mapId}/access`,jsonOptions('PUT',{kind,principal_id:Number(principalId),access}));
  notice('access-status',access?tr('Доступ сохранён'):tr('Доступ отозван'));
  if($('grant-map').value===mapId)await loadGrants();
}

bindAccessForm('grant-form','access-error',async()=>{
  const [kind,principalId]=$('grant-principal').value.split(':');
  const mapId=$('grant-map').value;
  if(mapId&&principalId)await putGrant(mapId,kind,principalId,$('grant-level').value);
});

for(const id of ['edit-layout','group-select','edit-node','duplicate-node','import-button','poll-now'])$(id).dataset.mapEdit='';
refreshLoop();
