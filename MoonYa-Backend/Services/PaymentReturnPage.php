<?php
declare(strict_types=1);

function paymentReturnPage(string $state,?string $number=null): void {
    $result=['state'=>$state,'open_url'=>$state==='paid'&&$number!==null?'moonya://payment/return?order_no='.rawurlencode($number):null];
    if (($_SERVER['HTTP_ACCEPT']??'')==='application/json') {
        header('Content-Type: application/json; charset=utf-8');echo json_encode($result,JSON_THROW_ON_ERROR);return;
    }
    $nonce=base64_encode(random_bytes(18));
    header('Content-Type: text/html; charset=utf-8');
    header("Content-Security-Policy: default-src 'none'; script-src 'nonce-$nonce'; style-src 'nonce-$nonce'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    $titles=['paid'=>'付款成功','pending'=>'正在确认付款','closed'=>'订单已关闭','invalid'=>'无法确认付款','unavailable'=>'付款确认暂不可用'];
    $messages=['paid'=>'付款已确认，你的会员信息已更新。','pending'=>'正在等待服务器确认付款，请稍候…','closed'=>'此订单已关闭，请在 MoonYa 中重新选择套餐。','invalid'=>'付款返回信息无效，请在 MoonYa 中查看订单。','unavailable'=>'暂时无法查询付款结果，请稍后重试。'];
    $title=$titles[$state];$message=$messages[$state];
    $json=json_encode($result,JSON_THROW_ON_ERROR|JSON_HEX_TAG|JSON_HEX_AMP|JSON_HEX_APOS|JSON_HEX_QUOT);
    ?>
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title><?= $title ?> · MoonYa</title>
<style nonce="<?= $nonce ?>">
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f8;color:#202124;font-family:system-ui,"Microsoft YaHei",sans-serif;padding:24px}.card{width:100%;max-width:440px;text-align:center;background:white;border:1px solid #e8e8ed;border-radius:24px;padding:40px 28px;box-shadow:0 12px 40px #20212408}.brand{font-size:16px;font-weight:700;letter-spacing:.5px;margin:0 0 32px}.icon{display:grid;place-items:center;width:64px;height:64px;border-radius:50%;margin:0 auto 24px;background:#f0f1f4;color:#757780;font-size:32px}.icon.success{background:#e9f7ef;color:#26945c}h1{font-size:26px;margin:0 0 12px}p{font-size:15px;line-height:1.7;margin:0 0 24px;color:#666973}.actions{display:flex;flex-direction:column;gap:12px}a,button{display:block;width:100%;padding:13px 18px;border:0;border-radius:12px;background:#202124;color:white;font:inherit;text-decoration:none;cursor:pointer}[hidden]{display:none!important}.hint{font-size:13px;margin:20px 0 0;color:#868891}
</style></head>
<body><main class="card"><div class="brand">MoonYa</div><div id="icon" class="icon<?= $state==='paid'?' success':'' ?>" aria-hidden="true"><?= $state==='paid'?'✓':'…' ?></div><h1 id="title"><?= $title ?></h1><p id="message" role="status" aria-live="polite"><?= $message ?></p><div class="actions"><a id="open" <?= $result['open_url']?'href="'.htmlspecialchars($result['open_url'],ENT_QUOTES,'UTF-8').'"':'hidden' ?>>打开 MoonYa</a><button id="retry" type="button" <?= in_array($state,['paid','invalid','closed'],true)?'hidden':'' ?>>重新查询</button></div><p id="hint" class="hint" <?= $state==='paid'?'':'hidden' ?>>正在打开 MoonYa；若未打开，请点击上方按钮并允许浏览器打开应用。</p></main>
<script nonce="<?= $nonce ?>">
(() => {
    const initial=<?= $json ?>;
    let opened=false,checking=false,attempts=0,timer;
    function render(result){
        const paid=result.state==='paid';
        document.getElementById('icon').textContent=paid?'✓':'…';
        document.getElementById('icon').classList.toggle('success',paid);
        const titles={paid:'付款成功',pending:'正在确认付款',closed:'订单已关闭',invalid:'无法确认付款',unavailable:'付款确认暂不可用'};
        const messages={paid:'付款已确认，你的会员信息已更新。',pending:'正在等待服务器确认付款，请稍候…',closed:'此订单已关闭，请在 MoonYa 中重新选择套餐。',invalid:'付款返回信息无效，请在 MoonYa 中查看订单。',unavailable:'暂时无法查询付款结果，请稍后重试。'};
        document.title=titles[result.state]+' · MoonYa';
        document.getElementById('title').textContent=titles[result.state];
        document.getElementById('message').textContent=messages[result.state];
        const link=document.getElementById('open');link.hidden=!paid;
        document.getElementById('hint').hidden=!paid;
        document.getElementById('retry').hidden=!['pending','unavailable'].includes(result.state);
        if(paid&&result.open_url){
            link.href=result.open_url;
            if(!opened){opened=true;setTimeout(()=>location.href=result.open_url,700);}
        }
        return result.state;
    }
    async function check(){
        if(checking||opened)return;checking=true;clearTimeout(timer);
        const retry=document.getElementById('retry');retry.disabled=true;
        try{
            const response=await fetch(location.href,{headers:{Accept:'application/json'},cache:'no-store'});
            const state=render(await response.json());
            if(['pending','unavailable'].includes(state)&&++attempts<6)timer=setTimeout(check,5000);
            else if(state==='pending')document.getElementById('message').textContent='付款确认仍在处理中，请稍后点击“重新查询”。';
        }catch{document.getElementById('message').textContent='暂时无法查询付款结果，请稍后重试。';}
        finally{checking=false;retry.disabled=false;}
    }
    document.getElementById('retry').onclick=()=>{attempts=0;void check();};
    if(['pending','unavailable'].includes(render(initial)))timer=setTimeout(check,5000);
})();
</script></body></html>
<?php
}
