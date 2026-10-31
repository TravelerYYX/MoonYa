<?php
declare(strict_types=1);

function migrationAssert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$root = dirname(__DIR__);
$migration = (string)file_get_contents($root . '/sql/migrate_remove_multi_agent_v1.sql');
$schema = (string)file_get_contents($root . '/sql/数据库.sql');
$prompts = (string)file_get_contents($root . '/admin/api/system_prompts.php');
$office = (string)file_get_contents($root . '/script/MoonYa-index/modules/script-5-office.php');
$office .= (string)file_get_contents($root . '/script/MoonYa-index/subagent-store.js');
$workProjects = (string)file_get_contents($root . '/api/work_projects.php');

foreach (['agents', 'agent_routing_capabilities', 'agent_tool_grants', 'team_runs', 'team_run_events', 'team_event_media', 'team_project_groups', 'team_project_actors', 'team_artifacts', 'tool_approvals'] as $table) {
    migrationAssert(str_contains($migration, "`{$table}`"), "迁移未删除 {$table}");
}
migrationAssert(str_contains($migration, "NOT IN ('normal', 'programming')"), '迁移未清理无用系统提示词');
migrationAssert(str_contains($migration, "LIKE 'cu\\_%'"), '迁移未清理旧 Computer User 文案');
migrationAssert(str_contains($schema, "NOT IN ('normal', 'programming')"), '全量初始化仍会保留旧系统提示词');
migrationAssert(str_contains($schema, 'DROP TABLE IF EXISTS `team_project_actors`'), '全量初始化仍会保留多 Agent 表');
migrationAssert(str_contains($prompts, "['normal', 'programming']"), '后台系统提示词保护名单错误');
migrationAssert(!str_contains($office, '/api/team.php') && str_contains($office, 'office_events'), '办公室应使用 Harness 而非旧团队运行时');
migrationAssert(!str_contains($workProjects, 'btn_computer_user') && !str_contains($workProjects, 'cu_step_'), '启动时仍会写入旧 Computer User 文案');

echo "multi_agent_migration_state_test: OK\n";
