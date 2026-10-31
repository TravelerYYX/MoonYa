import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const PHP = process.env.PHP_BIN || 'php';

function run(args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(PHP, args, { cwd: repo, windowsHide: true, env: { ...process.env, ...env } });
        let out = '', err = '';
        child.stdout.on('data', value => out += value);
        child.stderr.on('data', value => err += value);
        child.on('error', reject);
        child.on('exit', code => code ? reject(new Error(err + out)) : resolve(out));
    });
}

async function freePort() {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

const DOMAIN = 'https://themes.example.test';

test('builtin themes API: public catalogue, admin CRUD, config-file override and export', async () => {
    let server;
    try {
        const fixture = JSON.parse(await run(['MoonYa-Backend/tests/builtin_themes_http_fixture.php']));
        const port = await freePort();
        const origin = `http://127.0.0.1:${port}`;
        server = spawn(PHP, ['-S', `127.0.0.1:${port}`, '-t', fixture.root],
            { cwd: repo, windowsHide: true, env: { ...process.env, MAIN_API_DOMAIN: DOMAIN } });
        let errors = '';
        server.stderr.on('data', value => errors += value);
        for (let attempt = 0; ; attempt++) {
            try { if ((await fetch(`${origin}/api/builtin_themes.php?action=catalog`)).ok) break; } catch {}
            if (attempt > 50) throw new Error(errors);
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const auth = { Authorization: 'Bearer fixture-token' };
        async function admin(action, body) {
            const response = await fetch(`${origin}/admin/api/builtin_themes.php?action=${action}`, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            return { status: response.status, ...(await response.json()) };
        }
        const catalog = async () => (await (await fetch(`${origin}/api/builtin_themes.php?action=catalog`)).json());

        // 管理端必须鉴权
        assert.equal((await (await fetch(`${origin}/admin/api/builtin_themes.php?action=list`)).json()).success, false);

        // 公开目录：只含已上架，绝对 URL，颜色与版本号原样下发
        const published = await catalog();
        assert.equal(published.success, true);
        assert.equal(published.data.themes.length, 1, '下架的主题不下发');
        const forest = published.data.themes[0];
        assert.equal(forest.slug, 'forest');
        assert.equal(forest.name, '深林');
        assert.equal(forest.blur, 12);
        assert.equal(forest.shellOpacity, 0.8);
        assert.equal(forest.colors.accent, '#7fd1a0');
        assert.equal(forest.assetVersion, 3);
        assert.equal(forest.background.type, 'image');
        assert.equal(forest.background.ext, 'webp');
        assert.equal(forest.background.url, `${DOMAIN}/uploads/themes/forest/bg-${'a'.repeat(64)}.webp`, '静态资源必须是绝对地址（客户端 origin 是 127.0.0.1）');
        assert.equal(forest.background.bytes, 2048);
        assert.ok(forest.background.sha256);

        // 管理端列表含下架项
        const listed = await admin('list');
        assert.equal(listed.status, 200);
        assert.equal(listed.data.themes.length, 2);
        assert.equal(listed.data.themes.find(theme => theme.slug === 'hidden').enabled, false);

        // 校验：标识、颜色白名单、色值格式、数值范围
        assert.equal((await admin('save', { slug: 'Bad Slug', name: 'x' })).status, 400);
        assert.equal((await admin('save', { slug: 'ocean', name: '', colors: {} })).status, 400, '名称必填');
        assert.equal((await admin('save', { slug: 'ocean', name: '海', colors: { accent: 'red' } })).status, 400);
        assert.equal((await admin('save', { slug: 'ocean', name: '海', colors: { nope: '#ffffff' } })).status, 400);
        assert.equal((await admin('save', { slug: 'ocean', name: '海', blur: 90 })).status, 400);
        assert.equal((await admin('save', { slug: 'ocean', name: '海', shellOpacity: 0.1 })).status, 400);

        // 新增 → 目录里出现
        const created = await admin('save', {
            slug: 'ocean', name: '海', summary: '海边', sortOrder: 5, enabled: true,
            colors: { appBackground: '#0b2239' }, blur: 6, shellOpacity: 0.7,
            backgroundKind: 'image', backgroundFill: 'contain', backgroundKey: 'ocean/bg.webp'
        });
        assert.equal(created.status, 200);
        const afterCreate = await catalog();
        assert.equal(afterCreate.data.themes[0].slug, 'ocean', '排序值小的排前面');
        assert.equal(afterCreate.data.themes[0].background.fill, 'contain');

        // 下架 → 目录里消失
        await admin('unpublish', { id: created.data.id });
        assert.equal((await catalog()).data.themes.some(theme => theme.slug === 'ocean'), false);
        await admin('publish', { id: created.data.id });
        assert.equal((await catalog()).data.themes.some(theme => theme.slug === 'ocean'), true);

        // 配置文件覆盖：缺 updated_at 的条目视为永久覆盖，even 未在库里
        const overridePath = join(fixture.root, 'config', 'builtin_themes.json');
        await writeFile(overridePath, JSON.stringify({
            version: 1,
            themes: [
                { slug: 'forest', name: '深林（热修）', colors: { accent: '#123456' }, blur: 30, shell_opacity: 0.9,
                  background: { kind: 'image', fill: 'cover', key: 'forest/bg-hotfix.webp', sha256: 'b'.repeat(64), bytes: 4096 } },
                { slug: 'purefile', name: '仅文件', colors: {}, blur: 0, shell_opacity: 0.85,
                  background: { kind: 'image', fill: 'cover', key: 'purefile/bg.webp', sha256: 'c'.repeat(64), bytes: 512 } }
            ]
        }), 'utf8');
        const overridden = await catalog();
        const forestNow = overridden.data.themes.find(theme => theme.slug === 'forest');
        assert.equal(forestNow.name, '深林（热修）');
        assert.equal(forestNow.blur, 30);
        assert.equal(forestNow.colors.accent, '#123456');
        assert.equal(forestNow.background.bytes, 4096);
        assert.equal(forestNow.background.url, `${DOMAIN}/uploads/themes/forest/bg-hotfix.webp`);
        assert.ok(overridden.data.themes.some(theme => theme.slug === 'purefile'), '纯文件条目也要能下发');

        // 后台保存会 bump updated_at，从而重新夺回优先权
        await admin('save', {
            id: listed.data.themes.find(theme => theme.slug === 'forest').id,
            slug: 'forest', name: '深林回归', colors: { accent: '#abcdef' }, blur: 4, shellOpacity: 0.85,
            backgroundKind: 'image', backgroundFill: 'cover'
        });
        const regained = (await catalog()).data.themes.find(theme => theme.slug === 'forest');
        assert.equal(regained.name, '深林回归');
        assert.equal(regained.colors.accent, '#abcdef');

        // 导出到配置文件：写出全量并原子替换
        const exported = await admin('export_config', {});
        assert.equal(exported.status, 200);
        assert.ok(exported.data.written >= 3);
        const written = JSON.parse(await readFile(overridePath, 'utf8'));
        assert.ok(Array.isArray(written.themes) && written.themes.length === exported.data.written);
        assert.ok(written.themes.some(theme => theme.slug === 'hidden'), '导出包含下架项');

        // 删除
        const removed = await admin('delete', { id: created.data.id });
        assert.equal(removed.status, 200);
        assert.equal((await catalog()).data.themes.some(theme => theme.slug === 'ocean'), false);
        assert.equal((await admin('delete', { id: 99999 })).status, 400);

        // PHP 内置服务器会把访问日志写进 stderr，这里只关心真正的报错。
        assert.equal(/PHP (Warning|Fatal|Parse|Notice|Deprecated)/.test(errors), false, errors);
    } finally {
        if (server) server.kill();
    }
});
