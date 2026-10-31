import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeApprovalMode } from './permissions.mjs';

export class SessionStore {
  constructor(root) { this.root = root; this.sessions = new Map(); }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const events = (await readFile(join(this.root, name), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      if (!events.length) continue;
      const created = events.find(event => event.event === 'session.created');
      const session = this.materialize(created?.payload || { id: name.slice(0, -6) }, events);
      this.sessions.set(session.id, session);
      for (const admission of [...events].filter(event => event.event === 'desktop.message.accepted')) {
        if (!events.some(event => event.turn === admission.turn && ['turn.started','turn.interrupted', 'turn.quota_stopped'].includes(event.event))) {
          await this.append(session, 'turn.interrupted', { reason:'process_restart_before_turn', client_message_id:admission.payload.client_message_id }, { turn:admission.turn,status:'interrupted' });
          session.status = 'interrupted';
        }
      }
      // An assistant decision is durable before tool.started is emitted. A
      // crash in that gap, or a legacy cancellation, still needs a result for
      // every call. Record uncertainty; never execute the operation again.
      const key = (event, id = event.tool_call_id) => `${event.turn}:${event.step}:${id}`;
      const settled = new Set(events.filter(event =>
        ['tool.completed', 'tool.failed', 'todo.updated', 'plan.updated', 'goal.updated'].includes(event.event))
        .map(event => key(event)));
      for (const decision of [...events].filter(event => event.event === 'assistant.message')) {
        for (const call of decision.payload?.tool_calls || []) {
          if (!call?.id || settled.has(key(decision, call.id))) continue;
          await this.append(session, 'tool.failed', {
            name: call.function?.name || 'tool', result: { success: false,
              error_code: events.some(event => event.turn === decision.turn
                && ['session.error', 'turn.completed', 'turn.cancelled', 'turn.interrupted', 'turn.quota_stopped'].includes(event.event))
                ? 'history_interrupted' : 'runtime_restarted',
              error: '未找到持久化工具结果，执行状态未知。请重新观察后继续，不要重复原操作。' },
          }, { turn: decision.turn, step: decision.step, toolCallId: call.id, status: 'error' });
          settled.add(key(decision, call.id));
        }
      }
      const lastTurn = [...events].reverse().find(event => event.event.startsWith('turn.'));
      const alreadyTerminal = events.some(event => event.turn === lastTurn?.turn
        && ['session.error', 'turn.completed', 'turn.cancelled', 'turn.interrupted', 'turn.quota_stopped'].includes(event.event));
      if (lastTurn?.event === 'turn.started' && !alreadyTerminal) {
        session.turn = lastTurn.turn || session.turn;
        const activeTurnEvents = events.filter(event => event.turn === session.turn);
        const settledToolCalls = new Set(activeTurnEvents
          .filter(event => event.event === 'tool.completed' || event.event === 'tool.failed')
          .map(event => event.tool_call_id).filter(Boolean));
        for (const started of activeTurnEvents.filter(event => event.event === 'tool.started')) {
          if (!started.tool_call_id || settledToolCalls.has(started.tool_call_id)) continue;
          await this.append(session, 'tool.failed', {
            name: started.payload?.name || 'tool',
            result: { success: false, error_code: 'runtime_restarted', error: '工具调用因 Agent Runtime 重启而中断。' },
          }, { turn: session.turn, step: started.step, toolCallId: started.tool_call_id, status: 'error' });
        }
        const decidedApprovals = new Set(activeTurnEvents
          .filter(event => event.event === 'approval.decided')
          .map(event => event.payload?.approval_id).filter(Boolean));
        for (const pending of activeTurnEvents.filter(event => event.event === 'approval.required')) {
          if (!pending.payload?.id || decidedApprovals.has(pending.payload.id)) continue;
          await this.append(session, 'approval.decided', {
            approval_id: pending.payload.id, status: 'expired', decision: 'runtime_restarted',
          }, { turn: session.turn, step: pending.step, toolCallId: pending.tool_call_id, status: 'interrupted' });
        }
        const decidedUserActions = new Set(activeTurnEvents
          .filter(event => event.event === 'user_action.decided')
          .map(event => event.payload?.action_id).filter(Boolean));
        for (const pending of activeTurnEvents.filter(event => event.event === 'user_action.required')) {
          if (!pending.payload?.id || decidedUserActions.has(pending.payload.id)) continue;
          await this.append(session, 'user_action.decided', {
            action_id: pending.payload.id, status: 'expired', decision: 'runtime_restarted',
          }, { turn: session.turn, step: pending.step, toolCallId: pending.tool_call_id, status: 'interrupted' });
        }
        for (const pending of activeTurnEvents.filter(event => event.event === 'context.compacting')) {
          if (activeTurnEvents.some(event => event.step === pending.step
            && ['context.compacted', 'context.compaction_failed'].includes(event.event))) continue;
          await this.append(session, 'context.compaction_failed', {
            message: '上下文压缩因 Agent Runtime 重启而中断；已有检查点保留。',
          }, { turn: session.turn, step: pending.step, status: 'interrupted' });
        }
        await this.append(session, 'turn.interrupted', { reason: 'process_restart' }, { turn: session.turn, status: 'interrupted' });
        session.status = 'interrupted';
      }
    }
  }

