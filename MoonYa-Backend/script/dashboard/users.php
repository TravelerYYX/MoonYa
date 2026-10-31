            <div id="usersSection" class="content-section">
                <div class="card">
                    <div class="card-header">
                        <h2 class="modern-card-title">用户管理</h2>
                        <div class="user-filter-bar">
                            <div class="user-search-pill">
                                <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                <input type="text" class="user-search-input" id="quickUserSearch" placeholder="用户ID / 昵称 / 邮箱" onkeydown="if(event.key==='Enter')searchUsers()">
                            </div>
                            <!-- Hidden inputs to preserve all existing API contract bindings -->
                            <input type="hidden" id="searchId">
                            <input type="hidden" id="searchUsername">
                            <input type="hidden" id="searchEmail">
                            <select class="user-select-box" id="searchGender">
                                <option value="">全部性别</option>
                                <option value="male">男</option>
                                <option value="female">女</option>
                                <option value="private">保密</option>
                            </select>
                            <select class="user-select-box" id="searchStatus">
                                <option value="">全部状态</option>
                                <option value="active">活跃</option>
                                <option value="banned">封禁</option>
                                <option value="deleted">已删除</option>
                            </select>
                            <button class="btn-search-blue" onclick="searchUsers()">搜索</button>
                            <button class="btn-add-green" onclick="showAddUserModal()">+ 添加用户</button>
                        </div>
                    </div>
                    <div class="table-container">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th style="width: 8%">ID</th>
                                    <th style="width: 18%">昵称/用户名</th>
                                    <th style="width: 18%">邮箱</th>
                                    <th style="width: 8%">性别</th>
                                    <th style="width: 10%">状态</th>
                                    <th style="width: 12%">会员与积分</th>
                                    <th style="width: 12%">注册时间</th>
                                    <th style="width: 14%">操作</th>
                                </tr>
                            </thead>
                            <tbody id="usersTableBody">
                            </tbody>
                        </table>
                    </div>
                    <div class="pagination-card" style="padding:16px 28px">
                        <div class="pagination" id="usersPagination"></div>
                    </div>
                </div>
            </div>

    <div id="addUserOverlay" class="modal" style="z-index:10000;">
    <div class="modal-content" onclick="event.stopPropagation()">
        <div class="modal-header"><h3>添加用户</h3></div>
        <div class="modal-body">
            <div class="form-group">
                <label>QQ号</label>
                <div class="form-input" style="display:flex;align-items:center;padding:0;">
                    <input type="text" id="addUserQQ" placeholder="请输入QQ号" maxlength="11" oninput="this.value=this.value.replace(/[^0-9]/g,'')" style="flex:1;border:none;background:transparent;padding:10px 14px;outline:none;">
                    <span style="padding-right:14px;color:var(--text-secondary);">@qq.com</span>
                </div>
            </div>
            <div class="form-group">
                <label>密码（可选，不填则只能验证码登录）</label>
                <input type="password" id="addUserPassword" class="form-input" placeholder="至少6位">
            </div>
        </div>
        <div class="modal-footer">
            <button class="btn-secondary" onclick="hideAddUserModal()">取消</button>
            <button class="btn-primary" id="addUserSubmitBtn" onclick="submitAddUser()">创建</button>
        </div>
    </div>
</div>

