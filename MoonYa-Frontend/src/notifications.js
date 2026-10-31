/* Shared, non-blocking notifications. Loaded before the request boundary. */
(() => {
    'use strict';
    const records = new Map();
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let root, announcer, serial = 0, layerFrame = 0;
    const ns = 'http://www.w3.org/2000/svg';
    function geometryChanged() { window.dispatchEvent(new Event('moonya:notifications')); }

    function host() {
        return [...document.querySelectorAll('dialog:modal')].at(-1) || document.body;
    }
    function ensure() {
        if (!document.body) return false;
        if (!root) {
            root = document.getElementById('toast') || document.createElement('div');
            root.id = 'toast'; root.className = 'toast';
            root.setAttribute('popover', 'manual');
            root.setAttribute('aria-hidden', 'true');
            announcer = document.createElement('div');
            announcer.className = 'toast-announcer';
            announcer.setAttribute('role', 'status');
            announcer.setAttribute('aria-live', 'polite');
            announcer.setAttribute('aria-atomic', 'true');
        }
        const parent = host();
        if (root.parentElement !== parent) parent.append(root);
        if (announcer.parentElement !== parent) parent.append(announcer);
        return true;
    }
    function raise() {
        layerFrame = 0;
        if (!ensure() || !records.size) return;
        // A large z-index cannot cover a modal dialog or a later top-layer popover.
        // Reinsert only when another surface opens; notification timers are untouched.
        if (root.matches(':popover-open')) root.hidePopover();
        root.showPopover();
        geometryChanged();
    }
    function scheduleRaise() {
        if (records.size && !layerFrame) layerFrame = requestAnimationFrame(raise);
    }
    function announce(message) {
        if (!ensure()) return;
        announcer.textContent = '';
        clearTimeout(announce.timer);
        announce.timer = setTimeout(() => { announcer.textContent = message; }, 30);
    }
    function contour(record, bulge = 0) {
        const w = record.width, h = record.height;
        // Compensate for stack scaling so every layer has the same visible 12px
        // corners. Use the same circular curve at all four corners at rest.
        const scale = 1 - (record.depth || 0) * .055;
        const r = Math.min(12 / scale, w / 2, h / 2), curve = r * .5522847498;
        const x = 8, y = 8, right = x + w, bottom = y + h;
        const spread = bulge * Math.min(7, w * .045);
        const drop = bulge * 5;
        record.path.setAttribute('d', `M ${x + r} ${y} H ${right - r}
            C ${right - r + curve} ${y} ${right} ${y + r - curve} ${right} ${y + r}
            V ${bottom - r} C ${right + spread} ${bottom - r + curve + drop} ${right - r + curve + spread} ${bottom + drop} ${right - r} ${bottom + drop}
            H ${x + r} C ${x + r - curve - spread} ${bottom + drop} ${x - spread} ${bottom - r + curve + drop} ${x} ${bottom - r}
            V ${y + r} C ${x} ${y + r - curve} ${x + r - curve} ${y} ${x + r} ${y} Z`);
    }
    function size(record) {
        record.width = record.node.offsetWidth; record.height = record.node.offsetHeight;
        record.svg.setAttribute('viewBox', `0 0 ${record.width + 16} ${record.height + 16}`);
        contour(record, record.bulge || 0);
    }
    function enter(record) {
        if (record.entered) return;
        record.entered = true;
        record.entryAnimation = record.motion.animate(reducedMotion.matches ? [{ opacity: 0 }, { opacity: 1 }] : [
            { opacity: 0, transform: 'translateY(-16px)', offset: 0 },
            { opacity: 1, transform: 'translateY(3px)', offset: .38 },
            { transform: 'translateY(-1.5px)', offset: .62 },
            { transform: 'translateY(.6px)', offset: .82 },
            { opacity: 1, transform: 'translateY(0)', offset: 1 }
        ], { duration: reducedMotion.matches ? 120 : 550, easing: 'ease-out' });
        if (reducedMotion.matches) return;
        const start = performance.now();
        function deform(now) {
            const t = Math.min(1, (now - start) / 550);
            // Two decreasing rebounds at the lower corners; the text never scales.
            record.bulge = Math.sin(t * Math.PI * 4) * Math.pow(1 - t, 1.6) * 1.7;
            contour(record, record.bulge);
            if (t < 1 && !reducedMotion.matches) record.frame = requestAnimationFrame(deform);
            else { record.bulge = 0; contour(record); record.frame = 0; }
        }
        record.frame = requestAnimationFrame(deform);
    }
    const resize = new ResizeObserver(entries => {
        for (const entry of entries) {
            const record = records.get(entry.target.dataset.notificationId);
            if (record) {
                size(record);
                if (!record.node.hasAttribute('data-stack-back')) {
                    root.style.setProperty('--toast-width', record.width + 'px');
                    root.style.setProperty('--toast-height', record.height + 'px');
                }
            }
        }
        geometryChanged();
    });
    function create(record) {
        const node = document.createElement('div'); node.className = 'toast-card';
        node.dataset.notificationId = record.id;
        const motion = document.createElement('div'); motion.className = 'toast-motion';
        const svg = document.createElementNS(ns, 'svg'); svg.classList.add('toast-surface');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(ns, 'path'); svg.append(path);
        const text = document.createElement('div'); text.className = 'toast-text'; text.textContent = record.message;
        motion.append(svg, text); node.append(motion);
        Object.assign(record, { node, motion, svg, path, text });
        root.append(node); resize.observe(node);
    }
    function render() {
        if (!ensure()) return;
        const ordered = [...records.values()].reverse();
        if (ordered.length && !root.matches(':popover-open')) root.showPopover();
        ordered.forEach((record, index) => {
            if (!record.node) create(record);
            record.node.hidden = index >= 3;
            record.node.toggleAttribute('data-stack-back', index > 0);
            record.depth = Math.min(index, 2);
            record.node.style.setProperty('--toast-depth', record.depth);
            record.node.style.zIndex = String(3 - index);
            // Keep DOM/text order consistent with the visible newest-first stack.
            root.append(record.node);
            if (index === 0) {
                root.style.setProperty('--toast-width', record.node.offsetWidth + 'px');
                root.style.setProperty('--toast-height', record.node.offsetHeight + 'px');
            }
            if (index < 3) { size(record); enter(record); }
        });
        root.classList.toggle('show', !!ordered.length);
        if (!ordered.length && !root.querySelector('.toast-leaving') && root.matches(':popover-open')) root.hidePopover();
        geometryChanged();
    }
    function remove(id) {
        const record = records.get(id);
        if (!record) return;
        records.delete(id); clearTimeout(record.timer); cancelAnimationFrame(record.frame);
        if (record.node) {
            resize.unobserve(record.node);
            if (!record.node.hidden && root?.matches(':popover-open')) {
                record.node.classList.add('toast-leaving');
                const animation = record.motion.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-6px)' }],
                    { duration: reducedMotion.matches ? 120 : 180, fill: 'forwards', easing: 'ease-in' });
                animation.finished.then(() => { record.node.remove(); render(); });
            } else record.node.remove();
        }
        render();
    }
    function show(message, options = {}) {
        const id = options.id || 'notification-' + ++serial;
        const text = String(message ?? '');
        if (!text.trim()) { remove(id); return id; }
        let record = records.get(id);
        const changed = !record || record.message !== text;
        if (!record) { record = { id, message: text }; records.set(id, record); }
        else { record.message = text; if (record.text) record.text.textContent = text; }
        clearTimeout(record.timer);
        const duration = Number.isFinite(options.duration) && options.duration >= 0 ? options.duration : 2000;
        // duration=0 keeps a state notice until its owner explicitly removes it.
        if (duration) record.timer = setTimeout(() => remove(id), duration);
        render();
        if (changed) announce(text);
        return id;
    }
    function overlaps(rect) {
        if (!root?.isConnected || !root.matches(':popover-open')) return false;
        // Account for the surface's elastic corners and shadow near native overlays.
        return [...root.querySelectorAll('.toast-card:not([hidden])')].some(node => {
            const bounds = node.getBoundingClientRect();
            return bounds.left - 8 < rect.right && bounds.right + 8 > rect.left && bounds.top - 8 < rect.bottom && bounds.bottom + 12 > rect.top;
        });
    }
    window.MoonYaNotifications = { show, update: (id, message, options = {}) => show(message, { ...options, id }), remove, overlaps };
    window.showToast = (message, duration = 2000) => show(message, {
        duration: typeof duration === 'number' ? duration : duration === 'error' ? 4000 : 2000
    });
    document.addEventListener('DOMContentLoaded', () => { render(); if (records.size) announce([...records.values()].at(-1).message); });
    document.addEventListener('toggle', event => {
        if (event.target !== root && (event.target instanceof HTMLDialogElement || event.target.hasAttribute?.('popover'))) scheduleRaise();
    }, true);
    new MutationObserver(mutations => {
        if (mutations.some(change => change.type === 'attributes' && change.target instanceof HTMLDialogElement ||
            change.type === 'childList' && [...change.removedNodes].some(node => node instanceof Element &&
                (node === root || node.contains(root) || node.matches('dialog[open]') || node.querySelector('dialog[open]'))))) scheduleRaise();
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    reducedMotion.addEventListener('change', () => {
        if (!reducedMotion.matches) return;
        for (const record of records.values()) {
            cancelAnimationFrame(record.frame); record.entryAnimation?.cancel();
            record.bulge = 0; if (record.path) contour(record);
        }
    });
})();
