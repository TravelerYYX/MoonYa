(function () {
  'use strict';
  const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||new Error('migration_transaction_failed'));});
  function decode(value) {
    if(value?.__moonya_export_type) {
      const type=value.__moonya_export_type;
      if(type==='Date')return new Date(value.value);
      const bytes=Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0));
      if(type==='Blob')return new Blob([bytes],{type:value.mime});
      if(type==='File')return new File([bytes],value.name,{type:value.mime,lastModified:value.lastModified});
      if(type==='ArrayBuffer')return bytes.buffer;
      const typed={Uint8Array,Uint8ClampedArray,Int8Array,Uint16Array,Int16Array,Uint32Array,Int32Array,Float32Array,Float64Array,DataView};
      if(!typed[type])throw new Error('migration_binary_type_invalid');
      return new typed[type](bytes.buffer);
    }
    if(Array.isArray(value))return value.map(decode);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,decode(v)]));
    return value;
  }
  async function importMigration(data,finalize=true) {
    if(!data||data.version!==1||typeof data.source!=='string'||!data.stores||!data.storage)return false;
    const marker='moonya.migration.v1:'+data.source;
    if(localStorage.getItem(marker))return true;
    data={...data,stores:decode(data.stores)};
    const open=indexedDB.open('moonya-history',1);
    open.onupgradeneeded=()=>{for(const name of ['conversations','messages','events','attachments','drafts','migrations']){
      const store=open.result.createObjectStore(name,{keyPath:'key'});store.createIndex('scope','scope');
      if(['events','attachments'].includes(name))store.createIndex('conversation','conversation');
    }};
    const db=await request(open), names=[...db.objectStoreNames].filter(n=>Array.isArray(data.stores[n]));
    if(names.length){const tx=db.transaction(names,'readwrite'),done=complete(tx);
      for(const name of names)for(const row of data.stores[name]){
        if(!row||row.key==null){tx.abort();throw new Error('migration_record_invalid');}
        const store=tx.objectStore(name),lookup=store.get(row.key);
        lookup.onsuccess=()=>{if(lookup.result===undefined)store.add(row);};
      }
      await done;
    }
    db.close();
    for(const [key,value]of Object.entries(data.storage))
      if(/^(moonya[._-]|chat_history|api_token|voice|deepseek_|selected_|work_|chatDisplayMode$)/i.test(key)&&localStorage.getItem(key)===null)localStorage.setItem(key,value);
    if(finalize)localStorage.setItem(marker,'1');return true;
  }
  async function offerLocalAccounts(data) {
    const ids=[...new Set([...(data.stores.conversations||[]).map(r=>r.scope),...Object.keys(data.storage)].map(scope=>/^chat_history_(\d+)$/.exec(scope)?.[1]).filter(Boolean))];
    if(!ids.length||MoonYaClient.cachedUser())return;
    const panel=document.createElement('div');panel.style.cssText='position:fixed;bottom:42px;left:12px;z-index:10001;background: var(--theme-warning-soft, #fff5df);border-radius:8px;padding:8px;font-size:12px';
    const label=document.createElement('label');label.textContent='选择已迁移的本地账号：';
    const select=document.createElement('select');const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='请选择';select.append(placeholder);
    for(const id of ids){const option=document.createElement('option');option.value=id;option.textContent='本地账号 #'+id;select.append(option);}
    select.onchange=async()=>{if(!select.value)return;localStorage.setItem('moonya.auth-expired.v1','1');renderAuthState({id:Number(select.value),username:'本地账号 #'+select.value},false);
      await MoonYaHistoryStore.reload(CHAT_HISTORY_KEY);await initializeChatHistory();renderChatList();panel.remove();};
    label.append(select);panel.append(label);document.body.append(panel);
  }
  function showFailure(message) {
    MoonYaNotifications.remove('migration-progress');
    if(document.getElementById('migrationRetry'))return;
    const button=document.createElement('button');button.id='migrationRetry';button.textContent=message+'，点击重试';
    button.style.cssText='position:fixed;bottom:42px;left:12px;z-index:10002;padding:8px';
    button.onclick=async()=>{button.remove();await MoonYaClient.originalFetch('/gateway/migration/retry',{method:'POST',headers:{'X-MoonYa-Gateway':MoonYaHost.gatewayToken}});void run();};document.body.append(button);
  }
  function showProgress(message) {
    document.getElementById('migrationRetry')?.remove();
    MoonYaNotifications.update('migration-progress', message, {duration:0});
  }
  let running;
  async function run(){
    if(running)return running;
    running=performRun();try{return await running;}finally{running=null;}
  }
  async function performRun(){
    try{
      const options={headers:{'X-MoonYa-Gateway':MoonYaHost.gatewayToken}};
      let data=await(await MoonYaClient.originalFetch('/gateway/migration',options)).json();
      if(data?.error)throw new Error(data.error);
      if(!data)return false;
      if(data.version===2){
        if(!Number.isSafeInteger(data.chunks)||data.chunks<1||typeof data.source!=='string')throw new Error('migration_manifest_invalid');
        const summary={version:1,source:data.source,storage:{},stores:{conversations:[]}};
        for(let i=0;i<data.chunks;i++){
          showProgress('正在导入本地历史 '+(i+1)+' / '+data.chunks);
          const response=await MoonYaClient.originalFetch('/gateway/migration?chunk='+i,options);
          if(!response.ok)throw new Error('migration_chunk_unavailable');
          const part=await response.json();if(part.source!==data.source||!await importMigration(part,false))throw new Error('migration_chunk_invalid');
          Object.assign(summary.storage,part.storage);
          for(const row of part.stores.conversations||[])summary.stores.conversations.push({scope:row.scope});
        }
        await importMigration({version:1,source:data.source,storage:{},stores:{}},true);
        data=summary;
      }else if(!await importMigration(data))return false;
      const completed=await MoonYaClient.originalFetch('/gateway/migration',{...options,method:'DELETE'});
      if(!completed.ok)throw new Error('migration_completion_failed');
      document.getElementById('migrationRetry')?.remove();MoonYaNotifications.remove('migration-progress');
      const cached=MoonYaClient.cachedUser();if(cached)renderAuthState(cached,!localStorage.getItem('moonya.auth-expired.v1'));
      await MoonYaHistoryStore.reload(CHAT_HISTORY_KEY);await initializeChatHistory();renderChatList();await offerLocalAccounts(data);void checkUserSession();showToast('本地历史迁移完成');return true;
    }catch(error){console.warn('本地历史迁移未完成，可重试：',error.message);showFailure('本地历史迁移未完成');return false;}
  }
  window.MoonYaMigration={run,importMigration,showFailure,showProgress};
  document.addEventListener('DOMContentLoaded',()=>{void run();});
})();
