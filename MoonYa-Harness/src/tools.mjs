import path, { win32 } from 'node:path';
import { BROWSER_ACTIONS, executeBrowser } from './browser.mjs';
import { executeComputerCell } from './computer.mjs';
import { grantMatches, pathIsInside } from './permissions.mjs';

const fileTool = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }
});

export const CODING_TOOLS = Object.freeze([
  fileTool('read_skill', 'Load the complete instructions for one skill from the catalog supplied by the MoonYa backend.', {
    name: { type: 'string', description: 'Exact skill name from the available skill catalog' },
    path: { type: 'string', description: 'Optional registered Markdown reference path, for example references/xiaohongshu/README.md' }
  }, ['name']),
  fileTool('interaction_request_action', 'Pause for user takeover. Use desktopControl for the MoonYa physical primary desktop, browserControl for the selected automation browser, or fileUpload for selecting local media. Complete resumes with a fresh observation.', {
    type: { type: 'string', enum: ['browserControl', 'fileUpload', 'desktopControl'] },
    browser: { type: 'string', enum: ['builtin', 'chrome', 'edge'], description: 'For browserControl, use the same browser as the preceding browser operations. Defaults to builtin.' },
    display_message: { type: 'string', minLength: 1, description: 'Name the site and exact action, explain why user intervention is required, and say to click 确认完成 afterward.' }
  }, ['type', 'display_message']),
  fileTool('read_file', 'Read a text file with optional line window.', {
    path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }
  }, ['path']),
  fileTool('view_directory', 'Inspect a directory tree.', {
    path: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 8 }
  }, ['path']),
  fileTool('glob', 'Find files by glob pattern.', {
    pattern: { type: 'string' }, path: { type: 'string' }
  }, ['pattern']),
  fileTool('grep', 'Search file contents with ripgrep syntax.', {
    pattern: { type: 'string' }, path: { type: 'string' }, glob_filter: { type: 'string' },
    case_insensitive: { type: 'boolean' }, context: { type: 'integer', minimum: 0 }
  }, ['pattern']),
  fileTool('edit_file', 'View, precisely replace, or insert file content. str_replace must match exactly once.', {
    command: { type: 'string', enum: ['view', 'str_replace', 'insert'] }, path: { type: 'string' },
    old_str: { type: 'string' }, new_str: { type: 'string' }, insert_line: { type: 'integer', minimum: 0 },
    view_range: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }
  }, ['command', 'path']),
  fileTool('create_file', 'Create a new file.', { path: { type: 'string' }, content: { type: 'string' } }, ['path']),
  fileTool('delete_file', 'Delete a file or directory subject to host approval policy.', { path: { type: 'string' } }, ['path']),
  fileTool('execute_command', 'Run a PowerShell command in the workspace, foreground or background.', {
    command: { type: 'string' }, cwd: { type: 'string' }, blocking: { type: 'boolean' }, timeout: { type: 'integer', minimum: 1, maximum: 3600 },
    shell: { type: 'string', enum: ['auto', 'powershell', 'cmd'] }, phase: { type: 'string', enum: ['inspect', 'act', 'verify'] },
    operation_id: { type: 'string' }, intent: { type: 'string' }, completion_mode: { type: 'string', enum: ['finite', 'persistent'] },
    success_criteria: { type: 'object', properties: {
      expected_exit_code: { type: 'integer' }, stderr_empty: { type: 'boolean' },
      stdout_contains: { type: 'array', items: { type: 'string' } }, stdout_regex: { type: 'array', items: { type: 'string' } },
      stderr_contains: { type: 'array', items: { type: 'string' } }, stderr_not_contains: { type: 'array', items: { type: 'string' } }
    }, additionalProperties: false }
  }, ['command']),
  fileTool('get_command_status', 'Read output and state for a background command.', { command_id: { type: 'string' } }, ['command_id']),
  fileTool('stop_command', 'Stop a background command and its process tree.', { command_id: { type: 'string' } }, ['command_id']),
  fileTool('get_diagnostics', 'Read language-server diagnostics for a file.', {
    path: { type: 'string' }, full_project: { type: 'boolean' }
  }, ['path']),
  fileTool('find_references', 'Find symbol references with the language server.', {
    path: { type: 'string' }, line: { type: 'integer', minimum: 0 }, column: { type: 'integer', minimum: 0 }
  }, ['path', 'line', 'column']),
  fileTool('goto_definition', 'Find a symbol definition with the language server.', {
    path: { type: 'string' }, line: { type: 'integer', minimum: 0 }, column: { type: 'integer', minimum: 0 }
  }, ['path', 'line', 'column']),
  fileTool('todo_write', 'Replace or merge the durable task list.', {
    todos: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      priority: { type: 'string', enum: ['high', 'medium', 'low'] }, summary: { type: 'string' }
    }, required: ['id', 'content', 'status', 'priority'], additionalProperties: false } }, merge: { type: 'boolean' }
  }, ['todos']),
  fileTool('plan_write', 'Persist the current implementation plan and its step states.', {
    summary: { type: 'string' }, steps: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] }
    }, required: ['id', 'content', 'status'], additionalProperties: false } }
  }, ['summary', 'steps']),
  fileTool('goal_write', 'Persist the session goal and completion state.', {
    objective: { type: 'string' }, status: { type: 'string', enum: ['active', 'complete', 'blocked'] }, blocker: { type: 'string' }
  }, ['objective', 'status']),
  fileTool('web_search', 'Search the live web for current information. This is an always-available tool, not a skill.', {
    query: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 20 }
  }, ['query']),
  fileTool('web_fetch', 'Fetch and extract readable content from a specified URL.', {
    url: { type: 'string' }
  }, ['url']),
  fileTool('computer_use_tool', 'Execute a fresh Python desktop cell on the MoonYa physical primary desktop. Read computer-use-automation and its MoonYa compatibility reference first. Use seed_computer_use; observe before coordinate actions. The title is shown to the user.', {
    plane: { type: 'string', enum: ['cu'] }, code: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1 }
  }, ['plane', 'code', 'title']),
  // Browser automation runs on the same loopback contract the delegated Browser
  // Agent used, so the desktop safety gate keeps enforcing site/TLS/sensitive
  // confirmation.  Element operations must use the element_id returned by the
  // most recent inspect, which is bound to a page version.
  fileTool('browser_automation_control',
    'Observe and operate the built-in browser through one protocol: navigate, inspect, screenshot, click, fill and page/tab/download actions. Only inspect returns semantic elements and usable element_id values. Write actions return a fast summary, invalidate the prior observation, and require a fresh inspect before another element action. The runtime resolves site and sensitive-action permissions under the active chat mode.', {
      action: { type: 'string', enum: BROWSER_ACTIONS, description: 'Browser action to perform' },
      browser: { type: 'string', enum: ['builtin', 'chrome', 'edge'], description: 'Defaults to builtin. Use chrome or edge only when the user explicitly requests that browser and its plugin is enabled. Pass the same browser for every operation in that session. External browsers use independent automation windows; never fall back automatically.' },
      url: { type: 'string' }, element_id: { type: 'string' }, selector: { type: 'string' },
      text: { type: 'string' }, values: { type: 'array', items: { type: 'string' } }, key: { type: 'string' },
      direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'integer' },
      condition: { type: 'string', enum: ['time', 'element', 'text', 'url', 'navigation', 'dom_stable'] },
      state: { type: 'string', enum: ['visible', 'hidden'] }, ms: { type: 'integer', minimum: 1 },
      tab_id: { type: 'string' },
      risk_category: { type: 'string', enum: ['submit_personal_data', 'purchase', 'change_permissions', 'delete_data'] },
      approval_token: { type: 'string' },
      save_screenshot_to: { type: 'string', description: 'Optional workspace path to save a copy. Screenshots are also automatically supplied as actual images to your vision input, including when saved.' }
    }, ['action'])
]);

