        <!-- 左侧侧边栏 -->
        <div class="sidebar" id="sidebar">
            <div class="sidebar-header">
                <div class="avatar">
                    <img src="/icon.png" alt="雅泫">
                </div>
                <div class="sidebar-title">MoonYa</div>
                <div class="sidebar-toggle" id="sidebarToggle" role="button" aria-label="收起侧边栏">
                    <svg viewBox="0 0 12 12" width="20" height="20" fill="none" aria-hidden="true">
                        <rect x="0.6" y="0.6" width="10.8" height="10.8" rx="2.6"
                              stroke="#1a1a1a" stroke-width="1.2"></rect>
                        <line x1="4.4" y1="0.6" x2="4.4" y2="11.4"
                              stroke="#1a1a1a" stroke-width="1.2"></line>
                    </svg>
                </div>
            </div>
            <div class="sidebar-menu">
                <!-- 模式切换 Tab -->
                <div class="mode-toggle-container" id="modeToggleContainer">
                    <div class="mode-toggle-tab active" data-value="work" id="modeWorkTab">
                        <svg class="mode-tab-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                        <span>Work</span>
                    </div>
                    <div class="mode-toggle-tab" data-value="chat" id="modeChatTab">
                        <svg class="mode-tab-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                        <span>Chat</span>
                    </div>
                    <input type="hidden" id="modeSelect" value="work">
                </div>

                <!-- 新建会话按钮 -->
                <div class="new-session-btn" id="sidebarNewChatBtn">
                    <div class="new-session-left">
                        <div class="new-session-icon">
                            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" role="img" class="iconify new-icon" width="20" height="20" viewBox="0 0 1024 1024" name="AddConversation"><path d="M475.136 561.152v89.74336c0 20.56192 16.50688 37.23264 36.864 37.23264s36.864-16.67072 36.864-37.23264v-89.7024h89.7024c20.60288 0 37.2736-16.54784 37.2736-36.864 0-20.39808-16.67072-36.864-37.2736-36.864H548.864V397.63968A37.0688 37.0688 0 0 0 512 360.448c-20.35712 0-36.864 16.67072-36.864 37.2736v89.7024H385.4336a37.0688 37.0688 0 0 0-37.2736 36.864c0 20.35712 16.67072 36.864 37.2736 36.864h89.7024z" fill="currentColor"></path><path d="M512 118.784c-223.96928 0-405.504 181.57568-405.504 405.504 0 78.76608 22.44608 152.3712 61.35808 214.6304l-44.27776 105.6768a61.44 61.44 0 0 0 56.68864 85.1968H512c223.92832 0 405.504-181.53472 405.504-405.504 0-223.92832-181.57568-405.504-405.504-405.504z m-331.776 405.504a331.776 331.776 0 1 1 331.73504 331.776H198.656l52.59264-125.5424-11.59168-16.62976A330.09664 330.09664 0 0 1 180.224 524.288z" fill="currentColor"></path></svg>
                        </div>
                        <span class="new-session-text">新建会话</span>
                    </div>
                    <span class="new-session-shortcut">Ctrl K</span>
                </div>

                <!-- 模型选择模块 -->
                <div class="model-select-container" id="modelSelectContainer">
                    <div class="model-select-label">选择模型</div>
                    <div class="custom-model-select">
                        <div class="model-select-value" id="modelSelectValue">DeepSeek</div>
                        <img class="model-select-arrow" src="/image/y.png" alt="展开">
                        <div class="model-select-dropdown">
                            <div class="model-option selected" data-value="deepseek">
                                <div class="model-option-name">DeepSeek</div>
                                <div class="model-option-desc">深度求索</div>
                            </div>
                        </div>
                    </div>
                    <input type="hidden" id="modelSelect" value="deepseek">
                </div>

