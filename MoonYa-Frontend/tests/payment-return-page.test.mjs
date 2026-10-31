import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const repo=fileURLToPath(new URL('../../',import.meta.url));

test('payment return page renders success on desktop/mobile and automatically confirms pending results',async()=>{
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const server=spawn(process.env.PHP_BIN||'php',['-S',`127.0.0.1:${port}`,join(repo,'MoonYa-Backend/tests/payment_return_page_router.php')],{cwd:repo,windowsHide:true,env:{...process.env,MOONYA_PAYMENT_RETURN_PAGE_TEST:'1'}});
  let errors='';server.stderr.on('data',data=>errors+=data);let browser;
  try{
    const base=`http://127.0.0.1:${port}`;let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,errors);
    browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const scriptErrors=[];page.on('pageerror',error=>scriptErrors.push(error.message));
    const artifacts=join(repo,'MoonYa-Frontend/artifacts/payment');await mkdir(artifacts,{recursive:true});
    await page.goto(base+'/?state=paid');assert.equal(await page.locator('h1').textContent(),'付款成功');assert.equal(await page.locator('#open').getAttribute('href'),'moonya://payment/return?order_no=MYfixture0000000001');assert.equal(await page.locator('#retry').isVisible(),false);
    await page.screenshot({path:join(artifacts,'return-success-desktop.png')});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(artifacts,'return-success-mobile.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.goto(base+'/?state=invalid');assert.equal(await page.locator('#open').isVisible(),false);assert.equal(await page.locator('h1').textContent(),'无法确认付款');
    await page.goto(base+'/?state=pending');assert.equal(await page.locator('#open').isVisible(),false);
    await page.route(base+'/?state=pending',route=>route.request().headers().accept==='application/json'?route.fulfill({contentType:'application/json',body:JSON.stringify({state:'paid',open_url:'moonya://payment/return?order_no=MYfixture0000000001'})}):route.continue());
    await page.waitForFunction(()=>document.querySelector('h1').textContent==='付款成功',{},{timeout:10000});assert.equal(await page.locator('#open').isVisible(),true);assert.equal(await page.locator('#retry').isVisible(),false);assert.deepEqual(scriptErrors,[]);
  }finally{if(browser)await browser.close();server.kill();await new Promise(resolve=>server.once('exit',resolve));}
});
