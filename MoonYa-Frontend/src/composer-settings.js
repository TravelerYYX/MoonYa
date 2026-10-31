/* Custom composer controls; native range inputs retain keyboard/AT semantics. */
(() => {
    'use strict';
    const sliders = new WeakMap();
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

    function expand(panel, open, trigger) {
        if (!panel) return;
        panel.hidden = !open;
        panel.inert = !open;
        panel.setAttribute('aria-hidden', String(!open));
        trigger?.setAttribute('aria-expanded', String(open));
    }

    function mountSlider(input) {
        if (!input) return;
        let state = sliders.get(input);
        if (!state) {
            const shell = document.createElement('div');
            shell.className = 'effort-spring-slider';
            input.before(shell);
            shell.append(input);
            const visual = document.createElement('div');
            visual.className = 'effort-slider-visual';
            visual.setAttribute('aria-hidden', 'true');
            visual.innerHTML = '<div class="effort-slider-fill"></div><div class="effort-slider-stars"></div><div class="effort-slider-stops"></div><div class="effort-slider-thumb"></div>';
            visual.querySelector('.effort-slider-stars').innerHTML = Array.from({ length: 16 }, (_, index) => {
                const lane = 13 + (index * 29 % 76);
                const duration = .76 + (index * 7 % 9) * .09;
                const size = 1.2 + (index % 3) * .45;
                return `<i class="effort-slider-particle" style="--lane:${lane}%;--flight-duration:${duration}s;--flight-delay:${-index * .23}s;--particle-size:${size}px;--particle-trail:${6 + index % 5 * 2}px"></i>`;
            }).join('');
            shell.append(visual);
            state = { shell, visual, position: Number(input.value), target: Number(input.value), velocity: 0, frame: 0, pointer: null, count: 0 };
            sliders.set(input, state);
            const paint = () => {
                const maximum = Math.max(1, Number(input.max));
                shell.style.setProperty('--slider-position', input.dataset.fixedOn === 'true' ? 1 : Math.max(0, Math.min(1, state.position / maximum)));
            };
            const animate = () => {
                state.frame = 0;
                if (!input.isConnected) return;
                if (reducedMotion.matches) { state.position = state.target; state.velocity = 0; }
                else {
                    // A damped spring, subdivided by elapsed time for high refresh displays.
                    const now = performance.now();
                    const steps = Math.max(1, Math.min(4, Math.round((now - (state.lastTime || now - 16)) / 8)));
                    state.lastTime = now;
                    for (let i = 0; i < steps; i++) {
                        state.velocity = (state.velocity + (state.target - state.position) * .095) * .64;
                        state.position += state.velocity;
                    }
                }
                paint();
                if (Math.abs(state.target - state.position) + Math.abs(state.velocity) > .001) state.frame = requestAnimationFrame(animate);
                else { state.position = state.target; state.velocity = 0; state.lastTime = 0; paint(); }
            };
            state.move = target => { state.target = target; if (!state.frame) state.frame = requestAnimationFrame(animate); };
            const commit = value => {
                if (Number(input.value) === value) return;
                input.value = String(value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            };
            const drag = event => {
                const rect = shell.getBoundingClientRect();
                const raw = Math.max(0, Math.min(Number(input.max), (event.clientX - rect.left - 13) / Math.max(1, rect.width - 26) * Number(input.max)));
                const nearest = Math.round(raw), distance = raw - nearest;
                // Magnetic resistance near each stop, with continuous movement between stops.
                state.move(Math.abs(distance) < .22 ? nearest + distance * .24 : raw);
                commit(nearest);
            };
            shell.addEventListener('pointerdown', event => {
                if (input.disabled || event.button !== 0 || state.pointer !== null) return;
                event.preventDefault(); event.stopPropagation();
                input.focus({ preventScroll: true });
                state.pointer = event.pointerId;
                shell.setPointerCapture(event.pointerId);
                shell.classList.add('dragging');
                drag(event);
            });
            shell.addEventListener('pointermove', event => { if (state.pointer === event.pointerId) drag(event); });
            const release = event => {
                if (state.pointer !== event.pointerId) return;
                state.pointer = null;
                shell.classList.remove('dragging');
                state.move(Number(input.value));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            };
            shell.addEventListener('pointerup', release);
            shell.addEventListener('pointercancel', release);
            shell.addEventListener('lostpointercapture', release);
            input.addEventListener('input', () => { if (state.pointer === null) state.move(Number(input.value)); });
        }
        const count = Number(input.max) + 1;
        if (state.count !== count) {
            state.count = count;
            state.visual.querySelector('.effort-slider-stops').innerHTML = Array.from({ length: count }, (_, i) => `<i style="--stop:${i / Math.max(1, count - 1)}"></i>`).join('');
            state.position = Number(input.value); state.velocity = 0;
        }
        state.visual.querySelectorAll('.effort-slider-stops i').forEach((dot, i) => dot.classList.toggle('filled', i <= Number(input.value)));
        state.shell.classList.toggle('disabled', input.disabled);
        state.shell.classList.toggle('fixed-on', input.dataset.fixedOn === 'true');
        if (state.pointer === null) state.move(Number(input.value));
    }

    function setHeader(label, level, highest = level === 'ultra', penultimate = false) {
        const popover = document.getElementById('agentSettingsPopover');
        if (!popover) return;
        popover.dataset.effort = level;
        popover.dataset.highest = String(highest);
        popover.dataset.flow = highest ? 'fast' : penultimate ? 'normal' : 'off';
        document.getElementById('agentSettingsCaptionEffort').textContent = label;
    }

    function contextPicker(host, choices, value, format, onSelect) {
        const signature = JSON.stringify(choices);
        if (host.dataset.choices !== signature) {
            host.dataset.choices = signature;
            host.replaceChildren();
            if (choices.length > 1) {
                const root = document.createElement('div'); root.className = 'context-custom-picker';
                const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'context-picker-trigger';
                trigger.setAttribute('aria-label', '上下文长度'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
                const list = document.createElement('div'); list.className = 'context-picker-menu'; list.hidden = true; list.inert = true;
                list.id = 'context-options-' + (++contextPicker.sequence); trigger.setAttribute('aria-controls', list.id);
                list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '上下文长度');
                choices.forEach(tokens => {
                    const option = document.createElement('button'); option.type = 'button'; option.dataset.contextTokens = tokens;
                    option.setAttribute('role', 'option'); option.innerHTML = `<span>${format(tokens)}</span>${check}`;
                    option.addEventListener('click', event => { event.stopPropagation(); onSelect(tokens); expand(list, false, trigger); trigger.focus(); });
                    list.append(option);
                });
                trigger.addEventListener('click', event => { event.stopPropagation(); expand(list, list.hidden, trigger); });
                root.addEventListener('keydown', event => {
                    const options = [...list.children];
                    if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); expand(list, false, trigger); trigger.focus(); }
                    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                        event.preventDefault(); event.stopPropagation();
                        const index = options.indexOf(document.activeElement);
                        expand(list, true, trigger);
                        const selected = choices.indexOf(Number(root.dataset.value));
                        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index < 0 ? Math.max(0, selected) : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                        options[next].focus();
                    }
                });
                root.append(trigger, list); host.append(root);
            }
        }
        const root = host.querySelector('.context-custom-picker');
        if (root) {
            root.dataset.value = value;
            root.querySelector('.context-picker-trigger').innerHTML = `<span>${format(value)}</span>${chevron}`;
            root.querySelectorAll('[data-context-tokens]').forEach(option => option.setAttribute('aria-selected', String(Number(option.dataset.contextTokens) === value)));
        } else host.textContent = format(value);
    }
    contextPicker.sequence = 0;
    document.addEventListener('click', event => {
        document.querySelectorAll('.context-custom-picker').forEach(root => {
            if (!root.contains(event.target)) expand(root.querySelector('.context-picker-menu'), false, root.querySelector('.context-picker-trigger'));
        });
    });
    window.MoonYaComposerSettings = { expand, mountSlider, setHeader, contextPicker };
})();
