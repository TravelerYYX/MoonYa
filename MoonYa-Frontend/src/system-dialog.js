(function () {
    'use strict';
    const overlay = document.createElement('div');
    overlay.className = 'membership-dialog-overlay system-dialog-overlay'; overlay.hidden = true;
    overlay.innerHTML = '<section class="membership-dialog" role="dialog" aria-modal="true" aria-labelledby="systemDialogTitle" tabindex="-1"><button class="membership-dialog-close" type="button" aria-label="关闭弹窗">×</button><h2 id="systemDialogTitle"></h2><div class="system-dialog-content"></div><div class="system-dialog-status" role="status"></div><div class="membership-dialog-actions"></div></section>';
    document.body.append(overlay);
    const card = overlay.firstElementChild, close = card.querySelector('button'), title = card.querySelector('h2');
    const content = card.querySelector('.system-dialog-content'), status = card.querySelector('[role=status]'), actions = card.querySelector('.membership-dialog-actions');
    let kind = '', focus = null, inert = new Map(), dismiss = null;
    function hide() {
        if (overlay.hidden) return;
        overlay.hidden = true; kind = ''; dismiss = null;
        for (const [node, previous] of inert) if (node.isConnected) node.inert = previous;
        inert.clear(); if (focus?.isConnected) focus.focus(); focus = null;
    }
    function show(nextKind, heading, build, buttons, onDismiss) {
        const fresh = overlay.hidden;
        if (fresh) {
            focus = document.activeElement;
            for (const node of document.body.children) if (node !== overlay) { inert.set(node, node.inert); node.inert = true; }
        }
        kind = nextKind; dismiss = onDismiss; close.hidden = kind === 'update'; title.textContent = heading;
        content.replaceChildren(); status.textContent = ''; build(content); actions.replaceChildren();
        for (const action of buttons) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'membership-dialog-' + (action.style || 'primary');
            button.textContent = action.text; button.disabled = !!action.disabled; button.onclick = action.run; actions.append(button);
        }
        overlay.hidden = false;
        if (fresh || !overlay.contains(document.activeElement)) (actions.querySelector('button:not(:disabled)') || card).focus();
    }
    close.onclick = () => { if (kind !== 'update') dismiss?.(); };
    document.addEventListener('keydown', event => {
        if (overlay.hidden) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (kind !== 'update') dismiss?.(); }
        if (event.key === 'Tab') {
            const elements = [...card.querySelectorAll('button:not(:disabled)')].filter(node => !node.hidden);
            event.preventDefault(); const index = elements.indexOf(document.activeElement);
            (elements.length ? elements[(index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length] : card).focus();
        }
    }, true);
    document.addEventListener('focusin', event => { if (!overlay.hidden && !overlay.contains(event.target)) card.focus(); });
    window.MoonYaSystemDialog = {show, hide, get kind() { return kind; }, setStatus(text) { status.textContent = text; }};
})();
