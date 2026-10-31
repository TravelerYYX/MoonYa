.subagent-turn-list { width:100%; box-sizing:border-box; padding:0 20px; margin:4px 0 12px; }
.subagent-header { display:flex; align-items:center; gap:6px; width:100%; min-width:0; min-height:30px; padding:3px 0; border:0; background:none; text-align:left; color:var(--dsw-alias-label-secondary,#777); cursor:pointer; font:inherit; font-size:13px; }
.subagent-header:hover { color:var(--dsw-alias-label-primary,#333); }
.subagent-header:focus-visible { outline:2px solid var(--primary-color,#e66b80); outline-offset:2px; border-radius:4px; }
.subagent-icon,.subagent-chevron { display:inline-flex; flex:none; width:16px; height:16px; }
.subagent-icon svg,.subagent-chevron svg { width:100%; height:100%; }
.subagent-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.subagent-status { flex:none; white-space:nowrap; font-size:12px; color:var(--dsw-alias-label-tertiary,#999); }
.subagent-chevron { transition:transform 100ms ease; }
.subagent-header[aria-expanded="true"] .subagent-chevron { transform:rotate(90deg); }
.subagent-disclosure[data-state="failed"] .subagent-status,.subagent-error { color:#c85a6f; }
.subagent-disclosure[data-state="running"] .subagent-icon { color:var(--primary-color,#e66b80); }
.subagent-detail { padding:8px 0 14px 22px; font-size:13px; overflow-wrap:anywhere; }
.subagent-detail[hidden] { display:none; }
.subagent-detail h4 { margin:10px 0 5px; font-size:13px; font-weight:500; }
.subagent-relations { color:var(--dsw-alias-label-tertiary,#999); font-size:12px; }
.subagent-task,.subagent-record { white-space:pre-wrap; }
.subagent-task { max-height:200px; overflow:auto; }
.subagent-record,.subagent-output { margin:6px 0; }
.subagent-log { max-height:360px; overflow:auto; }
.subagent-tool-record.tool-row { display:block; height:auto; overflow:visible; margin:8px 0; }
.subagent-tool-name { font-size:12px; color:var(--dsw-alias-label-secondary,#777); }
.subagent-tool-record .codex-tool-detail { display:block; }
.subagent-detail pre { overflow:auto; max-width:100%; }
@media(max-width:600px) { .subagent-turn-list { padding:0 12px; } }
