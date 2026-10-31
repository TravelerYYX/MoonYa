<?php
declare(strict_types=1);

function uiAssert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$root = dirname(__DIR__);
$layout = (string)file_get_contents($root . '/script/MoonYa-index/layouts/main-content.php');
$variables = (string)file_get_contents($root . '/script/MoonYa-index/modules/script-1a-vars.php');
$dom = (string)file_get_contents($root . '/script/MoonYa-index/modules/script-1d-dom.php');
$events = (string)file_get_contents($root . '/script/MoonYa-index/modules/script-1e-rest.php');
$office = (string)file_get_contents($root . '/script/MoonYa-index/modules/script-5-office.php');
$office .= (string)file_get_contents($root . '/script/MoonYa-index/subagent-store.js');
$officeLayout = (string)file_get_contents($root . '/script/MoonYa-index/layouts/office-panel.php');

uiAssert(str_contains($layout, 'data-skill-name="<?php echo htmlspecialchars($skill[\'name\']'), '技能未出现在“+”菜单');
uiAssert(str_contains($dom, "startsWith('/')") && str_contains($dom, "event.key === 'ArrowDown'"), '/ 技能菜单缺少键盘入口');
uiAssert(str_contains($layout, 'id="selectedSkillsInline"') && str_contains($dom, 'selected-skill-inline'), '已选技能内联标签缺失');
uiAssert(str_contains($dom, "event.key === 'Backspace'") && str_contains($dom, 'selectedSkills.pop()'), '已选技能缺少退格删除');
uiAssert(str_contains($events, 'selected_skills: selectedSkillsToSend'), '技能未随当前请求发送');
uiAssert(str_contains($events, 'targetContainer = null, skillNames = []') && str_contains($events, 'sent-selected-skills'), '已发送消息未携带所选技能');
uiAssert(str_contains($events, 'selectedSkills = [];'), '发送后没有清空本轮技能');
uiAssert(!str_contains($layout . $variables . $events, 'computer_user_mode'), '独立 Computer User 模式仍在前端');
uiAssert(!str_contains($layout, 'id="computerUserBtn"'), 'Computer User 开关仍在界面');
uiAssert(!str_contains($office, '/api/team.php') && str_contains($office, 'office_events'), '办公室未使用新 Harness 事件流');
uiAssert(str_contains($officeLayout, 'id="officeStage"') && str_contains($office, "querySelectorAll('.workstation')"), '办公室工位画面已被误删');
uiAssert(!str_contains($events . $office, 'moonya:team-event'), '旧团队事件监听仍存在');

echo "agent_ui_contract_test: OK\n";
