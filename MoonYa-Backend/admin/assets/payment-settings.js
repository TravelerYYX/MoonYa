(function(){
 'use strict';
 const el=id=>document.getElementById(id), materials=['private_key','public_key','app_cert','alipay_cert','root_cert'];
 const token=localStorage.getItem('adminToken');let state=null,pending=null,expiry=null,busy=false,loadVersion=0;
 if(!token){location.replace('login.php');return;}
 const labels={save:'保存支付配置',import:'导入旧配置',settle:'查单并关闭未付款订单',force_delete:'强制删除未结清订单',enabled:'支付开关',environment:'环境',mode:'签名模式',app_id:'AppID',seller_id:'商户 UID',public_url:'后端地址',materials_changed:'更换或清除的材料',order_numbers:'订单号',private_key:'应用私钥',public_key:'支付宝公钥',app_cert:'应用证书',alipay_cert:'支付宝证书',root_cert:'根证书',deleted:'已删除'};
 function notice(message,success=false){el('notice').textContent=message;el('notice').dataset.success=String(success);}
 async function request(action,body){
  const response=await fetch('api/payment_settings.php?action='+action,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},cache:'no-store',credentials:'same-origin',body:body?JSON.stringify(body):undefined});
  const result=await response.json();if(!response.ok||!result.success)throw new Error(result.error||'支付管理操作失败');return result.data;
 }
 function eraseMaterials(){for(const field of materials){el(field).value='';el(field+'_clear').checked=false;}el('paymentSettingsSection').querySelectorAll('[data-file]').forEach(input=>input.value='');}
 function modeChanged(){const certificate=el('mode').value==='certificate';for(const field of materials)el(field).closest('[data-material]').hidden=field==='public_key'?certificate:field!=='private_key'&&!certificate;}
 async function load(){
  const version=++loadVersion;try{const result=await request('state');if(version!==loadVersion)return;state=result;const config=state.configuration;for(const field of ['enabled','environment','mode','app_id','seller_id','public_url'])el(field).value=String(config[field]);
   eraseMaterials();modeChanged();el('configurationState').textContent=(config.enabled?'购买开关已启用':'购买开关已关闭')+'；'+(config.ready?'本地配置校验通过':'配置未就绪：'+config.missing.map(field=>labels[field]||({sdk:'支付宝 SDK',invalid_key_or_certificate:'密钥或证书校验未通过'})[field]||field).join('、'));
   el('notifyUrl').textContent=config.notify_url||'—';el('returnUrl').textContent=config.return_url||'—';el('blockingState').textContent='当前未结清订单：'+config.blocking_orders+' 笔';
   for(const field of materials)el(field+'_state').textContent=config.materials[field].configured?'已配置（不回显材料）':'未配置';
   const verification=state.verification;
   el('verificationState').textContent=verification.ready?'所有操作均使用当前管理员密码确认':'管理员密码验证暂不可用';
   el('save').disabled=false;el('settle').disabled=!verification.ready;el('forceDelete').disabled=!verification.ready;el('import').disabled=!verification.ready||config.revision>0;
  }catch(error){if(version!==loadVersion)return;notice(error.message);for(const id of ['save','settle','import','forceDelete'])el(id).disabled=true;}
 }
 function format(summary){return Object.entries(summary).map(([key,value])=>(key==='operation'?'操作':labels[key]||key)+'：'+(Array.isArray(value)?value.map(v=>labels[v]||v).join('、'):typeof value==='boolean'?(value?'启用':'关闭'):labels[value]||value)).join('\n');}
 function passwordStep(){
  el('verifyPassword').disabled=false;el('verifyPassword').required=true;el('verifyError').textContent='';
  el('verificationHint').textContent=pending?.operation==='save'?'输入当前管理员密码即可保存本次配置。':'输入当前管理员密码，验证通过后执行上方操作。';
  el('confirmVerification').textContent=pending?.operation==='save'?'确认并保存':'确认并执行操作';el('verifyPassword').focus();
  if(pending?.operation==='force_delete'){el('verificationHint').textContent='将永久删除上方订单，不会关闭支付宝交易。删除后若实际付款，无法自动补发会员权益，需人工核对处理。输入当前管理员密码确认删除。';el('confirmVerification').textContent='确认强制删除';}
 }
 function deadline(){
  clearTimeout(expiry);expiry=setTimeout(()=>{cancel();notice('本次验证已过期，请重新发起操作');},Math.max(0,pending.expires_at*1000-Date.now()));
 }
 function openVerification(challenge,summary){
  pending=challenge;busy=false;el('operationSummary').textContent=summary;el('verifyForm').reset();el('confirmVerification').disabled=false;
  el('verification').showModal();passwordStep();deadline();
 }
 function cancel(){el('verification').close();pending=null;clearTimeout(expiry);el('verifyForm').reset();el('verifyPassword').value='';busy=false;}
 async function challenge(body){try{const response=await request('challenge',body);eraseMaterials();openVerification({...response,operation:body.operation},format(response.summary));}catch(error){notice(error.message);}}
 el('configurationForm').addEventListener('submit',async event=>{event.preventDefault();if(!state)return;const config={revision:state.configuration.revision,enabled:el('enabled').value==='true',clear:[]};for(const field of ['environment','mode','app_id','seller_id','public_url',...materials])config[field]=el(field).value;for(const field of materials)if(el(field+'_clear').checked)config.clear.push(field);eraseMaterials();openVerification({operation:'save',configuration:config,expires_at:Math.floor(Date.now()/1000)+120},format({operation:'save',enabled:config.enabled,environment:config.environment,mode:config.mode,app_id:config.app_id,seller_id:config.seller_id,public_url:config.public_url,materials_changed:materials.filter(f=>config[f]||config.clear.includes(f))}));});
 el('import').addEventListener('click',()=>challenge({operation:'import'}));el('settle').addEventListener('click',()=>challenge({operation:'settle',order_numbers:el('orderNumbers').value.split(/\s+/).filter(Boolean)}));
 el('forceDelete').addEventListener('click',()=>challenge({operation:'force_delete',order_numbers:el('orderNumbers').value.split(/\s+/).filter(Boolean)}));
 el('reload').addEventListener('click',()=>{notice('');load();});el('mode').addEventListener('change',modeChanged);
 el('paymentSettingsSection').querySelectorAll('[data-file]').forEach(input=>input.addEventListener('change',async()=>{try{const file=input.files[0];if(!file)return;if(file.size>65536)throw new Error('文件超过 64 KiB');el(input.dataset.file).value=await file.text();el(input.dataset.file+'_clear').checked=false;}catch(error){notice(error.message);}finally{input.value='';}}));
 for(const field of materials)el(field+'_clear').addEventListener('change',()=>{if(el(field+'_clear').checked)el(field).value='';});
 el('cancelVerification').addEventListener('click',cancel);el('verification').addEventListener('cancel',event=>{event.preventDefault();cancel();});
 el('verifyForm').addEventListener('submit',async event=>{
  event.preventDefault();if(!pending||busy)return;const challenge=pending;busy=true;el('confirmVerification').disabled=true;el('verifyError').textContent='';
  try{
   if(challenge.operation==='save'){const result=await request('save_password',{configuration:challenge.configuration,password:el('verifyPassword').value});if(pending===challenge){cancel();notice(result.message,true);await load();}return;}
   const result=await request('confirm',{challenge_id:challenge.challenge_id,password:el('verifyPassword').value});if(pending!==challenge)return;cancel();
   if(result.results)el('settleResults').textContent=result.results.map(r=>r.order_no+'：'+(r.error||labels[r.status]||r.status)).join('\n');
   if(challenge.operation==='force_delete')el('orderNumbers').value='';
   notice(result.message||'订单结清检查完成，请查看结果',true);await load();
  }catch(error){if(pending===challenge)el('verifyError').textContent=error.message;else notice(error.message);}
  finally{if(pending===challenge||pending===null){busy=false;el('confirmVerification').disabled=false;el('verifyPassword').value='';}}
 });
 window.paymentSettings={load,leave(){loadVersion++;eraseMaterials();cancel();state=null;for(const id of ['save','settle','import','forceDelete'])el(id).disabled=true;}};
 window.addEventListener('pagehide',()=>window.paymentSettings.leave());
}());
