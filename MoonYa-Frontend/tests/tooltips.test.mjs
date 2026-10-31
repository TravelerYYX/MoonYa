import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

test('shared tooltip preserves text, handles dynamic controls, modal layers, focus and viewport edges', async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const css = await readFile(new URL('../src/styles/css-25-tooltips.css', import.meta.url), 'utf8');
    const script = await readFile(new URL('../src/tooltips.js', import.meta.url), 'utf8');
    const tip = page.locator('#moonyaTooltip');
    try {
        await page.setContent(`<style>${css}</style><button id="parent" data-tooltip="项目提示" style="position:absolute;left:100px;top:100px;width:200px;height:60px"><span id="child" data-tooltip="按钮提示">子控件</span></button>`);
        await page.addScriptTag({ content: script });
        await page.locator('#parent').hover({ position: { x: 10, y: 10 } });
        await page.waitForTimeout(150);
        assert.equal(await tip.isVisible(), false, 'Do not show before the hover delay');
        await tip.waitFor({ state: 'visible' });
        assert.equal(await tip.textContent(), '项目提示');
        await page.locator('#child').hover(); await tip.waitFor({ state: 'visible' });
        assert.equal(await tip.textContent(), '按钮提示', 'The nearest nested hint takes priority');
        await page.keyboard.press('Escape'); await tip.waitFor({ state: 'hidden' });

        const fullText = '动画 <项目> & 中文\nC:\\Users\\Administrator\\Desktop\\' + '很长的目录名称'.repeat(18);
        await page.evaluate(text => {
            const node = document.createElement('button'); node.id = 'dynamic';
            node.dataset.tooltip = text; node.textContent = '动态项目';
            node.setAttribute('aria-describedby', 'existing');
            node.style.cssText = 'position:absolute;left:20px;top:220px'; document.body.append(node);
        }, fullText);
        await page.locator('#dynamic').hover(); await tip.waitFor({ state: 'visible' });
        assert.equal(await tip.textContent(), fullText);
        assert.equal(await tip.locator('*').count(), 0, 'Hint content must stay plain text');
        assert.equal(await page.locator('#dynamic').getAttribute('aria-describedby'), 'existing moonyaTooltip');
        assert.equal(await page.locator('#dynamic').getAttribute('title'), null);
        const appearance = await tip.evaluate(el => {
            const s = getComputedStyle(el); return { color: s.color, background: s.backgroundColor, radius: s.borderRadius,
                font: s.fontSize, line: s.lineHeight, border: s.borderTopWidth, pointer: s.pointerEvents, width: el.offsetWidth };
        });
        assert.deepEqual(appearance, { color: 'rgb(255, 255, 255)', background: 'rgb(37, 38, 40)', radius: '10px',
            font: '12px', line: '18px', border: '0px', pointer: 'none', width: 360 });
        await page.evaluate(() => document.getElementById('dynamic').dataset.tooltip = '已更新\n完整路径');
        await page.waitForFunction(() => document.getElementById('moonyaTooltip').textContent === '已更新\n完整路径');
        const artifacts = new URL('../../artifacts/tooltips/', import.meta.url); await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: fileURLToPath(new URL('tooltip.png', artifacts)) });
        await page.locator('#dynamic').click(); await tip.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#dynamic').getAttribute('aria-describedby'), 'existing');

        await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
        await tip.waitFor({ state: 'visible' });
        assert.equal(await tip.textContent(), '已更新\n完整路径', 'Keyboard focus exposes the hint');
        await page.evaluate(() => document.getElementById('dynamic').remove()); await tip.waitFor({ state: 'hidden' });

        await page.evaluate(() => {
            const row = document.createElement('div'); row.dataset.tooltip = '项目名称\n完整路径';
            row.innerHTML = '<button id="focusChild" aria-describedby="existing">项目名称</button>'; document.body.append(row);
        });
        await page.keyboard.press('Tab'); await page.locator('#focusChild').focus(); await tip.waitFor({ state: 'visible' });
        assert.equal(await tip.textContent(), '项目名称\n完整路径');
        assert.equal(await page.locator('#focusChild').getAttribute('aria-describedby'), 'existing moonyaTooltip');
        await page.keyboard.press('Escape'); await tip.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#focusChild').getAttribute('aria-describedby'), 'existing');

        await page.evaluate(() => {
            const dialog = document.createElement('dialog'); dialog.id = 'modal';
            dialog.innerHTML = '<button id="modalButton" data-tooltip="弹窗中的提示">弹窗按钮</button>';
            document.body.append(dialog); dialog.showModal();
        });
        await page.locator('#modalButton').hover(); await tip.waitFor({ state: 'visible' });
        assert.equal(await tip.evaluate(el => el.parentElement.id), 'modal');
        assert.equal(await tip.evaluate(el => el.matches(':popover-open')), true);
        await page.evaluate(() => document.getElementById('modal').close()); await tip.waitFor({ state: 'hidden' });

        for (const viewport of [{ width: 600, height: 400 }, { width: 180, height: 240 }]) {
            await page.setViewportSize(viewport);
            for (const edge of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
                await page.evaluate(edge => {
                    const button = document.getElementById('parent'); button.dataset.tooltip = '边缘提示' + '很长的路径'.repeat(7);
                    button.style.cssText = 'position:fixed;width:60px;height:25px;' +
                        (edge.includes('top') ? 'top:0;' : 'bottom:0;') + (edge.includes('left') ? 'left:0;' : 'right:0;');
                }, edge);
                await page.mouse.move(viewport.width / 2, viewport.height / 2);
                await page.locator('#parent').hover({ position: { x: 2, y: 2 } }); await tip.waitFor({ state: 'visible' });
                const bounds = await tip.boundingBox();
                assert.ok(bounds.x >= 8 && bounds.y >= 8);
                assert.ok(bounds.x + bounds.width <= viewport.width - 8 && bounds.y + bounds.height <= viewport.height - 8);
                await page.evaluate(() => document.dispatchEvent(new Event('scroll'))); await tip.waitFor({ state: 'hidden' });
            }
        }
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});
