/* ══ 内置主题编辑器：共享常量（纯数据，零 DOM 依赖）══════════════════════════
   拆成独立文件是为了让 tests/theme-editor-base.test.mjs 能直接在 vm 里加载它做一致性校验。
   本文件只挂一个全局对象，不做任何 DOM 访问，也不读 localStorage。

   三个「必须与客户端/服务端保持一致」的同步点，由 theme-editor-base.test.mjs 守着：
   1) COLOR_DEFS   ← MoonYa-Frontend/src/appearance.js          (COLOR_DEFS)
                   ← MoonYa-Backend/Services/BuiltinThemeService.php (COLOR_KEYS)
   2) BASE         ← MoonYa-Frontend/src/styles/css-32-theme.css     (--theme-* / --ui-*)
                   ← MoonYa-Frontend/src/styles/css-01-base.css       (浅色 --ui-*)
   3) SCHEME       ← 由 BASE 派生，不需手工核对

   为什么 BASE 里没有 --ui-shell / --ui-sidebar：
   客户端 .app-shell 会把它们重绑为 var(--theme-shell) / var(--theme-sidebar)
   （css-24-app-shell.css:2），预览里的 .tp-app-shell 也照抄这条重绑，
   所以主背景/侧边栏真正生效的杠杆是 --theme-*，--ui-* 只在 shell 之外有意义。
   --moonya-input-bg / --moonya-input-text / --moonya-btn-bg / --moonya-btn-text
   在客户端就没有基底定义（消费处带 fallback，见 css-33-appearance.css:72-97），
   所以这里也不定义，靠预览 CSS 里的 var(--x, fallback) 复刻。
*/
(function () {
    'use strict';

    /* 配色分组（仅用于编辑器里的视觉分组，顺序不影响下发结果）。 */
    var COLOR_GROUPS = [
        { title: '背景层', keys: ['appBackground', 'sidebar', 'surface', 'border'] },
        { title: '交互元素', keys: ['inputBackground', 'inputText', 'buttonBackground', 'buttonText', 'accent'] },
        { title: '文字', keys: ['textPrimary', 'textSecondary'] }
    ];

    /* 配色键 → CSS 变量落点。键的顺序与集合必须与 BuiltinThemeService::COLOR_KEYS 完全一致。 */
    var COLOR_DEFS = [
        { key: 'appBackground', label: '主背景', vars: ['--ui-shell', '--theme-shell'] },
        { key: 'sidebar', label: '侧边栏', vars: ['--theme-sidebar', '--ui-sidebar'] },
        { key: 'surface', label: '卡片 / 面板 / 气泡', vars: ['--theme-surface', '--dsw-specific-bubble', '--ui-bg'], rgb: '--theme-surface-rgb' },
        { key: 'inputBackground', label: '输入框背景', vars: ['--moonya-input-bg'] },
        { key: 'inputText', label: '输入框文字', vars: ['--moonya-input-text'] },
        { key: 'buttonBackground', label: '按钮背景', vars: ['--moonya-btn-bg'] },
        { key: 'buttonText', label: '按钮文字', vars: ['--moonya-btn-text'] },
        { key: 'border', label: '边框', vars: ['--theme-border', '--ui-border'] },
        { key: 'accent', label: '强调色', vars: ['--ui-accent', '--theme-accent-text'] },
        { key: 'textPrimary', label: '正文文字', vars: ['--theme-text'] },
        { key: 'textSecondary', label: '次要文字', vars: ['--theme-secondary'] }
    ];

    /* 明暗基底真值。浅色取自 css-32-theme.css 的 :root 与 css-01-base.css 的 :root；
       深色取自 css-32-theme.css 的 :root[data-theme="dark"]。
       值是「客户端真实生效值」，改动前端主题必须先改本表，否则守卫测试会红。 */
    var BASE = {
        light: {
            '--theme-shell': '#f1eff4',
            '--theme-sidebar': '#fbfafd',
            '--theme-surface': '#ffffff',
            '--theme-surface-rgb': '255, 255, 255',
            '--theme-soft': '#f4f4f6',
            '--theme-hover': '#e9e9ed',
            '--theme-border': '#e5e4e8',
            '--theme-text': '#26272b',
            '--theme-secondary': '#62646d',
            '--theme-muted': '#767983',
            '--theme-accent-soft': '#e8f2ff',
            '--theme-accent-text': '#2168bd',
            '--ui-bg': '#ffffff',
            '--ui-border': '#e5e4e8',
            '--ui-text': '#26272b',
            '--ui-muted': '#8a8a90',
            '--ui-hover': '#eeeeef',
            '--ui-accent': '#3b82f6'
        },
        dark: {
            '--theme-shell': '#18191d',
            '--theme-sidebar': '#1b1c20',
            '--theme-surface': '#1e1f23',
            '--theme-surface-rgb': '30, 31, 35',
            '--theme-soft': '#27282e',
            '--theme-hover': '#32343b',
            '--theme-border': '#383a43',
            '--theme-text': '#eeeef2',
            '--theme-secondary': '#bec0cb',
            '--theme-muted': '#a4a6b1',
            '--theme-accent-soft': '#24354d',
            '--theme-accent-text': '#92bdff',
            '--ui-bg': '#1e1f23',
            '--ui-border': '#383a43',
            '--ui-text': '#eeeef2',
            '--ui-muted': '#a4a6b1',
            '--ui-hover': '#32343b',
            '--ui-accent': '#80b4ff'
        }
    };

    /* 未自定义配色时，客户端消费处的兜底值（css-33-appearance.css:72-97）。 */
    var COLOR_FALLBACK = {
        inputBackground: '--ui-bg',
        inputText: '--theme-text',
        buttonBackground: null,
        buttonText: null
    };
    var COLOR_HARD_FALLBACK = {
        buttonBackground: '#3a83f7',
        buttonText: '#ffffff'
    };

    /* 一键填充用的整配色。浅色直接取基底；深色同样取基底，
       只有「发送按钮」两项沿用客户端写死的兜底（css-33 里 #sendBtn 的 fallback 不随明暗变化）。 */
    var SCHEME = {
        light: {
            appBackground: BASE.light['--theme-shell'],
            sidebar: BASE.light['--theme-sidebar'],
            surface: BASE.light['--theme-surface'],
            border: BASE.light['--theme-border'],
            inputBackground: BASE.light['--ui-bg'],
            inputText: BASE.light['--theme-text'],
            buttonBackground: COLOR_HARD_FALLBACK.buttonBackground,
            buttonText: COLOR_HARD_FALLBACK.buttonText,
            accent: BASE.light['--ui-accent'],
            textPrimary: BASE.light['--theme-text'],
            textSecondary: BASE.light['--theme-secondary']
        },
        dark: {
            appBackground: BASE.dark['--theme-shell'],
            sidebar: BASE.dark['--theme-sidebar'],
            surface: BASE.dark['--theme-surface'],
            border: BASE.dark['--theme-border'],
            inputBackground: BASE.dark['--ui-bg'],
            inputText: BASE.dark['--theme-text'],
            buttonBackground: COLOR_HARD_FALLBACK.buttonBackground,
            buttonText: COLOR_HARD_FALLBACK.buttonText,
            accent: BASE.dark['--ui-accent'],
            textPrimary: BASE.dark['--theme-text'],
            textSecondary: BASE.dark['--theme-secondary']
        }
    };

    window.MoonYaThemeBase = Object.freeze({
        COLOR_GROUPS: COLOR_GROUPS,
        COLOR_DEFS: COLOR_DEFS,
        COLOR_KEYS: COLOR_DEFS.map(function (def) { return def.key; }),
        COLOR_FALLBACK: COLOR_FALLBACK,
        COLOR_HARD_FALLBACK: COLOR_HARD_FALLBACK,
        BASE: BASE,
        SCHEME: SCHEME
    });
})();
