// Compare against a saved process-ui.js/css-28-process.css pair with --baseline DIR.
// Run separately from the browser regression suite to avoid CPU contention.
import { chromium } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const baselineAt = process.argv.indexOf('--baseline');
const baseline = baselineAt < 0 ? null : resolve(process.argv[baselineAt + 1]);
const reportPath = resolve(frontend, '../artifacts/process-performance/benchmark.json');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
const sources = {};
try {
    for (const version of baseline ? ['before', 'after'] : ['after']) {
        const script = await readFile(version === 'before' ? join(baseline, 'process-ui.js') : join(frontend, 'src/process-ui.js'), 'utf8');
        const css = await readFile(version === 'before' ? join(baseline, 'css-28-process.css') : join(frontend, 'src/styles/css-28-process.css'), 'utf8');
        sources[version] = { scriptSha256: createHash('sha256').update(script).digest('hex'), cssSha256: createHash('sha256').update(css).digest('hex') };
        for (const count of version === 'before' ? [100, 1000, 3000] : [100, 1000, 3000, 5000]) {
            for (let trial = 0; trial < 3; trial++) {
                const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
                try {
                    await page.setContent('<div class="message ai"><div class="message-content"></div></div>');
                    for (const name of ['css-01-base.css', 'css-06-main.css'])
                        await page.addStyleTag({ content: await readFile(join(frontend, 'src/styles', name), 'utf8') });
                    await page.addStyleTag({ content: css });
                    await page.evaluate(() => {
                        window.MoonYaIcons = { icon: () => '<svg></svg>' };
                        window.formatTurnDuration = () => '1秒';
                    });
                    await page.addScriptTag({ content: script });
                    const createMs = await page.evaluate(count => {
                        window.sequence = MoonYaProcessUI.sequence(document.querySelector('.message-content'), 'benchmark');
                        const start = performance.now();
                        MoonYaProcessUI.withoutAnimation(() => {
                            for (let i = 0; i < count; i++) {
                                const tool = i % 3 === 0 ? 'execute_command' : i % 3 === 1 ? 'read_file' : 'edit_file';
                                MoonYaProcessUI.tool(sequence, String(i), { tool, args: { command: tool === 'execute_command' ? 'echo ' + i : 'insert', path: 'file-' + i + '.js' },
                                    result: { stdout: 'output\n'.repeat(50) }, state: 'success' });
                                if (i % 10 === 0) MoonYaProcessUI.reason(sequence, 'think-' + i, '思考\n' + i, false);
                            }
                            MoonYaProcessUI.finish(sequence);
                        });
                        return performance.now() - start;
                    }, count);
                    // Warm browser layout while still collapsed; isolate disclosure metrics.
                    await page.evaluate(() => new Promise(requestAnimationFrame));
                    const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
                    for (const style of ['soft', 'glass']) {
                        await page.evaluate(style => {
                            MoonYaProcessUI.setAnimationStyle(style);
                            const segment = sequence.segments[0]; MoonYaProcessUI.disclose(segment.header, segment.body, false, false);
                        }, style);
                        const before = (await cdp.send('Performance.getMetrics')).metrics;
                        const timing = await page.evaluate(async () => {
                            const frames = [], longTasks = [];
                            const observer = new PerformanceObserver(list => list.getEntries().forEach(entry => longTasks.push(entry.duration)));
                            observer.observe({ type: 'longtask' });
                            let stopped = false, previous = performance.now();
                            const sample = now => { frames.push(now - previous); previous = now; if (!stopped) requestAnimationFrame(sample); };
                            requestAnimationFrame(sample);
                            const start = performance.now(), segment = sequence.segments[0];
                            MoonYaProcessUI.disclose(segment.header, segment.body, true);
                            const openMs = performance.now() - start;
                            await new Promise(resolve => setTimeout(resolve, 450)); stopped = true; observer.disconnect();
                            return { openMs, maxFrameMs: Math.max(...frames), longTasks, clipped: segment.body.clientHeight < segment.body.scrollHeight - 1,
                                records: segment.body.querySelectorAll('.tool-row').length };
                        });
                        const after = (await cdp.send('Performance.getMetrics')).metrics;
                        const delta = name => 1000 * (after.find(value => value.name === name).value - before.find(value => value.name === name).value);
                        const row = { version, count, trial, style, createMs, ...timing, layoutMs: delta('LayoutDuration'), styleMs: delta('RecalcStyleDuration') };
                        results.push(row); console.log(JSON.stringify(row));
                    }
                    await cdp.detach();
                } finally { await page.close(); }
            }
        }
    }
} finally { await browser.close(); }
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summaries = [];
for (const version of baseline ? ['before', 'after'] : ['after']) for (const count of [100, 1000, 3000, 5000]) for (const style of ['soft', 'glass']) {
    const rows = results.filter(row => row.version === version && row.count === count && row.style === style);
    if (rows.length) summaries.push({ version, count, style, createMs: median(rows.map(row => row.createMs)),
        openMs: median(rows.map(row => row.openMs)), layoutMs: median(rows.map(row => row.layoutMs)),
        maxFrameMs: median(rows.map(row => row.maxFrameMs)), longTaskCount: rows.reduce((n, row) => n + row.longTasks.length, 0) });
}
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify({ viewport: { width: 1000, height: 800 }, trials: 3, sources, summaries, results }, null, 2));
console.log(JSON.stringify({ reportPath, summaries }, null, 2));