<a href="/down/Moonya-setup.msi" target="_blank" style="text-decoration:none; color: inherit;">
                <div id="downloadAppBtn" class="menu-item">
                    <div class="menu-item-main">
                        <div class="menu-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="size-16"><path d="M16.4385 20.1621C16.9903 20.1626 17.4385 20.6101 17.4385 21.1621C17.4385 21.7141 16.9903 22.1616 16.4385 22.1621H7.5625C7.01022 22.1621 6.5625 21.7144 6.5625 21.1621C6.5625 20.6098 7.01022 20.1621 7.5625 20.1621H16.4385ZM13.9688 1.83789C16.0913 1.83789 17.153 1.83798 18.0156 2.10352L18.3662 2.22363C20.0959 2.87538 21.4364 4.29255 21.9844 6.07227L22.0723 6.40723C22.2501 7.21726 22.25 8.26197 22.25 10.1191C22.25 12.2417 22.2499 13.3034 21.9844 14.166L21.8643 14.5166C21.2125 16.2463 19.7953 17.5868 18.0156 18.1348C17.3686 18.3339 16.6095 18.384 15.375 18.3965L13.9688 18.4004H10.0312L8.625 18.3965C7.39084 18.384 6.63225 18.3338 5.98535 18.1348C4.20541 17.5869 2.78753 16.2464 2.13574 14.5166L2.01562 14.166C1.81647 13.519 1.76635 12.7598 1.75391 11.5254L1.75 10.1191C1.75 7.9966 1.75009 6.93488 2.01562 6.07227C2.60013 4.17384 4.08688 2.6879 5.98535 2.10352C6.63225 1.90444 7.39084 1.85424 8.625 1.8418L10.0312 1.83789H13.9688ZM10.0312 3.83789C7.76125 3.83789 7.07583 3.85994 6.57324 4.01465C5.30754 4.40428 4.31637 5.39542 3.92676 6.66113C3.77209 7.16372 3.75 7.84922 3.75 10.1191C3.75 12.3891 3.77209 13.0746 3.92676 13.5771C4.31637 14.8429 5.30754 15.834 6.57324 16.2236C7.07583 16.3783 7.76125 16.4004 10.0312 16.4004H13.9688C16.2388 16.4004 16.9242 16.3783 17.4268 16.2236C18.6925 15.834 19.6836 14.8429 20.0732 13.5771C20.2279 13.0746 20.25 12.3891 20.25 10.1191C20.25 7.84913 20.2279 7.16372 20.0732 6.66113C19.6836 5.3954 18.6925 4.40427 17.4268 4.01465C16.9242 3.85997 16.2388 3.83789 13.9688 3.83789H10.0312Z" fill="currentColor"></path></svg>
                        </div>
                        <span>下载电脑版</span>
                    </div>
                </div>
</a>

<div id="conversationBtn" class="menu-item" style="cursor: pointer;">
                    <div class="menu-item-main">
                        <div class="menu-icon">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path><path d="M8 9h8M8 13h5"></path></svg>
                        </div>
                        <span>对话</span>
                    </div>
                </div>

<div id="officeBtn" class="menu-item" style="cursor: pointer;">
                    <div class="menu-item-main">
                        <div class="menu-icon">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="20" height="20"><path d="M192 896V341.333333c0-23.466667 19.2-42.666667 42.666667-42.666667h170.666666V128c0-23.466667 19.2-42.666667 42.666667-42.666667h298.666667c23.466667 0 42.666667 19.2 42.666666 42.666667v554.666667h42.666667c23.466667 0 42.666667 19.2 42.666666 42.666667s-19.2 42.666667-42.666666 42.666666H234.666667c-23.466667 0-42.666667-19.2-42.666667-42.666666s19.2-42.666667 42.666667-42.666667h42.666666v-85.333334h-85.333333v-85.333333h85.333333v-85.333333h-85.333333V426.666667h85.333333v85.333333h85.333334v-85.333333h85.333333v85.333333h-85.333333v85.333333h85.333333v85.333334h-85.333333v85.333333h85.333333v-85.333333h85.333334v85.333333h42.666666V170.666667H490.666667v128h128v85.333333H490.666667v128h128v85.333334H490.666667v298.666666h-85.333334v-85.333333h-128v85.333333H192z m341.333333-554.666667h128v-85.333333h-128v85.333333z" fill="currentColor"></path></svg>
                        </div>
                        <span>办公室</span>
                    </div>
                </div>

                <div id="recentChatBtn" class="menu-item">
                    <div class="menu-item-main">
                        <div class="menu-icon">
                            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" role="img" class="iconify nav-icon" width="20" height="20" viewBox="0 0 1024 1024" name="History"><path d="M512 81.066667c-233.301333 0-422.4 189.098667-422.4 422.4s189.098667 422.4 422.4 422.4 422.4-189.098667 422.4-422.4-189.098667-422.4-422.4-422.4z m-345.6 422.4a345.6 345.6 0 1 1 691.2 0 345.6 345.6 0 1 1-691.2 0z m379.733333-174.933334a38.4 38.4 0 0 0-76.8 0v187.733334a38.4 38.4 0 0 0 11.264 27.136l93.866667 93.866666a38.4 38.4 0 1 0 54.272-54.272L546.133333 500.352V328.533333z" fill="currentColor"></path></svg>
                        </div>
                        <span>最近对话</span>
                    </div>
                    <svg class="menu-arrow" id="recentChatArrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>
                </div>
                <div id="recentChatList" class="recent-chat-list">

                </div>
            </div>
            <div class="sidebar-footer">
                <div class="user-info" id="userInfoDiv" style="cursor: pointer;">
                    <div class="user-avatar">
                        <img id="userAvatar" src="/icon.png" alt="用户头像" style="display: block; width: 32px; height: 32px;">
                        <div id="avatarPlaceholder" style="width: 32px; height: 32px; border-radius: 50%; background-color: #e8e8e8; display: none; align-items: center; justify-content: center; color: #999;">👤</div>
                    </div>
                    <div class="user-details">
                        <div id="userName" class="user-name">未登录</div>
                        <div id="userQQ" class="user-qq"></div>
                    </div>
                </div>
                <button id="qqLoginBtn" class="qq-login-btn">登陆</button>
            </div>
            