const FILE_ACTIONS = new Set(['read_file', 'view_directory', 'glob', 'grep', 'edit_file', 'create_file', 'delete_file', 'validate_command', 'execute_command', 'get_command_status', 'stop_command']);
const LSP_ACTIONS = new Set(['get_diagnostics', 'find_references', 'goto_definition']);
const CU_ACTIONS = new Set(['computer_observe', 'computer_interact']);
const SEARCH_ACTIONS = new Set(['web_search', 'web_fetch']);

export function validateToolArguments(name, args) {
  // Keep legacy desktop observations/interactions replayable without adding them
  // to the current model tool catalog. Their host protocol validates the payload.
  const legacy = CU_ACTIONS.has(name) ? { type: 'object' } : null;
  const schema = CODING_TOOLS.find(tool => tool.function.name === name)?.function.parameters || legacy;
  if (!schema) throw new Error('Unknown tool: ' + name);
  function check(value, rule, field) {
    const type = rule.type;
    if (type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(field + ' must be an object');
      for (const key of rule.required || []) if (!Object.hasOwn(value, key)) throw new Error(field + '.' + key + ' is required');
      for (const [key, item] of Object.entries(value)) {
        const property = rule.properties?.[key];
        if (!property && rule.additionalProperties === false) throw new Error(field + '.' + key + ' is not allowed');
        if (property) check(item, property, field + '.' + key);
      }
    } else if (type === 'array') {
      if (!Array.isArray(value)) throw new Error(field + ' must be an array');
      if (rule.minItems !== undefined && value.length < rule.minItems || rule.maxItems !== undefined && value.length > rule.maxItems) throw new Error(field + ' has invalid length');
      value.forEach((item, index) => check(item, rule.items, field + '[' + index + ']'));
    } else if (type === 'integer' ? !Number.isInteger(value) : typeof value !== type) throw new Error(field + ' must be ' + type);
    if (rule.enum && !rule.enum.includes(value)) throw new Error(field + ' has invalid value');
    if (rule.minLength !== undefined && value.length < rule.minLength) throw new Error(field + ' is empty');
    if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum) throw new Error(field + ' is out of range');
  }
  check(args, schema, name);
}

