import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

async function fixture() {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.route('http://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('http://fixture.test/');
    await page.setContent('<div class="message ai"><div class="message-content"></div></div>');
    for (const name of ['css-01-base.css', 'css-06-main.css', 'css-28-process.css'])
        await page.addStyleTag({ content: await readFile(new URL('../src/styles/' + name, import.meta.url), 'utf8') });
    await page.evaluate(() => {
        window.MoonYaIcons = { icon: () => '<svg></svg>' };
        window.formatTurnDuration = () => '1秒';
    });
    await page.addScriptTag({ content: await readFile(new URL('../src/process-ui.js', import.meta.url), 'utf8') });
    await page.evaluate(() => {
        window.sequence = MoonYaProcessUI.sequence(document.querySelector('.message-content'), 'clipping');
        MoonYaProcessUI.tool(sequence, 'first', { tool: 'read_file', args: { path: 'a.js' }, state: 'success' });
    });
    return { browser, page };
}

test('completed operations stop sweeping while the next segment is still thinking', async () => {
    const { browser, page } = await fixture();
    try {
        for (const style of ['soft', 'glass']) {
            const result = await page.evaluate(async style => {
                const api = MoonYaProcessUI;
                api.setAnimationStyle(style);
                sequence.host.replaceChildren();
                window.sequence = api.sequence(document.querySelector('.message-content'), 'completed-sweep');
                api.reason(sequence, 'first-thought', '开始写共享样式。', true);
                api.tool(sequence, 'edit', { tool: 'edit_file', args: { path: 'styles.css' }, state: 'executing' });
                const previous = sequence.segments[0];
                api.disclose(previous.header, previous.body, true, false);
                api.flush();
                // Content closes this segment before a late tool result arrives.
                api.boundary(sequence);
                api.refresh(previous);
                const closedHeaderActive = previous.header.hasAttribute('data-process-active');
                api.tool(sequence, 'edit', { state: 'success', result: { success: true } });
                const completedActiveImmediately = previous.container.querySelectorAll('[data-process-active]').length;
                api.activity(sequence);
                api.reason(sequence, 'first-thought', '开始写共享样式。\n已完成。', true);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                api.refresh(previous);
                const current = sequence.segments[1];
                return { closedHeaderActive, completedActiveImmediately,
                    completedActive: previous.container.querySelectorAll('[data-process-active]').length,
                    completedSweeps: previous.container.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'process-white-sweep').length,
                    currentActive: current.header.hasAttribute('data-process-active'),
                    currentSweep: getComputedStyle(current.label).animationName,
                    label: previous.label.textContent, reasoningState: sequence.reasons.get('first-thought').dataset.state };
            }, style);
            assert.deepEqual(result, { closedHeaderActive: false, completedActiveImmediately: 0,
                completedActive: 0, completedSweeps: 0, currentActive: true, currentSweep: 'process-white-sweep',
                label: '编辑了 1 个文件', reasoningState: 'ok' });
        }
    } finally { await browser.close(); }
});

test('terminal tool updates stop the batch sweep immediately and preserve parallel running tools', async () => {
    const { browser, page } = await fixture();
    try {
        for (const state of ['success', 'failure', 'stopped']) {
            const result = await page.evaluate(state => {
                const api = MoonYaProcessUI;
                sequence.host.replaceChildren();
                window.sequence = api.sequence(document.querySelector('.message-content'), 'terminal-sweep');
                api.tool(sequence, 'edit', { tool: 'edit_file', args: { path: 'a.js' }, state: 'executing' });
                api.tool(sequence, 'command', { tool: 'execute_command', args: { command: 'check' }, state: 'executing' });
                const segment = sequence.segments[0];
                api.disclose(segment.header, segment.body, true, false); api.flush();
                api.tool(sequence, 'edit', { state });
                const parallel = { active: segment.header.hasAttribute('data-process-active'), label: segment.label.textContent,
                    editActive: sequence.tools.get('edit').row.querySelector('.codex-tool-main').hasAttribute('data-process-active') };
                api.tool(sequence, 'command', { state });
                return { parallel, active: segment.container.querySelectorAll('[data-process-active]').length,
                    sweeps: segment.container.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'process-white-sweep').length };
            }, state);
            assert.deepEqual(result, { parallel: { active: true, label: '运行命令', editActive: false }, active: 0, sweeps: 0 });
        }
    } finally { await browser.close(); }
});

