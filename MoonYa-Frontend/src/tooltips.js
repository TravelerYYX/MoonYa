(function () {
    'use strict';
    const tooltip = document.createElement('div');
    tooltip.id = 'moonyaTooltip';
    tooltip.className = 'moonya-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('popover', 'manual');
    document.body.append(tooltip);

    let hovered = null, focused = null, focusTarget = null, owner = null, describedTarget = null, timer = null;
    const nearest = target => target instanceof Element ? target.closest('[data-tooltip]') : null;
    const text = target => target?.getAttribute('data-tooltip') || '';
    const visible = target => {
        const modal = document.querySelector('dialog:modal');
        return target?.isConnected && (!modal || modal.contains(target)) && !target.closest('[hidden], [inert]') &&
            target.getClientRects().length > 0 && getComputedStyle(target).visibility === 'visible';
    };

    function describe(target) {
        if (target === describedTarget) return;
        if (describedTarget) {
            const ids = (describedTarget.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tooltip.id);
            if (ids.length) describedTarget.setAttribute('aria-describedby', ids.join(' '));
            else describedTarget.removeAttribute('aria-describedby');
        }
        describedTarget = target;
        if (target) {
            const ids = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
            ids.add(tooltip.id); target.setAttribute('aria-describedby', [...ids].join(' '));
        }
    }
    function clear() {
        clearTimeout(timer); timer = null;
        describe(null);
        if (tooltip.matches(':popover-open')) tooltip.hidePopover();
        owner = null;
    }
    function dismiss() { hovered = null; focused = null; focusTarget = null; clear(); }

    function position() {
        const anchor = owner.getBoundingClientRect();
        const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
        const viewportWidth = document.documentElement.clientWidth, viewportHeight = window.innerHeight;
        const left = Math.max(8, Math.min(viewportWidth - width - 8, anchor.left + (anchor.width - width) / 2));
        let top = anchor.bottom + 8;
        if (top + height > viewportHeight - 8) top = anchor.top - height - 8;
        tooltip.style.left = left + 'px';
        tooltip.style.top = Math.max(8, Math.min(viewportHeight - height - 8, top)) + 'px';
    }
    function show() {
        timer = null;
        if (!visible(owner) || !text(owner).trim()) { clear(); return; }
        // Keep the tooltip in a modal dialog's accessible subtree and top layer.
        const host = owner.closest('dialog[open]') || document.body;
        if (tooltip.parentNode !== host) host.append(tooltip);
        tooltip.textContent = text(owner);
        tooltip.showPopover();
        describe(focused === owner && focusTarget ? focusTarget : owner);
        position();
    }
    function select() {
        const next = hovered || focused;
        if (next === owner) {
            if (owner && tooltip.matches(':popover-open')) describe(focused === owner && focusTarget ? focusTarget : owner);
            return;
        }
        clear();
        if (!visible(next) || !text(next).trim()) return;
        owner = next;
        timer = setTimeout(show, 400);
    }

    document.addEventListener('pointerover', event => {
        if (event.pointerType === 'touch') return;
        hovered = nearest(event.target); select();
    });
    document.addEventListener('pointerout', event => {
        if (event.pointerType === 'touch') return;
        hovered = nearest(event.relatedTarget); select();
    });
    document.addEventListener('focusin', event => {
        focused = event.target.matches(':focus-visible') ? nearest(event.target) : null;
        focusTarget = focused ? event.target : null;
        select();
    });
    document.addEventListener('focusout', () => { focused = null; focusTarget = null; select(); });
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('dragstart', dismiss, true);
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') dismiss(); }, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);

    new MutationObserver(() => {
        if (!owner) return;
        if (!visible(owner) || !text(owner).trim()) { dismiss(); return; }
        if (tooltip.matches(':popover-open') && tooltip.textContent !== text(owner)) {
            tooltip.textContent = text(owner); position();
        }
    }).observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-tooltip', 'hidden', 'inert', 'class', 'style'] });
}());
