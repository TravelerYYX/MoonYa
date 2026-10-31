        /* 模型选择样式 */
        .model-select-container {
            padding: 6px 0;
            margin: 0 0 8px 0;
        }

        .model-select-label {
            font-size: 12px;
            color: #666;
            margin-bottom: 6px;
            padding: 0 12px;
        }

        .custom-model-select {
            padding: 0 12px;
        }
        
        .model-select {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid #e8e8e8;
            border-radius: 8px;
            font-size: 13px;
            background-color: white;
            color: #333;
            cursor: pointer;
            outline: none;
            transition: all 0.3s;
        }
        
        .model-select:hover {
            border-color: #1890ff;
        }
        
        .model-select:focus {
            border-color: #1890ff;
            box-shadow: 0 0 0 2px rgba(24, 144, 255, 0.1);
        }
        
        .model-select.loading {
            opacity: 0.6;
            pointer-events: none;
        }
        
        /* 自定义模型选择样式 */
        .custom-model-select {
            position: relative;
            width: 100%;
        }
        
        .model-select-value {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid #e8e8e8;
            border-radius: 8px;
            font-size: 13px;
            background-color: white;
            color: #333;
            cursor: pointer;
            transition: all 0.3s;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .model-select-value:hover {
            border-color: #1890ff;
        }
        
        .model-select-arrow {
            position: absolute;
            right: 12px;
            top: 50%;
            transform: translateY(-50%);
            width: 16px;
            height: 16px;
            transition: transform 0.3s;
            cursor: pointer;
        }
        
        .model-select-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            bottom: auto;
            background-color: white;
            border: 1px solid #e8e8e8;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            margin-top: 4px;
            z-index: 1000;
            max-height: calc(100vh - 200px);
            overflow-y: auto;
            scrollbar-width: none;
            -ms-overflow-style: none;
            display: none;
        }
        
        .model-select-dropdown::-webkit-scrollbar {
            display: none;
        }
        
        .model-option {
            padding: 10px 12px;
            cursor: pointer;
            transition: all 0.3s;
            border-bottom: 1px solid #f0f0f0;
        }
        
        .model-option:last-child {
            border-bottom: none;
        }
        
        .model-option:hover {
            background-color: #f5f7fa;
        }
        
        .model-option.selected {
            background-color: #e6f7ff;
            color: #1890ff;
        }
        
        .model-option-name {
            font-size: 13px;
            font-weight: 500;
            color: #333;
        }
        
        .model-option-desc {
            font-size: 11px;
            color: #999;
            margin-top: 2px;
        }
        
        /* 模式切换 Tab */
        .mode-toggle-container {
            display: flex;
            align-items: center;
            justify-content: space-between;
            width: 100%;
            height: 40px;
            margin: 0 0 8px 0;
            padding: 3px;
            background: #eceeef;
            border-radius: 10px;
            box-sizing: border-box;
        }
        .mode-toggle-tab {
            flex: 1;
            height: 34px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            color: #6b7280;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            user-select: none;
        }
        .mode-toggle-tab.active {
            background: #ffffff;
            color: #111827;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
        }
        .mode-toggle-tab:not(.active):hover {
            color: #374151;
        }
        .mode-tab-icon {
            width: 14px;
            height: 14px;
        }

        /* 侧边栏新建会话按钮 */
        .new-session-btn {
            display: flex;
            align-items: center;
            justify-content: space-between;
            width: 100%;
            height: 40px;
            padding: 0 12px;
            margin: 0 0 8px 0;
            background: #eceeef;
            border: 1px solid #e4e6e8;
            border-radius: 10px;
            cursor: pointer;
            box-sizing: border-box;
            transition: all 0.2s ease;
        }
        .new-session-btn:hover {
            background: #eceeef;
        }
        .new-session-left {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .new-session-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: #ffffff;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 1px 2px rgba(0,0,0,0.06);
            color: #374151;
        }
        .new-session-icon svg {
            width: 20px;
            height: 20px;
        }
        .new-session-text {
            font-size: 14px;
            font-weight: 500;
            color: #374151;
        }
        .new-session-shortcut {
            font-size: 12px;
            font-weight: 500;
            color: #9ca3af;
            background: #ffffff;
            padding: 3px 8px;
            border-radius: 6px;
            border: 1px solid #e4e6e8;
        }
        
        /* 隐藏的文件输入 */
        #fileInput,
        #folderInput {
            display: none;
        }

        .sidebar-model-hidden { display: none !important; }

        /* ==================== 上下文圆环 ==================== */
        .context-ring-wrap {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            margin-right: 6px;
            flex-shrink: 0;
        }
        .context-ring-svg {
            transform: rotate(-90deg);
            display: block;
        }
        .context-ring-bg {
            fill: none;
            stroke: #e6e6e6;
            stroke-width: 2.2;
        }
        .context-ring-fill {
            fill: none;
            stroke: #1a1a1a;
            stroke-width: 2.2;
            stroke-linecap: round;
            stroke-dasharray: 47.12;
            stroke-dashoffset: 47.12;
            transition: stroke-dashoffset 0.35s ease;
        }
        /* 接近上限：轻脉冲提示（保持黑白极简，不改色） */
        .context-ring-wrap.warn .context-ring-fill {
            animation: context-ring-pulse 1.6s ease-in-out infinite;
        }
        .context-ring-wrap.full .context-ring-fill {
            animation: context-ring-pulse 0.8s ease-in-out infinite;
        }
        @keyframes context-ring-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.35; }
        }
        .context-ring-trigger {
            display: flex; align-items: center; justify-content: center;
            width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px;
            background: transparent; color: inherit; cursor: pointer;
        }
        .context-ring-trigger:hover { background: #f0f1f3; }
        .context-ring-trigger:focus-visible { outline: 2px solid #508dff; outline-offset: 2px; }
        .context-ring-tooltip {
            position: fixed; width: 304px; max-width: calc(100vw - 16px);
            max-height: calc(100vh - 16px); overflow-y: auto; box-sizing: border-box;
            background: #fafbfc; color: #17191d; border: 1px solid #e5e7eb;
            border-radius: 10px; padding: 22px 14px 10px; font-size: 12px;
            line-height: 1.5; z-index: 1100; box-shadow: 0 8px 28px #00000018;
            text-align: left; font-weight: 400;
        }
        .context-ring-tooltip[hidden] { display: none; }
        .context-ring-tooltip .crt-close {
            position: absolute; right: 7px; top: 4px; display: flex; align-items: center;
            justify-content: center; width: 20px; height: 20px; padding: 3px; border: 0;
            border-radius: 4px; background: transparent; color: #828894; cursor: pointer;
        }
        .context-ring-tooltip .crt-close:hover { background: #e9ebef; color: #17191d; }
        .context-ring-tooltip svg { fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }
        .context-ring-tooltip .crt-close svg { width: 14px; height: 14px; }
        .crt-section + .crt-section { border-top: 1px solid #e1e3e8; margin-top: 8px; padding-top: 8px; }
        .crt-section summary { display: flex; align-items: center; gap: 6px; min-height: 24px; cursor: pointer; list-style: none; user-select: none; }
        .crt-section summary::-webkit-details-marker { display: none; }
        .crt-section summary:focus-visible { outline: 2px solid #508dff; border-radius: 3px; }
        .crt-section-icon { width: 15px; height: 15px; flex-shrink: 0; }
        .crt-summary-value { margin-left: auto; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .crt-chevron { width: 12px; height: 12px; margin-left: auto; flex-shrink: 0; color: #818792; transition: transform .15s; }
        .crt-summary-value + .crt-chevron { margin-left: 0; }
        .crt-section[open] > summary .crt-chevron { transform: rotate(90deg); }
        .crt-title { color: #818792; }
        #crtPercent { white-space: nowrap; font-variant-numeric: tabular-nums; }
        .crt-details { padding: 8px 0 0; margin: 0; border-top: 1px solid #e1e3e8; margin-top: 5px; }
        .crt-details > div { display: flex; align-items: baseline; gap: 8px; margin: 4px 0; }
        .crt-details > div[hidden] { display: none; }
        .crt-details dt { color: #818792; }
        .crt-details dd { margin: 0 0 0 auto; color: #6e747f; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .crt-record-note { margin: 6px 0 0; font-size: 10px; color: #8a909b; }
        .crt-record-note[hidden] { display: none; }
        .crt-context-body { padding-top: 6px; }
        .crt-bar { display: flex; height: 4px; border-radius: 2px; background: #e9ebee; overflow: hidden; margin: 0 0 14px; }
        .crt-seg { display: block; height: 100%; width: 0; transition: width .25s; }
        .crt-seg-system { background: #aeb4bf; }
        .crt-seg-tools { background: #b181ff; }
        .crt-seg-msgs { background: #508dff; }
        .crt-bar.crt-unknown .crt-seg-msgs { background: #aeb4bf; }
        .crt-legend { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 5px; }
        .crt-legend li { display: flex; align-items: center; gap: 6px; color: #818792; }
        .crt-legend b { margin-left: auto; color: #252930; font-weight: 400; font-variant-numeric: tabular-nums; }
        .context-ring-tooltip svg.crt-dot { width: 8px; height: 8px; stroke: none; flex-shrink: 0; }
        .crt-dot-system { fill: #aeb4bf !important; }
        .crt-dot-tools { fill: #b181ff !important; }
        .crt-dot-msgs { fill: #508dff !important; }
        @media (prefers-reduced-motion: reduce) { .crt-seg, .crt-chevron { transition: none; } }

        /* ==================== 模型菜单：上下文长度选择 ==================== */
        .context-limit-section,
        .agent-context-section {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 8px 12px;
            border-top: 1px solid #f0f0f0;
        }
        .agent-context-section {
            border-top: 1px solid #ececec;
            padding: 10px 12px;
        }
        .context-limit-label,
        .agent-context-label {
            font-size: 12px;
            color: #666;
            flex-shrink: 0;
        }
        .context-limit-group {
            display: flex;
            align-items: center;
            background: #f2f2f2;
            border-radius: 7px;
            padding: 2px;
            gap: 2px;
        }
        .context-limit-option {
            border: none;
            background: transparent;
            color: #555;
            font-size: 12px;
            font-weight: 500;
            padding: 3px 10px;
            border-radius: 5px;
            cursor: pointer;
            transition: all 0.18s ease;
            line-height: 1.4;
        }
        .context-limit-option:hover {
            color: #1a1a1a;
        }
        .context-limit-option.selected {
            background: #ffffff;
            color: #1a1a1a;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
        }
