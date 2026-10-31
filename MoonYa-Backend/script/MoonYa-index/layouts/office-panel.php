        <!-- 办公室 2.5D 视图（主界面内切换 / 独立窗口共用） -->
        <?php
        // 仅主代理固定展示，子代理工位由真实 Harness 目录动态创建。
        $officeCharacters = [
            ['key' => 'moonya', 'name' => 'MoonYa', 'row' => 0, 'col' => 0],
        ];
        ?>
        <div class="office-view" id="officeView">
            <div class="office-header">
                <label class="office-concurrency">子代理并发 <input id="officeConcurrency" type="number" min="1" step="1" value="8" aria-label="子代理并发数"></label>
                <div class="office-title">MoonYa 办公室</div>
                <button type="button" class="office-popout-btn" id="officePopoutBtn">单独弹出</button>
            </div>
            <div class="office-stage" id="officeStage">
                <div class="office-floor"></div>
                <?php foreach ($officeCharacters as $oa): ?>
                <div class="workstation" data-character="<?php echo $oa['key']; ?>"
                    data-row="<?php echo $oa['row']; ?>" data-col="<?php echo $oa['col']; ?>"
                    aria-label="<?php echo htmlspecialchars($oa['name'], ENT_QUOTES, 'UTF-8'); ?> 工位">
                    <div class="ws-shadow"></div>
                    <div class="ws-mover">
                        <div class="ws-name"><?php echo htmlspecialchars($oa['name'], ENT_QUOTES, 'UTF-8'); ?></div>
                        <div class="ws-status" aria-live="polite"></div>
                        <div class="ws-character-trigger" aria-hidden="true">
                            <img class="ws-character" src="/assets/office/seated-back/<?php echo $oa['key']; ?>.png"
                                 alt="" draggable="false">
                        </div>
                        <img class="ws-empty-chair" src="/assets/office/seated-back/empty-chair.png"
                             alt="" aria-hidden="true" draggable="false">
                    </div>
                    <div class="ws-desk">
                        <div class="ws-desk-front"></div>
                    </div>
                    <div class="ws-desk-top"></div>
                    <div class="ws-monitor">
                        <div class="ws-monitor-frame">
                            <div class="ws-screen"></div>
                        </div>
                        <div class="ws-monitor-stand"></div>
                        <div class="ws-monitor-base"></div>
                    </div>
                    <div class="ws-work-hands" aria-hidden="true">
                        <span class="ws-keyboard"></span>
                        <span class="ws-mouse"></span>
                        <span class="ws-hand ws-hand-keyboard"></span>
                        <span class="ws-hand ws-hand-mouse"></span>
                    </div>
                </div>
                <?php endforeach; ?>
            </div>
            <div class="office-notice" id="officeNotice" role="status"></div>
            <aside class="office-employee-card" id="officeEmployeeCard" hidden aria-label="子代理任务详情">
                <button type="button" id="officeCardClose" aria-label="关闭详情">×</button>
                <h2 id="officeEmployeeTitle"></h2>
                <div id="officeEmployeeStatus"></div>
                <p id="officeEmployeeTask"></p>
                <div id="officeEmployeeRelations"></div>
                <pre id="officeEmployeeResult"></pre>
                <details><summary>执行记录</summary><pre id="officeEmployeeLog"></pre></details>
                <button type="button" id="officeEmployeeStop">停止整个任务分支</button>
            </aside>
        </div>
