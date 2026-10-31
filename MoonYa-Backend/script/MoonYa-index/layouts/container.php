</head>
<?php $officePopoutMode = isset($_GET['office_popout']) && $_GET['office_popout'] === '1'; ?>
<body class="work-mode office-active<?php echo $officePopoutMode ? ' office-popout-mode' : ''; ?>"
      data-office-popout="<?php echo $officePopoutMode ? '1' : '0'; ?>"
      data-authenticated="<?php echo isset($_SESSION['user_id']) ? '1' : '0'; ?>">
    <div class="container">
        <!-- 浮动按钮组（侧边栏收起且非桌面端时显示；桌面端这两个按钮在原生标题栏） -->
        <div class="floating-controls" id="floatingControls">
            <div class="floating-btn-group">
                <div class="floating-btn-small" id="expandSidebarBtn" role="button" aria-label="展开侧边栏">
                    <svg viewBox="0 0 12 12" width="16" height="16" fill="none" aria-hidden="true">
                        <rect x="0.6" y="0.6" width="10.8" height="10.8" rx="2.6"
                              stroke="#1a1a1a" stroke-width="1.2"></rect>
                        <line x1="4.4" y1="0.6" x2="4.4" y2="11.4"
                              stroke="#1a1a1a" stroke-width="1.2"></line>
                    </svg>
                </div>
                <div class="floating-btn-large" id="newChatFloatingBtn" role="button" aria-label="新建对话">
                    <svg viewBox="0 0 13 13" width="24" height="24" fill="none" aria-hidden="true">
                        <path d="M 4.279,10.833 A 4.875,4.875 0 1 0 2.167,8.721 L 1.083,11.917 Z"
                              stroke="#1a1a1a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></path>
                        <path d="M 4.9,6.5 H 8.1 M 6.5,4.9 V 8.1"
                              stroke="#1a1a1a" stroke-width="1.2" stroke-linecap="round"></path>
                    </svg>
                </div>
            </div>
        </div>
