/*
 * 共用 SVG 圆环进度。
 * 仓内原本散落 5 处同款实现（program-updates 的下载环、上下文环、上传进度环…），
 * 这里抽一个共用的，供「内置主题下载」用；已有的实现不动，避免回归。
 * 约定：<circle r=R> 配 transform:rotate(-90deg) 让 0 点从 12 点方向起算。
 */
(function () {
    'use strict';

    const circumference = radius => 2 * Math.PI * Number(radius || 10);

    window.MoonYaRing = Object.freeze({
        circumference,

        /** @param {SVGCircleElement|null} circle @param {number} percent 0-100 */
        setRing(circle, percent) {
            if (!circle) return;
            const radius = Number(circle.getAttribute('r')) || 10;
            const total = circumference(radius);
            const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
            circle.style.strokeDasharray = String(total);
            circle.style.strokeDashoffset = String(total * (1 - clamped / 100));
        }
    });
})();