test('streaming updates cannot keep an expanded process clipped by restarting its height animation', async () => {
    const { browser, page } = await fixture();
    try {
        const result = await page.evaluate(async () => {
            const segment = sequence.segments[0];
            MoonYaProcessUI.disclose(segment.header, segment.body, true);
            for (let i = 0; i < 45; i++) {
                await new Promise(resolve => setTimeout(resolve, 16));
                MoonYaProcessUI.tool(sequence, 'row-' + i, { tool: 'read_file', args: { path: 'file-' + i }, state: 'success' });
            }
            return { height: segment.body.clientHeight, contentHeight: segment.body.scrollHeight,
                animated: segment.body.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => frame.height)),
                open: segment.header.getAttribute('aria-expanded') };
        });
        assert.equal(result.open, 'true');
        assert.equal(result.animated, false, 'incoming content must not restart the opening animation indefinitely');
        assert.ok(result.height >= result.contentHeight - 1, JSON.stringify(result));
    } finally { await browser.close(); }
});

test('rapid disclosure toggles and history replay remove temporary clipping while details retain scrolling', async () => {
    const { browser, page } = await fixture();
    try {
        for (const style of ['soft', 'glass']) {
            await page.evaluate(style => {
                MoonYaProcessUI.setAnimationStyle(style);
                const segment = sequence.segments[0];
                MoonYaProcessUI.disclose(segment.header, segment.body, true);
                MoonYaProcessUI.disclose(segment.header, segment.body, false);
                MoonYaProcessUI.disclose(segment.header, segment.body, true);
                const copy = document.querySelector('.message-content').cloneNode(true);
                MoonYaProcessUI.normalize(copy);
                if (copy.querySelector('.process-disclosure-animating')) throw Error('History retained animation clipping');
            }, style);
            await page.waitForFunction(() => !document.querySelector('.process-disclosure-animating'));
            const result = await page.evaluate(() => {
                const segment = sequence.segments[0];
                const entry = sequence.tools.get('first');
                MoonYaProcessUI.tool(sequence, 'first', { result: { content: 'long output\n'.repeat(100) } });
                const detail = entry.row.querySelector('.codex-tool-detail');
                detail.textContent = 'long output\n'.repeat(100);
                MoonYaProcessUI.disclose(entry.row.querySelector('.codex-tool-main'), detail, true, false);
                return { hidden: segment.body.hidden, overflow: getComputedStyle(segment.body).overflowY,
                    clipped: !!document.querySelector('.process-disclosure-animating'),
                    detailOverflow: getComputedStyle(detail).overflowY, detailHeight: detail.clientHeight, detailContent: detail.scrollHeight };
            });
            assert.equal(result.hidden, false);
            assert.equal(result.clipped, false);
            assert.equal(result.overflow, 'visible');
            assert.equal(result.detailOverflow, 'auto');
            assert.ok(result.detailContent > result.detailHeight, JSON.stringify(result));
        }
    } finally { await browser.close(); }
});

test('duration collapse moves the final reply continuously through the last frame', async () => {
    const { browser, page } = await fixture();
    try {
        await page.evaluate(() => {
            const message = document.querySelector('.message');
            MoonYaProcessUI.endDuration(message, 1000);
            for (let i = 0; i < 3; i++) {
                if (i) MoonYaProcessUI.tool(sequence, 'extra-' + i, { tool: 'read_file', state: 'success' });
                MoonYaProcessUI.boundary(sequence);
                const text = document.createElement('div'); text.className = 'ai-text-segment';
                text.textContent = i === 2 ? '最终回复' : '中间回复';
                sequence.host.append(text);
            }
        });
        for (const style of ['soft', 'glass']) {
            const positions = await page.evaluate(async style => {
                const api = MoonYaProcessUI, header = document.querySelector('.turn-duration');
                const bodies = [...sequence.host.children].slice(0, -1);
                api.setAnimationStyle(style);
                bodies.forEach(body => api.disclose(header, body, true, false));
                const reply = document.querySelector('.ai-text-segment:last-child');
                const top = () => reply.getBoundingClientRect().top;
                const before = top(); header.click();
                const animations = bodies.map(body => body.getAnimations()[0]);
                animations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
                const start = top();
                animations.forEach(animation => { animation.currentTime = animation.effect.getTiming().duration - .01; });
                const last = top();
                animations.forEach(animation => animation.finish());
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
                return { before, start, last, settled: top(), hidden: bodies.every(body => body.hidden),
                    retained: bodies.reduce((count, body) => count + body.getAnimations().length, 0) };
            }, style);
            assert.ok(Math.abs(positions.start - positions.before) <= 1, 'no jump at the start: ' + JSON.stringify(positions));
            assert.ok(Math.abs(positions.settled - positions.last) <= 1, 'no second movement after collapse: ' + JSON.stringify(positions));
            assert.equal(positions.hidden, true);
            assert.equal(positions.retained, 0);
        }
    } finally { await browser.close(); }
});