  materialize(seed, events = []) {
    const workspaceEvent = events.findLast(event => event.event === 'workspace.bound');
    const backgroundCommands = new Set();
    for (const event of events.filter(event => event.event.startsWith('job.'))) {
      if (event.event === 'job.started' || event.event === 'job.progress') {
        if (['running', 'pending', 'queued'].includes(String(event.payload.status).toLowerCase())) backgroundCommands.add(event.payload.job_id);
        else backgroundCommands.delete(event.payload.job_id);
      } else backgroundCommands.delete(event.payload.job_id);
    }
    const permissionEvent = events.findLast(event => event.event === 'permissions.updated');
    const todoEvent = [...events].reverse().find(event => event.event === 'todo.updated');
    const planEvent = [...events].reverse().find(event => event.event === 'plan.updated');
    const goalEvent = [...events].reverse().find(event => event.event === 'goal.updated');
    const terminal = [...events].reverse().find(event => ['turn.completed', 'turn.cancelled', 'turn.interrupted', 'session.error', 'turn.quota_stopped'].includes(event.event));
    return { id: seed.id, workspace: workspaceEvent?.payload?.workspace || seed.workspace || '', workspaceId: workspaceEvent?.payload?.workspace_id || seed.workspaceId || '', workspaceIdentity: seed.workspaceIdentity || '', status: terminal?.status || 'idle', seq: events.at(-1)?.seq || 0,
      turn: Math.max(0, ...events.map(event => event.turn || 0)), events, todos: todoEvent?.payload?.result?.todos || [],
      plan: planEvent?.payload?.result?.plan || null, goal: goalEvent?.payload?.result?.goal || null,
      // Browser site trust is scoped per user by the desktop gate, so the owning
      // user context travels with the session and is replayed on every browser call.
      userContext: seed.userContext || '',
      clientChatId: seed.clientChatId || permissionEvent?.payload?.client_chat_id || '',
      approvalMode: normalizeApprovalMode(permissionEvent?.payload?.approval_mode || seed.approvalMode),
      parentSessionId: seed.parentSessionId || '', rootSessionId: seed.rootSessionId || '', delegationDepth: seed.delegationDepth || 0,
      backgroundCommands, subscribers: new Set(), controller: null, turnPromise: null, writeQueue: Promise.resolve(),
      permissionQueue: Promise.resolve(), pendingApprovals: new Map(), pendingUserActions: new Map() };
  }

  async create(seed) {
    const session = this.materialize({ ...seed, id: seed.id || randomUUID() });
    this.sessions.set(session.id, session);
    await this.append(session, 'session.created', {
      id: session.id, workspace: session.workspace,
      workspaceId: session.workspaceId,
      workspaceIdentity: session.workspaceIdentity, userContext: session.userContext,
      clientChatId: session.clientChatId, approvalMode: session.approvalMode,
      parentSessionId: session.parentSessionId, rootSessionId: session.rootSessionId, delegationDepth: session.delegationDepth
    });
    return session;
  }

  get(id) { return this.sessions.get(id); }

  async setPermissions(session, mode, clientChatId = session.clientChatId) {
    mode = normalizeApprovalMode(mode);
    const update = session.permissionQueue.then(async () => {
      if (session.approvalMode === mode && session.clientChatId === clientChatId) return;
      await this.append(session, 'permissions.updated', { approval_mode: mode, client_chat_id: clientChatId });
      session.approvalMode = mode;
      session.clientChatId = clientChatId;
    });
    session.permissionQueue = update.catch(() => {});
    await update;
  }

  async append(session, event, payload = {}, meta = {}) {
    const record = { version: 1, session_id: session.id, seq: ++session.seq, timestamp: new Date().toISOString(),
      turn: meta.turn ?? session.turn, step: meta.step ?? null, tool_call_id: meta.toolCallId ?? null,
      parent_task_id: meta.parentTaskId ?? null, origin_session_id: meta.originSessionId ?? session.id,
      agent_id: meta.agentId ?? session.id, event, status: meta.status ?? null, payload };
    session.events.push(record);
    const write = session.writeQueue.then(() => appendFile(join(this.root, `${session.id}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8'));
    session.writeQueue = write.catch(() => {});
    await write;
    for (const subscriber of session.subscribers) {
      try { subscriber(record); } catch { session.subscribers.delete(subscriber); }
    }
    return record;
  }

  summary(session) {
    return { id: session.id, workspace: session.workspace, workspace_identity: session.workspaceIdentity,
      workspace_id: session.workspaceId || null,
      user_context: session.userContext, client_chat_id: session.clientChatId,
      approval_mode: this.get(session.rootSessionId)?.approvalMode || session.approvalMode,
      parent_session_id: session.parentSessionId, root_session_id: session.rootSessionId,
      status: session.status, seq: session.seq,
      turn: session.turn, todos: session.todos, plan: session.plan, goal: session.goal, event_count: session.events.length };
  }
}

export async function atomicJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), 'utf8');
}
