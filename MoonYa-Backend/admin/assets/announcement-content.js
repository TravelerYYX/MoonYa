(function () {
    'use strict';
    window.MoonYaAnnouncementContent = function (host, blocks, backend) {
        host.replaceChildren(); host.classList.add('announcement-content');
        for (const block of blocks || []) {
            if (block.type === 'text') {
                const p = document.createElement('p'); p.textContent = block.text; host.append(p);
            } else if (block.type === 'image' && /^\/uploads\/new-images\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|gif|webp|bmp)$/.test(block.url)) {
                const figure = document.createElement('figure'), img = document.createElement('img');
                img.alt = '公告图片'; img.src = new URL(block.url.slice(1), backend).href;
                img.style.width = Math.min(100, Math.max(10, Number(block.width) || 100)) + '%';
                img.style.marginLeft = block.align === 'left' ? '0' : 'auto';
                img.style.marginRight = block.align === 'right' ? '0' : 'auto';
                img.onerror = () => { const error = document.createElement('span'); error.className = 'announcement-image-error'; error.textContent = '图片暂时无法加载'; img.replaceWith(error); };
                figure.append(img); host.append(figure);
            }
        }
    };
})();
