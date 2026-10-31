import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

async function fixture() {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
        await page.setContent('<div class="message ai"><div class="message-content"></div></div>');
        for (const name of ['css-01-base.css', 'css-06-main.css', 'css-28-process.css'])
            await page.addStyleTag({ content: await readFile(new URL('../src/styles/' + name, import.meta.url), 'utf8') });
        await page.evaluate(() => {
            window.MoonYaIcons = { icon: name => '<svg data-name="' + name + '"></svg>' };
            window.formatTurnDuration = () => '1秒';
        });
        await page.addScriptTag({ content: await readFile(new URL('../src/process-ui.js', import.meta.url), 'utf8') });
        await page.evaluate(() => {
            window.sequence = MoonYaProcessUI.sequence(document.querySelector('.message-content'), 'performance', { pathBase: 'D:/Fixture' });
        });
        return { browser, page };
    } catch (error) { await browser.close(); throw error; }
}

test('1000 hidden records and repeated deltas do not measure layout or repeatedly scan the list', async () => {
    const { browser, page } = await fixture();
    try {
        const result = await page.evaluate(async () => {
            const rect = Element.prototype.getBoundingClientRect, query = Element.prototype.querySelectorAll;
            let reads = 0, hiddenReads = 0, scans = 0;
            Element.prototype.getBoundingClientRect = function (...args) {
                reads++; if (this.closest('[hidden]')) hiddenReads++;
                return rect.apply(this, args);
            };
            Element.prototype.querySelectorAll = function (...args) {
                if (this.classList.contains('turn-process-body')) scans++;
                return query.apply(this, args);
            };
            try {
                for (let i = 0; i < 1000; i++) {
                    MoonYaProcessUI.tool(sequence, String(i), { tool: i % 2 ? 'read_file' : 'execute_command',
                        args: i % 2 ? { path: 'file-' + i } : { command: 'echo ' + i }, state: 'success' });
                }
                for (let i = 0; i < 100; i++) MoonYaProcessUI.reason(sequence, 'think', '思考\n增量 ' + i, true);
                await new Promise(requestAnimationFrame);
                MoonYaProcessUI.finish(sequence);
                return { reads, hiddenReads, scans, label: sequence.segments[0].label.textContent,
                    details: sequence.segments[0].body.querySelectorAll('.codex-tool-detail').length };
            } finally { Element.prototype.getBoundingClientRect = rect; Element.prototype.querySelectorAll = query; }
        });
        assert.equal(result.hiddenReads, 0, 'collapsed details and streaming initialization never force layout');
        assert.ok(result.reads <= 4, 'only the coalesced, visible header transitions measure layout: ' + JSON.stringify(result));
        assert.ok(result.scans <= 4, JSON.stringify(result));
        assert.equal(result.details, 1000);
        assert.equal(result.label, '运行了 500 个命令，读取了 500 项内容');
    } finally { await browser.close(); }
});

test('cached counts follow duplicate paths, external insertion/removal, reclassification and background commands', async () => {
    const { browser, page } = await fixture();
    try {
        const results = await page.evaluate(async () => {
            const api = MoonYaProcessUI;
            api.tool(sequence, 'a', { tool: 'edit_file', args: { command: 'insert', path: './a.js' }, state: 'success' });
            api.tool(sequence, 'b', { tool: 'edit_file', args: { command: 'insert', path: 'd:/fixture/a.js' }, state: 'success' });
            const segment = sequence.segments[0], labels = [];
            const label = () => { api.flush(); labels.push(segment.label.textContent); };
            label();
            sequence.tools.get('a').row.remove(); label();
            sequence.tools.get('b').row.dataset.filePath = 'b.js';
            const group = document.createElement('div');
            group.innerHTML = '<div class="process-row status-success" data-tool-name="edit_file" data-file-path="a.js">旧记录</div>';
            segment.body.append(group); api.refresh(segment); label();
            group.firstChild.dataset.activityKind = 'read';
            await new Promise(requestAnimationFrame); label();
            group.remove(); api.refresh(segment); label();
            api.tool(sequence, 'cmd', { tool: 'execute_command', args: { command: 'echo test' },
                result: { command_id: 'bg', status: 'running' }, state: 'success' }); label();
            api.tool(sequence, 'poll', { tool: 'get_command_status', args: { command_id: 'bg' },
                result: { status: 'done', command_ok: false, exit_code: 1 }, state: 'success' });
            api.finish(sequence); label();
            return { labels, state: sequence.tools.get('cmd').row.dataset.state };
        });
        assert.deepEqual(results.labels, ['编辑了 1 个文件', '编辑了 1 个文件', '编辑了 2 个文件',
            '编辑了 1 个文件，读取了 1 项内容', '编辑了 1 个文件', '运行命令', '编辑了 1 个文件，运行了 1 个命令']);
        assert.equal(results.state, 'failure');
    } finally { await browser.close(); }
});