export function resolvePathArguments(name, args, workspace) {
  const next = { ...args };
  const api = windowsPath(workspace) ? win32 : path;
  const fields = name === 'read_skill' ? [] : name === 'browser_automation_control' ? ['save_screenshot_to'] : ['path'];
  if (['glob', 'grep'].includes(name)) next.path ||= workspace;
  if (name === 'execute_command') { next.cwd ||= workspace; fields.push('cwd'); }
  for (const field of fields) {
    if (typeof next[field] === 'string' && next[field]) next[field] = api.resolve(workspace, next[field]);
  }
  return next;
}

export async function executeTool(name, rawArgs, context) {
  const args = resolvePathArguments(name, rawArgs || {}, context.workspace);
  if (name === 'computer_interact' && !args.run_id) args.run_id = context.session.id;
  if (!grantMatches(context.permissionGrant, name, args)) await enforceWorkspaceBoundary(name, args, context.workspace);
  if (name === 'read_skill') return readSkill(args, context);
  if (name === 'computer_use_tool') return executeComputerCell(args, context);
  if (name === 'todo_write') return updateTodos(context.session, args);
  if (name === 'plan_write') return updatePlan(context.session, args);
  if (name === 'goal_write') return updateGoal(context.session, args);
  if (name === 'browser_automation_control') return executeBrowser(args, context);
  if (SEARCH_ACTIONS.has(name)) return executeSearch(name, args, context);
  const endpoint = FILE_ACTIONS.has(name) ? '/file-op' : LSP_ACTIONS.has(name) ? '/lsp-op' : CU_ACTIONS.has(name) ? '/cu-op' : null;
  if (!endpoint) throw new Error(`Unknown tool: ${name}`);
  const serviceUrl = LSP_ACTIONS.has(name) ? context.lspServiceUrl : context.localServiceUrl;
  const timeoutMs = name === 'execute_command' && args.blocking !== false
    ? (Math.min(Number(args.timeout || 120), 3600) + 5) * 1000
    : 60000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;
  const approvedFile = ['read_file', 'create_file', 'edit_file', 'delete_file', 'view_directory', 'glob', 'grep'].includes(name)
    && grantMatches(context.permissionGrant, name, args);
  const response = await fetch(`${serviceUrl}${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: name, ...args, ...(approvedFile ? { approval_granted: true } : {}) }), signal
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Host tool ${name} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return { success: true, output: text }; }
}

function readSkill(args, context) {
  const suppliedName = String(args.name || '');
  const name = suppliedName === 'computer-use' ? 'computer-use-automation' : suppliedName;
  const skill = Array.isArray(context.skills) ? context.skills.find(item => item?.name === name) : null;
  if (!skill || typeof skill.body !== 'string' || !skill.body.trim()) {
    return { success: false, error_code: 'skill_not_found', error: `Unknown or invalid skill: ${name}` };
  }
  const requestedPath = String(args.path || '').replace(/\\/g, '/');
  if (!requestedPath || requestedPath === 'SKILL.md') {
    if (name === 'computer-use-automation') context.session.desktopSkillLoaded = true;
    return { success: true, name, path: 'SKILL.md', display_name: skill.display_name || name, content: skill.body,
      resource_paths: Object.keys(skill.resources || {}).sort() };
  }
  if (requestedPath.startsWith('/') || /^[a-zA-Z]:\//.test(requestedPath)
    || requestedPath.split('/').some(part => !part || part === '.' || part === '..')
    || !requestedPath.toLowerCase().endsWith('.md')) {
    return { success: false, error_code: 'skill_reference_invalid', error: `Invalid skill reference path: ${requestedPath}` };
  }
  const content = skill.resources && typeof skill.resources[requestedPath] === 'string'
    ? skill.resources[requestedPath] : '';
  if (!content.trim()) {
    return { success: false, error_code: 'skill_reference_not_found', error: `Unknown skill reference: ${name}/${requestedPath}` };
  }
  if (name === 'computer-use-automation' && requestedPath === 'references/moonya-runtime.md') context.session.desktopCompatibilityLoaded = true;
  return { success: true, name, path: requestedPath, display_name: skill.display_name || name, content };
}

async function executeSearch(name, args, context) {
  const response = await fetch(`${context.searchServiceUrl}/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: name, ...args }), signal: context.signal
  });
  const output = await response.text();
  if (!response.ok) throw new Error(`Search service returned HTTP ${response.status}: ${output.slice(0, 500)}`);
  try { return JSON.parse(output); } catch { return { success: true, output }; }
}

