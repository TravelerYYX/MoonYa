'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises');
const path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const http = require('node:http'), {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');

test('the complete static page compiles and registers real model-menu and dialog clicks', {timeout:45000}, async()=>{
    const backend = path.resolve(__dirname, '..');
    const temporary = path.join(os.homedir(), '.MoonYa', 'temp');
    await fsp.mkdir(temporary, {recursive:true});
    const dataRoot = await fsp.mkdtemp(path.join(temporary, 'page-boot-'));
    let server, browser, supplier;
    try {
        const frontend = path.resolve(backend, '../MoonYa-Frontend/dist');
        const rendered = spawnSync(process.execPath, [path.join(frontend, '../build.mjs')], {encoding:'utf8'});
        assert.equal(rendered.status, 0, rendered.stderr);
        const html = fs.readFileSync(path.join(frontend,'index.html'),'utf8');
        let count = 0;
        for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
            const src = /\bsrc="([^"]+)"/.exec(script[1])?.[1];
            if (src) {if(src!=='/runtime-config.js')new vm.Script(fs.readFileSync(path.join(frontend,src),'utf8'));count++;continue;}
            new vm.Script(script[2], {filename:'rendered-page-script-'+count+'.js'}); count++;
        }
        assert.ok(count > 5, 'compile all complete script blocks, including combined main modules');
        const presets = ['deepseek','kimi','glm','minimax','openai'].map(id=>({id,name:id,protocol:'openai-completions',base_url:'https://example.test/v1',models:[]}));
        const providers = [{id:'kimi',name:'Kimi',provider:'kimi',models:[
            {id:'kimi-k3',context_window:1048576,context_window_options:[300000,1048576],context_window_source:'official',supports_chat:true,supports_tools:true,supports_thinking:true,reasoning:'openai',efforts:['low','medium','high','xhigh','max'],default_effort:'medium'},
            {id:'kimi-k2.6',context_window:262144,context_window_source:'official',supports_chat:true,supports_tools:true},
            {id:'small',context_window:8192,context_window_source:'api',supports_chat:true,supports_tools:true},
            {id:'long-name',name:'kimi-k2.7-code-highspeed-with-an-extra-long-display-name',context_window:262144,context_window_source:'api',supports_chat:true,supports_tools:true},
            {id:'unknown',context_window:null,context_window_source:'unknown',supports_chat:true,supports_tools:true}
        ]}];
        const {ConversationStats} = await import('../../MoonYa-Harness/src/conversation-stats.mjs');
        const {callModel} = await import('../../MoonYa-Harness/src/model-client.mjs');
        const {estimateMessageTokens} = await import('../../MoonYa-Harness/src/conversation.mjs');
        const statsStore = new ConversationStats(path.join(dataRoot,'statistics.jsonl'));
        const actualMessages = [{role:'system',content:'Answer clearly and accurately.'},{role:'user',content:'Explain the meaning of a context window.'}];
        supplier = http.createServer(async(req,res)=>{
            req.resume();
            res.setHeader('content-type','text/event-stream');
            res.write('data: '+JSON.stringify({choices:[{delta:{role:'assistant'}}]})+'\n\n');
            await new Promise(resolve=>setTimeout(resolve,120));
            res.write('data: '+JSON.stringify({choices:[{delta:{content:'A context window holds the current input.'}}]})+'\n\n');
            await new Promise(resolve=>setTimeout(resolve,100));
            res.end('data: '+JSON.stringify({choices:[{finish_reason:'stop'}],usage:{prompt_tokens:240,prompt_cache_hit_tokens:160,prompt_cache_miss_tokens:80,completion_tokens:32}})+'\n\ndata: [DONE]\n\n');
        });
        await new Promise(resolve=>supplier.listen(0,'127.0.0.1',resolve));
        await statsStore.open('1','context-a',false);
        const actualReply = await callModel({name:'deepseek-flash',base_url:'http://127.0.0.1:'+supplier.address().port},actualMessages,'none',null,async()=>{},
            {onMetrics: record=>statsStore.record('1','context-a',record)});
        const systemTokens=estimateMessageTokens(actualMessages.slice(0,1));
        const messageTokens=estimateMessageTokens([...actualMessages.slice(1),actualReply]);
        await statsStore.record('1','context-a',{kind:'context',id:'context:fixture',model_id:'deepseek-flash',limit_tokens:1048576,
            used_tokens:systemTokens+messageTokens,system_tokens:systemTokens,tools_tokens:0,messages_tokens:messageTokens});
        const recordedStats = await statsStore.snapshot('1','context-a');
        server = http.createServer((req,res)=>{
            const url = new URL(req.url, 'http://localhost');
            url.pathname=url.pathname.replace(/^\/gateway\/(local|remote)\//,'/');
            if(url.pathname==='/runtime-config.js'){res.setHeader('content-type','text/javascript');res.end('window.MoonYaHost={backendUrl:"http://localhost/",gatewayToken:"fixture"};');return;}
            if(url.pathname==='/gateway/migration'){res.setHeader('content-type','application/json');res.end('null');return;}
            if (url.pathname === '/') {res.setHeader('content-type','text/html; charset=utf-8');res.end(html);return;}
            if (url.pathname === '/statistics.php') {
                void statsStore.snapshot('1',url.searchParams.get('client_chat_id'),{has_history:url.searchParams.get('has_history')==='1'}).then(data=>{
                    res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data}));
                });return;
            }
            if (url.pathname.endsWith('.php')) {
                if (url.pathname === '/admin/api/updates.php') {
                    res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data:null}));return;
                }
                let data = {};
                if (url.pathname === '/model_api.php') data={providers,presets};
                else if (url.pathname === '/user_auth.php') data={logged_in:true,user:{id:1,username:'fixture',real_name:'Fixture'}};
                else if (url.pathname === '/conversation_api.php') data={conversations:[],messages:[]};
                else if (url.pathname === '/api/work_projects.php') data={projects:[]};
                res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data}));return;
            }
            const target = path.resolve(frontend, '.'+decodeURIComponent(url.pathname));
            if (!target.startsWith(frontend+path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {res.writeHead(404);res.end();return;}
            if (target.endsWith('.js')) res.setHeader('content-type','text/javascript; charset=utf-8');
            if (target.endsWith('.css')) res.setHeader('content-type','text/css; charset=utf-8');
            res.end(fs.readFileSync(target));
        });
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        browser = await chromium.launch({channel:'chrome',headless:true});
        const context = await browser.newContext({viewport:{width:1400,height:1000}});
        await context.route('https://**/*', route=>route.abort());
        const page = await context.newPage(), errors=[];
        await page.addInitScript(()=>localStorage.setItem('moonya.context.limit.v1','300000'));
        page.setDefaultTimeout(5000);page.on('pageerror', error=>errors.push(error.message));
        const initialized = page.waitForResponse(response=>response.url().includes('conversation_api.php?action=list'));
        await page.goto('http://127.0.0.1:'+server.address().port, {waitUntil:'domcontentloaded'});
        await initialized;
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        await page.waitForFunction(()=>!!window.renderMoonYaAgentSettings && !!window.MoonYaModels);
        await page.waitForFunction(()=>document.querySelectorAll('[data-custom-model]').length>=5);
        const settleMenus = async()=>page.waitForFunction(()=>['agentSettingsPopover','agentModelMenu'].every(id=>!document.getElementById(id).getAnimations().length));
        const screenshots=path.resolve(backend,'..','artifacts','model-context');
        await fsp.mkdir(screenshots,{recursive:true});
        assert.equal(await page.evaluate(()=>contextLimitTokens),1048576,'old global preference is ignored');
        assert.equal(await page.locator('.context-limit-option').count(),0);
        let menu, toggle;
        if (await page.locator('#agentSettingsStatus').isVisible()) {
            await page.locator('#agentSettingsStatus').click();
            await settleMenus();
            assert.equal(await page.locator('#agentAdvancedPanel .agent-context-section').isVisible(),false,'context length is folded into advanced settings');
            assert.equal(await page.locator('#agentSettingsPopover select').count(),0,'reasoning menu contains no native select');
            assert.doesNotMatch(await page.locator('#agentSettingsPopover').textContent(),/\p{Extended_Pictographic}/u);
            const builtInSlider = page.locator('#reasoningEffortSlider');
            await page.locator('#agentSettingsStatus').focus();
            await page.locator('#agentSettingsPopover').screenshot({path:path.join(screenshots,'reasoning-high.png')});
            await builtInSlider.focus(); await page.keyboard.press('End');
            assert.equal(await page.locator('#agentSettingsCaptionEffort').textContent(),'Ultra');
            assert.equal(await page.evaluate(()=>reasoningEffort),'ultra');
            assert.equal(await page.locator('#agentSettingsPopover').getAttribute('data-highest'),'true');
            const particle = page.locator('.agent-effort-slider-wrap .effort-slider-particle').first();
            assert.equal(await particle.evaluate(node=>getComputedStyle(node).animationPlayState),'running');
            const firstParticlePosition = await particle.evaluate(node=>getComputedStyle(node).transform);
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
            assert.notEqual(await particle.evaluate(node=>getComputedStyle(node).transform),firstParticlePosition,'highest effort particles travel across the track');
            await page.locator('#agentSettingsStatus').focus();
            await page.waitForFunction(()=>Number(document.querySelector('.agent-effort-slider-wrap .effort-spring-slider').style.getPropertyValue('--slider-position'))>.999);
            await page.locator('#agentSettingsPopover').screenshot({path:path.join(screenshots,'reasoning-ultra.png')});
            const fastestDuration = await particle.evaluate(node=>parseFloat(getComputedStyle(node).animationDuration));
            await builtInSlider.focus(); await page.keyboard.press('ArrowLeft');
            assert.equal(await page.locator('#agentSettingsCaptionEffort').textContent(),'Max');
            assert.equal(await page.locator('#agentSettingsPopover').getAttribute('data-flow'),'normal');
            assert.equal(await particle.evaluate(node=>getComputedStyle(node).animationPlayState),'running','penultimate effort also has flowing particles');
            const penultimateDuration = await particle.evaluate(node=>parseFloat(getComputedStyle(node).animationDuration));
            assert.ok(penultimateDuration>fastestDuration,'highest effort particles move faster than penultimate effort');
            assert.equal(await particle.evaluate(node=>parseFloat(node.style.getPropertyValue('--flight-duration'))),penultimateDuration,'penultimate effort retains the original speed');
            await page.locator('#agentEffortReset').click();
            assert.equal(await page.evaluate(()=>reasoningEffort),'high');
            assert.equal(await particle.evaluate(node=>getComputedStyle(node).animationPlayState),'paused','leaving highest effort stops the particle motion');
            const spring = page.locator('#agentSettingsPopover .agent-effort-slider-wrap .effort-spring-slider');
            const sliderBounds = await spring.boundingBox();
            await page.mouse.move(sliderBounds.x+sliderBounds.width-13,sliderBounds.y+14);
            await page.mouse.down();
            await page.waitForFunction(()=>{const position=Number(document.querySelector('.agent-effort-slider-wrap .effort-spring-slider').style.getPropertyValue('--slider-position'));return position>.5&&position<1;});
            await page.mouse.move(sliderBounds.x+13,sliderBounds.y+14,{steps:12});
            await page.mouse.up();
            await page.waitForFunction(()=>Number(document.querySelector('#reasoningEffortSlider').value)===0);
            await page.waitForFunction(()=>Number(document.querySelector('.agent-effort-slider-wrap .effort-spring-slider').style.getPropertyValue('--slider-position'))<.001);
            assert.equal(await page.evaluate(()=>reasoningProfile),'light','drag snaps to a legal Work effort');
            await page.locator('#agentEffortReset').click();
            await page.locator('#agentSettingsStatus').click();
            assert.equal(await page.locator('#agentSettingsPopover').getAttribute('aria-hidden'),'true');
            await page.waitForFunction(()=>getComputedStyle(document.getElementById('agentSettingsPopover')).visibility==='hidden');
            await page.locator('#agentSettingsStatus').click();
            await settleMenus();
            await page.locator('#agentAdvancedToggle').click();
            await page.locator('#agentSettingsPopover .context-picker-trigger').click();
            await page.waitForFunction(()=>[document.getElementById('agentAdvancedPanel'),document.querySelector('#agentSettingsPopover .context-picker-menu')].every(node=>!node.getAnimations().length));
            await page.locator('#agentSettingsPopover').screenshot({path:path.join(screenshots,'reasoning-advanced-context.png')});
            await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(()=>contextLimitTokens),300000,'custom context picker supports keyboard selection');
            await page.locator('#agentSettingsPopover .context-picker-trigger').click();
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#agentAdvancedToggle').getAttribute('aria-expanded'),'true','Escape closes only the inner picker');
            assert.equal(await page.locator('#agentSettingsPopover .context-picker-trigger').getAttribute('aria-expanded'),'false');
            await page.evaluate(()=>MoonYaModelContext.select(1048576));
            await page.locator('#agentModelMenuToggle').click();
            menu=page.locator('#agentModelMenu');toggle=page.locator('#agentModelMenuToggle');
            await settleMenus();
            assert.equal(Math.round((await menu.boundingBox()).width),256);
            await page.locator('#agentModelMenu .custom-model-configure').click();
        } else {
            await page.locator('#deepseekModelBtn').click();
            menu=page.locator('#deepseekModelDropdown');toggle=page.locator('#deepseekModelBtn');
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            assert.equal(Math.round((await menu.boundingBox()).width),256);
            await page.locator('#deepseekModelDropdown .custom-model-configure').click();
        }
        await page.waitForFunction(()=>document.querySelector('#cmProvider')?.options.length===5);
        await page.locator('#cmCustomTab').click();
        await page.locator('#cmId').fill('click_validation');
        assert.equal(await page.locator('#cmId').inputValue(), 'click_validation');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.custom-model-overlay').isVisible(), true);
        await page.locator('#cmClose').click();
        assert.equal(await page.locator('.custom-model-overlay').isVisible(), false);
        const reopen = async()=>{
            if(menu===undefined)return;
            if(await menu.evaluate(node=>node.hidden || !node.getClientRects().length || getComputedStyle(node).visibility==='hidden')) {
                if(await page.locator('#agentSettingsStatus').getAttribute('aria-expanded')==='false') {
                    await page.locator('#agentSettingsStatus').click();
                }
                if(toggle===undefined)return;
                if(await page.locator('#agentAdvancedToggle').getAttribute('aria-expanded')==='false')await page.locator('#agentAdvancedToggle').click();
                await toggle.click();
                await settleMenus();
            }
        };
        await reopen();
        assert.equal(await menu.locator('[data-custom-model*="unknown"]').isDisabled(),true);
        assert.match(await menu.locator('[data-custom-model*="unknown"]').textContent(),/待配置/);
        assert.match(await menu.locator('[data-custom-model*="long-name"]').getAttribute('title'),/extra-long-display-name/);
        await menu.screenshot({path:path.join(screenshots,'model-menu-desktop.png')});
        const desktopBounds=await menu.boundingBox();
        assert.ok(desktopBounds.x>=0&&desktopBounds.x+desktopBounds.width<=1400&&desktopBounds.y>=0&&desktopBounds.y+desktopBounds.height<=1000,JSON.stringify(desktopBounds));
        await menu.locator('[data-custom-model*="kimi-k2.6"]').click();
        assert.equal(await page.evaluate(()=>contextLimitTokens),262144);
        assert.match(await page.locator('.context-model-length').first().getAttribute('title'),/262,144/);
        await reopen();await menu.locator('[data-custom-model*="small"]').click();
        assert.equal(await page.evaluate(()=>contextLimitTokens),8192);
        await page.evaluate(()=>MoonYaModels.setReference({provider_id:'kimi',model_id:'unknown'}));
        assert.equal(await page.evaluate(()=>MoonYaModels.ready()),false);
        assert.match(await page.locator('#crtNums').textContent(),/待配置/);
        await page.evaluate(()=>MoonYaModels.setReference(null));
        assert.equal(await page.evaluate(()=>contextLimitTokens),1048576);
        await page.setViewportSize({width:390,height:760});
        await reopen();
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const bounds=await menu.boundingBox();
        assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y>=0&&bounds.y+bounds.height<=760,JSON.stringify(bounds));
        await menu.screenshot({path:path.join(screenshots,'model-menu-mobile.png')});
        await page.setViewportSize({width:320,height:640});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const resized=await menu.boundingBox();
        assert.ok(resized.x>=0&&resized.x+resized.width<=320&&resized.y>=0&&resized.y+resized.height<=640,JSON.stringify(resized));
        await page.locator('.message-input:visible').fill('输入响应验证');
        assert.equal(await page.locator('.message-input:visible').inputValue(), '输入响应验证');
        await page.setViewportSize({width:1400,height:1000});
        await page.evaluate(()=>{
            currentChatId='context-a';activateConversationRuntime(currentChatId);
            MoonYaModels.setReference({provider_id:'kimi',model_id:'kimi-k3'});
        });
        assert.equal(await page.evaluate(()=>MoonYaModelContext.value()),1048576);
        assert.deepEqual(await page.evaluate(()=>MoonYaModelContext.choices()),[300000,1048576]);
        if(await page.locator('#agentSettingsStatus').getAttribute('aria-expanded')!=='true')await page.locator('#agentSettingsStatus').click();
        if(await page.locator('#agentAdvancedToggle').getAttribute('aria-expanded')!=='true')await page.locator('#agentAdvancedToggle').click();
        await page.locator('#agentSettingsPopover .context-picker-trigger').click();
        await page.locator('#agentSettingsPopover [data-context-tokens="300000"]').click();
        const customSlider=page.locator('#agentSettingsPopover .cm-session-effort input[type=range]');
        assert.deepEqual(JSON.parse(await customSlider.getAttribute('data-effort-choices')),['auto','none','low','medium','high','xhigh','max']);
        await customSlider.focus();await page.keyboard.press('End');await page.keyboard.press('ArrowLeft');
        assert.equal(await customSlider.getAttribute('aria-valuetext'),'超高');
        assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),'xhigh');
        assert.equal(await page.locator('#deepseekModelDropdown .cm-session-effort input[type=range]').getAttribute('aria-valuetext'),'超高','Chat and Work controls show the same effort');
        assert.equal(await page.evaluate(()=>contextLimitTokens),300000);
        await page.evaluate(()=>{ currentChatId='context-b';activateConversationRuntime(currentChatId); });
        assert.equal(await page.evaluate(()=>contextLimitTokens),1048576,'new conversation defaults to the maximum');
        assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),'auto','new conversations use model defaults');
        await page.evaluate(()=>{ currentChatId='context-a';activateConversationRuntime(currentChatId); });
        assert.equal(await page.evaluate(()=>contextLimitTokens),300000);
        assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),'xhigh');
        await page.evaluate(()=>{ const runtime=getConversationRuntime(currentChatId,messagesContainer); runtime.mode='chat';runtime.composer.agentMode=false;renderConversationRuntimeComposer(runtime); });
        assert.equal(await page.evaluate(()=>contextLimitTokens),300000,'Chat and Work share the conversation choice');
        await page.evaluate(()=>{ const runtime=getConversationRuntime(currentChatId,messagesContainer);runtime.mode='work';runtime.composer.agentMode=true;renderConversationRuntimeComposer(runtime); });
        await page.waitForFunction(async()=>!!(await MoonYaHistoryStore.loadDraft(CHAT_HISTORY_KEY,'context-a'))?.composer?.contextSelections);
        await page.reload();await page.waitForFunction(()=>!!MoonYaModels && document.querySelectorAll('[data-custom-model]').length>=5);
        await page.evaluate(async()=>{ currentChatId='context-a';const runtime=activateConversationRuntime(currentChatId);await restoreConversationDraft(runtime); });
        assert.equal(await page.evaluate(()=>contextLimitTokens),300000,'IndexedDB draft restores the selected context after reload');
        assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),'xhigh');
        if(await page.locator('#agentSettingsStatus').getAttribute('aria-expanded')!=='true')await page.locator('#agentSettingsStatus').click();
        await customSlider.focus();await page.keyboard.press('Home');
        const steps=[['none','关闭思考'],['low','低'],['medium','中'],['high','高'],['xhigh','超高'],['max','极致']];
        for(const [effort,label] of steps){
            await page.keyboard.press('ArrowRight');
            assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),effort);
            assert.equal(await customSlider.getAttribute('aria-valuetext'),label);
        }
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),'max','slider stops at the highest supported effort');
        await page.setViewportSize({width:390,height:760});
        const effortBounds=await customSlider.boundingBox();
        assert.ok(effortBounds.x>=0&&effortBounds.x+effortBounds.width<=390,'slider fits narrow viewport');
        await page.locator('#agentSettingsPopover').screenshot({path:path.join(screenshots,'effort-slider-mobile.png')});
        await page.setViewportSize({width:1400,height:1000});
        await page.evaluate(()=>{
            const model=MoonYaModels.selected();model.efforts=['medium','xhigh'];model.reasoning_required=true;MoonYaModels.syncUi();
        });
        assert.deepEqual(JSON.parse(await customSlider.getAttribute('data-effort-choices')),['auto','medium','xhigh'],'only supported levels appear, and required thinking has no off step');
        await customSlider.focus();await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),'medium');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),'xhigh');
        await page.evaluate(()=>{const model=MoonYaModels.selected();model.efforts=[];model.reasoning_required=false;model.allow_thinking_off=true;MoonYaModels.syncUi();});
        assert.equal(await customSlider.isVisible(),false,'models with no effort levels use only a switch');
        const thinkingSwitch=page.locator('#agentSettingsPopover .cm-thinking-switch input');
        await thinkingSwitch.uncheck();assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),'none');
        await thinkingSwitch.check();assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),'high');
        await page.locator('#agentSettingsPopover .cm-effort-auto').click();assert.equal(await page.evaluate(()=>MoonYaModels.effort('high')),'auto');
        await page.evaluate(()=>{const model=MoonYaModels.selected();model.reasoning_required=true;MoonYaModels.syncUi();});
        assert.equal(await thinkingSwitch.isDisabled(),true);
        await page.evaluate(()=>{const model=MoonYaModels.selected();model.supports_thinking=false;MoonYaModels.syncUi();});
        assert.equal(await thinkingSwitch.isDisabled(),true);
        assert.equal(await thinkingSwitch.isChecked(),false);
        await page.evaluate(()=>{
            const model=MoonYaModels.selected();model.context_window_options=[1048576];MoonYaModels.syncUi();
        });
        assert.equal(await page.evaluate(()=>contextLimitTokens),1048576,'removed choices return to maximum');
        await page.emulateMedia({reducedMotion:'reduce'});
        await page.waitForFunction(()=>!document.getElementById('toast')||getComputedStyle(document.getElementById('toast')).opacity==='0');
        // Statistics are supplied by an actual model-client request to the local test provider.
        await page.keyboard.press('Escape');
        await page.evaluate(async()=>{
            MoonYaModels.setReference(null,false);
            const history=getChatHistory();
            if(!history.some(chat=>chat.id==='context-a'))history.push({id:'context-a',mode:'chat',storage:'local',messages:[]});
            await saveChatHistory(history);
            currentChatId='context-a';currentDbConversationId=null;isAgentMode=false;
            MoonYaModelContext.update(MoonYaModelContext.builtin());
            await MoonYaContextRing.refresh();
        });
        const popup=page.locator('#contextRingTooltip'), ring=page.locator('#contextRingTrigger');
        await page.waitForFunction(()=>document.getElementById('crtTokenTotal').textContent==='272 tok');
        assert.equal(await popup.isVisible(),false,'hover does not open the detail panel');
        await ring.hover();assert.equal(await popup.isVisible(),false);
        await ring.focus();await page.keyboard.press('Enter');
        assert.equal(await popup.isVisible(),true);
        assert.equal(await ring.getAttribute('aria-expanded'),'true');
        const tokenSection=popup.locator('[data-stat-section="tokens"]');
        const timingSection=popup.locator('[data-stat-section="timing"]');
        const contextSection=popup.locator('[data-stat-section="context"]');
        assert.notEqual(await tokenSection.getAttribute('open'),null,'all statistic sections start expanded');
        assert.notEqual(await timingSection.getAttribute('open'),null);
        assert.notEqual(await contextSection.getAttribute('open'),null);
        assert.equal(await page.locator('#crtTokenTotal').textContent(),String(recordedStats.token_usage.total)+' tok');
        assert.equal(await page.locator('#crtCacheHit').textContent(),'66.7%');
        assert.equal(await page.locator('#crtUncachedInput').textContent(),'80 tok');
        assert.match(await page.locator('#crtNums').textContent(),/^~.* \/ 1M$/);
        assert.equal(await popup.locator('#crtCacheWriteRow').isVisible(),false);
        assert.doesNotMatch(await popup.textContent(),/\p{Extended_Pictographic}/u);
        const statsScreenshots=path.resolve(backend,'..','artifacts','context-statistics');
        await fsp.mkdir(statsScreenshots,{recursive:true});
        await page.waitForFunction(()=>!document.getElementById('toast')||getComputedStyle(document.getElementById('toast')).opacity==='0');
        await popup.screenshot({path:path.join(statsScreenshots,'default.png')});
        await tokenSection.locator('summary').click();
        await timingSection.locator('summary').click();
        assert.equal(await popup.isVisible(),true,'clicking content never toggles the whole panel');
        assert.equal(await tokenSection.getAttribute('open'),null,'clicking a summary folds that section');
        await page.waitForFunction(()=>getChatHistory().find(chat=>chat.id==='context-a')?.statisticsExpanded?.timing===false);
        await page.waitForFunction(()=>!document.getElementById('toast')||getComputedStyle(document.getElementById('toast')).opacity==='0');
        await popup.screenshot({path:path.join(statsScreenshots,'folded.png')});
        await tokenSection.locator('summary').click();
        await timingSection.locator('summary').click();
        await page.waitForFunction(()=>getChatHistory().find(chat=>chat.id==='context-a')?.statisticsExpanded?.timing===true);
        await page.waitForFunction(()=>!document.getElementById('toast')||getComputedStyle(document.getElementById('toast')).opacity==='0');
        await popup.screenshot({path:path.join(statsScreenshots,'expanded.png')});
        await page.keyboard.press('Escape');
        assert.equal(await popup.isVisible(),false);assert.equal(await ring.evaluate(node=>node===document.activeElement),true);
        await ring.click();assert.notEqual(await tokenSection.getAttribute('open'),null);
        await page.mouse.click(5,5);assert.equal(await popup.isVisible(),false);
        await ring.click();await ring.click();assert.equal(await popup.isVisible(),false);
        const newest={...recordedStats,revision:recordedStats.revision+10,token_usage:{...recordedStats.token_usage,total:999}};
        await page.evaluate(data=>MoonYaContextRing.applyStatistics(data,'context-a'),newest);
        await page.evaluate(data=>MoonYaContextRing.applyStatistics(data,'context-a'),recordedStats);
        assert.equal(await page.locator('#crtTokenTotal').textContent(),'999 tok','an older snapshot cannot override a newer stream revision');
        await page.evaluate(data=>MoonYaContextRing.applyStatistics({...data,client_chat_id:'other-chat'},'other-chat'),newest);
        assert.equal(await page.locator('#crtTokenTotal').textContent(),'999 tok','another conversation cannot supply statistics');
        await page.reload();await page.waitForFunction(()=>!!window.MoonYaContextRing&&!!window.MoonYaModels);
        await page.evaluate(async()=>{currentChatId='context-a';currentDbConversationId=null;isAgentMode=false;MoonYaModels.setReference(null,false);MoonYaModelContext.update(MoonYaModelContext.builtin());await MoonYaContextRing.refresh();});
        await ring.click();assert.notEqual(await tokenSection.getAttribute('open'),null,'IndexedDB restores the conversation folding choice');
        await page.setViewportSize({width:320,height:620});
        await page.waitForFunction(()=>{const r=document.getElementById('contextRingTooltip').getBoundingClientRect();return r.x>=8&&r.right<=innerWidth-8&&r.top>=8&&r.bottom<=innerHeight-8;});
        await popup.screenshot({path:path.join(statsScreenshots,'narrow.png')});
        await page.locator('#crtClose').click();assert.equal(await popup.isVisible(),false);
        await page.setViewportSize({width:1400,height:1000});
        await page.evaluate(async()=>{currentChatId='context-b';currentDbConversationId=null;isAgentMode=true;await MoonYaContextRing.refresh();});
        await ring.click();assert.notEqual(await tokenSection.getAttribute('open'),null,'another conversation also starts expanded');
        assert.notEqual(await timingSection.getAttribute('open'),null);assert.notEqual(await contextSection.getAttribute('open'),null);
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close();
        if(supplier){supplier.closeAllConnections();await new Promise(resolve=>supplier.close(resolve));}
        if (server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
        assert.ok(dataRoot.startsWith(temporary+path.sep));
        await fsp.rm(dataRoot, {recursive:true,force:true});
    }
});
