<?php
// The server keeps business pages and this login page; no server-hosted chat UI.
header('Cache-Control: no-store');
?>
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MoonYa 账号登录</title>
<style>body{font-family:system-ui,sans-serif;background:#f7f7fa;color:#242424;display:grid;place-items:center;min-height:90vh;margin:0}main{background:white;border-radius:16px;padding:32px;width:min(320px,80vw)}h1{font-size:22px;margin-top:0}label{display:block;margin:16px 0}input,button{box-sizing:border-box;padding:12px;width:100%;border:1px solid #ddd;border-radius:8px;font:inherit}button{background:#333;color:#fff;cursor:pointer}#status{font-size:14px;color:#8a5036}p{font-size:14px;color:#666}</style></head>
<body><main><h1>MoonYa 账号登录</h1><p>登录后查看个人中心。聊天与办公室请在桌面客户端使用。</p>
<div style="display:flex;gap:8px"><button id="codeTab" type="button">验证码登录</button><button id="passwordTab" type="button">密码登录</button></div>
<form id="codeLogin"><label>QQ 号<input name="qq" inputmode="numeric" autocomplete="username" maxlength="11" required></label><label>验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label><button id="sendCode" type="button">发送验证码</button><p>验证码发送至 QQ号@qq.com，有效期 5 分钟</p><button id="codeSubmit" type="submit">登录</button></form>
<form id="login" hidden><label>账号<input name="account" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button>登录</button></form><p id="status" role="status"></p></main>
<script>
const passwordForm=document.getElementById('login'),codeForm=document.getElementById('codeLogin'),status=document.getElementById('status'),sendButton=document.getElementById('sendCode');
let challenge=null;
document.getElementById('codeTab').onclick=()=>{passwordForm.hidden=true;codeForm.hidden=false;status.textContent='';};
document.getElementById('passwordTab').onclick=()=>{passwordForm.hidden=false;codeForm.hidden=true;status.textContent='';};
codeForm.elements.qq.oninput=()=>{challenge=null;codeForm.elements.code.value='';};
async function authRequest(action,input){const response=await fetch('user_auth.php?action='+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!result.success)throw new Error(result.error||'操作失败');return result.data;}
sendButton.onclick=async()=>{
 const qq=codeForm.elements.qq.value.trim();if(!/^[1-9][0-9]{4,10}$/.test(qq)){status.textContent='请输入有效的 5-11 位 QQ 号';return;}
 sendButton.disabled=true;challenge=null;
 try{const data=await authRequest('send_code',{qq,purpose:'login'});if(codeForm.elements.qq.value.trim()===qq)challenge={qq,id:data.challenge_id};status.textContent='验证码已发送，请查看 QQ 邮箱';const until=Date.now()+data.retry_after*1000;const timer=setInterval(()=>{const remaining=Math.max(0,Math.ceil((until-Date.now())/1000));sendButton.textContent=remaining?remaining+' 秒后重发':'发送验证码';if(!remaining){clearInterval(timer);sendButton.disabled=false;}},1000);}
 catch(error){status.textContent=error.message;sendButton.disabled=false;}
};
codeForm.onsubmit=async event=>{event.preventDefault();const qq=codeForm.elements.qq.value.trim(),code=codeForm.elements.code.value.trim();if(!challenge||challenge.qq!==qq){status.textContent='请先发送验证码';return;}if(!/^[0-9]{6}$/.test(code)){status.textContent='请输入 6 位验证码';return;}const button=document.getElementById('codeSubmit');button.disabled=true;try{await authRequest('login_code',{qq,code,challenge_id:challenge.id});location.href='user/user_xinxi.php';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
passwordForm.onsubmit=async event=>{event.preventDefault();const button=passwordForm.querySelector('button');button.disabled=true;try{await authRequest('login',Object.fromEntries(new FormData(passwordForm)));location.href='user/user_xinxi.php';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
</script></body></html>
