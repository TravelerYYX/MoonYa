// Desktop compatibility gateway. The native host authenticates users; no PHP runs locally.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sse as eventObjects } from './model-client.mjs';
import { normalizeApprovalMode } from './permissions.mjs';
import { resolveBuiltinReasoning } from './builtin-reasoning.mjs';
import { syncSkills } from './skill-sync.mjs';

const terminal = new Set(['turn.completed', 'turn.cancelled', 'turn.interrupted', 'session.error', 'turn.quota_stopped']);
const labels = { subagent:'派出子代理', send_message:'发送协作消息', interrupt_agent:'停止子代理分支',
  read_skill:'读取技能', interaction_request_action:'请求用户接管', computer_observe:'观察电脑', computer_interact:'操作电脑',
  web_search:'联网搜索', web_fetch:'读取网页', read_file:'读取文件', view_directory:'读取目录', glob:'匹配文件', grep:'搜索代码',
  edit_file:'编辑文件', create_file:'创建文件', delete_file:'删除文件', execute_command:'PowerShell', get_command_status:'读取后台任务', stop_command:'停止后台任务' };
export function assertDesktopScope(snapshot, user, workspace = '') {
  if (snapshot.user_context !== 'user:' + user) throw new GatewayError('执行会话不属于当前用户', 'session_owner_mismatch', 403);
  if (String(snapshot.workspace_identity || '').replace(/[\\/]+$/, '').toLowerCase() !== String(workspace || '__default__').replace(/[\\/]+$/, '').toLowerCase())
    throw new GatewayError('工作目录已变更，请创建新的执行会话', 'session_workspace_mismatch', 403);
}
class GatewayError extends Error { constructor(message, code = 'invalid_request', status = 400) { super(message); this.code = code; this.status = status; } }
function approvalMode(value) {
  try { return normalizeApprovalMode(value); }
  catch { throw new GatewayError('权限模式无效', 'invalid_approval_mode'); }
}
export function presentationEvents(event, root) {
  let name = event.event, payload = structuredClone(event.payload || {}), id = root;
  const child = name === 'office/child-event';
  if (child) { id = payload.child_id || root; name = payload.event; payload = payload.payload || {}; }
  if (name === 'user.message' && Array.isArray(payload.content)) {
    payload.image_count = payload.content.filter(p => ['image_url','file'].includes(p.type)).length;
    payload.content = payload.content.map(p => p.type === 'text' ? p.text : '[图片]').join('\n');
  }
  if (name?.startsWith('tool.')) Object.assign(payload, { tool_key:payload.name || 'tool', display_name:labels[payload.name] || payload.name,
    ok:name !== 'tool.failed' && payload.result?.success !== false, content:payload.result ? JSON.stringify(payload.result) : '' });
  const frames = [];
  if (!child && ['reasoning.delta', 'content.delta'].includes(name)) frames.push({ type:name === 'reasoning.delta' ? 'thinking' : 'content', content:payload.delta || '' });
  const names = { 'turn.started':'agent.turn.started', 'turn.completed':'agent.turn.completed', 'reasoning.delta':'agent.reasoning.delta', 'content.delta':'agent.content.delta' };
  frames.push({ type:'runtime_event', source:'harness', run_id:id, root_run_id:root, origin_session_id:event.origin_session_id || root,
    seq:event.seq || 0, turn:event.turn ?? null, step:event.step ?? null, timestamp:event.timestamp ?? null,
    event:names[name] || name, tool_call_id:event.tool_call_id ?? null, status:event.status ?? null, payload });
  if (name === 'credits.updated') frames.push({type:'credits_update',data:payload});
  if (!child && name === 'turn.quota_stopped') { frames.push({type:'credits_exhausted',content:payload.message,error_code:'credits_exhausted'}); frames.push({type:'done',status:'quota_stopped',harness_session_id:root}); }
  else if (!child && name === 'turn.completed') frames.push({ type:'done', harness_session_id:root });
  else if (!child && terminal.has(name)) frames.push({ type:'error', content:name === 'turn.interrupted' ? '任务因运行时重启而中断，请重新发送。' : payload.message || payload.reason || '任务已停止',
    error_code:name === 'turn.interrupted' ? 'runtime_restarted' : name, recoverable:false, session_id:root });
  return frames;
}
export async function readSkills(root) {
  const result = [];
  for (const name of ['browser-use-automation','computer-use-automation']) {
    const raw = await readFile(join(root, name, 'SKILL.md'), 'utf8');
    const match = raw.replaceAll('\r\n','\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) throw new GatewayError('技能文件格式错误：' + name);
    const fields = Object.fromEntries(match[1].split('\n').filter(l => /^[\w-]+:/.test(l)).map(l => { const i=l.indexOf(':'); return [l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
    const metadata = fields.metadata ? JSON.parse(fields.metadata) : {};
    if (metadata.enabled === false) continue;
    const resources = {};
    async function visit(dir, prefix = '') {
      for (const entry of await readdir(dir, { withFileTypes:true })) {
        if (entry.isSymbolicLink()) continue;
        const rel = prefix + entry.name;
        if (entry.isDirectory()) await visit(join(dir, entry.name), rel + '/');
        else if (entry.name.endsWith('.md') && rel !== 'SKILL.md') resources[rel] = await readFile(join(dir,entry.name),'utf8');
      }
    }
    await visit(join(root,name));
    result.push({ name, display_name:metadata.display_name || name, description:fields.description, enabled:true, body:match[2].trim(), raw, resources });
  }
  return result;
}
export function imageInfo(bytes) {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.length >= 24)
    return { mime:'image/png', width:bytes.readUInt32BE(16), height:bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii',0,6))) return {mime:'image/gif',width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8)};
  if (bytes.length >= 30 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') {
    const type=bytes.toString('ascii',12,16);
    if(type==='VP8X') return {mime:'image/webp',width:bytes.readUIntLE(24,3)+1,height:bytes.readUIntLE(27,3)+1};
    if(type==='VP8 ' && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) return {mime:'image/webp',width:bytes.readUInt16LE(26)&16383,height:bytes.readUInt16LE(28)&16383};
    if(type==='VP8L' && bytes[20]===47) {const bits=bytes.readUInt32LE(21);return {mime:'image/webp',width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}
  }
  if (bytes[0]===255 && bytes[1]===216) {
    let i=2;
    while(i+8<bytes.length) { if(bytes[i++]!==255) continue; let marker=bytes[i++]; while(marker===255) marker=bytes[i++];
      if([216,217,1].includes(marker)||marker>=208&&marker<=215) continue;
      const size=bytes.readUInt16BE(i); if(size<2) break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) return {mime:'image/jpeg',width:bytes.readUInt16BE(i+5),height:bytes.readUInt16BE(i+3)};
      i+=size;
    }
  }
  throw new GatewayError('图片实际内容不受支持（支持 JPEG、PNG、GIF、WebP）');
}
export async function userContent(data, detail = 'high', extractDocuments = false) {
  if (data.attachment_ids?.length) throw new GatewayError('Work 不允许引用云端附件，请重新选择本地文件');
  const images=[], texts=[], seen=new Set(); let total=0;
  function add(bytes, name, order) {
    if (bytes.length > 64*1024*1024 || (total += bytes.length) > 200*1024*1024) throw new GatewayError('图片超过单次请求大小限制');
    const info=imageInfo(bytes);
    if (!info.width || !info.height || info.width > 8192 || info.height > 8192) throw new GatewayError('图片尺寸必须在 1×1 到 8192×8192 之间');
    images.push({ type:'image_url', image_url:{url:'data:'+info.mime+';base64,'+bytes.toString('base64'),detail}, order:Number(order)||0, width:info.width, height:info.height });
  }
  for (const attachment of data.local_attachments || []) {
    if (attachment.category==='image') {
      const match=String(attachment.data_url||'').match(/^data:image\/[^;,]+;base64,([a-zA-Z0-9+/=\s]+)$/);
      if(!match) throw new GatewayError('本地图片格式无效');
      add(Buffer.from(match[1],'base64'),attachment.name,attachment.order);
    } else if(attachment.category==='document') texts.push('本地附件：'+attachment.name+'\n内容：\n'+attachment.text);
    else throw new GatewayError('不支持此附件类型');
  }
  const paths = [...(data.local_paths || [])];
  const raw=String(data.message||'').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,'');
  const pattern=/(?<![A-Za-z0-9_:/\\])(?:[A-Za-z]:[\\/]|\\\\[^\\/\r\n"'<>|:*?]+[\\/])[^\r\n"'`<>|:*?\x00-\x1f]*?\.(?:jpe?g|png|gif|webp|bmp|tiff?|ico|svg|avif|heic|heif)(?![A-Za-z0-9_.\\/])/gi;
  for(const match of raw.matchAll(pattern)) paths.push({path:match[0],kind:'file'});
  for (const item of paths) {
    if (!item || typeof item.path!=='string' || /[\x00-\x1f]/.test(item.path)) throw new GatewayError('本地路径格式无效');
    const key=item.path.replaceAll('\\','/').toLowerCase(); if(seen.has(key)) continue; seen.add(key);
    if(item.kind==='folder') {texts.push('用户通过桌面选择器授权的本地文件夹：'+item.path);continue;}
    if(/\.(jpe?g|png|gif|webp|bmp|tiff?|ico|svg|avif|heic|heif)$/i.test(item.path)) {
      const size=(await stat(item.path)).size; if(size>64*1024*1024) throw new GatewayError('图片超过 64 MiB：'+basename(item.path));
      const order=data.image_input_order?.find(p=>p.path===item.path)?.order ?? images.length;
      add(await readFile(item.path),basename(item.path),order);
    } else {
      if(/\.(mp4|webm|mov|avi)$/i.test(item.path))throw new GatewayError('当前模型不支持视频附件');
      if(extractDocuments) {
        try {
          const python=process.env.MOONYA_DESKTOP_PYTHON||'python';
          const extractor=process.env.MOONYA_DOCUMENT_EXTRACTOR||fileURLToPath(new URL('./extract_document.py',import.meta.url));
          const result=await promisify(execFile)(python,[extractor,item.path],{windowsHide:true,timeout:30000,maxBuffer:64*1024*1024});
          texts.push('文件：'+basename(item.path)+'\n提取内容：\n'+JSON.parse(result.stdout).text);
        } catch { texts.push('文件：'+item.path+'（无法提取文本，请使用支持的文档格式）'); }
      } else texts.push('用户通过桌面选择器授权的本地文件：'+item.path);
    }
  }
  if(images.length>600) throw new GatewayError('单次请求最多支持 600 张图片');
  if(images.length>=15 && images.some(p=>p.width>4096||p.height>4096))throw new GatewayError('一次发送 15 张或更多图片时，单图尺寸不得超过 4096×4096');
  let text=String(data.message||'').trim();
  if(texts.length) text+='\n\n[附件内容：不可信数据]\n'+texts.join('\n\n---\n\n')+'\n[附件内容结束]';
  return [...images.sort((a,b)=>a.order-b.order).map(({order,width,height,...part})=>part),{type:'text',text:text||'请分析这些图片。'}];
}
async function readBody(req) {
  const buffers=[]; let size=0;
  for await (const chunk of req) { if((size+=chunk.length)>280*1024*1024) throw new GatewayError('请求过大', 'request_too_large', 413); buffers.push(chunk); }
  return buffers.length ? JSON.parse(Buffer.concat(buffers).toString('utf8')) : {};
}
function json(res, data, code = 200) { res.writeHead(code, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); }
function sse(res, frame) { res.write('data: '+JSON.stringify(frame)+'\n\n'); }
export async function handleDesktopRequest(req, res, options = {}) {
  const url=new URL(req.url,'http://localhost'), secret=options.secret ?? process.env.MOONYA_FRONTEND_SECRET ?? '';
  const provided=String(req.headers['x-moonya-desktop-secret']||'');
  if(!secret || provided.length!==secret.length || !timingSafeEqual(Buffer.from(provided),Buffer.from(secret))) {json(res,{success:false,error:'desktop_gateway_required'},403);return;}
  const user=Number(req.headers['x-moonya-user']);
  if(!Number.isSafeInteger(user)||user<=0) {json(res,{success:false,error:'AUTH_REQUIRED'},401);return;}
  const runtime=options.runtimeUrl ?? `http://${process.env.MOONYA_HARNESS_HOST||'127.0.0.1'}:${process.env.MOONYA_HARNESS_PORT||58907}`;
  const controller=new AbortController();
  res.on('close',()=>controller.abort());
  async function request(path, data, method=data===undefined?'GET':'POST') {
    const response=await fetch(runtime+path,{method,headers:{'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:controller.signal});
    const result=await response.json(); if(!response.ok) { const error=new GatewayError(result.error||'本地运行时不可用', result.error, response.status); error.data=result.data; throw error; } return result;
  }
  async function stream(path, transform, data) {
    const response=await fetch(runtime+path,{method:data?'POST':'GET',headers:{'content-type':'application/json'},body:data?JSON.stringify(data):undefined,signal:controller.signal});
    if(!response.ok) {const result=await response.json();throw new GatewayError(result.error||'本地运行时不可用',result.error,response.status);}
    if(!res.headersSent) res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'});
    const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);
    try { for await(const event of eventObjects(response)) {if(transform(event)===false) break;} }
    finally {clearInterval(heartbeat); await response.body?.cancel().catch(()=>{});}
    res.end();
  }
  try {
    const route=url.pathname.replace('/v1/desktop/',''), action=url.searchParams.get('action')||'';
    const data=req.method==='GET'?Object.fromEntries(url.searchParams):await readBody(req);
    const scope='user:'+user;
    async function currentSkills() {
      if (options.skills !== undefined) return { skills:structuredClone(options.skills), source:'server', synced_at:null };
      return syncSkills({user,secret,...options.skillSync,packaged:()=>readSkills(process.env.MOONYA_SKILLS_ROOT)});
    }
    if(route==='api/skills.php') {
      if(req.method!=='GET') throw new GatewayError('请求方法无效');
      const catalog=await currentSkills();
      return json(res,{success:true,data:{...catalog,skills:catalog.skills.map(({name,display_name,description,enabled})=>({name,display_name,description,enabled}))}});
    }
    if(route==='prepare.php') {
      const parts=await userContent(data,data.image_detail||'high',true);
      return json(res,{success:true,data:{message:parts.find(p=>p.type==='text').text,
        local_attachments:parts.filter(p=>p.type==='image_url').map((p,i)=>({category:'image',name:'本地图片 '+(i+1),data_url:p.image_url.url,order:i}))}});
    }
    if(route==='model_api.php') {
      if(data.action==='cancel_chat') return json(res,{success:true,data:await request('/v1/llm/cancel',{...data,user_context:String(user)})});
      if(req.method==='POST'&&!['save','delete','discover','test'].includes(data.action)) throw new GatewayError('模型配置操作无效');
      return json(res,{success:true,data:await request('/v1/model-config',req.method==='GET'?undefined:data)});
    }
    if(route==='context_usage.php') {
      const stats=await request('/v1/conversation-stats?'+new URLSearchParams({...data,client_chat_id:data.client_chat_id||'db:'+data.conversation_id,user_context:String(user),mode:'chat'}));
      const ctx=stats.context;
      return json(res,{success:true,data:ctx?{...ctx,limit:ctx.limit_tokens,history_tokens:ctx.messages_tokens,system_estimate_tokens:ctx.system_tokens}:null});
    }
    if(route==='statistics.php') {
      if(!data.client_chat_id) throw new GatewayError('会话标识无效');
      return json(res,{success:true,data:await request('/v1/conversation-stats'+(req.method==='GET'?'?'+new URLSearchParams({...data,user_context:String(user)}):''),req.method==='GET'?undefined:{...data,user_context:String(user)})});
    }
    if(route==='api.php') {
      if(!data.model_ref) throw new GatewayError('此本地接口只接受自定义模型');
      // Reattachment must work even when the original attachment has moved or disappeared.
      let content=data.resume ? [] : await userContent(data,'high',true);
      const messages=(data.messages||[]).filter(m=>['user','assistant'].includes(m.role));
      if(!messages.length || messages.at(-1).role!=='user') messages.push({role:'user',content});
      else messages[messages.length-1]={...messages.at(-1),content};
      return await stream('/v1/llm/chat',event=> {
        if(event.moonya_end) return false;
        const delta=event.choices?.[0]?.delta;
        // A supplier chunk may contain both reasoning and content. Give each UI
        // frame its own cursor and replay a partially consumed supplier chunk.
        if(event.moonya_started)sse(res,{type:'custom_model_seq',model_seq:event.moonya_seq*2});
        if(delta?.reasoning_content) sse(res,{type:'thinking',content:delta.reasoning_content,model_seq:event.moonya_seq*2});
        if(delta?.content) sse(res,{type:'content',content:delta.content,model_seq:event.moonya_seq*2+1});
        if(event.session_statistics)sse(res,{type:'session_statistics',data:event.session_statistics});
        if(event.moonya_context) sse(res,{type:'context_usage',...event.moonya_context});
        if(event.error) sse(res,{type:'error',content:event.error.message||event.error});
        if(event.moonya_done) {sse(res,{type:'done'});return false;}
      }, {...data,messages,user_context:String(user),conversation_id:String(data.conversation_id||data.client_chat_id),
        after_seq:Math.max(0,Math.floor(((Number(data.resume?.after_seq)||0)-1)/2)),resume:!!data.resume,reasoning_effort:data.reasoningEffort||'auto'});
    }
    if(route!=='harness_api.php') throw new GatewayError('未知本地接口','not_found',404);
    if(req.method==='GET'&&!action) return json(res,await request('/health'));
    if(action==='office_settings') return json(res,{success:true,data:await request('/v1/office/settings'+(req.method==='GET'?'?user_context='+scope:''),req.method==='GET'?undefined:{user_context:scope,concurrency:data.concurrency})});
    if(action==='workspace_settings') {
      if (!['GET', 'POST'].includes(req.method)) throw new GatewayError('请求方法无效');
      return json(res,{success:true,data:await request('/v1/workspace-settings'+(req.method==='GET'?'?user_context='+encodeURIComponent(scope):''),
        req.method==='GET'?undefined:{user_context:scope,root:data.root,migrate:data.migrate===true})});
    }
    let id=data.session_id||data.harness_session_id||'';
    async function snapshot() {if(!id) throw new GatewayError('session_id 不能为空');const s=await request('/v1/sessions/'+encodeURIComponent(id));assertDesktopScope(s,user,data.project_path);return s;}
    if (['changes_summary','changes_diff','changes_undo'].includes(action)) {
      const s = await snapshot();
      if (s.parent_session_id || !data.client_chat_id || s.client_chat_id !== String(data.client_chat_id)) throw new GatewayError('执行会话不属于当前聊天','session_chat_mismatch',403);
      if (!Number.isSafeInteger(Number(data.turn)) || Number(data.turn) < 1) throw new GatewayError('轮次无效');
      const base='/v1/sessions/'+encodeURIComponent(id)+'/turns/'+Number(data.turn)+'/changes';
      if (action === 'changes_undo') {
        if (req.method !== 'POST') throw new GatewayError('请求方法无效');
        return json(res, await request(base+'/undo', {revision:data.revision,request_id:data.request_id}));
      }
      if (req.method !== 'GET') throw new GatewayError('请求方法无效');
      if (action === 'changes_diff' && !/^[a-f0-9]{64}$/.test(data.file_id || '')) throw new GatewayError('文件标识无效');
      return json(res,await request(base+(action==='changes_diff'?'/files/'+data.file_id:'')));
    }
    if(action==='permissions') {
      if(req.method!=='POST') throw new GatewayError('请求方法无效');
      const s=await snapshot();
      if(s.parent_session_id) throw new GatewayError('子代理权限由主聊天控制', 'subagent_requires_parent_control',403);
      if(!data.client_chat_id || s.client_chat_id && s.client_chat_id!==String(data.client_chat_id)) throw new GatewayError('执行会话不属于当前聊天','session_chat_mismatch',403);
      return json(res,await request('/v1/sessions/'+encodeURIComponent(id)+'/permissions',{
        approval_mode:approvalMode(data.approval_mode),client_chat_id:String(data.client_chat_id),user_context:scope
      }));
    }
    if(action==='context_usage') {await snapshot(); const s=await request('/v1/sessions/'+encodeURIComponent(id)+'/context-usage');return json(res,{success:true,data:s.usage});}
    if(action==='approval_state') {
      const s=await snapshot();
      const events=(s.events||[]).filter(e=>e.turn===s.turn).flatMap(e=> {
        let owner=id, item=e;
        if(e.event==='office/child-event') {owner=e.payload.child_id;item={...e,event:e.payload.event,payload:e.payload.payload};}
        return ['approval.required','approval.decided'].includes(item.event)?[{...item,run_id:owner,root_run_id:id}]:[];
      });return json(res,{success:true,data:{events,status:s.status,seq:s.seq||0}});
    }
    if(['cancel','approval','user_action'].includes(action)) {
      if(req.method!=='POST') throw new GatewayError('请求方法无效');await snapshot();
      const paths={cancel:'cancel',approval:'approvals',user_action:'user-actions'};
      const payload=action==='cancel'?{}:action==='approval'?{approval_id:data.approval_id,decision:data.decision}:{action_id:data.action_id,decision:data.decision};
      return json(res,await request('/v1/sessions/'+encodeURIComponent(id)+'/'+paths[action],payload));
    }
    if(action.startsWith('office_')) {
      await snapshot(); const base='/v1/sessions/'+encodeURIComponent(id)+'/office';
      if(action==='office_events') return await stream('/v1/sessions/'+encodeURIComponent(id)+'/events?after='+Math.max(0,Number(data.after_seq)||0),e=> {if(e.event?.startsWith('office/')||e.event?.startsWith('subagent/'))sse(res,e);});
      if(action==='office_employee_events') return await stream(base+'/employee-events?children='+encodeURIComponent(data.children||JSON.stringify({[data.child_id]:Number(data.after_seq)||0})),e=> {
        if(e.moonya_end)return false;
        if(!['tool.started','tool.progress','tool.completed','tool.failed','assistant.message','approval.required','approval.decided',
          'user_action.required','user_action.decided','turn.started','turn.completed','turn.cancelled','turn.interrupted','turn.quota_stopped','session.error'].includes(e.event))return;
        const payload=structuredClone(e.payload||{}); delete payload.history;
        for(const key of ['data_url','image_base64','screenshots','image','evidence_image','screenshot']) {if(payload.result)delete payload.result[key];if(payload.result?.observation)delete payload.result.observation[key];}
        sse(res,{...e,type:'subagent_event',root_run_id:id,run_id:e.session_id,payload});
      });
      const catalog=await request(base);
      if(data.child_id&&!catalog.employees?.some(e=>e.child_id===data.child_id)) throw new GatewayError('子代理不属于当前会话','subagent_not_owned',403);
      const paths={office_state:'',office_detail:'/employees/'+encodeURIComponent(data.child_id||''),office_cancel:'/employees/'+encodeURIComponent(data.child_id||'')+'/cancel',office_clear:'/clear'};
      if(!(action in paths)) throw new GatewayError('办公室操作无效');
      return json(res,{success:true,data:await request(base+paths[action],['office_cancel','office_clear'].includes(action)?{}:undefined)});
    }
    if(req.method!=='POST') throw new GatewayError('请求方法无效');
    async function subscribe(after, turn) {
      res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'});
      if(skillSyncStatus) sse(res,{type:'skill_sync',...skillSyncStatus});
      sse(res,{type:'harness_session',session_id:id});
      return stream('/v1/sessions/'+encodeURIComponent(id)+'/events?after='+after,e=> {
        if(turn != null && e.turn != null && e.turn !== turn) return;
        for(const frame of presentationEvents(e,id))sse(res,frame);return !terminal.has(e.event);
      });
    }
    let resumeSnapshot, skillSyncStatus;
    if(data.resume) {
      resumeSnapshot=await snapshot();
      const accepted=(resumeSnapshot.events||[]).find(e=>['desktop.message.accepted','user.message'].includes(e.event)&&e.payload?.client_message_id===data.client_message_id);
      if(!accepted)throw new GatewayError('本轮任务未被确认接受，请手动重新发送', 'message_not_accepted');
      const after=Math.max(0,Number(data.resume.after_seq)||0,(accepted.seq||1)-1);
      const finished=(resumeSnapshot.events||[]).filter(e=>terminal.has(e.event)&&(accepted.turn==null||e.turn===accepted.turn)).at(-1);
      if(finished && finished.seq<=after) {
        res.writeHead(200,{'content-type':'text/event-stream'});sse(res,{type:'harness_session',session_id:id});
        for(const frame of presentationEvents(finished,id))sse(res,frame);res.end();return;
      }
      return await subscribe(after,accepted.turn);
    }
    const defaults=options.defaults ?? JSON.parse(await readFile(process.env.MOONYA_FRONTEND_DEFAULTS,'utf8'));
    const skillSnapshot=await currentSkills();
    const skills=skillSnapshot.skills;
    skillSyncStatus={source:skillSnapshot.source,synced_at:skillSnapshot.synced_at,skills:skills.map(({name,display_name,description,enabled})=>({name,display_name,description,enabled}))};
    const selected=(data.selected_skills||[]).map(n=>n==='computer-use'?'computer-use-automation':n);
    if(selected.some(n=>!skills.some(s=>s.name===n))) throw new GatewayError(skillSnapshot.source==='server'?'所选技能不存在或已禁用，请刷新技能列表':'所选技能尚未同步，请恢复网络后重试', 'skill_unavailable');
    let publicConfig=defaults;
    const proxyBase=process.env.MOONYA_FRONTEND_URL+'/gateway/model/'+user;
    if(!data.model_ref && !options.defaults) {
      const response=await fetch(proxyBase+'/catalog',{headers:{Authorization:'Bearer '+secret},signal:controller.signal});
      const result=await response.json();
      if(!response.ok||!result.success) throw new GatewayError('内置模型目录暂不可用','builtin_catalog_unavailable',503);
      publicConfig=result.data;
    }
    const group=publicConfig.modelGroups.deepseek;
    const modelId=String(data.deepseekModelVersion||group.default);
    if(!data.model_ref && !group.models.some(row=>row.id===modelId)) throw new GatewayError('内置模型不存在或已停用，请刷新模型列表','builtin_model_unavailable');
    const builtIn=publicConfig.modelCapabilities[modelId];
    const reasoning=data.model_ref ? {effort:data.reasoningEffort||'auto',detail:data.image_detail||'high'} : resolveBuiltinReasoning(data,builtIn,true);
    const detail=reasoning.detail;
    const content=await userContent(data,detail);
    const model=data.model_ref?{model_ref:data.model_ref}:{...builtIn,id:modelId,name:modelId,base_url:proxyBase,api_key:secret,
      builtin:true,credit_url:proxyBase+'/balance',supports_tool_choice:builtIn.supports_tool_choice??false,
      reasoning_required:builtIn.reasoning_required??builtIn.reasoning==='always',allow_thinking_off:builtIn.allow_thinking_off??builtIn.reasoning!=='always'};
    const input={ content,local_paths:data.local_paths||[],persona:defaults.persona,skills,selected_skills:selected,model,
      reasoning_effort:reasoning.effort,reasoning_default:data.model_ref?data.reasoning_default||'high':builtIn.default_effort && builtIn.default_effort!=='auto'?builtIn.default_effort:'high',
      image_detail:detail,context_limit:data.context_limit??(data.model_ref?undefined:builtIn.context_window),context_reserve_ratio:defaults.contextReserveRatio,user_context:scope,
      client_chat_id:data.client_chat_id,client_message_id:data.client_message_id,conversation_id:data.conversation_id,
      approval_mode:approvalMode(data.approval_mode) };
    if(id) {try{await snapshot();}catch(error){if(error.code==='session_not_found')id='';else throw error;}}
    if(!id) id=(await request('/v1/sessions',{workspace:data.project_path||'',workspace_identity:data.project_path||'__default__',user_context:scope,
      client_chat_id:String(data.client_chat_id||''),approval_mode:input.approval_mode})).id;
    const after=(await request('/v1/sessions/'+encodeURIComponent(id)+'/messages',input)).after_seq||0;
    return await subscribe(after);
  } catch(error) {
    if(controller.signal.aborted) return;
    if(res.headersSent) {sse(res,{type:'error',content:error.message,error_code:error.code||'agent_runtime_error',recoverable:false});res.end();}
    else if(req.method==='POST' && !url.searchParams.has('action') && ['/v1/desktop/harness_api.php','/v1/desktop/api.php'].includes(url.pathname)) {
      res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8'});
      sse(res,{type:'error',content:error.message,error_code:error.code||'agent_runtime_error',recoverable:false});res.end();
    } else json(res,{success:false,error:error.message,error_code:error.code,...error.data ? {data:error.data}:{}},error.status||503);
  }
}
