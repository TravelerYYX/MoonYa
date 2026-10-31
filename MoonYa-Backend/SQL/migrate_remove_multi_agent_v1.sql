-- Irreversible removal of the retired multi-Agent runtime and its history.
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `team_project_actors`;
DROP TABLE IF EXISTS `team_project_groups`;
DROP TABLE IF EXISTS `team_event_media`;
DROP TABLE IF EXISTS `team_artifacts`;
DROP TABLE IF EXISTS `tool_approvals`;
DROP TABLE IF EXISTS `team_run_events`;
DROP TABLE IF EXISTS `agent_delegations`;
DROP TABLE IF EXISTS `agent_tool_grants`;
DROP TABLE IF EXISTS `agent_routing_capabilities`;
DROP TABLE IF EXISTS `conversation_agent_settings`;
DROP TABLE IF EXISTS `team_runs`;
DROP TABLE IF EXISTS `user_mcp_connections`;
DROP TABLE IF EXISTS `mcp_tool_catalog`;
DROP TABLE IF EXISTS `mcp_servers`;
DROP TABLE IF EXISTS `tool_registry`;
DROP TABLE IF EXISTS `agent_runtime_config`;
DROP TABLE IF EXISTS `agents`;

DELETE FROM `system_prompts` WHERE `name` NOT IN ('normal', 'programming');
DELETE FROM `work_project_texts`
WHERE `text_key` = 'btn_computer_user'
   OR `text_key` = 'web_mode_warning_cu'
   OR `text_key` LIKE 'cu\_%' ESCAPE '\\';

SET FOREIGN_KEY_CHECKS = 1;