async function enforceWorkspaceBoundary(name, args, workspace) {
  // Browser actions carry no filesystem target except an optional screenshot
  // destination; URL text and selectors are not paths and must not be validated
  // as if they were.
  const fields = name === 'read_skill' ? []
    : name === 'execute_command' ? ['cwd']
    : name === 'browser_automation_control' ? ['save_screenshot_to']
    : ['path'];
  for (const field of fields) {
    if (typeof args[field] !== 'string' || !args[field]) continue;
    if (!await pathIsInside(workspace, args[field])) throw new Error(`Path is outside the selected workspace: ${args[field]}`);
  }
}

function windowsPath(value) { return /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(String(value || '')); }

function updateTodos(session, args) {
  const current = Array.isArray(session.todos) ? session.todos : [];
  let todos = args.merge ? [...current] : [];
  for (const todo of args.todos) {
    const index = todos.findIndex(item => item.id === todo.id);
    if (index >= 0) todos[index] = { ...todos[index], ...todo };
    else todos.push(todo);
  }
  let active = false;
  todos = todos.map(todo => {
    if (todo.status !== 'in_progress') return todo;
    if (!active) { active = true; return todo; }
    return { ...todo, status: 'pending' };
  });
  session.todos = todos;
  return { success: true, todos };
}

function updatePlan(session, args) {
  session.plan = { summary: args.summary, steps: args.steps, updated_at: new Date().toISOString() };
  return { success: true, plan: session.plan };
}

function updateGoal(session, args) {
  session.goal = { objective: args.objective, status: args.status, blocker: args.blocker || '', updated_at: new Date().toISOString() };
  return { success: true, goal: session.goal };
}
