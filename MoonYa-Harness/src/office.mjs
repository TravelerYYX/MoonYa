import { clearCreditScope } from './builtin-credit.mjs';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createFoundationHost } from './foundation-subagent.bundle.mjs';

export const OFFICE_AVATARS = Object.freeze(['search', 'code', 'file', 'browser', 'computer', 'app', 'image', 'voice']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'quota_stopped']);

/** Fair per-user execution permits. Waiting parents and approvals release their permits. */
export class OfficeScheduler {
  constructor(onState = async () => {}) { this.onState = onState; this.limits = new Map(); this.active = new Map(); this.queue = []; }
  limit(user) { return this.limits.get(user) || 8; }
  setLimit(user, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('concurrency_must_be_a_positive_integer');
    this.limits.set(user, limit); this.pump();
  }
  release(id) { this.active.delete(id); this.pump(); }
  async acquire(session, signal) {
    if (!session.parentSessionId || this.active.has(session.id)) return;
    signal.throwIfAborted();
    await this.onState(session, 'queued');
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const item = { session, signal, resolve, reject };
      item.abort = () => { const index = this.queue.indexOf(item); if (index >= 0) this.queue.splice(index, 1); reject(signal.reason); this.pump(); };
      signal.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item); this.pump();
    });
    signal.throwIfAborted();
    await this.onState(session, 'running');
  }
  pump() {
    for (let i = 0; i < this.queue.length;) {
      const item = this.queue[i], user = item.session.userContext;
      const count = [...this.active.values()].filter(owner => owner === user).length;
      if (count >= this.limit(user)) { i++; continue; }
      this.queue.splice(i, 1); item.signal.removeEventListener('abort', item.abort);
      if (item.signal.aborted) { item.reject(item.signal.reason); continue; }
      this.active.set(item.session.id, user); item.resolve();
    }
  }
}

