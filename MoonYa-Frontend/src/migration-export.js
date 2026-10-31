// Served by CEF under the previous origin. Read bounded batches, never stringify the entire history.
(async function () {
  try {
    async function encode(value) {
      if(value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes=new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength));
        let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
        return {__moonya_export_type:value instanceof File?'File':value instanceof Blob?'Blob':value instanceof ArrayBuffer?'ArrayBuffer':value.constructor.name,
          base64:btoa(binary),mime:value.type||'',name:value.name,lastModified:value.lastModified};
      }
      if(value instanceof Date)return {__moonya_export_type:'Date',value:value.toISOString()};
      if(Array.isArray(value))return Promise.all(value.map(encode));
      if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([k,v])=>[k,await encode(v)])));
      return value;
    }
    const source=location.origin, storage={};
    for(let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i);
      if(/^(moonya[._-]|chat_history|api_token|voice|deepseek_|selected_|work_|chatDisplayMode$)/i.test(key))storage[key]=localStorage.getItem(key);
    }
    let db;
    if((await indexedDB.databases()).some(d=>d.name==='moonya-history')) {
      db=await new Promise((resolve,reject)=>{const r=indexedDB.open('moonya-history');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    }
    const names=db?[...db.objectStoreNames]:[];
    let sentStorage=false, storeIndex=0, afterKey, queue=[], ended=false;
    async function next() {
      if(ended)return {done:true};
      let part;
      if(!sentStorage) {sentStorage=true;part={version:1,source,storage,stores:{}};}
      else {
        while(storeIndex<names.length) {
          const name=names[storeIndex],rows=[];let chars=0;
          while(rows.length<100) {
            if(!queue.length) {
              const range=afterKey===undefined?undefined:IDBKeyRange.lowerBound(afterKey,true);
              const tx=db.transaction(name),store=tx.objectStore(name);
              const [values,keys]=await Promise.all(['getAll','getAllKeys'].map(method=>new Promise((resolve,reject)=>{
                const r=store[method](range,100);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
              })));
              queue=values.map((value,i)=>({value,key:keys[i]}));
              if(!queue.length)break;
            }
            const entry=queue[0];
            if(!entry.encoded) {entry.encoded=await encode(entry.value);entry.chars=JSON.stringify(entry.encoded).length;}
            if(rows.length&&chars+entry.chars>1024*1024)break;
            rows.push(entry.encoded);chars+=entry.chars;afterKey=entry.key;queue.shift();
          }
          if(rows.length) {part={version:1,source,storage:{},stores:{[name]:rows}};break;}
          storeIndex++;afterKey=undefined;queue=[];
        }
        if(!part) {ended=true;db?.close();return {done:true};}
      }
      window.__moonyaMigrationChunk=JSON.stringify(part);
      return {done:false,length:window.__moonyaMigrationChunk.length};
    }
    window.MoonYaMigrationExport={next};
    window.__moonyaMigration={version:2,source};
  }catch(error){window.__moonyaMigration={error:error.message};}
})();
