import path, { win32 } from 'node:path';
import { realpath } from 'node:fs/promises';

export const APPROVAL_MODES = Object.freeze(['confirm_writes', 'high_risk', 'full_access']);
export function normalizeApprovalMode(value = 'confirm_writes') {
  const mode = ({ always_confirm_changes: 'confirm_writes', high_risk_only: 'high_risk' })[value] || value;
  if (!APPROVAL_MODES.includes(mode)) throw new Error('invalid_approval_mode');
  return mode;
}
export function permissionInstructions(value) {
  const mode = normalizeApprovalMode(value);
  const description = {
    confirm_writes: 'Routine project file operations and known local read commands run directly. External modifications, task networking, deletion, opaque commands and computer actions require the user to approve the exact operation.',
    high_risk: 'The same permission boundaries apply. An independent request to the current chat model reviews operations that require approval. On rejection, explain the reason and use a safer plan or ask the user; never switch tools to retry the denied operation automatically. Review failure falls back to a user approval card.',
    full_access: 'Task-scoped tools may access external files and the internet without permission confirmation. Parameter, syntax, protocol checks and explicitly configured prohibitions remain in force.'
  }[mode];
  return 'Active chat permission mode: ' + mode + '. ' + description + '\nSubmit the intended tool call for the runtime to apply permissions. Do not claim an approval that was not granted. User takeover requests still require user action. These are application-layer checks, not operating-system isolation.';
}
const windowsPath = value => /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(String(value || ''));
const inside = (api, root, target) => {
  const relative = api.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + api.sep) && !api.isAbsolute(relative));
};
async function canonicalTarget(api, target) {
  let probe = target;
  while (true) {
    try { return api.resolve(await realpath(probe), api.relative(probe, target)); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    const parent = api.dirname(probe);
    if (parent === probe) return target;
    probe = parent;
  }
}
export async function pathIsInside(workspace, candidate) {
  const api = windowsPath(workspace) || windowsPath(candidate) ? win32 : path;
  const root = api.resolve(workspace), target = api.resolve(root, candidate);
  if (!inside(api, root, target)) return false;
  const realRoot = await canonicalTarget(api, root), realTarget = await canonicalTarget(api, target);
  return inside(api, realRoot, realTarget);
}

const network = new Set(['web_search', 'web_fetch']);
const browserLocal = new Set(['status', 'stop', 'inspect', 'screenshot', 'list_tabs', 'switch_tab', 'close_tab', 'list_downloads', 'scroll', 'hover']);
const reads = new Set(['read_file', 'view_directory', 'glob', 'grep', 'get_diagnostics', 'find_references', 'goto_definition', 'read_skill', 'get_command_status', 'stop_command', 'computer_observe']);
const internal = new Set(['todo_write', 'plan_write', 'goal_write', 'interaction_request_action', 'subagent', 'send_message', 'interrupt_agent']);
export async function toolPermission(name, args, workspace, preflight) {
  const request = reason => ({ required: true, reason, riskLevel: 'high', effect: 'unknown' });
  if (['path', 'cwd', 'save_screenshot_to'].some(field => typeof args[field] === 'string' && /^\\\\/.test(args[field]))) return request('网络共享路径可能主动访问网络，需要批准。');
  if (network.has(name)) return request('此操作需要访问互联网。');
  if (name === 'browser_automation_control') {
    if (args.save_screenshot_to && !await pathIsInside(workspace, args.save_screenshot_to)) return request('截图将写入项目目录外。');
    if (args.risk_category || !browserLocal.has(args.action)) return request('此浏览器操作可能访问互联网或修改网页数据。');
    return { required: false };
  }
  if (name === 'delete_file') return { ...request('删除文件或目录属于高风险操作。'), effect: 'destructive' };
  if (name === 'computer_use_tool' || name === 'computer_interact') return request('电脑操作或任意 Python 代码的影响无法由应用层可靠判定。');
  if (name === 'execute_command') {
    if (args.cwd && !await pathIsInside(workspace, args.cwd)) return request('命令将在项目目录外执行。');
    // Only the host parser's read-only classification is trusted. Other commands
    // may spawn arbitrary children, write external files or use the network.
    if (preflight?.effect === 'read' && String(preflight.riskLevel || preflight.risk_level).toLowerCase() === 'low') return { required: false };
    return { ...request('命令包含修改、联网或无法确定影响的操作。'), ...preflight, required: true };
  }
  if (name === 'create_file' || (name === 'edit_file' && args.command !== 'view')) {
    return await pathIsInside(workspace, args.path) ? { required: false } : request('文件修改目标位于项目目录外。');
  }
  if (reads.has(name) || internal.has(name) || name === 'edit_file' && args.command === 'view') return { required: false };
  return request('无法确定该工具的影响，需要批准后执行。');
}

export function toolGrant(name, args) { return { name, arguments: JSON.stringify(args) }; }
export function grantMatches(grant, name, args) { return grant?.name === name && grant.arguments === JSON.stringify(args); }
