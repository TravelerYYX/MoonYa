/**
 * 守卫：后台主题编辑器的「预览常量」必须与客户端/服务端的真值保持一致。
 *
 * 为什么需要这个测试：admin/theme_editor.php 是纯 PHP 页面，生产包里拿不到
 * MoonYa-Frontend/src，所以配色键与明暗基底色只能复制一份到
 * MoonYa-Backend/admin/assets/theme-editor-base.js。复制就会漂移，
 * 一旦漂移，编辑器的实时预览会开始"骗人"——比没有预览更糟。
 *
 * 本测试直接加载那份纯数据文件（无 DOM 依赖），逐项对照：
 *   1) COLOR_DEFS 的键与顺序 ← MoonYa-Backend/Services/BuiltinThemeService.php 的 COLOR_KEYS
 *   2) COLOR_DEFS 的键与 vars ← MoonYa-Frontend/src/appearance.js 的 COLOR_DEFS
 *   3) BASE 的明暗基色 ← MoonYa-Frontend/src/styles/css-32-theme.css / css-01-base.css
 *   4) SCHEME 覆盖全部配色键
 *   5) 编辑器页面确实加载了这两个脚本；列表页确实改成了开新页而非弹窗
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const repo = fileURLToPath(new URL('../../', import.meta.url));

const PATHS = {
    base: join(repo, 'MoonYa-Backend/admin/assets/theme-editor-base.js'),
    page: join(repo, 'MoonYa-Backend/admin/theme_editor.php'),
    service: join(repo, 'MoonYa-Backend/Services/BuiltinThemeService.php'),
    appearance: join(repo, 'MoonYa-Frontend/src/appearance.js'),
    darkLight: join(repo, 'MoonYa-Frontend/src/styles/css-32-theme.css'),
    baseLight: join(repo, 'MoonYa-Frontend/src/styles/css-01-base.css'),
    dashboard: join(repo, 'MoonYa-Backend/script/dashboard/themes.php')
};

async function read(path) {
    return readFile(path, 'utf8');
}

/** 在 vm 里跑那份纯数据文件，取出它挂到 window 上的对象。 */
function loadBase(source) {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(source, context);
    const base = context.window.MoonYaThemeBase;
    assert.ok(base, 'theme-editor-base.js 必须挂出 window.MoonYaThemeBase');
    return base;
}

/**
 * vm 里造出来的 Array 原型与当前 realm 不同，直接 deepEqual 会报
 * "same structure but not reference-equal"，所以一律先摊平成同域数组。
 */
function plain(value) {
    return Array.from(value);
}

/** 取出 CSS 里某个选择器的声明块；没找到返回 null。 */
function cssBlock(text, selector) {
    const start = text.indexOf(selector);
    if (start === -1) return null;
    const open = text.indexOf('{', start);
    const close = text.indexOf('}', open);
    if (open === -1 || close === -1) return null;
    return text.slice(open + 1, close);
}

/** 把声明块解析成 { '--name': '#value' }。 */
function cssVars(block) {
    const vars = {};
    for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        vars[match[1]] = match[2].trim();
    }
    return vars;
}

function quotedList(block) {
    return [...block.matchAll(/'([^']+)'/g)].map(match => match[1]);
}

