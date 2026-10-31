import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSystemPrompt } from '../src/prompt.mjs';
import { CODING_TOOLS, executeTool, resolvePathArguments } from '../src/tools.mjs';

test('controlled coding rules remain after a custom persona', () => {
  const prompt = assembleSystemPrompt({ persona: 'Be concise.', workspace: 'D:\\Project' });
  assert.match(prompt, /Be concise/);
  assert.match(prompt, /never guess file paths/);
  assert.match(prompt, /D:\\Project/);
});

test('tool names are unique and include the complete coding loop', () => {
  const names = CODING_TOOLS.map(tool => tool.function.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of ['read_skill', 'read_file', 'grep', 'edit_file', 'execute_command', 'get_command_status', 'get_diagnostics', 'todo_write', 'plan_write', 'goal_write', 'web_search', 'web_fetch', 'computer_use_tool']) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
});

test('read_skill returns only a cataloged body and rejects unknown names', async () => {
  const context = { session: { id: 'session-1' }, workspace: 'D:\\Work', localServiceUrl: '', lspServiceUrl: '',
    skills: [{ name: 'computer-use-automation', display_name: 'Computer Use', description: 'Desktop', body: 'Observe first.',
      resources: { 'references/guide.md': 'Reference body.' } }] };
  const found = await executeTool('read_skill', { name: 'computer-use' }, context);
  assert.equal(found.success, true);
  assert.equal(found.content, 'Observe first.');
  const reference = await executeTool('read_skill', { name: 'computer-use', path: 'references/guide.md' }, context);
  assert.equal(reference.content, 'Reference body.');
  const escaped = await executeTool('read_skill', { name: 'computer-use', path: '../secret.md' }, context);
  assert.equal(escaped.error_code, 'skill_reference_invalid');
  const missing = await executeTool('read_skill', { name: '../computer-use' }, context);
  assert.equal(missing.success, false);
  assert.equal(missing.error_code, 'skill_not_found');
});

test('user handoff tool supports browser, desktop and file upload', () => {
  const tool = CODING_TOOLS.find(entry => entry.function.name === 'interaction_request_action');
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.type.enum, ['browserControl', 'fileUpload', 'desktopControl']);
  assert.deepEqual(tool.function.parameters.required, ['type', 'display_message']);
});

test('relative paths resolve against the selected workspace', () => {
  assert.equal(resolvePathArguments('read_file', { path: 'src/app.js' }, 'D:\\Work').path, 'D:\\Work\\src\\app.js');
  assert.equal(resolvePathArguments('read_file', { path: 'E:\\Other\\app.js' }, 'D:\\Work').path, 'E:\\Other\\app.js');
});

test('host tools cannot escape the selected workspace', async () => {
  await assert.rejects(() => executeTool('read_file', { path: 'E:\\Other\\secret.txt' }, {
    session: {}, workspace: 'D:\\Work', localServiceUrl: 'http://127.0.0.1:1', lspServiceUrl: 'http://127.0.0.1:1'
  }), /outside the selected workspace/);
});

test('plan and goal tools update durable session state', async () => {
  const session = {};
  const context = { session, workspace: 'D:\\Work', localServiceUrl: '', lspServiceUrl: '' };
  await executeTool('plan_write', { summary: 'Implement', steps: [{ id: '1', content: 'Verify', status: 'in_progress' }] }, context);
  await executeTool('goal_write', { objective: 'Ship verified code', status: 'active' }, context);
  assert.equal(session.plan.steps[0].status, 'in_progress');
  assert.equal(session.goal.objective, 'Ship verified code');
});