test('large disclosures retain both motion styles, complete history, focus and scrollable details', async () => {
    const { browser, page } = await fixture();
    try {
        await page.evaluate(() => {
            for (let i = 0; i < 1000; i++) MoonYaProcessUI.tool(sequence, String(i), {
                tool: 'execute_command', args: { command: 'echo ' + i }, result: { stdout: 'output\n'.repeat(100) }, state: 'success' });
            MoonYaProcessUI.reason(sequence, 'think', '思考\n'.repeat(300), false);
            MoonYaProcessUI.finish(sequence);
        });
        for (const style of ['soft', 'glass']) {
            const timing = await page.evaluate(style => {
                MoonYaProcessUI.setAnimationStyle(style);
                const segment = sequence.segments[0];
                MoonYaProcessUI.disclose(segment.header, segment.body, true);
                return segment.body.getAnimations().map(animation => ({ duration: animation.effect.getTiming().duration,
                    height: animation.effect.getKeyframes().some(frame => frame.height !== undefined) }));
            }, style);
            assert.deepEqual(timing, [{ duration: style === 'soft' ? 260 : 340, height: true }]);
            await page.waitForFunction(() => !document.querySelector('.process-disclosure-animating'));
            await page.evaluate(() => {
                const row = sequence.tools.get('999').row; row.scrollIntoView();
            });
            const last = page.locator('[data-tool-id="999"] .codex-tool-main');
            await last.focus(); await page.keyboard.press('Enter');
            await page.waitForFunction(() => !document.querySelector('.process-disclosure-animating'));
            const detail = await page.evaluate(() => {
                const row = sequence.tools.get('999').row, detail = row.querySelector('.codex-tool-detail');
                detail.textContent = 'output\n'.repeat(300);
                detail.tabIndex = 0; detail.focus();
                MoonYaProcessUI.disclose(row.querySelector('.codex-tool-main'), detail, false, false);
                const focused = document.activeElement === row.querySelector('.codex-tool-main');
                MoonYaProcessUI.disclose(row.querySelector('.codex-tool-main'), detail, true, false);
                return { focused, scrolls: detail.scrollHeight > detail.clientHeight, overflow: getComputedStyle(detail).overflowY,
                    containment: getComputedStyle(row).contentVisibility };
            });
            assert.equal(detail.focused, true); assert.equal(detail.scrolls, true); assert.equal(detail.overflow, 'auto');
            assert.equal(detail.containment, 'visible');
            await page.evaluate(() => {
                const segment = sequence.segments[0];
                MoonYaProcessUI.disclose(segment.header, segment.body, false);
                MoonYaProcessUI.disclose(segment.header, segment.body, true);
                MoonYaProcessUI.disclose(segment.header, segment.body, false);
            });
            await page.waitForFunction(() => !document.querySelector('.process-disclosure-animating'));
        }
        const history = await page.evaluate(() => {
            const copy = document.querySelector('.message-content').cloneNode(true); MoonYaProcessUI.normalize(copy);
            return { rows: copy.querySelectorAll('.tool-row').length, details: copy.querySelectorAll('.codex-tool-detail').length,
                text: copy.querySelector('.reasoning-row-body').textContent, hidden: copy.querySelector('.turn-process-body').hidden,
                temporary: !!copy.querySelector('[data-process-active], .process-disclosure-animating, .process-motion-ghost') };
        });
        assert.equal(history.rows, 1000); assert.equal(history.details, 1000); assert.equal(history.text, '思考\n'.repeat(300));
        assert.equal(history.hidden, true); assert.equal(history.temporary, false);
    } finally { await browser.close(); }
});

test('removing a chat during motion cleans ghosts and settles its disclosure', async () => {
    const { browser, page } = await fixture();
    try {
        await page.evaluate(() => {
            MoonYaProcessUI.tool(sequence, 'first', { tool: 'execute_command', state: 'executing' }); MoonYaProcessUI.flush();
            const segment = sequence.segments[0]; MoonYaProcessUI.disclose(segment.header, segment.body, true);
            document.querySelector('.message').remove();
        });
        await page.waitForFunction(() => !document.querySelector('.process-motion-ghost'));
        await page.evaluate(() => new Promise(requestAnimationFrame));
        assert.equal(await page.evaluate(() => sequence.segments[0].body.classList.contains('process-disclosure-animating')), false);
    } finally { await browser.close(); }
});