test('主题编辑器预览常量与客户端真值一致', async () => {
    const [baseSource, serviceSource, appearanceSource, darkLightCss, baseCss] = await Promise.all([
        read(PATHS.base),
        read(PATHS.service),
        read(PATHS.appearance),
        read(PATHS.darkLight),
        read(PATHS.baseLight)
    ]);
    const base = loadBase(baseSource);

    /* ── 1) 配色键 ← 服务端白名单 ─────────────────────────── */

    const serviceKeys = quotedList(
        serviceSource.match(/public const COLOR_KEYS = \[([^\]]*)\];/s)[1]
    );
    assert.deepEqual(
        plain(base.COLOR_KEYS),
        serviceKeys,
        'COLOR_KEYS 与 BuiltinThemeService::COLOR_KEYS 不一致（顺序也要一致）'
    );
    assert.equal(base.COLOR_KEYS.length, 11);

    /* ── 2) 配色键与变量落点 ← 前端 appearance.js ─────────── */

    const appearanceDefs = appearanceSource.match(/const COLOR_DEFS = \[([\s\S]*?)\n\s*\];/);
    assert.ok(appearanceDefs, 'appearance.js 里应当能找到 COLOR_DEFS');

    const appearanceKeys = [...appearanceDefs[1].matchAll(/key:\s*'([A-Za-z]+)'/g)].map(match => match[1]);
    const appearanceVars = [...appearanceDefs[1].matchAll(/vars:\s*\[([^\]]*)\]/g)]
        .map(match => quotedList(match[1]));

    assert.deepEqual(plain(base.COLOR_KEYS), appearanceKeys, 'COLOR_DEFS 的键与 appearance.js 不一致');
    assert.equal(appearanceVars.length, base.COLOR_DEFS.length);

    base.COLOR_DEFS.forEach((def, index) => {
        assert.deepEqual(
            plain(def.vars),
            appearanceVars[index],
            `配色 ${def.key} 的 CSS 变量落点与 appearance.js 不一致`
        );
    });

    // 分组必须无遗漏、无重复地覆盖全部键
    const grouped = Array.from(base.COLOR_GROUPS).flatMap(group => plain(group.keys));
    assert.deepEqual(grouped.sort(), Array.from(base.COLOR_KEYS).sort(), 'COLOR_GROUPS 未覆盖全部配色键');

    /* ── 3) 明暗基底 ← 客户端 CSS ─────────────────────────── */

    const lightVars = {
        ...cssVars(cssBlock(darkLightCss, ':root {')),
        ...cssVars(cssBlock(baseCss, ':root'))
    };
    const darkVars = cssVars(cssBlock(darkLightCss, ':root[data-theme="dark"]'));
    assert.ok(Object.keys(lightVars).length > 0 && Object.keys(darkVars).length > 0, '未能解析客户端主题变量块');

    for (const [name, value] of Object.entries(base.BASE.light)) {
        assert.equal(lightVars[name], value, `浅色基底 ${name} 与客户端 CSS 不一致（客户端是 ${lightVars[name]}）`);
    }
    for (const [name, value] of Object.entries(base.BASE.dark)) {
        assert.equal(darkVars[name], value, `深色基底 ${name} 与客户端 CSS 不一致（客户端是 ${darkVars[name]}）`);
    }

    // 明暗两套必须键集相同，否则预览切基底会漏项
    assert.deepEqual(Object.keys(base.BASE.light).sort(), Object.keys(base.BASE.dark).sort());

    /* ── 4) 一键方案覆盖全部配色键、且色值合法 ───────────── */

    for (const which of ['light', 'dark']) {
        const scheme = base.SCHEME[which];
        assert.deepEqual(Object.keys(scheme).sort(), Array.from(base.COLOR_KEYS).sort(), `${which} 方案未覆盖全部配色键`);
        for (const [key, value] of Object.entries(scheme)) {
            assert.match(value, /^#[0-9a-f]{6}$/, `${which} 方案的 ${key} 不是合法 #rrggbb`);
        }
    }
    // 一键套浅色应等于浅色基底（发送键两项走客户端写死的兜底，不参与比较）
    assert.equal(base.SCHEME.light.appBackground, base.BASE.light['--theme-shell']);
    assert.equal(base.SCHEME.dark.appBackground, base.BASE.dark['--theme-shell']);
});

test('主题编辑器页面与列表页的接线正确', async () => {
    const [page, dashboard] = await Promise.all([read(PATHS.page), read(PATHS.dashboard)]);
    // 注释里也会出现文件名，先剥掉 HTML 注释再找引用位置
    const markup = page.replace(/<!--[\s\S]*?-->/g, '');

    // 页面必须加载共享常量与主脚本（顺序不能反）
    const baseAt = markup.indexOf('theme-editor-base.js');
    const mainAt = markup.indexOf('theme-editor.js');
    assert.ok(baseAt > -1 && mainAt > -1, '主题编辑器页面未加载 theme-editor-base.js / theme-editor.js');
    assert.ok(baseAt < mainAt, 'theme-editor-base.js 必须先于 theme-editor.js 加载');

    // 预览画布与基底切换控件是实时预览的承载体
    assert.match(page, /id="tePreview"/);
    assert.match(page, /data-base-view="light"/);
    assert.match(page, /data-base-view="dark"/);
    assert.match(page, /id="teSchemeLight"/);
    assert.match(page, /id="teSchemeDark"/);

    // 列表页已改为开新标签页的独立编辑器，弹窗编辑的痕迹必须清干净
    assert.match(dashboard, /theme_editor\.php/);
    assert.match(dashboard, /window\.open\(/);
    assert.doesNotMatch(dashboard, /bt-dialog/, '列表页仍残留弹窗编辑器的样式');
    assert.doesNotMatch(dashboard, /bt-form|btSave/, '列表页仍残留弹窗编辑器的表单代码');
    assert.doesNotMatch(dashboard, /window\.prompt/, '排序不应再使用原生 prompt');
    assert.doesNotMatch(dashboard, /linear-gradient/, '主按钮不应再使用渐变（后台统一扁平主色）');
    assert.match(dashboard, /setSort/);
});
