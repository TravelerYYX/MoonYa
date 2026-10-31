'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const {randomBytes} = require('node:crypto'), {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events'), net = require('node:net');
const {chromium} = require('playwright-core');

test('admin credits: isolated service, authenticated HTTP and real dashboard interactions', {timeout:120000}, async () => {
    const backend = path.resolve(__dirname, '..');
    const root = path.join(os.tmpdir(), 'moonya-credits-http-' + randomBytes(8).toString('hex'));
    await fs.mkdir(root);
    let database, server, browser, serverErrors = '';
    const fixture = (action, ...args) => {
        const result = spawnSync('php', [path.join(__dirname, 'admin_credits_fixture.php'), action, root, ...(database ? [database] : []), ...args], {encoding:'utf8', timeout:45000});
        assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
        return result.stdout.trim();
    };
    try {
        database = JSON.parse(fixture('create')).database;
        const service = JSON.parse(fixture('service'));
        assert.ok(service.checks >= 40);
        const token = fixture('auth'), ordinary = fixture('auth', 'ordinary-admin'), denied = fixture('auth', 'no-permission');
        const socket = net.createServer();
        await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
        const port = socket.address().port;
        await new Promise(resolve => socket.close(resolve));
        const origin = 'http://127.0.0.1:' + port;
        server = spawn('php', ['-S', '127.0.0.1:' + port, '-t', backend, path.join(__dirname, 'admin_credits_router.php')], {
            env:{...process.env, MOONYA_CREDITS_TEST_DATABASE:database, MOONYA_CREDITS_TEST_ROOT:root}, stdio:['ignore','pipe','pipe']
        });
        server.stderr.on('data', chunk => { serverErrors += chunk.toString(); });
        server.stdout.resume();
        for (let n = 0; n < 100; n++) {
            try { if ((await fetch(origin + '/ready')).ok) break; } catch (_) {}
            assert.equal(server.exitCode, null, serverErrors);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        const api = async (query, {method='GET', body, auth=token, raw} = {}) => {
            const response = await fetch(origin + '/admin/api/users.php?' + query, {
                method, headers:{'Content-Type':'application/json', ...(auth ? {Authorization:'Bearer ' + auth} : {})},
                body:raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body))
            });
            return {status:response.status, json:await response.json()};
        };
        const get = user => 'action=membership&user_id=' + user;
        const post = user => 'action=adjust_credits&user_id=' + user;
        assert.equal((await api(get(2), {auth:null})).status, 401);
        assert.equal((await api(post(2), {method:'POST', body:{delta:'1', reason:'未登录'}, auth:null})).status, 401);
        assert.equal((await api(get(2), {auth:denied})).status, 403);
        assert.equal((await api(post(2), {method:'POST', body:{delta:'1', reason:'无权限'}, auth:denied})).status, 403);
        assert.equal((await api(get(2), {auth:ordinary})).status, 200);
        const initial = await api(get(2));
        assert.equal(initial.json.data.account.balance, '100.000025');
        assert.equal(initial.json.data.ledger.items.length, 20);
        assert.equal((await api(get(2) + '&page=2')).json.data.ledger.items.length, 6);
        const added = await api(post(2), {method:'POST', body:{delta:'2.5', reason:'  后台增加  '}, auth:ordinary});
        assert.equal(added.status, 200);
        assert.equal(added.json.data.account.balance, '102.500025');
        const inspect = JSON.parse(fixture('inspect'));
        assert.deepEqual(JSON.parse(inspect.ledger[0].details_json), {admin_id:3, reason:'后台增加'});
        assert.deepEqual(JSON.parse(inspect.logs[0].details), {delta:'2.5', reason:'后台增加'});
        assert.equal((await api(post(2), {method:'POST', body:{delta:'-102.500025', reason:'扣至零'}})).json.data.account.balance, '0.000000');
        const unchanged = JSON.parse(fixture('inspect'));
        const badInputs = [
            {delta:'-0.000001',reason:'超过余额'}, {delta:'0',reason:'零值'}, {delta:'-0.000000',reason:'零值'},
            {delta:'1.0000001',reason:'超精度'}, {delta:'1e2',reason:'指数'}, {delta:'1000000000',reason:'上限'},
            {delta:[],reason:'类型'}, {delta:{},reason:'类型'}, {delta:true,reason:'类型'},
            {delta:'1',reason:[]}, {delta:'1',reason:42}, {delta:'1',reason:null},
            {delta:'1',reason:'  '}, {delta:'1',reason:'字'.repeat(501)}, {reason:'缺失数量'}, {delta:'1'}
        ];
        for (const body of badInputs) {
            const result = await api(post(2), {method:'POST', body});
            assert.equal(result.status, 400, JSON.stringify(body));
            assert.equal(result.json.success, false);
        }
        for (const raw of ['{', 'null', '[]', '"text"', '{}']) assert.equal((await api(post(2), {method:'POST', raw})).status, 400);
        for (const query of ['action=membership', get('0'), get('-1'), get('2abc'), get('2.5'), 'action=membership&user_id[]=2', get(2) + '&page=0', get(2) + '&page[]=1']) {
            assert.equal((await api(query)).status, 400, query);
        }
        for (const user of [3,4,999]) {
            const status = user === 999 ? 404 : 400;
            assert.equal((await api(get(user))).status, status);
            assert.equal((await api(post(user), {method:'POST',body:{delta:'1',reason:'不可用用户'}})).status, status);
        }
        assert.equal((await api(post(2))).status, 405);
        assert.equal((await api(get(2), {method:'POST',body:{}})).status, 405);
        assert.deepEqual(JSON.parse(fixture('inspect')), unchanged, 'Failed HTTP requests never update balance, ledger or audit');
        assert.equal((await api(post(2), {method:'POST', body:{delta:'1',reason:'浏览器测试准备'}})).json.data.account.balance, '1.000000');
        // Existing membership operations continue accepting the same payload.
        const grant = await api('action=set_membership&user_id=1', {method:'POST',body:{plan_id:initial.json.data.plans[1].id,expires_at:null}});
        assert.equal(grant.status, 200);
        assert.equal(grant.json.data.account.balance, '300.000000');

        browser = await chromium.launch({channel:'chrome',headless:true});
        const context = await browser.newContext({viewport:{width:1440,height:1000}});
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await context.addInitScript(({token}) => {
            localStorage.setItem('adminToken',token);
            localStorage.setItem('adminInfo',JSON.stringify({id:1,username:'fixture',role:'super_admin'}));
        }, {token});
        const page = await context.newPage(), errors = [];
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/admin/dashboard.php?section=users');
        await page.waitForSelector('[data-credits-user]');
        assert.equal(await page.locator('[data-credits-user="3"]').count(), 0);
        await page.evaluate(() => loadUsers(1,{id:'2'}));
        await page.locator('[data-credits-user="2"]').click();
        await page.waitForSelector('#ucBalance');
        assert.equal(await page.locator('#ucBalance').textContent(), '1');
        assert.ok((await page.locator('#userCreditsPanel').textContent()).includes('<积分> & "测试"'));
        assert.equal(await page.locator('#ucLedger tr').count(), 20);
        await page.locator('#ucNext').click();
        await page.waitForFunction(() => document.getElementById('ucPages').textContent.includes('第 2 页'));
        assert.equal(await page.locator('#ucPrev').isEnabled(), true);
        await page.locator('#ucAmount').fill('0');
        await page.locator('#ucReason').fill('不能为零');
        await page.locator('#ucSubmit').click();
        await page.waitForFunction(() => document.getElementById('ucMessage').textContent.includes('大于零'));
        let attempts = 0;
        await page.route('**/admin/api/users.php?action=adjust_credits*', async route => {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 250));
            await route.continue();
        });
        await page.locator('#ucAmount').fill('0.000001');
        await page.locator('#ucReason').fill('  页面最小精度  ');
        await page.locator('#ucSubmit').click();
        assert.equal(await page.locator('#ucSubmit').isDisabled(), true);
        assert.equal(await page.locator('#ucDirection').isDisabled(), true);
        await page.evaluate(() => document.getElementById('ucForm').dispatchEvent(new Event('submit',{cancelable:true})));
        await page.waitForFunction(() => document.getElementById('ucMessage').textContent.includes('积分已调整成功，'));
        assert.equal(attempts, 1, 'Repeated submit while pending makes one request');
        assert.equal(await page.locator('#ucBalance').textContent(), '1.000001');
        assert.ok((await page.locator('#ucPages').textContent()).includes('第 1 页'));
        assert.ok((await page.locator('#ucLedger tr').first().textContent()).includes('+0.000001'));
        assert.ok((await page.locator('#usersTableBody').textContent()).includes('1.000001 积分'));
        assert.deepEqual(await page.evaluate(() => ({page:currentPage,filters:currentFilters})), {page:1,filters:{id:'2'}});
        assert.equal(await page.locator('#ucAmount').inputValue(), '');
        await page.locator('#ucDirection').selectOption('subtract');
        await page.locator('#ucAmount').fill('2');
        await page.locator('#ucReason').fill('余额不足');
        await page.locator('#ucSubmit').click();
        await page.waitForFunction(() => document.getElementById('ucMessage').textContent.includes('超出允许范围'));
        assert.equal(await page.locator('#ucAmount').inputValue(), '2');
        assert.equal(await page.locator('#ucReason').inputValue(), '余额不足');
        assert.equal(await page.locator('#ucSubmit').isEnabled(), true);
        assert.equal(await page.locator('#ucBalance').textContent(), '1.000001');
        await page.locator('#ucAmount').fill('1.000001');
        await page.locator('#ucReason').fill('页面扣至零');
        await page.locator('#ucSubmit').click();
        await page.waitForFunction(() => document.getElementById('ucBalance').textContent === '0');
        await page.waitForFunction(() => !document.getElementById('ucSubmit').disabled);
        assert.ok((await page.locator('#ucLedger tr').first().textContent()).includes('-1.000001'));
        // A committed mutation followed by a failed refresh must never be automatically retried.
        await page.locator('#ucDirection').selectOption('add');
        await page.locator('#ucAmount').fill('1');
        await page.locator('#ucReason').fill('刷新异常');
        await page.route('**/admin/api/users.php?action=membership*', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:'fixture refresh failure'})}));
        await page.locator('#ucSubmit').click();
        await page.waitForFunction(() => document.getElementById('ucMessage').textContent.includes('积分已调整成功，但刷新失败'));
        assert.equal(await page.locator('#ucBalance').textContent(), '1');
        assert.equal(await page.locator('#ucAmount').inputValue(), '');
        assert.equal(attempts, 4);
        await page.unroute('**/admin/api/users.php?action=membership*');
        await page.locator('#ucRefresh').click();
        await page.waitForFunction(() => document.getElementById('ucMessage').textContent === '余额和流水已刷新');
        assert.ok((await page.locator('#ucLedger tr').first().textContent()).includes('刷新异常'));
        await page.locator('#ucClose').click();
        await page.getByRole('button',{name:'会员与积分',exact:true}).click();
        await page.waitForSelector('#umAdjust');
        assert.equal(await page.locator('#umGrant').count(), 1);
        await page.getByRole('button',{name:'关闭',exact:true}).click();
        await page.locator('[data-credits-user="2"]').click();
        await page.waitForSelector('#ucBalance');
        assert.equal(await page.locator('#ucBalance').textContent(), '1');
        await page.screenshot({path:path.join(root,'credits-dialog.png'),fullPage:true,animations:'disabled'});
        const desktopLayout = await page.locator('#userCreditsPanel').evaluate(panel => {
            const rect = panel.getBoundingClientRect();
            return {top:rect.top,bottom:rect.bottom,bodyDisplay:getComputedStyle(panel.querySelector('.modal-body')).display};
        });
        assert.equal(desktopLayout.bodyDisplay, 'block');
        assert.ok(desktopLayout.top >= 0 && desktopLayout.bottom <= 1000);
        await page.setViewportSize({width:390,height:844});
        const mobileLayout = await page.locator('#userCreditsPanel').evaluate(panel => {
            const rect = panel.getBoundingClientRect(), footer = panel.querySelector('.modal-footer').getBoundingClientRect();
            return {left:rect.left,right:rect.right,bottom:rect.bottom,footerBottom:footer.bottom,formColumns:getComputedStyle(document.getElementById('ucForm')).gridTemplateColumns};
        });
        assert.ok(mobileLayout.left >= 0 && mobileLayout.right <= 390 && mobileLayout.bottom <= 844 && mobileLayout.footerBottom <= 844);
        assert.equal(mobileLayout.formColumns.split(' ').length, 1);
        await page.screenshot({path:path.join(root,'credits-dialog-mobile.png'),fullPage:true,animations:'disabled'});
        await page.locator('#ucClose').click();
        await page.setViewportSize({width:1440,height:1000});
        await page.evaluate(() => loadUsers(2,{username:'credit-fixture'}));
        await page.locator('[data-credits-user]').first().click();
        await page.waitForSelector('#ucAmount');
        await page.locator('#ucAmount').fill('1');
        await page.locator('#ucReason').fill('保留第二页及筛选');
        // The list API returns errors as data rather than throwing; detect refresh failures too.
        await page.route('**/admin/api/users.php?page=*', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:'fixture list failure'})}));
        await page.locator('#ucSubmit').click();
        await page.waitForFunction(() => document.getElementById('ucMessage').textContent.includes('积分已调整成功，但刷新失败'));
        assert.deepEqual(await page.evaluate(() => ({page:currentPage,filters:currentFilters})), {page:2,filters:{username:'credit-fixture'}});
        assert.equal(await page.locator('#ucAmount').inputValue(), '');
        await page.unroute('**/admin/api/users.php?page=*');
        await page.locator('#ucAmount').fill('1');
        await page.locator('#ucReason').fill('第二页成功刷新');
        await page.locator('#ucSubmit').click();
        await page.waitForFunction(() => document.getElementById('ucMessage').textContent.includes('积分已调整成功，'));
        assert.deepEqual(await page.evaluate(() => ({page:currentPage,filters:currentFilters})), {page:2,filters:{username:'credit-fixture'}});
        assert.deepEqual(errors, [], 'Dashboard executes without JavaScript errors');
        console.log(`PASS: ${service.checks} isolated service checks, HTTP validation and browser interactions`);
        console.log('Credits screenshot: ' + path.join(root,'credits-dialog.png'));
    } finally {
        if (browser) await browser.close();
        if (server && server.exitCode === null) { const exited = once(server,'exit'); server.kill(); await exited; }
        if (database) fixture('drop');
        // Keep the screenshot and isolated logs for visual QA; all test user data is dropped.
    }
});