/** Rebuild office state from durable events without loading or waking any Agent. */
export function projectOffice(root) {
  const employees = new Map();
  for (const event of [...root.events].sort((a, b) => a.seq - b.seq)) {
    if (event.event === 'office/cleared') { employees.clear(); continue; }
    const payload = event.payload || {};
    const id = event.event === 'subagent/catalog' ? payload.childId : payload.child_id || payload.id;
    if (!id || !['subagent/catalog', 'subagent/start', 'subagent/end', 'office/agent-state', 'office/appearance'].includes(event.event)) continue;
    let row = employees.get(id);
    if (!row) { row = { child_id: id, parent_id: event.origin_session_id || root.id, order: employees.size, label: '', status: 'queued', avatar: OFFICE_AVATARS[employees.size % OFFICE_AVATARS.length], seq: 0 }; employees.set(id, row); }
    if (event.seq <= row.seq) continue;
    row.seq = event.seq;
    if (event.event === 'subagent/catalog') {
      if (!row.established) {
        row.order = [...employees.values()].filter(item => item.established).length;
        row.created_seq = event.seq;
        row.created_turn = event.turn || employees.get(event.origin_session_id)?.created_turn || 1;
      }
      row.established = true; row.label = String(payload.label || '').trim(); row.parent_id = event.origin_session_id || root.id;
    }
    if (event.event === 'office/appearance') { row.avatar = payload.avatar; row.task = payload.task; }
    if (event.event === 'subagent/start') { row.run_id = payload.runId; row.status = 'running'; }
    if (event.event === 'office/agent-state' && !TERMINAL.has(row.status)) row.status = payload.state;
    if (event.event === 'subagent/end') {
      if(row.status!=='quota_stopped')row.status = payload.stopReason === 'completed' ? 'completed' : payload.stopReason === 'aborted' ? 'cancelled' : 'failed';
      row.result = (payload.lastAssistantMessage || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    }
    if (payload.cancelled) row.status = 'cancelled';
  }
  return [...employees.values()].filter(row => row.established).map(({ established, ...row }) => ({ ...row, label: row.label || `子代理 ${row.order + 1}` }));
}

/** MoonYa presentation and execution bridge; DeepSeek owns creation, lineage and settlement. */
export class OfficeRuntime {
  constructor(store, dataRoot, runTurn) {
    this.store = store; this.dataRoot = dataRoot; this.runTurn = runTurn;
    this.inputs = new Map(); this.pendingInputs = new Map(); this.pendingRoots = new Map(); this.metadata = new Map();
    this.closed = new Set(); this.tasks = new Map(); this.waiters = new Set(); this.userSettings = {};
    this.scheduler = new OfficeScheduler((session, state) => this.state(session, state));
  }
  async initialize() {
    this.settingsPath = join(this.dataRoot, 'office-settings.json');
    try { this.userSettings = JSON.parse(await readFile(this.settingsPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [user, limit] of Object.entries(this.userSettings)) this.scheduler.setLimit(user, limit);
    this.settingsWrites = Promise.resolve();
    for (const session of this.store.sessions.values()) {
      for (const event of session.events) if (event.event === 'office/branch-closed')
        for (const id of event.payload.ids) this.closed.add(id);
    }
    this.host = await createFoundationHost({ root: join(this.dataRoot, 'foundation-sessions'), drive: (agent, options) => this.drive(agent, options),
      onFact: (session, event) => this.fact(session, event), onLifecycle: (name, info, agent) => this.lifecycle(name, info, agent) });
    // Repair a crash between the upstream catalog commit and its presentation mirror.
    // Read handles never compose Agents or schedule any model/tool work.
    const catalogs = await this.host.catalogs(), headers = new Map(catalogs.map(item => [item.header.id, item.header]));
    const sourceRoot = id => {
      const seen = new Set();
      while (headers.get(id)?.parentSession && !seen.has(id)) { seen.add(id); id = headers.get(id).parentSession; }
      return id;
    };
    for (const { header, events } of catalogs) for (const event of events) {
      const rootId = sourceRoot(header.id), root = this.store.get(rootId);
      if (!root) continue;
      this.metadata.set(event.data.childId, { root: rootId, parent: header.id });
      const cleared = root.events.findLast(item => item.event === 'office/cleared');
      if (cleared && event.data.childCreatedAt <= Date.parse(cleared.timestamp)) continue;
      if (!root.events.some(item => item.event === 'subagent/catalog' && item.payload.childId === event.data.childId))
        await this.append(event.data.childId, 'subagent/catalog', event.data, header.id,
          root.events.findLast(item => item.event === 'turn.started' && Date.parse(item.timestamp) <= event.data.childCreatedAt)?.turn || 1);
    }
    // Restart never repeats child work. Settle each interrupted residency in the presentation log.
    for (const root of this.store.sessions.values()) {
      if (root.parentSessionId) continue;
      for (const row of projectOffice(root)) if (!TERMINAL.has(row.status)) {
        await this.store.append(root, 'subagent/end', { id: row.child_id, runId: row.run_id, stopReason: 'error', reason: 'runtime_restarted' });
      }
    }
  }
  rootOf(id) { return this.metadata.get(id)?.root || this.store.get(id)?.rootSessionId || id; }
  async append(id, name, payload, origin, turn) {
    const root = this.store.get(this.rootOf(id));
    if (!root) throw new Error('office_root_not_found');
    const event = await this.store.append(root, name, payload, { originSessionId: origin || id, agentId: id, turn });
    for (const wake of this.waiters) wake();
    return event;
  }
  fact(session, event) {
    const root = this.rootOf(session.id), child = event.data.childId;
    const current = this.metadata.get(child) || {};
    this.metadata.set(child, { ...current, root, parent: session.id });
    if (this.closed.has(session.id) || this.closed.has(root)) {
      this.closed.add(child);
      void this.append(child, 'office/branch-closed', { ids: [child] }).catch(error => this.report(root, error));
    }
    void this.append(child, 'subagent/catalog', event.data, session.id).catch(error => this.report(root, error));
  }
  lifecycle(name, info, agent) {
    if (agent) this.metadata.set(info.id, { root: this.rootOf(agent.session.header.parentSession), parent: agent.session.header.parentSession });
    const cancelled = this.closed.has(info.id);
    void this.append(info.id, name, { ...info, ...(cancelled ? { stopReason: 'aborted', cancelled: true } : {}) }, this.metadata.get(info.id)?.parent)
      .catch(error => this.report(this.rootOf(info.id), error));
  }
  report(id, error) { const root = this.store.get(id); if (root) void this.store.append(root, 'office/error', { message: error.message }).catch(() => {}); }
  async sessionFor(agent) {
    let session = this.store.get(agent.id);
    if (!session) {
      const parent = this.store.get(agent.session.header.parentSession);
      if (!parent) throw new Error('subagent_parent_missing');
      session = await this.store.create({ id: agent.id, workspace: parent.workspace, workspaceIdentity: parent.workspaceIdentity,
        workspaceId: parent.workspaceId,
        userContext: parent.userContext, parentSessionId: parent.id, rootSessionId: parent.rootSessionId || parent.id, delegationDepth: agent.session.header.delegationDepth });
    }
    if (session.parentSessionId) {
      const parent = this.store.get(session.parentSessionId);
      if (parent && (session.workspace !== parent.workspace || session.workspaceId !== parent.workspaceId)) {
        session.workspace = parent.workspace; session.workspaceId = parent.workspaceId;
        session.workspaceIdentity = parent.workspaceIdentity;
        await this.store.append(session, 'workspace.bound', { workspace: session.workspace, workspace_id: session.workspaceId });
      }
    }
    if (session.parentSessionId && !session.officeForwarder) {
      session.officeForwarder = event => {
      if(event.event==='turn.quota_stopped')void this.append(session.id,'office/agent-state',{child_id:session.id,state:'quota_stopped'}).catch(error=>this.report(session.rootSessionId,error));
      if (['approval.required', 'approval.decided', 'user_action.required', 'user_action.decided','credits.updated','turn.quota_stopped'].includes(event.event))
        void this.append(session.id, 'office/child-event', { child_id: session.id, event: event.event, status: event.status, payload: event.payload }).catch(error => this.report(session.rootSessionId, error));
      };
      session.subscribers.add(session.officeForwarder);
    }
    return session;
  }
  async start(session, input) {
    if (this.pendingRoots.has(session.id)) throw new Error('session_is_running');
    session.status = 'running';
    if(input.model?.builtin) { clearCreditScope(input.model.credit_scope); input.model.credit_scope=session.id+':'+(session.turn+1); clearCreditScope(input.model.credit_scope); }
    this.closed.delete(session.id);
    const task = (async () => {
      this.inputs.set(session.id, { ...input, content: undefined, local_paths: [] });
      this.pendingInputs.set(session.id, input);
      const agent = await this.host.rootAgent(session.id, session.workspace);
      session.foundationAgent = agent;
      this.host.send(agent, typeof input.content === 'string' ? input.content : '[Work attachments]');
      await agent.whenIdle();
      await session.writeQueue;
    })();
    this.pendingRoots.set(session.id, task);
    try { await task; } finally { this.pendingRoots.delete(session.id); }
  }
  async drive(agent, options) {
    const session = await this.sessionFor(agent);
    session.foundationAgent = agent;
    const rootId = session.rootSessionId || session.id;
    if (this.closed.has(session.id) || this.closed.has(rootId)) return '';
    const saved = this.pendingInputs.get(session.id);
    this.pendingInputs.delete(session.id);
    const user = options.messages.filter(message => message.role === 'user' && message.source?.kind !== 'plugin').at(-1);
    const input = saved || { ...this.inputs.get(rootId), content: (user?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n') };
    if (!input.model) throw new Error('subagent_model_context_unavailable');
    const drive = this.runTurn(session, { ...input, external_signal: options.signal });
    this.tasks.set(session.id, drive);
    try { return await drive; }
    catch (error) {
      if (session.controller?.signal.aborted || options.signal?.aborted) {
        session.status = 'cancelled'; await this.store.append(session, 'turn.cancelled', { reason: 'cancelled' }, { status: 'cancelled' });
      } else if (error.code === 'credits_exhausted') { session.status='quota_stopped'; await this.store.append(session,'turn.quota_stopped',{message:error.message},{turn:session.turn,status:'quota_stopped'});
      } else { session.status = 'error'; await this.store.append(session, 'session.error', { message: error.message }, { status: 'error' }); }
      throw error;
    } finally { this.scheduler.release(session.id); this.tasks.delete(session.id); session.controller = null; }
  }
  schemas() {
    return this.host.schemas().filter(schema => ['subagent', 'send_message', 'interrupt_agent'].includes(schema.name)).map(schema => {
      // The tool registry has already converted defineTool's parameter map to
      // standard JSON Schema. Keep that object intact instead of wrapping its
      // type/properties/required keywords as if they were tool parameters.
      const parameters = structuredClone(schema.parameters);
      if (schema.name === 'subagent') {
        parameters.properties.avatar = { type: 'string', enum: OFFICE_AVATARS, description: 'Optional office appearance only; it does not restrict the task or tools.' };
        parameters.properties.run_in_background = { type: 'boolean', enum: [true], description: 'Work subagents always execute in the background; keep working and collect settlement notifications.' };
      }
      return { type: 'function', function: { name: schema.name, description: schema.description, parameters } };
    });
  }
  async execute(session, name, args, callId, signal) {
    if (this.closed.has(session.id) || this.closed.has(session.rootSessionId || session.id)) throw new Error('task_branch_cancelled');
    if (name === 'send_message' && this.closed.has(String(args.agent_id || ''))) throw new Error('task_branch_cancelled');
    if (name === 'subagent' && args.run_in_background === false) throw new Error('subagent_requires_background_mode');
    if (name === 'interrupt_agent') { await this.cancelBranch(session.rootSessionId || session.id, String(args.agent_id || ''), session.foundationAgent); return { success: true, accepted: true }; }
    if (args.avatar !== undefined && !OFFICE_AVATARS.includes(args.avatar)) throw new Error('invalid_office_avatar');
    const { avatar, ...input } = args;
    const result = await this.host.execute(session.foundationAgent, name, input, callId, signal);
    if (result.isError) return { success: false, error: JSON.stringify(result.content || result) };
    if (name === 'subagent') {
      const id = result.value?.subagentId;
      if (id) await this.append(id, 'office/appearance', { child_id: id, avatar: avatar || OFFICE_AVATARS[projectOffice(this.store.get(this.rootOf(id))).find(row => row.child_id === id)?.order % OFFICE_AVATARS.length] || OFFICE_AVATARS[0], task: String(args.prompt || '') });
    }
    return { success: true, ...result.value, content: result.content };
  }
  async state(session, state) { if (session.parentSessionId && !this.closed.has(session.id)) await this.append(session.id, 'office/agent-state', { child_id: session.id, state }); }
  async acquire(session, signal) { await this.scheduler.acquire(session, signal); }
  release(session) { this.scheduler.release(session.id); }
  async waiting(session, operation) {
    this.release(session); await this.state(session, 'waiting');
    try { return await operation(); } finally { if (!session.controller?.signal.aborted) await this.acquire(session, session.controller.signal); }
  }
  claim(session) {
    return this.host.claim(session.foundationAgent, session.turn).map(message => ({ content: message.content, source: message.source }));
  }
  async waitChildren(session, signal) {
    const pending = () => this.hasPendingChildren(session);
    if (!pending()) return false;
    this.release(session); await this.state(session, 'waiting');
    while (pending()) {
      signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const wake = () => { this.waiters.delete(wake); signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.waiters.delete(wake); reject(signal.reason); };
        this.waiters.add(wake); signal.addEventListener('abort', abort, { once: true });
        if (!pending()) wake();
      });
    }
    await this.acquire(session, signal); return true;
  }
  hasPendingChildren(session) {
    const root = this.store.get(session.rootSessionId || session.id);
    return projectOffice(root).some(row => row.parent_id === session.id && !TERMINAL.has(row.status));
  }
  async snapshot(root) { await root.writeQueue; return { session_id: root.id, seq: root.seq, concurrency: this.scheduler.limit(root.userContext), employees: projectOffice(root) }; }
  async detail(root, childId) {
    const row = projectOffice(root).find(row => row.child_id === childId);
    if (!row) throw new Error('subagent_not_found');
    const child = this.store.get(childId);
    const parent = this.store.get(row.parent_id);
    const dispatched = parent?.events.findLast(event => event.event === 'tool.completed' && event.payload?.result?.subagentId === childId);
    const originalPrompt = dispatched && parent.events.find(event => event.event === 'tool.started' && event.tool_call_id === dispatched.tool_call_id && event.turn === dispatched.turn && event.step === dispatched.step)?.payload?.arguments?.prompt;
    const originalTask = child?.events.find(event => event.event === 'user.message')?.payload?.content;
    return { ...row, task: typeof originalPrompt === 'string' ? originalPrompt : row.task || (typeof originalTask === 'string' ? originalTask : ''),
      event_session_ready: !!child,
      children: projectOffice(root).filter(item => item.parent_id === childId).map(item => item.child_id),
      events: child?.events.filter(event => !['reasoning.delta', 'content.delta'].includes(event.event)).slice(-100).map(event => {
        const { history, ...payload } = event.payload || {};
        return { seq: event.seq, event: event.event, status: event.status, payload: JSON.stringify(payload).slice(0, 12000) };
      }) || [] };
  }
  async cancelBranch(rootId, childId, caller) {
    const root = this.store.get(rootId);
    const rows = projectOffice(root), selected = rows.find(row => row.child_id === childId);
    if (!selected) throw new Error('subagent_not_found');
    if (caller && caller.id !== rootId && !this.isDescendant(rows, childId, caller.id)) throw new Error('subagent_not_owned');
    const ids = [childId, ...rows.filter(row => this.isDescendant(rows, row.child_id, childId)).map(row => row.child_id)];
    // Fence every descendant before the first await: no late send or spawn may enter the branch.
    ids.forEach(id => this.closed.add(id));
    await this.append(childId, 'office/branch-closed', { ids });
    const pending = this.capturePending(ids);
    for (const id of ids) { this.host.ctx.agents.get(id)?.cancel({ kind: 'user' }); this.store.get(id)?.controller?.abort(new Error('Task branch cancelled')); }
    await this.settlePending(pending);
    await Promise.all(ids.map(id => this.tasks.get(id)?.catch(() => {})));
    await Promise.all(ids.map(id => this.host.ctx.agents.get(id)?.whenIdle()));
    for (const id of ids) await this.append(id, 'subagent/end', { id, stopReason: 'aborted', cancelled: true });
  }
  isDescendant(rows, id, ancestor) {
    const visited = new Set();
    while (id && !visited.has(id)) { visited.add(id); const row = rows.find(item => item.child_id === id); id = row?.parent_id; if (id === ancestor) return true; }
    return false;
  }
  async cancelRoot(root) {
    this.closed.add(root.id);
    const rows = projectOffice(root);
    rows.forEach(row => this.closed.add(row.child_id));
    const ids = [root.id, ...rows.map(row => row.child_id)];
    await this.append(root.id, 'office/branch-closed', { ids: rows.map(row => row.child_id) });
    const pending = this.capturePending(ids);
    for (const id of ids) { this.host.ctx.agents.get(id)?.cancel({ kind: 'user' }); this.store.get(id)?.controller?.abort(new Error('Cancelled by user')); }
    await this.settlePending(pending);
    await Promise.all(ids.map(id => this.tasks.get(id)?.catch(() => {})));
    for (const row of rows.filter(row => !TERMINAL.has(row.status))) await this.append(row.child_id, 'subagent/end', { id: row.child_id, stopReason: 'aborted', cancelled: true });
  }
  async cancelDescendants(root) {
    const rows = projectOffice(root).filter(row => !TERMINAL.has(row.status));
    const ids = rows.map(row => row.child_id);
    const pending = this.capturePending(ids);
    for (const id of ids) { this.closed.add(id); this.host.ctx.agents.get(id)?.cancel({ kind: 'user' }); this.store.get(id)?.controller?.abort(new Error('Parent turn ended')); }
    await this.settlePending(pending);
    await Promise.all(ids.map(id => this.tasks.get(id)?.catch(() => {})));
  }
  async setLimit(user, value) {
    this.scheduler.setLimit(user, value); this.userSettings[user] = value;
    const saved = JSON.stringify(this.userSettings);
    const write = this.settingsWrites.then(async () => { await mkdir(this.dataRoot, { recursive: true }); await writeFile(`${this.settingsPath}.tmp`, saved); await rename(`${this.settingsPath}.tmp`, this.settingsPath); });
    this.settingsWrites = write.catch(() => {}); await write; return { concurrency: value };
  }
  async clear(root) {
    await this.cancelRoot(root);
    await this.pendingRoots.get(root.id)?.catch(() => {});
    await this.host.closeRoot(root.id);
    this.inputs.delete(root.id); this.pendingInputs.delete(root.id);
    for (const [id, info] of this.metadata) if (info.root === root.id) this.metadata.delete(id);
    await this.store.append(root, 'office/cleared');
  }
  capturePending(ids) {
    return ids.flatMap(id => {
      const session = this.store.get(id);
      if (!session) return [];
      return [...session.pendingApprovals.values()].map(item => ({ session, item, kind: 'approval' }))
        .concat([...session.pendingUserActions.values()].map(item => ({ session, item, kind: 'user_action' })));
    });
  }
  async settlePending(pending) {
    for (const { session, item, kind } of pending) await this.store.append(session, `${kind}.decided`, {
      [kind === 'approval' ? 'approval_id' : 'action_id']: item.id, status: 'cancelled', decision: 'cancel',
    }, { ...item.meta, status: 'cancelled' });
  }
  async dispose() { await this.host.dispose(); }
}
