            <!-- 登录注册弹窗 -->
            <div id="authOverlay" class="auth-overlay">
                <div class="auth-modal liquid-glass" id="authModalBox">
                    <div class="modal-glow" id="modalGlow"></div>
                    <button class="auth-close-btn" id="authCloseBtn">✕</button>
                    
                    <div class="auth-modal-left">
                        <div class="image-wrapper">
                            <img src="/image/bg.png" alt="background">
                            <div class="image-overlay"></div>
                        </div>
                        <div class="left-content">
                            <h2>MoonYa</h2>
                            <p>极简美学，温润通透</p>
                        </div>
                    </div>
                    
                    <div class="auth-modal-right">
                        <div class="auth-tabs">
                            <button class="auth-tab-btn active" data-tab="password">密码登录</button>
                            <button class="auth-tab-btn" data-tab="register">注册账号</button>
                        </div>
                        <div class="auth-form-container">
                            <form class="auth-form active" id="password-form">
                                <div class="input-group">
                                    <label>账号</label>
                                    <input type="text" id="loginAccount" placeholder="请输入用户名或邮箱">
                                </div>
                                <div class="input-group">
                                    <label>密码</label>
                                    <input type="password" id="loginPassword" placeholder="请输入密码">
                                </div>
                                <button type="button" class="auth-btn-primary" id="loginBtn">登录</button>
                            </form>

                            <form class="auth-form" id="register-form">
                                <div class="input-group">
                                    <label>用户名</label>
                                    <input type="text" id="registerUsername" placeholder="2-32 位，中文/字母/数字/下划线" maxlength="32">
                                </div>
                                <div class="input-group">
                                    <label>密码</label>
                                    <input type="password" id="registerPassword" placeholder="至少 6 位" maxlength="72">
                                </div>
                                <div class="input-group">
                                    <label>邮箱（选填）</label>
                                    <input type="text" id="registerEmail" placeholder="选填，仅用于展示" maxlength="100">
                                </div>
                                <button type="button" class="auth-btn-primary" id="registerBtn">注册</button>
                            </form>
                        </div>
                    </div>
                </div>
            </div>
        </div>
