/* Directory traversal and upload progress for the admin skill explorer. */
let skillUploadBusy = false;

(function () {
    const zone = document.getElementById('skillDropZone');
    const status = document.getElementById('skillUploadStatus');
    const message = document.getElementById('skillUploadMessage');
    const progress = document.getElementById('skillUploadProgress');
    let dragDepth = 0;

    function setStatus(text, percent, failed) {
        status.hidden = false;
        status.classList.toggle('is-error', !!failed);
        message.textContent = text;
        if (percent == null) progress.removeAttribute('value');
        else progress.value = percent;
    }

    function showSkipped(skipped) {
        const details = document.getElementById('skillUploadSkipped');
        const list = document.getElementById('skillUploadSkippedList');
        list.textContent = '';
        details.hidden = skipped.length === 0;
        document.getElementById('skillUploadSkippedSummary').textContent = '已跳过 ' + skipped.length + ' 个不支持的文件（查看详情）';
        skipped.forEach(function (item) {
            const row = document.createElement('li');
            row.textContent = item.path + '：' + item.reason;
            list.appendChild(row);
        });
    }

    function parentDirectories(path, directories) {
        const parts = path.split('/'); parts.pop();
        let parent = '';
        parts.forEach(function (part) { parent = parent ? parent + '/' + part : part; directories.add(parent); });
    }

    function collectFiles(files) {
        const directories = new Set();
        const entries = files.map(function (file) {
            const path = file.webkitRelativePath || file.name;
            parentDirectories(path, directories);
            return {path: path, file: file};
        });
        return {directories: Array.from(directories), files: entries, skipped: []};
    }

    async function collectDropped(roots) {
        const directories = new Set(), files = [], skipped = [];
        async function visit(entry, parent) {
            const path = parent ? parent + '/' + entry.name : entry.name;
            if (entry.isDirectory) {
                directories.add(path);
                const reader = entry.createReader();
                // Chromium returns at most 100 entries per call. Drain the reader completely.
                while (true) {
                    const children = await new Promise(function (resolve, reject) { reader.readEntries(resolve, reject); });
                    if (!children.length) break;
                    for (const child of children) await visit(child, path);
                }
            } else if (entry.isFile) {
                try {
                    const file = await new Promise(function (resolve, reject) { entry.file(resolve, reject); });
                    files.push({path: path, file: file});
                } catch (error) { skipped.push({path: path, reason: '文件无法读取：' + error.message}); }
            }
            setStatus('正在扫描：已发现 ' + files.length + ' 个文件、' + directories.size + ' 个目录');
        }
        for (const root of roots) {
            if (root.entry) await visit(root.entry, '');
            else if (root.file) files.push({path: root.file.name, file: root.file});
        }
        return {directories: Array.from(directories), files: files, skipped: skipped};
    }

    async function prepareUpload(tree, skipped) {
        const files = []; let total = 0;
        for (let index = 0; index < tree.files.length; index++) {
            const item = tree.files[index];
            setStatus('正在检查文件 ' + (index + 1) + '/' + tree.files.length + '：' + item.path);
            if (!/\.md$/i.test(item.path)) {
                skipped.push({path: item.path, reason: '不支持的文件格式，仅支持 Markdown (.md)'});
                showSkipped(skipped); continue;
            }
            if (item.file.size > 1048576) throw new Error(item.path + ' 超过单文件 1 MiB 限制，未上传');
            let raw;
            try { raw = new TextDecoder('utf-8', {fatal: true}).decode(await item.file.arrayBuffer()); }
            catch (error) { skipped.push({path: item.path, reason: '无法读取为 UTF-8 文本'}); showSkipped(skipped); continue; }
            if (!raw.trim() || raw.includes('\0')) {
                skipped.push({path: item.path, reason: 'Markdown 必须是非空文本，不能包含空字节'});
                showSkipped(skipped); continue;
            }
            total += item.file.size;
            if (total > 10485760) throw new Error('支持文件的总量超过单次 10 MiB 限制，未上传');
            files.push({path: item.path, raw: raw});
        }
        return {directories: tree.directories, files: files};
    }

    function sendUpload(input) {
        return new Promise(function (resolve, reject) {
            const xhr = new XMLHttpRequest();
            xhr.upload.addEventListener('progress', function (event) {
                const percent = event.lengthComputable ? Math.floor(event.loaded * 100 / event.total) : null;
                setStatus('正在上传' + (percent == null ? '…' : ' ' + percent + '%')
                    + ' · ' + input.files.length + ' 个文件、' + input.directories.length + ' 个目录', percent);
            });
            xhr.upload.addEventListener('load', function () { setStatus('传输已完成，服务器正在校验并保存…'); });
            xhr.open('POST', 'api/skills.php');
            xhr.timeout = 120000;
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.addEventListener('load', function () {
                let result;
                try { result = JSON.parse(xhr.responseText); }
                catch (error) { reject(new Error('上传接口返回无效响应（HTTP ' + xhr.status + '），请检查服务器请求体限制')); return; }
                if (xhr.status < 200 || xhr.status >= 300 || !result.success) reject(new Error(result.error || '上传失败'));
                else resolve(result.data || {});
            });
            xhr.addEventListener('error', function () { reject(new Error('上传网络连接失败，请刷新列表检查结果后重试')); });
            xhr.addEventListener('timeout', function () { reject(new Error('上传超时，请刷新列表检查结果后重试')); });
            xhr.addEventListener('abort', function () { reject(new Error('上传已中止')); });
            xhr.send(JSON.stringify(input));
        });
    }

    async function runUpload(collect) {
        if (skillUploadBusy) { showAlert('error', '已有上传正在进行，请等待完成'); return; }
        const location = Object.assign({}, skillExplorer), disabled = [], skipped = [];
        skillUploadBusy = true;
        zone.querySelectorAll('button').forEach(function (button) { disabled.push([button, button.disabled]); button.disabled = true; });
        showSkipped([]); setStatus('正在扫描文件和目录…');
        try {
            const tree = await collect(); skipped.push(...tree.skipped); showSkipped(skipped);
            const prepared = await prepareUpload(tree, skipped); showSkipped(skipped);
            if (!prepared.files.length && !prepared.directories.length) {
                setStatus('没有可上传的文件，已跳过 ' + skipped.length + ' 个文件', 0);
                return;
            }
            const data = await sendUpload(Object.assign({action: 'upload_tree', mode: location.name ? 'resources' : 'import', name: location.name, path: location.path}, prepared));
            skipped.push(...(data.skipped || [])); showSkipped(skipped);
            const text = (location.name ? '上传完成' : '已导入 ' + (data.skills || []).length + ' 个技能')
                + '：' + data.uploaded_count + ' 个文件、' + data.directory_count + ' 个目录'
                + (skipped.length ? '；已跳过 ' + skipped.length + ' 个不支持的文件' : '');
            setStatus(text, 100); showAlert('success', text);
            try { await refreshSkillList(location); }
            catch (error) { showAlert('error', '上传已完成，但列表刷新失败：' + error.message); }
        } catch (error) { showSkipped(skipped); setStatus(error.message, 0, true); showAlert('error', error.message); }
        finally {
            skillUploadBusy = false;
            disabled.forEach(function (item) { if (item[0].isConnected) item[0].disabled = item[1]; });
            renderSkillBreadcrumb();
        }
    }

    window.uploadSkillFiles = function (input) {
        const files = Array.from(input.files || []); input.value = '';
        if (files.length) return runUpload(function () { return collectFiles(files); });
    };
    window.uploadSkillFolder = window.uploadSkillFiles;

    function isFileDrag(event) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
    zone.addEventListener('dragenter', function (event) {
        if (!isFileDrag(event)) return;
        event.preventDefault(); dragDepth++;
        if (!skillUploadBusy) zone.classList.add('skill-drag-over');
    });
    zone.addEventListener('dragover', function (event) {
        if (!isFileDrag(event)) return;
        event.preventDefault(); event.dataTransfer.dropEffect = skillUploadBusy ? 'none' : 'copy';
    });
    zone.addEventListener('dragleave', function (event) {
        if (!isFileDrag(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) zone.classList.remove('skill-drag-over');
    });
    zone.addEventListener('drop', function (event) {
        if (!isFileDrag(event)) return;
        event.preventDefault(); dragDepth = 0; zone.classList.remove('skill-drag-over');
        // Capture handles synchronously while the DataTransfer store is still readable.
        const roots = Array.from(event.dataTransfer.items || []).filter(function (item) { return item.kind === 'file'; }).map(function (item) {
            const getEntry = item.getAsEntry || item.webkitGetAsEntry;
            return {entry: getEntry ? getEntry.call(item) : null, file: item.getAsFile()};
        });
        if (roots.length) runUpload(function () { return collectDropped(roots); });
        else {
            const files = Array.from(event.dataTransfer.files || []);
            if (files.length) runUpload(function () { return collectFiles(files); });
            else showAlert('error', '浏览器无法读取拖入的目录，请使用“上传文件夹”按钮');
        }
    });
})();
