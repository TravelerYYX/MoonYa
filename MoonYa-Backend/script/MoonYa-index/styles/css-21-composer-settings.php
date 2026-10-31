/* Composer toolbar dimensions match the compact reference at 100% zoom. */
.input-bottom-right { gap: 10px; }
.input-bottom-right .context-ring-wrap { width: 20px; height: 28px; margin-right: 0; }
.input-bottom-right .context-ring-trigger { width: 20px; height: 28px; }
.input-bottom-right .context-ring-svg { width: 12px; height: 12px; }
.input-bottom-right .context-ring-bg { stroke: #e6e6e6; }
.input-bottom-right .context-ring-fill { stroke: #8b9096; }
.input-bottom-right .agent-settings-status {
    height: 28px;
    gap: 4px;
    padding: 0 2px;
    font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
    font-size: 13px;
    font-weight: 400;
    line-height: 16px;
    white-space: nowrap;
}
#agentModelStatusText { color: #1a1c1f; font-size: 13px; letter-spacing: 0; }
#agentEffortStatusText { color: #999a9d; font-size: 13px; }
.input-bottom-right .agent-settings-status svg { width: 12px; height: 12px; margin-left: 2px; stroke: #85878b; stroke-width: 1.4; }
#voiceBtn { display: flex; align-items: center; justify-content: center; flex: 0 0 24px; width: 24px; height: 28px; margin: 0; cursor: pointer; border-radius: 6px; }
#voiceBtn:hover { background: #f0f1f3; }
#voiceBtnImg { display: block; width: 16px; height: 16px; margin: 0; }
#sendBtn { flex: 0 0 28px; width: 28px; height: 28px; background-color: #3a83f7; cursor: pointer; }
#sendBtn:hover { background-color: #2f76ed; }
#sendBtn #sendBtnImg { display: block; width: 16px; height: 16px; margin: 0; }
#sendBtn[data-state=stop] svg { display: block; width: 10px; height: 10px; }
@media (max-width: 680px) { .input-bottom-right { gap: 4px; } }

/* Compact custom reasoning menu. Both directions stay mounted for transitions. */
.agent-settings-popover {
    display: block;
    width: 254px;
    padding: 11px 12px 10px;
    border: 1px solid #e8e8eb;
    border-radius: 17px;
    background: rgba(255,255,255,.98);
    box-shadow: 0 6px 16px rgba(28,32,40,.07), 0 2px 5px rgba(28,32,40,.025);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transform: translateY(8px) scale(.96);
    transform-origin: bottom right;
    transition: opacity .18s ease, transform .26s cubic-bezier(.22,1,.36,1), visibility 0s .26s;
    --effort-color: #3982ff;
}
.agent-settings-selector.open .agent-settings-popover {
    animation: none;
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transform: translateY(0) scale(1);
    transition-delay: 0s;
}
.agent-settings-heading { display: grid; grid-template-columns: 26px minmax(0,1fr) 26px; align-items: center; height: 22px; }
.agent-settings-heading > span { text-align: center; color: var(--effort-color); font-size: 13px; font-weight: 600; line-height: 20px; transition: color .2s; }
.agent-settings-heading button { display: grid; place-items: center; width: 26px; height: 26px; padding: 5px; border: 0; border-radius: 7px; background: transparent; color: #939397; cursor: pointer; }
.agent-settings-heading button:hover, .agent-settings-heading button[aria-expanded=true] { background: #f3f3f6; color: var(--effort-color); }
.agent-settings-heading svg { width: 15px; height: 15px; margin: 0; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.agent-settings-popover:is([data-flow=normal],[data-flow=fast]) { --effort-color: #994dff; }
.agent-settings-popover[data-flow=fast] { --flight-speed: .6; }
.agent-settings-popover:is([data-flow=normal],[data-flow=fast]) .agent-effort-icon { color: var(--effort-color); fill: currentColor; }
.agent-settings-popover[data-effort=none], .agent-settings-popover[data-effort=auto] { --effort-color: #85858f; }
.agent-settings-caption { display: flex; align-items: center; justify-content: center; width: 100%; min-width: 0; height: 22px; margin: 2px 0 8px; padding: 0 18px; border: 0; border-radius: 6px; background: transparent; color: #828286; font: inherit; font-size: 11px; cursor: pointer; }
.agent-settings-caption:hover { color: #52525d; background: #f7f7f9; }
#agentSettingsCaptionModel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-settings-caption .ui-chevron-icon { flex-shrink: 0; width: 9px; height: 9px; }
.agent-settings-caption[aria-expanded=true] .ui-chevron-icon { transform: rotate(90deg); }
.agent-effort-control { border: 0; margin: 0; padding: 0; }
.agent-effort-slider-wrap { height: 28px; }
.agent-effort-dots { display: none; }
.effort-spring-slider { position: relative; width: 100%; height: 28px; touch-action: none; cursor: grab; }
.effort-spring-slider.dragging { cursor: grabbing; }
.effort-spring-slider input[type=range] { position: absolute; inset: 0; width: 100%; height: 28px; margin: 0; opacity: 0; pointer-events: none; }
.effort-slider-visual { position: absolute; inset: 2px 0; border-radius: 99px; background: #e8e8e8; pointer-events: none; }
.effort-slider-fill { position: absolute; inset: 0 auto 0 0; width: calc(13px + (100% - 26px) * var(--slider-position,0)); border-radius: inherit; background: #3982ff; transition: background .25s; }
.effort-slider-fill::before { content: ''; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(100deg,#637dff 0%,#785bff 36%,#9b4fff 68%,#bc51fa 100%); opacity: 0; transition: opacity .3s ease; }
.effort-slider-stops { position: absolute; inset: 0 13px; }
.effort-slider-stops i { position: absolute; left: calc(100% * var(--stop)); top: 50%; width: 4px; height: 4px; transform: translate(-50%,-50%); border-radius: 50%; background: #b6b6ba; transition: background .18s; }
.effort-slider-stops i.filled { background: rgba(255,255,255,.48); }
.effort-slider-thumb { position: absolute; left: calc(13px + (100% - 26px) * var(--slider-position,0)); top: 50%; width: 28px; height: 28px; border: 1px solid #e3e3e7; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(30,35,50,.05); transform: translate(-50%,-50%); transition: box-shadow .2s, width .2s, height .2s; }
.dragging .effort-slider-thumb { width: 30px; height: 30px; box-shadow: 0 2px 7px rgba(40,65,110,.12); }
.effort-spring-slider:has(input:focus-visible) .effort-slider-visual { outline: 2px solid var(--effort-color,#3982ff); outline-offset: 4px; }
.effort-spring-slider.disabled { opacity: .45; cursor: default; }
.effort-slider-stars { position: absolute; inset: 0 auto 0 0; width: calc(13px + (100% - 26px) * var(--slider-position,0)); border-radius: inherit; overflow: hidden; opacity: 0; transition: opacity .3s; }
.effort-slider-particle { position: absolute; left: 0; right: 0; top: var(--lane); height: var(--particle-size); opacity: 0; animation: effort-particle-flight calc(var(--flight-duration) * var(--flight-speed,1)) linear var(--flight-delay) infinite; animation-play-state: paused; will-change: transform,opacity; }
.effort-slider-particle::before { content: ''; display: block; width: var(--particle-trail); height: 100%; border-radius: 99px; background: linear-gradient(90deg,rgba(255,255,255,.9),rgba(255,255,255,.18) 65%,transparent); }
.effort-slider-particle::after { content: ''; position: absolute; top: 0; left: 0; width: var(--particle-size); height: var(--particle-size); border-radius: 50%; background: #fff; box-shadow: 0 0 3px rgba(255,255,255,.7); }
.agent-settings-popover:is([data-flow=normal],[data-flow=fast]) .effort-slider-fill::before { opacity: 1; }
.agent-settings-popover:is([data-flow=normal],[data-flow=fast]) .effort-slider-stars { opacity: 1; }
.agent-settings-popover:is([data-flow=normal],[data-flow=fast]) .effort-slider-stops { opacity: .35; }
.agent-settings-selector.open .agent-settings-popover:is([data-flow=normal],[data-flow=fast]) .effort-slider-particle { animation-play-state: running; }
@keyframes effort-particle-flight {
    0% { transform: translate3d(110%,0,0); opacity: 0; }
    9% { opacity: .8; }
    78% { opacity: .8; }
    100% { transform: translate3d(-10%,0,0); opacity: 0; }
}
.agent-settings-advanced { max-height: 200px; overflow: visible; margin-top: 10px; padding-top: 8px; }
.agent-advanced-heading { padding: 0 7px 5px; color: #96969f; font-size: 11px; }
.agent-context-section { padding: 6px 7px 0; border: 0; }
.agent-context-label { font-size: 12px; }
.agent-settings-popover .cm-session-effort { margin: 0; padding: 0; }
.agent-settings-popover .cm-session-effort[hidden] { display: none; }
.agent-settings-popover .cm-effort-control { margin: 0; }
.agent-settings-popover .cm-effort-heading, .agent-settings-popover .cm-effort-ticks { display: none; }
.agent-settings-popover .cm-thinking-switch { padding: 4px 2px; font-size: 12px; }
.agent-settings-popover .cm-thinking-switch input[role=switch] { position: relative; width: 28px; height: 17px; margin: 0; appearance: none; border: 0; border-radius: 99px; background: #dedee4; cursor: pointer; transition: background .2s; }
.agent-settings-popover .cm-thinking-switch input[role=switch]::before { content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.12); transition: transform .22s cubic-bezier(.22,1,.36,1); }
.agent-settings-popover .cm-thinking-switch input[role=switch]:checked { background: #3982ff; }
.agent-settings-popover .cm-thinking-switch input[role=switch]:checked::before { transform: translateX(11px); }
.agent-settings-popover .cm-thinking-switch input[role=switch]:disabled { opacity: .45; cursor: default; }
.agent-model-check { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.agent-model-menu, .context-picker-menu { opacity: 1; visibility: visible; transform: translateY(0) scale(1); transform-origin: bottom center; transition: opacity .16s ease, transform .22s cubic-bezier(.22,1,.36,1), visibility 0s; }
.agent-model-menu[hidden], .context-picker-menu[hidden] { display: block !important; opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(5px) scale(.97); transition-delay: 0s,0s,.22s; }
.context-model-length { position: relative; }
.context-custom-picker { position: relative; }
.context-picker-trigger { display: flex; align-items: center; gap: 12px; min-width: 68px; height: 28px; padding: 0 8px; border: 1px solid #e1e1e6; border-radius: 8px; background: #fff; color: #62626a; font: inherit; cursor: pointer; }
.context-picker-trigger svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; transition: transform .2s; }
.context-picker-trigger[aria-expanded=true] svg { transform: rotate(180deg); }
.context-picker-menu { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 2; min-width: 110px; max-height: min(220px,35vh); overflow-y: auto; padding: 4px; border: 1px solid #e7e7ec; border-radius: 10px; background: #fff; box-shadow: 0 7px 24px rgba(24,30,44,.12); }
.context-picker-menu button { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; min-height: 30px; padding: 4px 8px; border: 0; border-radius: 6px; background: transparent; color: #60606a; font: inherit; cursor: pointer; }
.context-picker-menu button:hover, .context-picker-menu button[aria-selected=true] { background: #f1f5ff; color: #3982ff; }
.context-picker-menu svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; visibility: hidden; }
.context-picker-menu button[aria-selected=true] svg { visibility: visible; }
.agent-settings-popover button:focus-visible { outline: 2px solid #3982ff; outline-offset: 2px; }
@media (max-width:680px) { .agent-settings-popover { width: min(254px,calc(100vw - 24px)); } }
@media (prefers-reduced-motion:reduce) {
    .agent-settings-popover, .agent-settings-popover *, .agent-settings-popover *::before { transition: none !important; animation: none !important; }
}
