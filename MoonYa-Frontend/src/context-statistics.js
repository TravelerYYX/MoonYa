(function () {
    'use strict';
    window.MoonYaStatisticsPanel = {
        create(hooks) {
            const trigger = document.getElementById('contextRingTrigger');
            const panel = document.getElementById('contextRingTooltip');
            if (!trigger || !panel) return null;
            const sections = Array.from(panel.querySelectorAll('[data-stat-section]'));
            // 三个分区默认全部展开（未手工折叠过的会话打开即看到完整明细）
            const defaults = { tokens: true, timing: true, context: true };
            const states = new Map();
            let scope = null, revision = -1, querySeq = 0, restoring = false, open = false;
            let poll = null;
            document.body.appendChild(panel);
            const active = () => String(hooks.chatId() || 'draft');
            const text = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
            const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
            const count = value => known(value) ? Math.round(value).toLocaleString('en-US') + ' tok' : '暂不可用';
            const seconds = value => known(value) && value > 0 && value < 100 ? '<0.1秒' : known(value) ? (value / 1000).toFixed(1).replace(/\.0$/, '') + '秒' : '暂不可用';
            const duration = value => !known(value) ? '暂不可用' : value < 60000 ? seconds(value)
                : Math.floor(Math.round(value / 1000) / 60) + '分' + Math.round(value / 1000) % 60 + '秒';
            function note(id, status, running) {
                const el = document.getElementById(id);
                el.hidden = status === 'complete' && !running;
                el.textContent = running ? '调用进行中，显示已记录的统计' : status === 'partial' ? '部分记录：仅统计已有真实数据' : '暂不可用：尚无完整记录';
            }
            function unavailable(label) {
                ['crtTokenTotal','crtCacheHit','crtUncachedInput','crtCacheRead','crtCacheWrite','crtOutputTokens',
                    'crtModelTime','crtToolTime','crtTtft','crtTps'].forEach(id => text(id, label || '暂不可用'));
                document.getElementById('crtCacheWriteRow').hidden = true;
                note('crtTokenNote', 'unavailable', false); note('crtTimingNote', 'unavailable', false);
            }
            function restore() {
                const next = active();
                if (scope !== next) {
                    close(false); scope = next; revision = -1; ++querySeq; unavailable('读取中');
                }
                const chat = hooks.chat();
                const values = states.get(next) || chat?.statisticsExpanded || defaults;
                restoring = true;
                sections.forEach(section => { section.open = Boolean(values[section.dataset.statSection]); });
                // Toggle events are dispatched asynchronously, so handlers compare saved values too.
                states.set(next, { ...values }); restoring = false;
            }
            function position() {
                if (!open) return;
                const rect = trigger.getBoundingClientRect();
                const width = panel.offsetWidth, height = panel.offsetHeight;
                const viewportWidth = document.documentElement.clientWidth, viewportHeight = window.innerHeight;
                panel.style.left = Math.max(8, Math.min(viewportWidth - width - 8, rect.right - width)) + 'px';
                let top = rect.top - height - 10;
                if (top < 8 && rect.bottom + height + 10 <= viewportHeight - 8) top = rect.bottom + 10;
                panel.style.top = Math.max(8, Math.min(viewportHeight - height - 8, top)) + 'px';
            }
            function close(focus) {
                open = false; panel.hidden = true; panel.inert = true; panel.setAttribute('aria-hidden', 'true');
                trigger.setAttribute('aria-expanded', 'false');
                clearInterval(poll); poll = null;
                if (focus) trigger.focus();
            }
            async function refresh() {
                restore();
                const chatId = active(), seq = ++querySeq, chat = hooks.chat();
                if (chatId === 'draft') { unavailable(); return; }
                const model = hooks.model();
                const params = new URLSearchParams({ client_chat_id: chatId, has_history: chat?.messages?.length ? '1' : '0',
                    model_id: model.id || '', limit_tokens: String(model.limit || ''), session_id: hooks.sessionId() || '', mode: hooks.mode() });
                if (chat?.dbConversationId) params.set('conversation_id', String(chat.dbConversationId));
                if (model.reference) params.set('model_ref', JSON.stringify(model.reference));
                try {
                    const response = await fetch('statistics.php?' + params.toString(), { headers: hooks.headers() });
                    const result = await response.json();
                    if (seq !== querySeq || chatId !== active()) return;
                    if (!response.ok || !result.success || !result.data) { unavailable(); return; }
                    if (apply(result.data, chatId) && result.data.context) hooks.context(result.data.context);
                } catch (error) { if (seq === querySeq && chatId === active()) unavailable(); }
                position();
            }
            function apply(data, chatId) {
                if (!data || String(chatId || data.client_chat_id) !== active() || String(data.client_chat_id) !== active()) return false;
                if (scope !== active()) restore();
                if (typeof data.revision !== 'number' || data.revision < revision) return false;
                revision = data.revision;
                const usage = data.token_usage || {}, timing = data.timing || {}, complete = data.completeness || {};
                text('crtTokenTotal', (complete.token_usage === 'partial' && known(usage.total) ? '已记录 ' : '') + count(usage.total));
                text('crtCacheHit', known(usage.cache_hit_percent) ? (usage.cache_hit_percent >= 99.95 && usage.cache_hit_percent < 100
                    ? '<100' : usage.cache_hit_percent.toFixed(1).replace(/\.0$/, '')) + '%' : '暂不可用');
                [['crtUncachedInput','input'],['crtCacheRead','cache_read'],['crtCacheWrite','cache_write'],['crtOutputTokens','output']].forEach(([id,key]) => text(id, count(usage[key])));
                document.getElementById('crtCacheWriteRow').hidden = !known(usage.cache_write) || usage.cache_write === 0;
                text('crtModelTime', duration(timing.llm_ms)); text('crtToolTime', duration(timing.tool_ms)); text('crtTtft', seconds(timing.ttft_ms));
                text('crtTps', known(timing.tps) ? Math.round(timing.tps * 10) / 10 + ' tok/s' : '暂不可用');
                note('crtTokenNote', complete.token_usage, complete.running); note('crtTimingNote', complete.timing, complete.running);
                position(); return true;
            }
            sections.forEach(section => section.addEventListener('toggle', () => {
                if (restoring || scope !== active()) return;
                const previous = states.get(scope) || defaults;
                const values = Object.fromEntries(sections.map(item => [item.dataset.statSection, item.open]));
                if (JSON.stringify(previous) === JSON.stringify(values)) return;
                states.set(scope, values); hooks.saveExpanded(values); position();
            }));
            trigger.addEventListener('click', () => {
                restore();
                if (open) { close(false); return; }
                open = true; panel.hidden = false; panel.inert = false; panel.setAttribute('aria-hidden', 'false');
                trigger.setAttribute('aria-expanded', 'true'); position();
                panel.querySelector('summary')?.focus();
                void hooks.refreshContext(); void refresh();
                poll = setInterval(() => { if (open) void refresh(); }, 2000);
            });
            document.getElementById('crtClose').addEventListener('click', () => close(true));
            document.addEventListener('pointerdown', event => { if (open && !panel.contains(event.target) && !trigger.contains(event.target)) close(false); });
            document.addEventListener('keydown', event => { if (open && event.key === 'Escape') { event.preventDefault(); close(true); } });
            window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
            restore();
            return { refresh, apply, scopeChanged: restore, position };
        }
    };
})();
