/* Parameter ids remain stable even when administrators rename their labels. */
(() => {
    const order = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const names = {none:'不思考',auto:'开启思考',low:'低',medium:'中',high:'高',xhigh:'超高',max:'极致',ultra:'Ultra'};
    const thinking = caps => caps.supports_thinking ?? !!(caps.reasoning || caps.reasoning_control);
    const allowsOff = caps => caps.reasoning !== 'always' && !caps.reasoning_required && caps.allow_thinking_off !== false;
    const levels = caps => thinking(caps) ? order.filter(e => caps.efforts?.includes(e)) : [];
    const choices = (caps, work) => !thinking(caps) ? ['none'] : [...(!work && allowsOff(caps) ? ['none'] : []), ...(levels(caps).length ? levels(caps) : ['auto'])];
    const defaultEffort = caps => {
        if (!thinking(caps)) return 'none';
        const offered = levels(caps);
        return offered.includes(caps.default_effort) ? caps.default_effort : offered.includes('high') ? 'high' : offered.at(-1) || 'auto';
    };
    const normalize = (caps, work, value) => choices(caps, work).includes(value) ? value : defaultEffort(caps);
    const label = (caps, value) => !thinking(caps) ? '无思考' : caps.effort_labels?.[value]?.trim() || names[value];
    const migrate = (value, version) => version === 2 ? value : ({none:'none',light:'low',low:'low',medium:'low',high:'high',xhigh:'high',max:'max',ultra:'max'})[value];
    window.MoonYaBuiltinReasoning = {order, names, thinking, allowsOff, levels, choices, defaultEffort, normalize, label, migrate};
})();
