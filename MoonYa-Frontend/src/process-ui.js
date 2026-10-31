/* Shared chronological process disclosures for main chat and child agents. */
(function (root) {
    'use strict';
    const animations = new Map();
    const transitions = new Map(), widths = new Map();
    const indexes = new WeakMap(), pending = new Set();
    const rowSelector = '.tool-row, .process-row, .execution-block-host';
    let refreshFrame = 0, cleanupFrame = 0;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let suppressed = 0, animationStyle = 'soft';
    try { animationStyle = localStorage.getItem('moonya.processAnimationStyle') === 'glass' ? 'glass' : 'soft'; } catch (_) {}
    document.documentElement.dataset.processAnimationStyle = animationStyle;
    function getAnimationStyle() { return animationStyle; }
    function motionOptions(disclosure = false) {
        return { duration: animationStyle === 'glass' ? (disclosure ? 340 : 360) : (disclosure ? 260 : 240),
            easing: animationStyle === 'glass' ? 'cubic-bezier(.22,.8,.22,1)' : 'cubic-bezier(.2,.7,.2,1)' };
    }
    function withoutAnimation(callback) {
        suppressed++;
        try { return callback(); } finally { flush(); suppressed--; }
    }
    // Animation maps must not retain a chat that was removed during a transition.
    function scheduleMotionCleanup() {
        if (cleanupFrame) return;
        cleanupFrame = root.requestAnimationFrame(() => {
            cleanupFrame = 0;
            transitions.forEach((_, node) => { if (!node.isConnected) cancelTransition(node); });
            widths.forEach((animation, node) => {
                if (!node.isConnected) { animation.onfinish = null; animation.cancel(); widths.delete(node); }
            });
            animations.forEach((animation, body) => {
                if (!body.isConnected) { const settle = animation.onfinish; animation.onfinish = null; animation.cancel(); settle?.(); }
            });
            if (transitions.size || widths.size || animations.size) scheduleMotionCleanup();
        });
    }
    function cancelTransition(node) {
        const current = transitions.get(node);
        if (!current) return;
        current.incoming.onfinish = null; current.incoming.cancel();
        current.outgoing.cancel(); current.ghost.remove(); transitions.delete(node);
    }
    function clearMotion() {
        [...transitions.keys()].forEach(cancelTransition);
        widths.forEach(animation => { animation.onfinish = null; animation.cancel(); }); widths.clear();
        // Settle disclosures at their latest requested state when preferences change.
        [...animations.values()].forEach(animation => { const settle = animation.onfinish; animation.onfinish = null; animation.cancel(); settle?.(); });
    }
    function setAnimationStyle(style) {
        clearMotion();
        animationStyle = style === 'glass' ? 'glass' : 'soft';
        document.documentElement.dataset.processAnimationStyle = animationStyle;
        try { localStorage.setItem('moonya.processAnimationStyle', animationStyle); } catch (_) {}
        root.dispatchEvent(new CustomEvent('moonya:process-animation-change', { detail: { style: animationStyle } }));
        return animationStyle;
    }
    reducedMotion.addEventListener('change', clearMotion);
    root.addEventListener('storage', event => {
        if (event.key !== 'moonya.processAnimationStyle' && event.key !== null) return;
        clearMotion();
        animationStyle = event.newValue === 'glass' && event.key !== null ? 'glass' : 'soft';
        document.documentElement.dataset.processAnimationStyle = animationStyle;
        root.dispatchEvent(new CustomEvent('moonya:process-animation-change'));
    });
    // Ghosts live outside messages so neither history serialization nor accessibility sees them.
    // Cancel on scroll/resize rather than letting a fixed snapshot drift away from its row.
    document.addEventListener('scroll', () => [...transitions.keys()].forEach(cancelTransition), true);
    root.addEventListener('resize', clearMotion);
    function setVisual(node, value, html = false, key = value) {
        if (!node) return;
        const field = html ? 'innerHTML' : 'textContent';
        if (node.__processVisualValue === value && node.__processVisualKey === key) return;
        const old = node[field], initialized = node.__processVisualKey !== undefined;
        // Do not force layout for newly created, hidden or replayed content.
        const visible = initialized && old && !suppressed && !reducedMotion.matches && node.animate && node.isConnected
            && !node.closest('[hidden]') && node.checkVisibility({ contentVisibilityAuto: true });
        const rect = visible ? node.getBoundingClientRect() : null;
        const computed = rect?.width && rect.height ? getComputedStyle(node) : null;
        const opacity = computed?.opacity, transform = computed?.transform, color = computed?.color, font = computed?.font;
        const parent = node.parentElement;
        const glassHeader = animationStyle === 'glass' && parent?.classList.contains('turn-process-header');
        const oldWidth = computed && glassHeader ? parent.getBoundingClientRect().width : 0;
        cancelTransition(node);
        node[field] = value; node.__processVisualKey = key; node.__processVisualValue = value;
        if (!computed) return;
        const ghost = element('span', 'process-motion-ghost');
        ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true; ghost[field] = old;
        Object.assign(ghost.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', color, font });
        document.body.appendChild(ghost);
        const interrupted = opacity !== '1' || transform !== 'none';
        const glass = animationStyle === 'glass', options = motionOptions();
        const incoming = node.animate([
            { opacity: interrupted ? opacity : 0, transform: interrupted ? transform : `translateY(4px) scale(${glass ? '.98' : '1'})` },
            { opacity: 1, transform: `translateY(${glass ? '-.5px' : '0'}) scale(1)`, offset: .8 },
            { opacity: 1, transform: 'none' }
        ], options);
        const outgoing = ghost.animate([{ opacity, transform: interrupted ? transform : 'none' },
            { opacity: 0, transform: `translateY(-4px) scale(${glass ? '.98' : '1'})` }], options);
        transitions.set(node, { incoming, outgoing, ghost });
        scheduleMotionCleanup();
        incoming.onfinish = () => { if (transitions.get(node)?.incoming === incoming) cancelTransition(node); };
        if (glassHeader) {
            const previous = widths.get(parent);
            if (previous) { previous.onfinish = null; previous.cancel(); }
            const to = parent.getBoundingClientRect().width;
            if (Math.abs(oldWidth - to) > .5) {
                const animation = parent.animate([{ width: oldWidth + 'px' }, { width: to + 'px' }], options);
                widths.set(parent, animation);
                animation.onfinish = () => { if (widths.get(parent) === animation) { animation.cancel(); widths.delete(parent); } };
            } else widths.delete(parent);
        }
    }
    function setActive(node, active) {
        if (!node) return;
        const wasActive = node.hasAttribute('data-process-active');
        if (wasActive === !!active) return;
        node.toggleAttribute('data-process-active', !!active);
        // Offscreen containment can defer style recalculation. Explicitly stop
        // an existing sweep so terminal rows never keep a stale CSS animation.
        if (wasActive && !active) node.getAnimations({ subtree: true }).forEach(animation => {
            if (animation.animationName === 'process-white-sweep') animation.cancel();
        });
    }
    const live = { edit: '编辑文件', command: '运行命令', read: '读取文件', search: '搜索内容', image: '查看图像', browser: '操作浏览器', other: '执行操作' };
    function element(tag, cls, text) {
        const node = document.createElement(tag); node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function arrow(cls) {
        const node = element('span', cls + ' process-arrow');
        node.innerHTML = root.MoonYaIcons.icon('chevron');
        return node;
    }
    function disclose(header, body, open, animate = true) {
        if (!header || !body) return;
        discloseBodies(header, [body], open, animate);
    }
    function discloseBodies(header, bodies, open, animate = true) {
        if (animate) flush();
        const visible = animate && !suppressed && !reducedMotion.matches
            && !header.closest('[hidden]') && header.checkVisibility({ contentVisibilityAuto: true });
        const spacing = ['marginTop', 'marginBottom', 'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'];
        const zero = Object.fromEntries(spacing.map(property => [property, '0px']));
        // Read every current box before changing any of them. A duration click can
        // collapse many interleaved segments; measuring after each write forces
        // the browser to lay out the same conversation repeatedly.
        const records = bodies.map(body => {
            const moving = visible && body.animate && body.isConnected;
            const shown = moving && !body.hidden;
            const computed = shown ? getComputedStyle(body) : null;
            return { body, moving, from: {
                height: (shown ? body.getBoundingClientRect().height : 0) + 'px',
                opacity: shown ? computed.opacity : 0,
                ...Object.fromEntries(spacing.map(property => [property, shown ? computed[property] : '0px']))
            } };
        });
        header.setAttribute('aria-expanded', String(open));
        header.toggleAttribute('data-open', open);
        const parent = header.parentElement;
        if (parent?.classList.contains('turn-process') || parent?.classList.contains('tool-row')) parent.toggleAttribute('data-open', open);
        records.forEach(record => {
            const { body, moving } = record;
            const previous = animations.get(body);
            if (previous) { previous.onfinish = null; previous.cancel(); animations.delete(body); }
            body.classList.remove('process-disclosure-animating');
            if (!open && body.contains(document.activeElement)) header.focus({ preventScroll: true });
            body.inert = !open;
            body.classList.add('process-disclosure-body');
            record.settle = () => {
                body.hidden = !open; body.style.removeProperty('height');
                body.classList.remove('process-disclosure-animating');
                if (body.matches('.process-segment, .process-commentary')) body.classList.remove('process-disclosure-body');
                const animation = animations.get(body);
                if (animation) { animation.onfinish = null; animation.cancel(); animations.delete(body); }
            };
            if (!moving) { record.settle(); return; }
            body.hidden = false;
            body.style.removeProperty('height');
        });
        // Measure all natural targets together, then start all animations together.
        records.forEach(record => {
            if (!record.moving) return;
            const { body } = record;
            const computed = open ? getComputedStyle(body) : null;
            record.to = open ? { height: body.getBoundingClientRect().height + 'px', opacity: 1,
                ...Object.fromEntries(spacing.map(property => [property, computed[property]])) }
                : { height: '0px', opacity: 0, ...zero };
        });
        records.forEach(record => {
            if (!record.moving) return;
            const { body } = record;
            body.classList.add('process-disclosure-animating');
            // Hold the zero-sized last frame until hidden is applied. Include the
            // whole box so margins/padding cannot move the reply again at finish.
            const animation = body.animate([record.from, record.to], { ...motionOptions(true), fill: 'both' });
            animations.set(body, animation);
            animation.onfinish = record.settle;
        });
        scheduleMotionCleanup();
    }
    function kind(tool, args = {}) {
        if (tool === 'edit_file' && args.command === 'view') return 'read';
        if (['edit_file', 'create_file', 'delete_file'].includes(tool)) return 'edit';
        if (['execute_command', 'execute_python', 'get_command_status', 'stop_command'].includes(tool)) return 'command';
        if (['grep', 'glob', 'web_search'].includes(tool)) return 'search';
        if (['read_file', 'view_directory', 'get_diagnostics', 'find_references', 'goto_definition', 'web_fetch', 'read_skill'].includes(tool)) return 'read';
        if (['read_image', 'view_image', 'cu_screenshot', 'ba_screenshot'].includes(tool)) return 'image';
        if (tool === 'browser_automation_control') return args.action === 'screenshot' ? 'image' : 'browser';
        return 'other';
    }
    function normalizePath(path, base = '') {
        let raw = String(path || '').replace(/\\/g, '/');
        if (raw && base && !/^(?:[a-z]:|\/)/i.test(raw)) raw = String(base).replace(/\\/g, '/') + '/' + raw;
        const parts = [];
        raw.split('/').forEach(part => { if (!part || part === '.') return; if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop(); else parts.push(part); });
        const normalized = (raw.startsWith('/') ? '/' : '') + parts.join('/');
        return normalized.toLowerCase();
    }
    function running(state) { return ['executing', 'running', 'thinking', 'pending'].includes(state); }
    function duration(message, elapsedMs) {
        let header = message.querySelector(':scope > .turn-duration');
        if (!header) {
            header = element('button', 'turn-duration'); header.type = 'button'; header.setAttribute('aria-expanded', 'true');
            const chevron = arrow('turn-duration-chevron');
            header.append(element('span', 'turn-duration-label'), chevron);
            message.insertBefore(header, message.querySelector(':scope > .message-content'));
        }
        elapsedMs = Math.max(0, Math.round(Number(elapsedMs) || 0));
        message.dataset.turnElapsed = String(elapsedMs);
        header.querySelector('.turn-duration-label').textContent = '用时 ' + root.formatTurnDuration(elapsedMs);
        return header;
    }
    function beginDuration(message, startedAt) {
        if (message.__codexElapsedTimer || message.dataset.turnCompletedAt) return;
        const start = Number(startedAt) || Date.now();
        message.dataset.turnStartedAt = new Date(start).toISOString();
        const update = () => duration(message, Date.now() - start);
        update();
        message.__codexElapsedTimer = root.setInterval(() => {
            if (!message.isConnected) { root.clearInterval(message.__codexElapsedTimer); message.__codexElapsedTimer = null; return; }
            update();
        }, 1000);
    }
    function endDuration(message, elapsedMs) {
        if (message.__codexElapsedTimer) { root.clearInterval(message.__codexElapsedTimer); message.__codexElapsedTimer = null; }
        message.dataset.turnCompletedAt = new Date().toISOString();
        return duration(message, elapsedMs);
    }
    function setStatus(message, status) {
        message.dataset.turnStatus = status;
        message.classList.toggle('is-interrupted', status === 'cancelled');
        const header = duration(message, Number(message.dataset.turnElapsed) || 0);
        let label = header.querySelector('.turn-status');
        if (status === 'cancelled') {
            if (!label) {
                label = element('span', 'turn-status');
                header.insertBefore(label, header.querySelector('.turn-duration-chevron'));
            }
            label.textContent = '已停止';
        } else if (label) label.remove();
    }
    function durationBodies(content) {
        if (!content) return [];
        // Everything before a later activity belongs to the process. Keep all
        // trailing reply blocks together, including prose, code and images.
        let beforeActivity = false;
        const bodies = [];
        [...content.children].reverse().forEach(node => {
            const process = node.classList.contains('process-segment');
            if (process) beforeActivity = true;
            const commentary = !process && beforeActivity && !node.matches('.subagent-turn-list, .workspace-changes-card, .loading-indicator');
            node.classList.toggle('process-commentary', commentary);
            if (process || commentary) bodies.push(node);
        });
        return bodies.reverse();
    }
    function toggleDuration(header) {
        const open = header.getAttribute('aria-expanded') !== 'true';
        discloseBodies(header, durationBodies(header.parentElement.querySelector(':scope > .message-content')), open);
    }
    function rowData(row, pathBase) {
        const tool = row.dataset.tool || row.dataset.toolName || row.dataset.toolCategory || '';
        const category = row.dataset.activityKind || kind(tool);
        const id = row.dataset.toolId || row;
        return { category, active: running(row.dataset.state || row.className.match(/status-(\w+)/)?.[1]),
            counted: tool !== 'get_command_status' && tool !== 'stop_command',
            key: category === 'edit' ? normalizePath(row.dataset.filePath || row.querySelector('[data-file-path]')?.dataset.filePath, pathBase) || id : id };
    }
    function removeIndexedRow(index, row) {
        const old = index.rows.get(row);
        if (!old) return;
        index.rows.delete(row);
        index.categories[old.category]?.delete(row); index.active[old.category]?.delete(row);
        if (old.counted && index.counts[old.category]) {
            const counts = index.counts[old.category], remaining = counts.get(old.key) - 1;
            if (remaining) counts.set(old.key, remaining); else counts.delete(old.key);
        }
        return true;
    }
    function indexRow(index, row) {
        const next = rowData(row, index.pathBase), old = index.rows.get(row);
        if (old && old.category === next.category && old.active === next.active && old.counted === next.counted && old.key === next.key) return;
        removeIndexedRow(index, row);
        index.rows.set(row, next); index.categories[next.category]?.add(row);
        if (next.active) index.active[next.category]?.add(row);
        if (next.counted && index.counts[next.category]) {
            const counts = index.counts[next.category]; counts.set(next.key, (counts.get(next.key) || 0) + 1);
        }
        if (index.segment) setActive(row.querySelector('.codex-tool-main'), !index.segment.complete && next.active);
        return true;
    }
    function applyIndexMutations(index, records) {
        const changed = new Set(), removed = new Set();
        for (const record of records) {
            if (record.type === 'attributes') {
                if (record.target.matches(rowSelector)) changed.add(record.target);
                else if (index.rows.has(record.target)) removed.add(record.target);
                else if (record.attributeName === 'data-file-path') {
                    const row = record.target.closest(rowSelector); if (row) changed.add(row);
                }
                continue;
            }
            // Detail/title changes do not alter the list. In particular, avoid
            // traversing every new output subtree while a command is streaming.
            if (record.target.closest(rowSelector + ', .reasoning-row, .reasoning-row-body')) continue;
            for (const node of record.removedNodes) {
                if (node.nodeType !== 1) continue;
                if (index.rows.has(node)) removed.add(node);
                else node.querySelectorAll(rowSelector).forEach(row => removed.add(row));
            }
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.matches(rowSelector)) changed.add(node);
                else node.querySelectorAll(rowSelector).forEach(row => changed.add(row));
            }
        }
        let dirty = false;
        removed.forEach(row => { if (!index.body.contains(row) || !row.matches(rowSelector)) dirty = removeIndexedRow(index, row) || dirty; });
        changed.forEach(row => { if (index.body.contains(row)) dirty = indexRow(index, row) || dirty; });
        if (dirty && index.segment) queueRefresh(index.segment);
    }
    function getIndex(segment) {
        let index = indexes.get(segment.body);
        if (!index) {
            const groups = factory => Object.fromEntries(Object.keys(live).map(key => [key, factory()]));
            index = { body: segment.body, pathBase: segment.pathBase, segment: segment.header && segment.label ? segment : null,
                rows: new Map(), counts: groups(() => new Map()),
                categories: groups(() => new Set()), active: groups(() => new Set()) };
            indexes.set(segment.body, index);
            segment.body.querySelectorAll(rowSelector).forEach(row => indexRow(index, row));
            index.observer = new MutationObserver(records => applyIndexMutations(index, records));
            index.observer.observe(segment.body, { childList: true, subtree: true, attributes: true,
                attributeFilter: ['data-tool', 'data-tool-name', 'data-tool-category', 'data-activity-kind', 'data-state', 'data-file-path', 'data-tool-id', 'class'] });
        }
        // Public summary({body}) also supports restored HTML without a sequence.
        if (segment.header && segment.label) index.segment = segment;
        if (segment.pathBase !== undefined && segment.pathBase !== index.pathBase) {
            index.pathBase = segment.pathBase;
            [...index.rows.keys()].forEach(row => indexRow(index, row));
        }
        applyIndexMutations(index, index.observer.takeRecords());
        return index;
    }
    function summary(segment) {
        const index = getIndex(segment), counts = index.counts;
        const active = segment.complete ? [] : Object.keys(live).filter(key => index.active[key].size);
        if (active.length) return active.map(key => live[key]).join('，');
        if (segment.thinking) return '正在思考';
        const labels = { edit: n => '编辑了 ' + n + ' 个文件', command: n => '运行了 ' + n + ' 个命令', read: n => '读取了 ' + n + ' 项内容',
            search: n => '搜索了 ' + n + ' 次', image: n => '查看了 ' + n + ' 张图像', browser: n => '操作了 ' + n + ' 次浏览器', other: n => '执行了 ' + n + ' 项操作' };
        return Object.keys(counts).filter(key => counts[key].size).map(key => labels[key](counts[key].size)).join('，') || '思考完毕';
    }
    function headerIcon(segment, index = getIndex(segment)) {
        let leading = segment.header.querySelector('.turn-process-leading');
        if (!leading) { leading = element('span', 'turn-process-leading'); segment.header.prepend(leading); }
        const hasActive = !segment.complete && Object.keys(live).some(key => index.active[key].size);
        const candidates = hasActive ? index.active : segment.thinking ? null : index.categories;
        const category = candidates && Object.keys(live).find(key => candidates[key].size) || 'thinking';
        const selected = candidates?.[category]?.values().next().value;
        setVisual(leading, selected?.querySelector('.tool-row-leading, .process-icon')?.innerHTML || root.MoonYaIcons.icon({ edit: 'edit', command: 'terminal', search: 'search', read: 'folder', image: 'computer', browser: 'globe', other: 'settings' }[category] || 'brain'), true);
    }
    function refresh(segment) {
        const index = getIndex(segment);
        // Explicit callers may have changed legacy rows without observable data
        // attributes; rebuild once, rather than once per normal streamed event.
        [...index.rows.keys()].forEach(row => { if (!segment.body.contains(row)) removeIndexedRow(index, row); else indexRow(index, row); });
        segment.body.querySelectorAll('.tool-row, .reasoning-row').forEach(row => setActive(row.matches('.tool-row') ? row.querySelector('.codex-tool-main') : row, !segment.complete && running(row.dataset.state)));
        renderRefresh(segment);
    }
    function renderRefresh(segment) {
        pending.delete(segment);
        const index = getIndex(segment);
        setVisual(segment.label, summary(segment));
        headerIcon(segment, index);
        const active = !segment.complete && !segment.closed && (segment.thinking || Object.keys(live).some(key => index.active[key].size));
        setActive(segment.header, active);
        // New stream content must use its natural height immediately. Restarting
        // the opening animation on every delta can keep the body clipped forever.
        if (animations.has(segment.body) && segment.header.getAttribute('aria-expanded') === 'true') disclose(segment.header, segment.body, true, false);
        pending.delete(segment);
    }
    function queueRefresh(segment) {
        pending.add(segment);
        if (!refreshFrame) refreshFrame = root.requestAnimationFrame(() => { refreshFrame = 0; flush(); });
    }
    function flush(host) {
        if (!host && refreshFrame) { root.cancelAnimationFrame(refreshFrame); refreshFrame = 0; }
        for (const segment of [...pending]) {
            if (!host || host.contains(segment.container)) renderRefresh(segment);
        }
    }
    function sequence(host, turnKey, options = {}) {
        return { host, turnKey, options, segments: [], active: null, tools: new Map(), commands: new Map(), reasons: new Map(), texts: new Map(), complete: false };
    }
    function ensure(sequence) {
        if (sequence.active) return sequence.active;
        const container = element('section', 'turn-process codex-turn-trace process-segment is-running');
        container.dataset.turnProcess = sequence.turnKey;
        container.dataset.processSegment = String(sequence.segments.length);
        const header = element('button', 'turn-process-header codex-turn-header'); header.type = 'button'; header.setAttribute('aria-expanded', 'false');
        const label = element('span', 'turn-process-label', '正在思考');
        header.append(arrow('turn-process-chevron'), label);
        const body = element('div', 'turn-process-body codex-trace-body process-disclosure-body'); body.hidden = true; body.inert = true;
        container.append(header, body); sequence.host.appendChild(container);
        const durationHeader = sequence.host.closest('.message')?.querySelector(':scope > .turn-duration');
        if (durationHeader?.getAttribute('aria-expanded') === 'false') {
            discloseBodies(durationHeader, durationBodies(sequence.host), false, false);
        }
        const segment = { container, header, label, body, thinking: true, pathBase: sequence.options.pathBase };
        renderRefresh(segment);
        sequence.segments.push(segment); sequence.active = segment;
        return segment;
    }
    function boundary(sequence) {
        const segment = sequence.active;
        if (segment) {
            segment.closed = true;
            sequence.reasons.forEach((row, id) => {
                if (row.__processSegment === segment && running(row.dataset.state)) reason(sequence, id, row.__text, false);
            });
            segment.thinking = false; renderRefresh(segment);
            segment.container.classList.remove('is-running'); segment.container.classList.add('is-complete');
        }
        sequence.active = null;
    }
    function activity(sequence) { sequence.complete = false; const segment = ensure(sequence); segment.thinking = true; renderRefresh(segment); }
    function finish(sequence) {
        sequence.complete = true;
        sequence.segments.forEach(segment => {
            segment.thinking = false;
            segment.complete = true;
            segment.container.classList.remove('is-running'); segment.container.classList.add('is-complete');
            segment.body.querySelectorAll('[data-process-active]').forEach(node => setActive(node, false));
        });
        sequence.reasons.forEach((row, id) => reason(sequence, id, row.__text, false));
        sequence.segments.forEach(renderRefresh);
        sequence.active = null;
    }
    function tool(sequence, id, spec) {
        let entry = sequence.tools.get(id);
        const wasActive = entry && running(entry.row.dataset.state);
        if (!entry) {
            const segment = ensure(sequence), row = element('div', 'tool-row'); row.dataset.toolId = id;
            const main = element('div', 'codex-tool-main');
            main.append(arrow('codex-tool-chevron'), element('span', 'tool-row-leading'), element('span', 'tool-row-title'), element('span', 'tool-row-summary'));
            row.appendChild(main); segment.body.appendChild(row);
            entry = { row, segment, spec: {} }; sequence.tools.set(id, entry);
        }
        spec = entry.spec = { ...entry.spec, ...spec, args: spec.args || entry.spec.args || {}, result: spec.result || entry.spec.result || {} };
        if (['failure', 'failed', 'error'].includes(spec.state) || spec.result.success === false || spec.result.command_ok === false) spec.state = 'failure';
        else if (['stopped', 'cancelled', 'rejected'].includes(spec.state) || spec.result.status === 'killed') spec.state = 'stopped';
        else if (kind(spec.tool, spec.args) === 'command' && spec.result.status === 'running') spec.state = 'executing';
        const { row, segment } = entry, category = kind(spec.tool, spec.args);
        row.dataset.tool = spec.tool; row.dataset.activityKind = category; row.dataset.state = spec.state || 'executing';
        row.dataset.filePath = spec.result.path || spec.args.path || '';
        const failed = ['failure', 'failed', 'error'].includes(row.dataset.state);
        const active = running(row.dataset.state);
        const title = failed ? ({ command: '运行失败', edit: '编辑失败' }[category] || '执行失败') : (active ? live[category] : ({ command: '运行命令', edit: '编辑文件', read: '读取文件', search: '搜索内容', image: '查看图像', browser: '操作浏览器' }[category] || '执行操作'));
        setVisual(row.querySelector('.tool-row-title'), title, false, title + ':' + row.dataset.state);
        setVisual(row.querySelector('.tool-row-leading'), sequence.options.icon?.(spec.tool, row.dataset.state, spec.args) || root.MoonYaIcons.icon(category === 'edit' ? 'edit' : category === 'command' ? 'terminal' : category === 'search' ? 'search' : 'folder'), true);
        const label = row.querySelector('.tool-row-summary');
        label.textContent = String(spec.detail || spec.args.command || spec.args.path || spec.tool || '').replace(/\s+/g, ' ').trim();
        if (category === 'edit' || category === 'read') {
            const file = spec.result.path || spec.args.path;
            if (file) { label.dataset.filePath = file; label.classList.add('codex-file-link'); label.setAttribute('role', 'button'); label.tabIndex = 0; label.textContent = file; }
            if (category === 'edit' && (spec.result.added_lines !== undefined || spec.result.removed_lines !== undefined)) label.textContent += ' +' + Number(spec.result.added_lines || 0) + ' -' + Number(spec.result.removed_lines || 0);
        }
        const wasOpen = row.getAttribute('data-open') !== null;
        const commandControls = row.querySelector('.codex-tool-detail .moonya-task-host');
        if (sequence.options.renderTool) sequence.options.renderTool(row, spec);
        else {
            let detail = row.querySelector('.codex-tool-detail');
            if (!detail) { detail = element('pre', 'codex-tool-detail'); row.appendChild(detail); }
            detail.textContent = JSON.stringify({ arguments: spec.args, result: spec.result }, null, 2);
        }
        const detail = row.querySelector('.codex-tool-detail'), main = row.querySelector('.codex-tool-main');
        if (detail && commandControls) detail.appendChild(commandControls);
        if (detail) { row.classList.add('has-detail'); main.setAttribute('role', 'button'); main.tabIndex = 0; disclose(main, detail, wasOpen, animations.has(detail)); }
        const commandId = spec.result.command_id || spec.args.command_id;
        if (commandId && !['get_command_status', 'stop_command'].includes(spec.tool)) sequence.commands.set(commandId, entry);
        if (commandId && ['get_command_status', 'stop_command'].includes(spec.tool)) {
            const original = sequence.commands.get(commandId);
            if (original) tool(sequence, original.row.dataset.toolId, { result: { ...original.spec.result, ...spec.result },
                state: spec.result.status === 'running' ? 'executing' : spec.result.status === 'killed' ? 'stopped' : spec.state === 'failure' ? 'failure' : 'success' });
        }
        segment.thinking = false; indexRow(getIndex(segment), row);
        // Stop the completed batch's sweep in the same update as its tool row,
        // while parallel tools that are still running retain their live state.
        if (wasActive && !active) renderRefresh(segment); else queueRefresh(segment);
        return row;
    }
    function reason(sequence, id, text, active = true) {
        let row = sequence.reasons.get(id);
        if (!row) {
            const segment = ensure(sequence); row = element('div', 'reasoning-row');
            row.dataset.reasoningBlock = id; row.dataset.variant = 'think'; row.dataset.expanded = '0'; row.setAttribute('role', 'button'); row.tabIndex = 0; row.setAttribute('aria-expanded', 'false');
            row.append(arrow('reasoning-chevron'), element('span', 'reasoning-row-leading'), element('span', 'reasoning-row-title', '思考'), element('span', 'reasoning-row-sep'), element('span', 'reasoning-row-summary'));
            row.querySelector('.reasoning-row-leading').innerHTML = sequence.options.icon?.('thinking', 'thinking', {}) || root.MoonYaIcons.icon('brain');
            row.querySelector('.reasoning-row-summary').appendChild(element('span', 'reasoning-row-summary-text'));
            const body = element('div', 'reasoning-row-body process-disclosure-body'); body.hidden = true; body.inert = true;
            segment.body.append(row, body); row.__processSegment = segment; sequence.reasons.set(id, row);
        }
        active = active && !sequence.complete && !row.__processSegment.closed;
        row.__text = String(text || ''); row.dataset.state = active ? 'running' : 'ok';
        setVisual(row.querySelector('.reasoning-row-title'), '思考', false, row.dataset.state);
        const lines = row.__text.trim().split('\n'); row.querySelector('.reasoning-row-summary-text').textContent = (active ? lines.at(-1) : lines[0]).replace(/\*\*/g, '');
        row.nextElementSibling.textContent = row.__text;
        setActive(row, active && !sequence.complete);
        row.__processSegment.thinking = active && !sequence.complete; queueRefresh(row.__processSegment);
        return row;
    }
    function normalize(host) { return withoutAnimation(() => { flush(host); return normalizeHistory(host); }); }
    function normalizeHistory(host) {
        [...transitions.keys()].filter(node => host.contains(node)).forEach(cancelTransition);
        widths.forEach((animation, node) => { if (host.contains(node)) { animation.onfinish = null; animation.cancel(); widths.delete(node); } });
        host.querySelectorAll('[data-process-active]').forEach(node => node.removeAttribute('data-process-active'));
        host.querySelectorAll('.tool-row, .process-row').forEach(row => {
            if ((row.dataset.activityKind || kind(row.dataset.tool || row.dataset.toolName || row.dataset.toolCategory)) !== 'edit') return;
            const leading = row.querySelector('.tool-row-leading, .process-icon');
            if (leading) leading.innerHTML = root.MoonYaIcons.icon('edit');
        });
        // Older Chat HTML used a single header and siblings inside the bubble.
        host.querySelectorAll('.turn-process-header').forEach(header => {
            if (header.parentElement.classList.contains('turn-process')) return;
            const parent = header.parentElement;
            parent.classList.remove('process-collapsed', 'codex-inline-complete');
            header.remove();
            const restored = sequence(parent, parent.closest('.message')?.dataset.processTurn || 'legacy');
            Array.from(parent.childNodes).forEach(node => {
                const activity = node.nodeType === 1 && node.matches('.process-row, .execution-block-host, .thinking-wrapper, .codex-activity-group');
                if (!activity) { boundary(restored); return; }
                const segment = ensure(restored);
                if (!segment.body.children.length) node.before(segment.container);
                if (node.matches('.codex-activity-group')) {
                    const list = node.querySelector('.codex-activity-list');
                    if (list) while (list.firstChild) segment.body.appendChild(list.firstChild);
                    node.remove();
                } else segment.body.appendChild(node);
            });
            finish(restored);
        });
        host.querySelectorAll('.turn-process').forEach(container => {
            const header = container.querySelector(':scope > .turn-process-header'), body = container.querySelector(':scope > .turn-process-body');
            if (!header || !body) return;
            if (!container.classList.contains('process-segment')) {
                container.classList.add('process-segment');
                body.querySelectorAll('.codex-activity-group').forEach(group => {
                    const list = group.querySelector('.codex-activity-list');
                    if (list) while (list.firstChild) group.before(list.firstChild);
                    group.remove();
                });
                let label = header.querySelector('.turn-process-label, .turn-title');
                if (!label) { label = element('span', 'turn-process-label'); header.appendChild(label); }
                label.textContent = summary({ body, thinking: false, complete: true });
                header.querySelectorAll('.turn-process-chevron, .turn-chevron').forEach(node => node.remove());
                header.prepend(arrow('turn-process-chevron'));
            }
            container.removeAttribute('data-open'); container.classList.remove('is-running'); container.classList.add('is-complete');
            container.hidden = false; container.inert = false; container.classList.remove('process-disclosure-body');
            headerIcon({ header, body, thinking: false, complete: true });
            disclose(header, body, false, false);
        });
        host.querySelectorAll('.reasoning-row, .codex-tool-main').forEach(header => {
            const body = header.classList.contains('reasoning-row') ? header.nextElementSibling : header.parentElement.querySelector('.codex-tool-detail');
            if (body) {
                header.querySelectorAll('.codex-tool-chevron:not(.process-arrow)').forEach(node => node.remove());
                if (!header.querySelector('.process-arrow')) header.prepend(arrow(header.classList.contains('reasoning-row') ? 'reasoning-chevron' : 'codex-tool-chevron'));
                header.dataset.expanded = '0'; disclose(header, body, false, false);
            }
        });
        host.querySelectorAll('.process-disclosure-animating').forEach(body => body.classList.remove('process-disclosure-animating'));
        host.querySelectorAll('.process-disclosure-body').forEach(body => { body.style.removeProperty('height'); body.style.removeProperty('opacity'); });
        host.querySelectorAll('[data-process-active]').forEach(node => node.removeAttribute('data-process-active'));
        // History stores every block, regardless of the current disclosure state.
        const contents = new Set([...host.querySelectorAll('.process-segment')].map(node => node.parentElement));
        contents.forEach(content => durationBodies(content).forEach(node => {
            node.hidden = false; node.inert = false;
            node.classList.remove('process-disclosure-body');
        }));
    }
    document.addEventListener('click', event => {
        const durationHeader = event.target.closest('.turn-duration');
        if (durationHeader) { event.moonyaProcessHandled = true; toggleDuration(durationHeader); return; }
        if (event.target.closest('.codex-file-link, .codex-viewed-image-tile')) return;
        const header = event.target.closest('.turn-process-header, .reasoning-row, .codex-tool-main');
        if (!header?.closest('.process-segment')) return;
        const body = header.classList.contains('turn-process-header') ? header.parentElement.querySelector(':scope > .turn-process-body')
            : header.classList.contains('reasoning-row') ? header.nextElementSibling : header.parentElement.querySelector('.codex-tool-detail');
        if (!body) return;
        event.moonyaProcessHandled = true;
        const open = header.getAttribute('aria-expanded') !== 'true';
        if (header.classList.contains('reasoning-row')) header.dataset.expanded = open ? '1' : '0';
        disclose(header, body, open);
    });
    document.addEventListener('keydown', event => {
        if (!['Enter', ' ', 'Spacebar'].includes(event.key) || event.target.tagName === 'BUTTON') return;
        const header = event.target.closest('.reasoning-row, .codex-tool-main');
        if (!header?.closest('.process-segment') || event.target.closest('.codex-file-link')) return;
        event.preventDefault(); event.moonyaProcessHandled = true; header.click();
    });
    root.MoonYaProcessUI = { arrow, disclose, kind, normalizePath, isRunning: running, duration, beginDuration, endDuration, setStatus, summary, refresh, flush, sequence, ensure, boundary, activity, finish, tool, reason, normalize, getAnimationStyle, setAnimationStyle, setVisual, setActive, withoutAnimation };
}(window));