<script>
        async function loadUsers(page = 1, filters = {}) {
            currentPage = page;
            currentFilters = filters;
            
            let query = `?page=${page}&limit=20`;
            if (filters.id) query += `&id=${filters.id}`;
            if (filters.username) query += `&username=${filters.username}`;
            if (filters.email) query += `&email=${filters.email}`;
            if (filters.gender) query += `&gender=${filters.gender}`;
            if (filters.status) query += `&status=${filters.status}`;
            
            const data = await apiRequest(query);
            if (data.success) {
                renderUsersTable(data.data.users);
                renderPagination('usersPagination', {
                    pages: data.data.pagination.pages,
                    current_page: currentPage
                }, (page) => loadUsers(page, currentFilters));
                return true;
            } else {
                showAlert('error', data.error || '加载失败');
                return false;
            }
        }
        
        window.toggleUserActionsMenu = function(e, id) {
            e.stopPropagation();
            const menu = document.getElementById('moreMenu_' + id);
            const isOpen = menu && menu.classList.contains('show');
            document.querySelectorAll('.more-actions-menu').forEach(m => m.classList.remove('show'));
            if (menu && !isOpen) {
                menu.classList.add('show');
            }
        };

        document.addEventListener('click', () => {
            document.querySelectorAll('.more-actions-menu').forEach(m => m.classList.remove('show'));
        });

        const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

        function renderUsersTable(users) {
            const tbody = document.getElementById('usersTableBody');
            tbody.innerHTML = users.map(user => {

                let datePart = '';
                let timePart = '';
                if (user.created_at) {
                    const parts = String(user.created_at).split(' ');
                    datePart = parts[0] || '';
                    timePart = parts[1] || '';
                }

                let statusBadge = '';
                if (user.status === 'active') {
                    statusBadge = `<span class="status-shield-pill"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg> 活跃</span>`;
                } else if (user.status === 'banned') {
                    statusBadge = `<span class="status-shield-pill banned">封禁</span>`;
                } else {
                    statusBadge = `<span class="status-shield-pill deleted">${getStatusText(user.status)}</span>`;
                }

                return `
                <tr>
                    <td style="color:#64748b;font-weight:600">${user.id}</td>
                    <td>
                        <div style="display:flex;align-items:center;gap:12px">
                            <img class="user-avatar-tag" src="${esc(user.avatar || '/image/user.png')}" alt="QQ头像" style="object-fit:cover" onerror="this.onerror=null;this.src='/image/user.png'">
                            <span style="font-weight:600;color:#0f172a">${esc(name)}</span>
                        </div>
                    </td>
                    <td style="color:#475569">${esc(user.email)}</td>
                    <td>${renderGenderTag(user.gender)}</td>
                    <td>${statusBadge}</td>
                    <td>
                        <button type="button" class="btn-membership-cell" onclick="editUserMembership(${user.id})" aria-label="会员与积分">
                            <strong style="color:#0f172a;display:block">${user.membership ? esc(user.membership.plan.name) : '免费版'}</strong>
                            <span class="sub-points">${user.membership ? Number(user.membership.balance) : 100} 积分</span>
                        </button>
                    </td>
                    <td>
                        <span style="font-weight:500;color:#1e293b">${datePart}</span>
                        <span class="sub-time">${timePart}</span>
                    </td>
                    <td>
                        <div class="actions-cell-wrap">
                            ${renderActions(user)}
                        </div>
                    </td>
                </tr>`;
            }).join('');
        }

        function renderGenderTag(gender) {
            if (gender === 'male') {
                return '<span class="gender-pill gender-pill-male">♂ 男</span>';
            }
            if (gender === 'female') {
                return '<span class="gender-pill gender-pill-female">♀ 女</span>';
            }
            if (gender === 'private') {
                return '<span class="gender-pill">保密</span>';
            }
            return '<span class="gender-pill">未设置</span>';
        }
        
        function getStatusText(status) {
            const map = { active: '活跃', banned: '封禁', deleted: '已删除' };
            return map[status] || status;
        }
        
        function membershipEscape(value) { return esc(value); }
        function renderActions(user) {
            let actions = '';
            if (user.status === 'active') {
                actions += `<button class="btn-action-outline" data-credits-user="${user.id}" data-credits-name="${esc(user.real_name || user.username)}">积分管理</button>`;
            }

            if (user.status !== 'deleted') {
                actions += `<button class="btn-action-outline" onclick="loginAsUser(${user.id}, '${esc(user.real_name || user.username)}')">登录</button>`;
                
                actions += `
                <div style="position:relative;display:inline-block">
                    <button class="btn-action-more" type="button" onclick="toggleUserActionsMenu(event, ${user.id})">•••</button>
                    <div class="more-actions-menu" id="moreMenu_${user.id}">
                        <div role="menuitem" class="more-actions-item" onclick="editUserMembership(${user.id})">会员与积分</div>
                        <div role="menuitem" class="more-actions-item" onclick="editRealName(${user.id}, '${esc(user.real_name || '')}')">修改昵称</div>
                        <div role="menuitem" class="more-actions-item" onclick="editUsername(${user.id}, '${esc(user.username)}')">修改账号</div>
                        <div role="menuitem" class="more-actions-item" onclick="editPassword(${user.id})">修改密码</div>
                        <div role="menuitem" class="more-actions-item" onclick="editEmail(${user.id}, '${esc(user.email)}')">修改邮箱</div>
                        <div role="menuitem" class="more-actions-item" onclick="editGender(${user.id}, '${esc(user.gender || '')}')">修改性别</div>
                        ${user.status === 'active' ? `<div role="menuitem" class="more-actions-item danger-text" onclick="banUser(${user.id})">封禁</div>` : user.status === 'banned' ? `<div role="menuitem" class="more-actions-item" onclick="unbanUser(${user.id})">解禁</div>` : ''}
                        <div role="menuitem" class="more-actions-item danger-text" onclick="deleteUser(${user.id})">删除</div>
                    </div>
                </div>`;
            }

            return actions;
        }
        
        function searchUsers() {
            const quick = (document.getElementById('quickUserSearch')?.value || '').trim();
            let idVal = document.getElementById('searchId')?.value || '';
            let usernameVal = document.getElementById('searchUsername')?.value || '';
            let emailVal = document.getElementById('searchEmail')?.value || '';

            if (quick) {
                if (/^\d+$/.test(quick)) {
                    idVal = quick;
                } else if (quick.includes('@')) {
                    emailVal = quick;
                } else {
                    usernameVal = quick;
                }
            }

            const filters = {
                id: idVal,
                username: usernameVal,
                email: emailVal,
                gender: document.getElementById('searchGender').value,
                status: document.getElementById('searchStatus').value
            };
            loadUsers(1, filters);
        }
        
        function editRealName(userId, currentRealName) {
            showModal(`
                <div class="modal-header">
                    <h3>修改用户昵称</h3>
                </div>
                <div class="form-group">
                    <label>新昵称</label>
                    <input class="form-input" type="text" id="newRealName" value="${currentRealName}">
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="hideModal()">取消</button>
                    <button class="btn-primary" onclick="confirmEditRealName(${userId})">确认</button>
                </div>
            `);
        }

        async function confirmEditRealName(userId) {
            const real_name = document.getElementById('newRealName').value;
            const data = await apiRequest(`?action=update_real_name&user_id=${userId}`, {
                method: 'POST',
                body: JSON.stringify({ real_name })
            });
            
            if (data.success) {
                showAlert('success', '昵称修改成功');
                hideModal();
                loadUsers(currentPage, currentFilters);
            } else {
                showAlert('error', data.error || '修改失败');
            }
        }

        function editUsername(userId, currentUsername) {
            showModal(`
                <div class="modal-header">
                    <h3>修改用户账号</h3>
                </div>
                <div class="form-group">
                    <label>新账号</label>
                    <input class="form-input" type="text" id="newUsername" value="${currentUsername}">
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="hideModal()">取消</button>
                    <button class="btn-primary" onclick="confirmEditUsername(${userId})">确认</button>
                </div>
            `);
        }

        async function confirmEditUsername(userId) {
            const username = document.getElementById('newUsername').value;
            const data = await apiRequest(`?action=update_username&user_id=${userId}`, {
                method: 'POST',
                body: JSON.stringify({ username })
            });
            
            if (data.success) {
                showAlert('success', '用户名修改成功');
                hideModal();
                loadUsers(currentPage, currentFilters);
            } else {
                showAlert('error', data.error || '修改失败');
            }
        }
        
        function editPassword(userId) {
            showModal(`
                <div class="modal-header">
                    <h3>修改密码</h3>
                </div>
                <div class="form-group">
                    <label>新密码</label>
                    <input class="form-input" type="password" id="newPassword" placeholder="请输入至少6位密码">
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="hideModal()">取消</button>
                    <button class="btn-primary" onclick="confirmEditPassword(${userId})">确认</button>
                </div>
            `);
        }
        
        async function confirmEditPassword(userId) {
            const password = document.getElementById('newPassword').value;
            const data = await apiRequest(`?action=update_password&user_id=${userId}`, {
                method: 'POST',
                body: JSON.stringify({ password })
            });
            
            if (data.success) {
                showAlert('success', '密码修改成功');
                hideModal();
            } else {
                showAlert('error', data.error || '修改失败');
            }
        }
        
        function editEmail(userId, currentEmail) {
            showModal(`
                <div class="modal-header">
                    <h3>修改邮箱</h3>
                </div>
                <div class="form-group">
                    <label>新邮箱</label>
                    <input class="form-input" type="email" id="newEmail" value="${currentEmail}">
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="hideModal()">取消</button>
                    <button class="btn-primary" onclick="confirmEditEmail(${userId})">确认</button>
                </div>
            `);
        }
        
        async function confirmEditEmail(userId) {
            const email = document.getElementById('newEmail').value;
            const data = await apiRequest(`?action=update_email&user_id=${userId}`, {
                method: 'POST',
                body: JSON.stringify({ email })
            });

            if (data.success) {
                showAlert('success', '邮箱修改成功');
                hideModal();
                loadUsers(currentPage, currentFilters);
            } else {
                showAlert('error', data.error || '修改失败');
            }
        }

        function editGender(userId, currentGender) {
            const safeGender = ['male', 'female', 'private'].includes(currentGender) ? currentGender : '';
            showModal(`
                <div class="modal-header">
                    <h3>修改用户性别</h3>
                </div>
                <div class="form-group">
                    <label>性别</label>
                    <select class="form-input" id="newGender">
                        <option value=""${safeGender === '' ? ' selected' : ''}>未设置</option>
                        <option value="male"${safeGender === 'male' ? ' selected' : ''}>男</option>
                        <option value="female"${safeGender === 'female' ? ' selected' : ''}>女</option>
                        <option value="private"${safeGender === 'private' ? ' selected' : ''}>保密</option>
                    </select>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="hideModal()">取消</button>
                    <button class="btn-primary" onclick="confirmEditGender(${userId})">确认</button>
                </div>
            `);
        }

        async function confirmEditGender(userId) {
            const gender = document.getElementById('newGender').value;
            const data = await apiRequest(`?action=update_gender&user_id=${userId}`, {
                method: 'POST',
                body: JSON.stringify({ gender: gender })
            });

            if (data.success) {
                showAlert('success', '性别修改成功');
                hideModal();
                loadUsers(currentPage, currentFilters);
            } else {
                showAlert('error', data.error || '修改失败');
            }
        }
        
        function banUser(userId) {
            showModal(`
                <div class="modal-header">
                    <h3>封禁用户</h3>
                </div>
                <div class="form-group">
                    <label>封禁原因（可选）</label>
                    <textarea class="form-textarea" id="banReason" rows="3"></textarea>
                </div>
                <div class="form-group">
                    <label>封禁时长（小时，留空则永久封禁）</label>
                    <input class="form-input" type="number" id="banDuration" min="1">
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="hideModal()">取消</button>
                    <button class="btn-danger" onclick="confirmBanUser(${userId})">确认封禁</button>
                </div>
            `);
        }
        
        async function confirmBanUser(userId) {
            const reason = document.getElementById('banReason').value;
            const duration = document.getElementById('banDuration').value;
            
            const data = await apiRequest(`?action=ban&user_id=${userId}`, {
                method: 'POST',
                body: JSON.stringify({
                    reason: reason,
                    duration_hours: duration ? parseInt(duration) : null
                })
            });
            
            if (data.success) {
                showAlert('success', '用户已封禁');
                hideModal();
                loadUsers(currentPage, currentFilters);
                loadStats();
            } else {
                showAlert('error', data.error || '操作失败');
            }
        }
        
        async function unbanUser(userId) {
            const data = await apiRequest(`?action=unban&user_id=${userId}`, { method: 'POST' });
            
            if (data.success) {
                showAlert('success', '用户已解禁');
                loadUsers(currentPage, currentFilters);
                loadStats();
            } else {
                showAlert('error', data.error || '操作失败');
            }
        }
        
        function deleteUser(userId) {
            showModal(`
                <div class="modal-header">
                    <h3>删除用户</h3>
                </div>
                <p style="color: var(--text-secondary); margin-bottom: 24px;">确定要删除该用户吗？此操作不可恢复。</p>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="hideModal()">取消</button>
                    <button class="btn-danger" onclick="confirmDeleteUser(${userId})">确认删除</button>
                </div>
            `);
        }
        
        async function confirmDeleteUser(userId) {
            const data = await apiRequest(`?user_id=${userId}`, { method: 'DELETE' });
            
            if (data.success) {
                showAlert('success', '用户已删除');
                hideModal();
                loadUsers(currentPage, currentFilters);
                loadStats();
            } else {
                showAlert('error', data.error || '操作失败');
            }
        }
    function showAddUserModal() {
        document.getElementById('addUserOverlay').classList.add('show');
        document.getElementById('addUserQQ').value = '';
        document.getElementById('addUserPassword').value = '';
        document.getElementById('addUserSubmitBtn').disabled = false;
        document.getElementById('addUserSubmitBtn').textContent = '创建';
    }
    function hideAddUserModal() {
        document.getElementById('addUserOverlay').classList.remove('show');
    }
    
    async function submitAddUser() {
        var qq = document.getElementById('addUserQQ').value.trim();
        if (!qq || !/^[0-9]{5,11}$/.test(qq)) {
            showAlert('error', '请输入有效的QQ号');
            return;
        }
        var password = document.getElementById('addUserPassword').value;
        var btn = document.getElementById('addUserSubmitBtn');
        btn.disabled = true;
        btn.textContent = '创建中...';
        
        try {
            var data = await apiRequest('?action=create_user', {
                method: 'POST',
                body: JSON.stringify({ email: qq + '@qq.com', password: password })
            });
            if (data.success) {
                showAlert('success', '用户创建成功：' + data.data.user.username);
                hideAddUserModal();
                loadUsers(currentPage, currentFilters);
            } else {
                showAlert('error', data.error || '创建失败');
                btn.disabled = false;
                btn.textContent = '创建';
            }
        } catch (e) {
            showAlert('error', '网络错误');
            btn.disabled = false;
            btn.textContent = '创建';
        }
    }
    
    async function loginAsUser(userId, userName) {
        if (!confirm('确定要以「' + userName + '」的身份登录前端吗？\n将在新窗口打开。')) return;
        
        try {
            var data = await apiRequest('?action=login_as&user_id=' + userId);
            if (data.success) {
                window.open(data.data.login_url, '_blank');
            } else {
                showAlert('error', data.error || '获取登录链接失败');
            }
        } catch (e) {
            showAlert('error', '网络错误');
        }
    }
</script>
