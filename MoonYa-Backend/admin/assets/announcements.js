(function () {
    'use strict';
    const el = id => document.getElementById('announcement' + id);
    const editor = el('Editor'), host = el('Blocks'), preview = el('AdminPreview');
    document.body.append(preview);
    const backend = new URL('../',location.href).href;
    let id = null, blocks = [{type:'text',text:''}], busy = false, dragging = null, loadVersion = 0, previewFocus, inert = new Map();
    function button(text, run) { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.onclick = run; return node; }
    async function api(action,body) {
        const response = await fetch('api/announcements.php?action=' + action,{method:body === undefined ? 'GET' : 'POST',headers:{Authorization:'Bearer ' + token,'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
        const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error || '公告操作失败'); return result.data;
    }
    async function operation(run) {
        if (busy) return; busy = true;
        const disabled = new Map();
        for (const node of document.querySelectorAll('#announcementsSection button,#announcementsSection input,#announcementsSection textarea,#announcementsSection select')) { disabled.set(node,node.disabled); node.disabled = true; }
        try { await run(); } catch (error) { el('EditorStatus').textContent = error.message; showAlert('error',error.message); }
        finally { busy = false; for (const [node,value] of disabled) if (node.isConnected) node.disabled = value; renderBlocks(); }
    }
    function move(index, target) { if (busy || index === target || target < 0 || target >= blocks.length) return; const [block] = blocks.splice(index,1); blocks.splice(target,0,block); renderBlocks(); }
    function renderBlocks() {
        host.replaceChildren();
        blocks.forEach((block,index) => {
            const row = document.createElement('div'); row.className = 'announcement-block'; row.dataset.index = index;
            const handle = button('↕',()=>{}); handle.className = 'announcement-drag'; handle.draggable = true; handle.setAttribute('aria-label','拖动图文块');
            handle.ondragstart = event => { if (busy) { event.preventDefault(); return; } dragging = index; event.dataTransfer.setData('text/plain',String(index)); row.classList.add('dragging'); };
            handle.ondragend = () => { dragging = null; row.classList.remove('dragging'); };
            row.ondragover = event => { if (dragging !== null) event.preventDefault(); };
            row.ondrop = event => { event.preventDefault(); if (dragging !== null) move(dragging,index); dragging = null; };
            const fields = document.createElement('div'); fields.className = 'block-fields';
            if (block.type === 'text') {
                const textarea = document.createElement('textarea'); textarea.value = block.text; textarea.required = true; textarea.setAttribute('aria-label','公告文字'); textarea.oninput = () => { block.text = textarea.value; }; fields.append(textarea);
            } else {
                const img = document.createElement('img'); img.src = new URL(block.url.slice(1),backend).href; img.alt = '公告图片'; fields.append(img);
                const controls = document.createElement('div'); controls.className = 'block-controls';
                const widthLabel = document.createElement('label'); widthLabel.textContent = '宽度 % '; const width = document.createElement('input'); width.type = 'number'; width.min = 10; width.max = 100; width.step = 1; width.value = block.width; width.required = true; width.oninput = () => { block.width = Number(width.value); }; widthLabel.append(width);
                const align = document.createElement('select'); align.setAttribute('aria-label','图片对齐');
                for (const [value,text] of [['left','左对齐'],['center','居中'],['right','右对齐']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; align.append(option); }
                align.value = block.align; align.onchange = () => { block.align = align.value; }; controls.append(widthLabel,align); fields.append(controls);
            }
            const controls = document.createElement('div'); controls.className = 'block-controls';
            const up = button('上移',()=>move(index,index-1)), down = button('下移',()=>move(index,index+1)); up.disabled = index === 0; down.disabled = index === blocks.length-1;
            controls.append(up,down,button('移除',()=>{if (!busy) { blocks.splice(index,1); renderBlocks(); }})); fields.append(controls); row.append(handle,fields); host.append(row);
        });
    }
    function edit(item) {
        if (busy) return; id = item?.id || null; el('Title').value = item?.title || ''; blocks = structuredClone(item?.blocks || [{type:'text',text:''}]);
        el('EditorHeading').textContent = id ? '编辑公告 #' + id + '（草稿）' : '新增公告'; el('EditorStatus').textContent = ''; renderBlocks();
    }
    async function load() {
        const version = ++loadVersion;
        try {
            const data = await api('list'); if (version !== loadVersion) return; el('List').replaceChildren();
            for (const item of data.announcements) {
                const row = document.createElement('div'); row.className = 'announcement-row'; const title = document.createElement('strong'); title.textContent = item.title;
                const status = document.createElement('span'); status.textContent = ({draft:'草稿',published:'已发布',withdrawn:'已撤下'}[item.status]) + ' · 修订 ' + item.revision;
                row.append(title,status,button('编辑',()=>edit(item)),button('发布草稿',()=>operation(async()=>{if (!confirm('发布保存的草稿并提醒用户？')) return; await api('publish',{id:item.id}); await load();})),button('撤下',()=>operation(async()=>{await api('withdraw',{id:item.id});await load();})),button('删除',()=>operation(async()=>{if (!confirm('删除公告“'+item.title+'”？')) return;await api('delete',{id:item.id});if(id===item.id){id=null;el('Title').value='';blocks=[{type:'text',text:''}];el('EditorHeading').textContent='新增公告';}await load();})));
                el('List').append(row);
            }
            if (!data.announcements.length) el('List').textContent = '暂无公告';
        } catch (error) { if (version === loadVersion) el('List').textContent = error.message; }
    }
    async function save(publish) {
        if (!editor.reportValidity()) return;
        const item = await api('save',{id,title:el('Title').value,blocks}); id = item.id;
        if (publish) await api('publish',{id});
        el('EditorHeading').textContent = '编辑公告 #' + id + '（草稿）'; el('EditorStatus').textContent = publish ? '公告已发布，用户将收到新修订。' : '草稿已保存，用户看到的已发布内容保持不变。'; await load();
    }
    function closePreview() { preview.hidden = true; for(const [node,value] of inert) node.inert=value; inert.clear(); previewFocus?.focus(); }
    el('New').onclick = () => edit(null); el('Reload').onclick = load;
    el('AddText').onclick = () => { if (!busy) { blocks.push({type:'text',text:''}); renderBlocks(); } };
    el('Image').onchange = () => operation(async()=>{
        const file = el('Image').files[0]; if (!file) return;
        try { const data = new FormData(); data.append('file',file); data.append('compress','0');
            const response = await fetch('api/upload_image.php',{method:'POST',headers:{Authorization:'Bearer '+token},body:data}); const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || '图片上传失败'); blocks.push({type:'image',url:result.url,width:100,align:'center'});
        } finally { el('Image').value = ''; }
    });
    el('Preview').onclick = () => {
        previewFocus = document.activeElement; el('PreviewTitle').textContent = el('Title').value || '公告预览'; MoonYaAnnouncementContent(preview.querySelector('.announcement-content'),blocks,backend);
        for (const node of document.body.children) if (node !== preview) { inert.set(node,node.inert); node.inert=true; }
        preview.hidden = false; preview.querySelector('.membership-dialog-primary').focus();
    };
    preview.querySelectorAll('button').forEach(node=>{node.onclick=closePreview;});
    preview.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closePreview();}if(event.key==='Tab'){event.preventDefault();const buttons=[...preview.querySelectorAll('button')];buttons[(buttons.indexOf(document.activeElement)+1)%buttons.length].focus();}});
    editor.onsubmit = event => { event.preventDefault(); operation(()=>save(false)); }; el('Publish').onclick = () => { if (editor.reportValidity()) operation(()=>save(true)); };
    window.announcements = {load}; renderBlocks();
})();
