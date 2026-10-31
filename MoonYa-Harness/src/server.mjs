import { CreditsExhausted, assertBuiltinCredits, guardBuiltinCredits } from './builtin-credit.mjs';
import http from 'node:http';
import { handleDesktopRequest } from './desktop-gateway.mjs';
import { join, basename } from 'node:path';
import { mkdir, copyFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SessionStore } from './session-store.mjs';
import { assembleSystemPrompt } from './prompt.mjs';
import { CODING_TOOLS, executeTool, resolvePathArguments, validateToolArguments } from './tools.mjs';
import { normalizeApprovalMode, toolPermission, toolGrant, permissionInstructions } from './permissions.mjs';
import { reviewPermission, redactReview } from './permission-review.mjs';
import { authorizeBrowser, browserEffectAndRisk, describeChallenge } from './browser.mjs';
import { projectToolVisuals, toolImageMessage } from './vision.mjs';
import { desktopRequest, closeDesktop } from './computer.mjs';
import { projectMessages, compactConversation, messageText, pruneResult, messageTokens, estimateMessageTokens, estimateTextTokens, validateToolExchanges, validateToolCallIds } from './conversation.mjs';
import { RUNTIME_CAPABILITY_VERSION, RUNTIME_CAPABILITIES } from './runtime-contract.mjs';
import { OfficeRuntime } from './office.mjs';
import { APP_DATA_ROOT, dataPath } from './data-paths.mjs';
import { ModelConfigStore, redactError } from './model-config.mjs';
import { PROVIDER_PRESETS, requireModelContext, resolveContextLimit, resolveModelEffort } from './model-catalog.mjs';
import { callModel as requestModel } from './model-client.mjs';
import { ChatHistory } from './chat-history.mjs';
import { ChatRuns } from './chat-runs.mjs';
import { ConversationStats } from './conversation-stats.mjs';
import { Workspaces } from './workspaces.mjs';
import { WorkspaceChanges } from './workspace-changes.mjs';

const HOST = process.env.MOONYA_HARNESS_HOST || '127.0.0.1';
const PORT = Number(process.env.MOONYA_HARNESS_PORT || 58907);
const DATA_ROOT = process.env.MOONYA_HARNESS_DATA || dataPath('agent-runtime');
const modelConfigs = new ModelConfigStore();
const chatHistory = new ChatHistory();
const chatRuns = new ChatRuns();
const statistics = new ConversationStats(join(DATA_ROOT, 'statistics', 'conversations.jsonl'));
await statistics.ready;
const LOCAL_SERVICE_URL = (process.env.MOONYA_LOCAL_SERVICE_URL || 'http://127.0.0.1:58900').replace(/\/$/, '');
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const LSP_SERVICE_URL = (process.env.MOONYA_LSP_SERVICE_URL || 'http://127.0.0.1:58906').replace(/\/$/, '');
const SEARCH_SERVICE_URL = (process.env.MOONYA_SEARCH_SERVICE_URL || 'http://127.0.0.1:58901').replace(/\/$/, '');
const store = new SessionStore(join(DATA_ROOT, 'sessions'));
await store.initialize();
const workspaces = new Workspaces(join(DATA_ROOT, 'workspaces'), dataPath('workspaces', 'default'), () => [...store.sessions.values()]);
await workspaces.initialize();
for (const session of store.sessions.values()) if (session.workspaceId) session.workspace = workspaces.pathFor(session.workspaceId);
const changes = new WorkspaceChanges(join(DATA_ROOT, 'workspace-changes'), workspaces);
await changes.recover();
for (const session of store.sessions.values()) if (!session.parentSessionId && session.turn) {
  const summary = await changes.summary(session, session.turn);
  if (summary?.state === 'recording') {
    try { const recovered = await changes.finish(session, session.turn); await store.append(session, 'workspace/changes', recovered, { turn: session.turn }); }
    catch (error) { await store.append(session, 'workspace/changes.error', { message: error.message }, { turn: session.turn }); }
  }
}
const office = new OfficeRuntime(store, DATA_ROOT, runTurn);
await office.initialize();

const server = http.createServer(async (req, res) => {
  // The runtime is an internal backend service. Browser pages must use the
  // authenticated PHP gateway and cannot call project tools directly.
  if (req.headers.origin) return json(res, 403, { error: 'browser_origin_not_allowed' });
  if (req.method === 'OPTIONS') return end(res, 403, '');
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/v1/desktop/')) return await handleDesktopRequest(req, res);
    if (url.pathname === '/v1/workspace-settings') {
      const input = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await body(req);
      const user = String(input.user_context || '');
      if (!user) return json(res, 400, { error: 'user_context_required' });
      if (req.method === 'GET') return json(res, 200, workspaces.settings(user));
      if (req.method === 'POST') {
        if (input.migrate === true) for (const binding of workspaces.settings(user).workspaces) await refreshBackgroundCommands(binding.path);
        return json(res, 200, await workspaces.update(user, input.root, input.migrate === true));
      }
      return json(res, 405, { error: 'method_not_allowed' });
    }
    const changesMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/turns\/(\d+)\/changes(?:\/(undo|files\/([a-f0-9]{64})))?$/);
    if (changesMatch) {
      const session = store.get(decodeURIComponent(changesMatch[1]));
      if (!session || session.parentSessionId) return json(res, 404, { error: 'session_not_found' });
      const turn = Number(changesMatch[2]);
      if (!changesMatch[3] && req.method === 'GET') return json(res, 200, { success: true, data: await changes.preview(session, turn) });
      if (changesMatch[4] && req.method === 'GET') return json(res, 200, { success: true, data: await changes.diff(session, turn, changesMatch[4]) });
      if (changesMatch[3] === 'undo' && req.method === 'POST') {
        await refreshBackgroundCommands(session.workspace);
        const summary = await changes.undo(session, turn, await body(req));
        if (!summary.error) await store.append(session, 'workspace/changes', summary, { turn });
        return json(res, summary.error ? 409 : 200, { success: !summary.error, data: summary, error: summary.error });
      }
      return json(res, 405, { error: 'method_not_allowed' });
    }
    if (url.pathname === '/v1/conversation-stats') {
      const input = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
      const user = runtimeUserContext(input), chatId = String(input.client_chat_id || input.conversation_id || '');
      if (!user || !chatId || chatId.length > 128) return json(res, 400, { error: 'statistics_scope_required' });
      if (req.method === 'POST') {
        await statistics.bind(user, chatId, input.conversation_id ? ['db:' + input.conversation_id] : []);
        await statistics.open(user, chatId, Boolean(input.has_history));
        if (input.record) await statistics.record(user, chatId, input.record);
      } else if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
      return json(res, 200, await statistics.snapshot(user, chatId, {
        has_history: input.has_history === true || input.has_history === '1', model_id: input.model_id,
        model_ref: typeof input.model_ref === 'string' ? JSON.parse(input.model_ref) : input.model_ref,
        session_id: input.session_id, limit_tokens: input.limit_tokens, mode: input.mode, conversation_id: input.conversation_id,
      }));
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, { status: 'ok', product: 'MoonYa Agent Runtime', protocol_version: 1,
        runtime_capability_version: RUNTIME_CAPABILITY_VERSION, capabilities: RUNTIME_CAPABILITIES,
        sessions: store.sessions.size, data_root: APP_DATA_ROOT, telemetry: false });
    }
    // Stale-instance handoff: when a previous MoonYa instance died without
    // stopping this runtime (orphaned node.exe), the next instance reclaims the
    // port by asking it to exit instead of failing with EADDRINUSE.
    // A custom header is required so no web page can reach this through a simple
    // cross-origin request, and `Origin`-carrying browsers are rejected above.
    if (url.pathname === '/v1/runtime/shutdown' && req.method === 'POST') {
      if (req.headers['x-moonya-runtime'] !== 'shutdown') return json(res, 400, { error: 'missing_x_moonya_runtime_header' });
      json(res, 202, { status: 'shutting_down', pid: process.pid });
      shutdown('api');
      return;
    }
    if (url.pathname === '/v1/tools' && req.method === 'GET') return json(res, 200, { tools: [...CODING_TOOLS, ...office.schemas()] });
    if (url.pathname === '/v1/model-config') {
      if (req.method === 'GET') return json(res, 200, await modelConfigs.list());
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      const input = await body(req);
      if (input.action === 'save') return json(res, 200, await modelConfigs.save(input.provider));
      if (input.action === 'delete') return json(res, 200, await modelConfigs.remove(input.id));
      if (input.action === 'discover') return json(res, 200, await modelConfigs.discover(input.provider));
      if (input.action === 'resolve') {
        const { api_key, ...model } = await modelConfigs.resolve(input.model_ref);
        return json(res, 200, model);
      }
      if (input.action === 'test') {
        const provider = await modelConfigs.draft(input.provider);
        const meta = provider.models.find(model => model.id === input.model_id && model.supports_chat);
        if (!meta) return json(res, 400, { error: '请选择可用的测试模型' });
        requireModelContext(meta);
        const start = Date.now();
        await requestModel({ ...provider, ...meta, protocol: meta.custom_protocol ? meta.protocol : provider.protocol, name: meta.id }, [{ role: 'user', content: 'Reply with OK.' }], 'auto',
          AbortSignal.timeout(30000), async () => {}, { tools: [], maxTokens: meta.supports_thinking || meta.reasoning === 'always' || meta.reasoning_required ? 4096 : 256 });
        return json(res, 200, { success: true, elapsed_ms: Date.now() - start, model_id: meta.id });
      }
      return json(res, 400, { error: '模型配置操作无效' });
    }
    if (url.pathname === '/v1/llm/cancel' && req.method === 'POST') return json(res, 200, await chatRuns.cancel(await body(req)));
    if (url.pathname === '/v1/llm/chat' && req.method === 'POST') {
      const input = await body(req), run = await chatRuns.get(input);
      await chatRuns.start(run, async()=>{
        if (input.resume) throw new Error('本轮生成记录不存在，请重新发送');
        const model = await modelConfigs.resolve(input.model_ref);
        const limit = resolveContextLimit(model, input.context_limit);
        const effort = resolveModelEffort(model, input.reasoning_effort, input.reasoning_default || 'none');
        if (!Array.isArray(input.messages) || !input.messages.length) throw new Error('messages_required');
        run.started = true;
        await chatRuns.publish(run,{moonya_started:true,model_ref:input.model_ref});
        run.promise = (async()=>{
          try {
            const statsChat = input.client_chat_id || input.conversation_id;
            await statistics.bind(input.user_context, statsChat, input.conversation_id ? ['db:' + input.conversation_id] : []);
            await statistics.open(input.user_context, statsChat, input.messages.length > 2);
            const onMetrics = async record => {
              await statistics.record(input.user_context, statsChat, record);
              if (record.status !== 'running') await chatRuns.publish(run, { session_statistics: await statistics.snapshot(input.user_context, statsChat) });
            };
            const scope = `${input.user_context || ''}:${input.conversation_id || ''}`;
            const messages = await chatHistory.replay(scope, model, input.messages);
            const compacted = await compactConversation(messages, limit, 0, {
              signal:run.controller.signal, reserveRatio:0.2,
              summarize:async(messages,{maxTokens,signal})=>(await requestModel(model,messages,'none',signal,async()=>{},{summary:true,maxTokens,tools:[],onMetrics})).content,
            });
            const assistant = await requestModel(model,compacted.messages,effort,run.controller.signal,async delta=>{
              const field=delta.type==='reasoning'?'reasoning_content':'content';
              await chatRuns.publish(run,{choices:[{delta:{[field]:delta.text}}]});
            },{tools:[],onMetrics,maxTokens:Math.min(input.max_tokens || model.max_output_tokens,Math.max(1,limit-estimateMessageTokens(compacted.messages)-512))});
            await chatHistory.remember(scope,model,assistant,input.client_message_id);
            const context = requestContext([...compacted.messages, assistant], [], model, limit);
            await statistics.record(input.user_context, statsChat, { ...context, id: 'context:chat:' + run.id, kind: 'context' });
            await chatRuns.publish(run,{moonya_context:{...context,
              message_count:compacted.messages.length,history_trimmed:compacted.removed>0,estimated:true}});
            await chatRuns.publish(run,{moonya_done:true,moonya_status:'completed'});
          } catch(error) {
            if (!run.controller.signal.aborted) await chatRuns.publish(run,{error:{message:redactError(error,model.api_key)}});
            await chatRuns.publish(run,{moonya_done:true,moonya_status:run.controller.signal.aborted?'cancelled':'failed'});
          }
        })();
        run.promise.catch(()=>{});
      });
      chatRuns.stream(run,res,input.after_seq);
      return;
    }
    if (url.pathname === '/v1/prompt' && req.method === 'POST') return json(res, 200, { prompt: assembleSystemPrompt(await body(req)) });
    if (url.pathname === '/v1/office/settings') {
      const input = req.method === 'POST' ? await body(req) : {};
      const user = String(input.user_context || url.searchParams.get('user_context') || '').trim();
      if (!user) return json(res, 400, { error: 'user_context_required' });
      if (req.method === 'GET') return json(res, 200, { concurrency: office.scheduler.limit(user) });
      if (req.method === 'POST') return json(res, 200, await office.setLimit(user, input.concurrency));
      return json(res, 405, { error: 'method_not_allowed' });
    }
    if (url.pathname === '/v1/sessions' && req.method === 'POST') {
      const input = await body(req);
      // A stable per-chat default binding replaces the legacy home-directory cwd.
      const sessionId = randomUUID();
      workspaces.assertAvailable(String(input.workspace || '').trim());
      const defaultBinding = !String(input.workspace || '').trim()
        ? await workspaces.bind(runtimeUserContext(input) || 'local', String(input.client_chat_id || sessionId)) : null;
      const workspace = defaultBinding?.path || String(input.workspace).trim();
      const workspaceIdentity = String(input.workspace_identity || '').trim() || (String(input.workspace || '').trim() || '__default__');
      let approvalMode;
      try { approvalMode = normalizeApprovalMode(input.approval_mode); } catch { return json(res, 400, { error: 'invalid_approval_mode' }); }
      const session = await store.create({ id: sessionId, workspace, workspaceIdentity, userContext: runtimeUserContext(input), approvalMode,
        workspaceId: defaultBinding?.id || '', clientChatId: String(input.client_chat_id || '') });
      return json(res, 201, store.summary(session));
    }
    const officeMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/office(?:\/(settings|clear|employee-events|employees\/([^/]+)(?:\/(cancel))?))?$/);
    if (officeMatch) {
      const root = store.get(decodeURIComponent(officeMatch[1]));
      if (!root || root.parentSessionId) return json(res, 404, { error: 'session_not_found' });
      const childId = officeMatch[3] && decodeURIComponent(officeMatch[3]);
      if (officeMatch[2] === 'employee-events' && req.method === 'GET') {
        const children = JSON.parse(url.searchParams.get('children') || '{}');
        const catalog = new Set((await office.snapshot(root)).employees.map(row => row.child_id));
        if (!children || Array.isArray(children) || typeof children !== 'object' || !Object.keys(children).length ||
            Object.entries(children).some(([id, after]) => !catalog.has(id) || !Number.isSafeInteger(after) || after < 0))
          return json(res, 403, { error: 'subagent_not_owned' });
        return streamEmployeeSessions(req, res, root, children);
      }
      if (officeMatch[2] === 'settings' && req.method === 'POST') return json(res, 200, await office.setLimit(root.userContext, (await body(req)).concurrency));
      if (officeMatch[2] === 'clear' && req.method === 'POST') { await office.clear(root); return json(res, 200, { success: true }); }
      if (childId && officeMatch[4] === 'cancel' && req.method === 'POST') { await office.cancelBranch(root.id, childId); return json(res, 200, { success: true }); }
      if (childId && req.method === 'GET') return json(res, 200, await office.detail(root, childId));
      if (!officeMatch[2] && req.method === 'GET') return json(res, 200, await office.snapshot(root));
      return json(res, 405, { error: 'method_not_allowed' });
    }
    const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(events|messages|cancel|approvals|user-actions|context-usage|permissions))?$/);
    if (!match) return json(res, 404, { error: 'not_found' });
    const session = store.get(decodeURIComponent(match[1]));
    if (!session) return json(res, 404, { error: 'session_not_found' });
    const action = match[2];
    if (action === 'permissions' && req.method === 'POST') {
      const input = await body(req);
      if (session.parentSessionId) return json(res, 403, { error: 'subagent_requires_parent_control' });
      if (!session.userContext || runtimeUserContext(input) !== session.userContext) return json(res, 403, { error: 'session_owner_mismatch' });
      const chatId = String(input.client_chat_id || '');
      if (!chatId || session.clientChatId && session.clientChatId !== chatId) return json(res, 403, { error: 'session_chat_mismatch' });
      let mode;
      try { mode = normalizeApprovalMode(input.approval_mode); } catch { return json(res, 400, { error: 'invalid_approval_mode' }); }
      const targets = [...store.sessions.values()].filter(item => !item.parentSessionId && item.userContext === session.userContext
        && (item.id === session.id || item.clientChatId === chatId));
      for (const target of targets) await store.setPermissions(target, mode, chatId);
      return json(res, 200, { success: true, approval_mode: mode, session_ids: targets.map(item => item.id) });
    }
    if (!action && req.method === 'GET') return json(res, 200, { ...store.summary(session), events: session.events });
    if (action === 'context-usage' && req.method === 'GET') {
      const latest = session.events.findLast(event => ['context.usage', 'context.compacted'].includes(event.event));
      const { history, ...usage } = latest?.payload || {};
      return json(res, 200, {
        user_context: session.userContext,
        workspace_identity: session.workspaceIdentity,
        usage: latest ? { ...usage, used_tokens: usage.used_tokens ?? usage.after_tokens,
          session_id: session.id, seq: latest.seq, estimated: true } : null,
      });
    }
    if (action === 'events' && req.method === 'GET') return streamEvents(req, res, session, Number(url.searchParams.get('after') || 0));
    if (action === 'cancel' && req.method === 'POST') {
      if (session.parentSessionId) return json(res, 403, { error: 'subagent_requires_branch_cancel' });
      const pendingApprovals = [...session.pendingApprovals.values()];
      session.pendingApprovals.clear();
      for (const approval of pendingApprovals) {
        await store.append(session, 'approval.decided', {
          approval_id: approval.id, status: 'cancelled', decision: 'cancel',
        }, { ...approval.meta, status: 'cancelled' });
      }
      const pendingUserActions = [...session.pendingUserActions.values()];
      session.pendingUserActions.clear();
      for (const pending of pendingUserActions) {
        await store.append(session, 'user_action.decided', {
          action_id: pending.id, status: 'cancelled', decision: 'cancel',
        }, { ...pending.meta, status: 'cancelled' });
      }
      await office.cancelRoot(session);
      session.controller?.abort(new Error('Cancelled by user'));
      await closeDesktop(toolContext(session, {}));
      await session.turnPromise?.catch(() => {});
      await store.append(session, 'turn.cancelled', { reason: 'user' }, { status: 'cancelled' });
      session.status = 'cancelled';
      return json(res, 202, store.summary(session));
    }
    if (action === 'approvals' && req.method === 'POST') {
      const input = await body(req);
      const approval = session.pendingApprovals.get(String(input.approval_id || ''));
      if (!approval) return json(res, 404, { error: 'approval_not_pending' });
      if (Date.now() >= approval.expiresAt) {
        await approval.expire();
        return json(res, 404, { error: 'approval_not_pending' });
      }
      const requestedDecision = String(input.decision || '').trim().toLowerCase();
      const aliases = { allowed: 'allow_once', denied: 'deny' };
      const decision = aliases[requestedDecision] || requestedDecision;
      if (!approval.allowedDecisions.includes(decision)) {
        return json(res, 400, {
          error: 'decision_not_allowed',
          allowed_decisions: approval.allowedDecisions,
        });
      }
      session.pendingApprovals.delete(approval.id);
      const status = decision === 'allow_once' || decision === 'allow_always' ? 'allowed' : 'denied';
      await store.append(session, 'approval.decided', { approval_id: approval.id, status, decision }, { ...approval.meta, status });
      approval.resolve(decision);
      return json(res, 200, { success: true, approval_id: approval.id, status, decision });
    }
    if (action === 'user-actions' && req.method === 'POST') {
      const input = await body(req);
      const pending = session.pendingUserActions.get(String(input.action_id || ''));
      if (!pending) return json(res, 404, { error: 'user_action_not_pending' });
      const decision = String(input.decision || '').trim().toLowerCase();
      if (!pending.allowedDecisions.includes(decision)) {
        return json(res, 400, { error: 'decision_not_allowed', allowed_decisions: pending.allowedDecisions });
      }
      session.pendingUserActions.delete(pending.id);
      const status = decision === 'complete' ? 'completed' : 'skipped';
      pending.resolve(decision);
      return json(res, 200, { success: true, action_id: pending.id, status, decision });
    }
    if (action === 'messages' && req.method === 'POST') {
      const input = await body(req);
      let mode;
      try { mode = normalizeApprovalMode(input.approval_mode ?? session.approvalMode); } catch { return json(res, 400, { error: 'invalid_approval_mode' }); }
      if (input.user_context !== undefined && session.userContext && runtimeUserContext(input) !== session.userContext) return json(res, 403, { error: 'session_owner_mismatch' });
      if (session.clientChatId && input.client_chat_id && session.clientChatId !== String(input.client_chat_id)) return json(res, 403, { error: 'session_chat_mismatch' });
      const clientMessageId = String(input.client_message_id || '');
      const accepted = clientMessageId && session.events.find(event => event.event === 'desktop.message.accepted' && event.payload.client_message_id === clientMessageId);
      if (accepted) return json(res, 202, { accepted:true, session_id:session.id, after_seq:accepted.payload.after_seq, duplicate:true });
      if (input.model_ref || input.model?.model_ref) input.model = await modelConfigs.resolve(input.model_ref || input.model.model_ref);
      if (!hasUserContent(input.content) || !input.model?.base_url || !input.model?.name) {
        return json(res, 400, { error: 'content and model.base_url/api_key/name are required' });
      }
      if (!input.model.context_window && input.model.name === 'deepseek-flash' && !input.model.protocol) {
        input.model.context_window = PROVIDER_PRESETS.deepseek.models[0].context_window;
      }
      if (!input.model.protocol && input.model.name === 'deepseek-flash') input.model.max_output_tokens ||= PROVIDER_PRESETS.deepseek.models[0].max_output_tokens;
      requireModelContext(input.model);
      if (!input.model.protocol) input.model.context_window_options ||= [300000, input.model.context_window].filter(value => value <= input.model.context_window);
      input.context_limit = resolveContextLimit(input.model, input.context_limit);
      input.reasoning_effort = resolveModelEffort(input.model, input.reasoning_effort, input.reasoning_default || 'high');
      if (input.model.supports_tools === false) return json(res, 400, { error: '所选模型不支持工具调用，无法用于 Work 模式' });
      if (input.mode && input.mode !== 'work') return json(res, 400, { error: 'agent_runtime_requires_work_mode' });
      try { validateUserContent(input.content); } catch (error) { return json(res, 400, { error: error.message }); }
      if (input.image_detail !== undefined && !['low', 'high'].includes(input.image_detail)) {
        return json(res, 400, { error: 'image_detail_must_be_low_or_high' });
      }
      if (session.status === 'running' || session.turnPromise || session.messageAdmission) return json(res, 409, { error: 'session_is_running' });
      workspaces.assertAvailable(session.workspace);
      // Backfill the owner on sessions created before the caller supplied one, so
      // browser site trust keeps resolving to the same user scope.
      if (!session.userContext && runtimeUserContext(input)) session.userContext = runtimeUserContext(input);
      const afterSeq = session.seq;
      if (session.parentSessionId) return json(res, 403, { error: 'subagent_requires_parent_control' });
      session.messageAdmission = true;
      try {
        if (session.workspaceIdentity === '__default__') {
          const binding = await workspaces.bind(session.userContext || 'local', session.clientChatId || input.client_chat_id || session.id);
          if (session.workspaceId !== binding.id || session.workspace !== binding.path) {
            session.workspace = binding.path; session.workspaceId = binding.id;
            await store.append(session, 'workspace.bound', { workspace: binding.path, workspace_id: binding.id });
          }
        }
        await store.setPermissions(session, mode, String(input.client_chat_id || session.clientChatId || ''));
        if (clientMessageId) await store.append(session, 'desktop.message.accepted', { client_message_id:clientMessageId, after_seq:afterSeq }, { turn:session.turn+1, status:'accepted' });
      const turnPromise = office.start(session, input);
      session.turnPromise = turnPromise;
      void turnPromise.catch(async error => {
        await closeDesktop(toolContext(session, {}));
        if (session.controller?.signal.aborted || session.status === 'cancelled' || session.status === 'error' || session.status === 'quota_stopped') return;
        session.status = 'error';
        try {
          await store.append(session, 'session.error', { message: error.message }, { status: 'error' });
        } finally { session.controller = null; }
      }).finally(() => {
        if (session.turnPromise === turnPromise) session.turnPromise = null;
      });
      return json(res, 202, { accepted: true, session_id: session.id, after_seq: afterSeq });
      } finally { session.messageAdmission = false; }
    }
    return json(res, 405, { error: 'method_not_allowed' });
  } catch (error) {
    return json(res, 500, { error: error.message || String(error) });
  }
});

async function runTurn(session, input) {
  let result, quotaError;
  try { result = await runTurnCore(session, input); }
  catch (error) {
    if(error.code==='credits_exhausted') { quotaError=error; if(!session.parentSessionId) await office.waitChildren(session,session.controller.signal); }
    else { if (!session.parentSessionId) await office.cancelDescendants(session).catch(() => {}); throw error; }
  } finally {
    if (!session.parentSessionId && session.changeTurnActive) {
      try { const summary = await changes.finish(session, session.changeTurnActive); if (summary?.total) await store.append(session, 'workspace/changes', summary, { turn: session.changeTurnActive }); }
      catch (error) { await store.append(session, 'workspace/changes.error', { message: error.message }, { turn: session.changeTurnActive }); }
      session.changeTurnActive = null;
    }
  }
  if(quotaError) {
    session.status='quota_stopped'; session.controller=null; office.release(session);
    await store.append(session,'turn.quota_stopped',{message:quotaError.message},{turn:session.turn,status:'quota_stopped'});
    return '';
  }
  if (!session.parentSessionId) {
    await store.append(session, 'turn.completed', { content: result || '' }, { turn: session.turn, status: 'completed' });
    session.status = 'completed'; session.controller = null;
  }
  return result;
}

async function runTurnCore(session, input) {
  session.permissionModel = input.model;
  session.statisticsChatId = session.parentSessionId ? 'session:' + session.id : input.client_chat_id || 'session:' + session.id;
  await statistics.bind(statisticsUser(session), session.statisticsChatId, ['session:' + session.id, ...(input.conversation_id ? ['db:' + input.conversation_id] : [])]);
  await statistics.open(statisticsUser(session), session.statisticsChatId, session.turn > 0);
  session.status = 'running';
  session.turn += 1;
  const turn = session.turn;
  const controller = session.controller = new AbortController();
  if (input.external_signal) {
    if (input.external_signal.aborted) controller.abort(input.external_signal.reason);
    else input.external_signal.addEventListener('abort', () => controller.abort(input.external_signal.reason), { once: true, signal: controller.signal });
  }
  session.skills = normalizeSkillCatalog(input.skills);
  const selectedSkills = normalizeSelectedSkills(input.selected_skills, session.skills);
  const system = assembleSystemPrompt({ persona: input.persona || '', workspace: session.workspace,
    runtimeContext: input.runtime_context || '', mode: input.mode || 'work', skills: session.skills, selectedSkills });
  const history = projectMessages(session.events);
  const visibleTools = [...CODING_TOOLS, ...office.schemas()];
  let messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: input.content }];
  await store.append(session, 'turn.started', {
    context_limit: input.context_limit, reasoning_effort: input.reasoning_effort,
    content: messageText(input.content),
    image_count: Array.isArray(input.content)
      ? input.content.filter(part => part?.type === 'image_url' || part?.type === 'file').length
      : 0
  }, { turn, status: 'running' });
  if (!session.parentSessionId) {
    await changes.begin(session, turn);
    session.changeTurnActive = turn;
  }
  await archiveUserFiles(session, input.local_paths, { turn, signal: controller.signal });
  await store.append(session, 'user.message', { content: input.content, image_detail: input.image_detail || 'high', client_message_id:input.client_message_id || null }, { turn });
  let repeatedSignature = '', repeatedCount = 0;
  const contextLimitTokens = input.context_limit ?? requireModelContext(input.model);
  session.contextModel = { model_id: input.model.id || input.model.name,
    model_ref: input.model.provider_id ? { provider_id: input.model.provider_id, model_id: input.model.id } : null };
  const reserveRatio = Number.isFinite(input.context_reserve_ratio)
    ? Math.min(0.5, Math.max(0, input.context_reserve_ratio)) : 0.2;
  for (let step = 1; ; step++) {
    controller.signal.throwIfAborted();
    assertBuiltinCredits(input.model);
    const permissionRoot = store.get(session.rootSessionId || session.id) || session;
    messages[0] = { role: 'system', content: system + '\n\n## permissions\n' + permissionInstructions(permissionRoot.approvalMode) };
    await office.acquire(session, controller.signal);
    for (const notification of office.claim(session)) {
      const content = notification.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      await store.append(session, 'user.message', { content, source: notification.source }, { turn, step });
      messages.push({ role: 'user', content });
    }
    await store.append(session, 'step.started', {}, { turn, step, status: 'running' });
    const toolsTokens = Math.max(0, estimateTextTokens(JSON.stringify(visibleTools)));
    let compressionStarted = false;
    let compacted;
    try {
      compacted = await compactConversation(messages, contextLimitTokens, toolsTokens, {
        reserveRatio, signal: controller.signal,
        onStart: async payload => {
          await store.append(session, 'context.compacting', payload, { turn, step, status: 'running' });
          compressionStarted = true;
        },
        summarize: async (summaryMessages, { maxTokens, signal }) => {
          const result = await callModel(input.model, summaryMessages, input.reasoning_effort, signal, async () => {},
            { summary: true, maxTokens, onBilling: billing => store.append(session,'credits.updated',billing,{turn:session.turn}), onMetrics: record => recordModelStatistics(session, record) });
          if (result.tool_calls?.length) return '';
          return result.content;
        },
      });
    } catch (error) {
      if (compressionStarted) await store.append(session, 'context.compaction_failed', {
        message: error.message,
      }, { turn, step, status: controller.signal.aborted ? 'cancelled' : 'failed' });
      throw error;
    }
    controller.signal.throwIfAborted();
    if (compacted.removed > 0) {
      messages = compacted.messages;
      await store.append(session, 'context.compacted', {
        removed_messages: compacted.removed,
        before_tokens: compacted.beforeTokens,
        after_tokens: compacted.afterTokens,
        limit_tokens: contextLimitTokens,
        growth_tokens: compacted.growthTokens,
        ...contextUsage(session, messages, contextLimitTokens, toolsTokens),
        // This is the effective history sent to the model. Replaying the raw
        // event log after this point would resurrect messages we just removed.
        history: messages.slice(1),
      }, { turn, step, status: 'completed' });
    }
    // Report the effective context, not cumulative event-log usage. Tokens are
    // estimates, including the handoff and every retained tool exchange.
    await appendContextStatistics(session, messages, contextLimitTokens, toolsTokens, { turn, step });
    const holdContent = office.hasPendingChildren(session), heldDeltas = [];
    const assistant = await callModel(input.model, messages, input.reasoning_effort, controller.signal, async delta => {
      if (holdContent && delta.type === 'content') { heldDeltas.push(delta.text); return; }
      await store.append(session, delta.type === 'reasoning' ? 'reasoning.delta' : 'content.delta', { delta: delta.text }, { turn, step });
    }, { tools: visibleTools, onActivity: activity => store.append(session, 'model.activity', activity, { turn, step }), onBilling: billing => store.append(session,'credits.updated',billing,{turn:session.turn}), onMetrics: record => recordModelStatistics(session, record), maxTokens:Math.min(input.model.max_output_tokens || 8192, Math.max(1, contextLimitTokens - estimateMessageTokens(messages) - toolsTokens - 512)) });
    if (assistant._billing?.exhausted || (()=>{try{assertBuiltinCredits(input.model);return false;}catch(error){if(error.code==='credits_exhausted')return true;throw error;}})()) {
      for (const delta of heldDeltas) await store.append(session,'content.delta',{delta},{turn,step});
      await store.append(session,'assistant.message',{content:assistant.content||'',reasoning:assistant.reasoning_content||'',tool_calls:[]},{turn,step});
      throw new CreditsExhausted(assistant._billing);
    }
    // Reject malformed decisions before admitting any side effects. Checking
    // only the next request is too late for duplicate ids in a parallel round.
    if (assistant.tool_calls !== undefined) validateToolCallIds(assistant.tool_calls);
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    if (!calls.length && holdContent) {
      await office.waitChildren(session, controller.signal);
      await store.append(session, 'step.completed', { awaiting_children: true }, { turn, step, status: 'completed' });
      office.release(session); continue;
    }
    for (const delta of heldDeltas) await store.append(session, 'content.delta', { delta }, { turn, step });
    messages.push(assistant);
    await store.append(session, 'assistant.message', { content: assistant.content || '', reasoning: assistant.reasoning_content || '', tool_calls: assistant.tool_calls || [], ...(assistant.provider_content ? { provider_content: assistant.provider_content } : {}) }, { turn, step });
    if (!calls.length) {
      if (await office.waitChildren(session, controller.signal)) continue;
      await closeDesktop(toolContext(session, {}));
      await appendContextStatistics(session, messages, contextLimitTokens, toolsTokens, { turn, step });
      await store.append(session, 'step.completed', {}, { turn, step, status: 'completed' });
      if (session.parentSessionId) await store.append(session, 'turn.completed', { content: assistant.content || '' }, { turn, step, status: 'completed' });
      office.release(session);
      if (session.parentSessionId) { session.status = 'completed'; session.controller = null; }
      return assistant.content || '';
    }
    const signature = JSON.stringify(calls.map(call => [call.function?.name, call.function?.arguments]));
    repeatedCount = signature === repeatedSignature ? repeatedCount + 1 : 1; repeatedSignature = signature;
    if (repeatedCount >= 8) {
      // Settle every admitted tool-call id without repeating its side effects.
      await Promise.all(calls.map(call => recordToolFailure(session, call, call.function?.name || '', {
        success: false, error_code: 'repeated_tool_loop', error: 'Repeated tool-call loop stopped after eight identical rounds'
      }, { turn, step })));
      throw new Error('Repeated tool-call loop stopped after eight identical rounds');
    }
    // A rejected admission must not finish the turn while an already admitted
    // parallel operation is still changing files or recording its result.
    const completed = await Promise.allSettled(calls.map(call => runTool(session, call, { turn, step, signal: controller.signal })));
    const rejected = completed.find(result => result.status === 'rejected');
    if (rejected) {
      for(let index=0;index<completed.length;index++)if(completed[index].status==='rejected')await recordToolFailure(session,calls[index],calls[index].function?.name||'',{
        success:false,error_code:completed[index].reason.code||'tool_admission_failed',error:completed[index].reason.message,
      },{turn,step,signal:controller.signal});
      throw rejected.reason;
    }
    const results = completed.map(result => result.value);
    if (controller.signal.aborted) throw controller.signal.reason || new Error('Cancelled by user');
    // All tool-call ids must settle before any user-role visual observation.
    const images = results.flatMap(result => result._images || []);
    messages.push(...results.map(({ _images, ...message }) => message));
    if (images.length) {
      const visualMessage = toolImageMessage(images, input.image_detail || 'high');
      await store.append(session, 'tool.images', { message: visualMessage }, { turn, step, status: 'completed' });
      messages.push(visualMessage);
    }
    if (repeatedCount >= 3) {
      const notice = 'The same tool calls are repeating. Choose a materially different strategy or report the concrete blocker.';
      messages.push({ role: 'system', content: notice });
      await store.append(session, 'loop.warning', { content: notice }, { turn, step });
    }
    await store.append(session, 'step.completed', {}, { turn, step, status: 'completed' });
    await appendContextStatistics(session, messages, contextLimitTokens, toolsTokens, { turn, step });
    office.release(session);
  }
}

function contextUsage(session, messages, limitTokens, toolsTokens) {
  const systemTokens = messageTokens(messages[0]);
  const messagesTokens = estimateMessageTokens(messages.slice(1));
  const usedTokens = systemTokens + messagesTokens + toolsTokens;
  return { ...session.contextModel, used_tokens: usedTokens, limit_tokens: limitTokens,
    percent: Math.min(100, Math.round(usedTokens / limitTokens * 100)),
    system_tokens: systemTokens, tools_tokens: toolsTokens, messages_tokens: messagesTokens,
    estimated: true, mode: 'work', session_id: session.id, seq: session.seq + 1 };
}

function statisticsUser(session) { return session.userContext || 'session:' + session.id; }
function requestContext(messages, tools, model, limit) {
  const system = messages.filter(message => ['system', 'developer'].includes(message.role));
  const history = messages.filter(message => !['system', 'developer'].includes(message.role));
  const system_tokens = estimateMessageTokens(system), messages_tokens = estimateMessageTokens(history);
  const tools_tokens = tools.length ? estimateTextTokens(JSON.stringify(tools)) : 0;
  return { model_id: model.id || model.name, model_ref: model.provider_id ? { provider_id: model.provider_id, model_id: model.id || model.name } : null,
    used_tokens: system_tokens + messages_tokens + tools_tokens, system_tokens, tools_tokens, messages_tokens, limit_tokens: limit, estimated: true, mode: 'chat' };
}
async function recordModelStatistics(session, record) {
  await statistics.record(statisticsUser(session), session.statisticsChatId, { ...record, session_id: session.id });
  await store.append(session, 'session_statistics', await statistics.snapshot(statisticsUser(session), session.statisticsChatId));
}
async function appendContextStatistics(session, messages, limit, toolsTokens, meta) {
  const usage = contextUsage(session, messages, limit, toolsTokens);
  await store.append(session, 'context.usage', usage, { ...meta, status: 'completed' });
  await statistics.record(statisticsUser(session), session.statisticsChatId, { ...usage, kind: 'context', id: 'context:work:' + session.id });
}

async function archiveUserFiles(session, paths, meta) {
  for (const selected of Array.isArray(paths) ? paths : []) {
    if (!selected || selected.kind === 'folder' || !selected.path) continue;
    meta.signal.throwIfAborted();
    const info = await stat(selected.path);
    if (!info.isFile()) throw new Error('selected_attachment_is_not_a_file');
    const attachmentId = randomUUID();
    const name = basename(selected.path);
    const relativePath = join('attachments', session.id, attachmentId, name);
    const directory = join(DATA_ROOT, 'attachments', session.id, attachmentId);
    await mkdir(directory, { recursive: true });
    await copyFile(selected.path, join(DATA_ROOT, relativePath));
    const copied = await stat(join(DATA_ROOT, relativePath));
    await store.append(session, 'attachment.saved', {
      attachment_id: attachmentId, name, relative_path: relativePath, size_bytes: copied.size,
      source_path: selected.path, storage: 'local'
    }, { turn: meta.turn, status: 'completed' });
    meta.signal.throwIfAborted();
  }
}

async function runTool(session, call, meta) {
  await guardBuiltinCredits(session.permissionModel,meta.signal);
  const executionStart = performance.now();
  meta = { ...meta, statisticsClock: { waited: 0 } };
  const statisticsId = 'tool:' + session.id + ':' + meta.turn + ':' + call.id;
  await statistics.record(statisticsUser(session), session.statisticsChatId, { kind: 'tool', id: statisticsId,
    status: 'running', session_id: session.id, tool_ms: null });
  const name = call.function?.name || '';
  let args, argumentsError;
  try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; argumentsError = '工具参数不是有效 JSON，操作未执行。'; }
  await store.append(session, 'tool.started', { name, arguments: args }, { ...meta, toolCallId: call.id, status: 'running' });
  try {
    if (argumentsError) throw new Error(argumentsError);
    if (['subagent', 'send_message', 'interrupt_agent'].includes(name)) {
      const result = await office.execute(session, name, args, call.id, meta.signal);
      if (toolFailed(result)) return await recordToolFailure(session, call, name, result, meta);
      await store.append(session, 'tool.completed', { name, result }, { ...meta, toolCallId: call.id, status: 'completed' });
      return { role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(result) };
    }
    const root = store.get(session.rootSessionId || session.id) || session;
    const mode = normalizeApprovalMode(root.approvalMode);
    delete args.approval_granted;
    delete args.approval_token;
    validateToolArguments(name, args);
    let preflight;
    if (name === 'execute_command') {
      preflight = await executeTool('validate_command', {
        command: args.command, shell: args.shell || 'auto', phase: args.phase || 'act'
      }, toolContext(session, meta));
      if (toolFailed(preflight) || preflight.valid === false) return await recordToolFailure(session, call, name, preflight, meta);
      args.phase ||= preflight.effect === 'read' ? 'inspect' : 'act';
    }
    args = resolvePathArguments(name, args, session.workspace);
    const permission = await toolPermission(name, args, session.workspace, preflight);
    const operationMeta = { ...meta, approvalMode: mode };
    if (permission.required && mode !== 'full_access') {
      const decision = await decidePermission(session, call, args, permission, operationMeta);
      if (!isAllowedDecision(decision)) {
        return await recordToolFailure(session, call, name, {
          success: false, status: 'rejected', error_code: 'permission_denied',
          error: operationMeta.reviewDenial || '操作未获批准，未执行。不要绕过拒绝；仅采用更安全方案或询问用户。'
        }, meta);
      }
    }
    meta.signal.throwIfAborted();
    await guardBuiltinCredits(session.permissionModel,meta.signal);
    if (name === 'execute_command') args.approval_granted = true;
    const executionContext = { ...toolContext(session, meta), permissionGrant: toolGrant(name, args) };
    let result = name === 'interaction_request_action'
      ? await waitForUserAction(session, call, args, meta)
      : await executeTool(name, args, executionContext);
    if (name === 'browser_automation_control' && isBrowserApprovalChallenge(result)) {
      result = await resolveBrowserApproval(session, call, args, result, { ...operationMeta, browserPermissionGranted: permission.required });
    }
    // Keep complete local records; only the model projection is bounded.
    if (toolFailed(result)) return await recordToolFailure(session, call, name, result, meta);
    const eventName = name === 'todo_write' ? 'todo.updated' : name === 'plan_write' ? 'plan.updated' : name === 'goal_write' ? 'goal.updated' : 'tool.completed';
    await store.append(session, eventName, { name, result }, { ...meta, toolCallId: call.id, status: 'completed' });
    await recordJobEvent(session, name, result, meta);
    const projected = projectToolVisuals(name, result, call.id);
    const compact = pruneResult(projected.result);
    return { role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(compact), _images: projected.images };
  } catch (error) {
    const result = { success: false, error: error.message || String(error) };
    return await recordToolFailure(session, call, name, result, meta);
  } finally {
    await statistics.record(statisticsUser(session), session.statisticsChatId, { kind: 'tool', id: statisticsId,
      session_id: session.id, tool_ms: Math.max(0, performance.now() - executionStart - meta.statisticsClock.waited) });
    await store.append(session, 'session_statistics', await statistics.snapshot(statisticsUser(session), session.statisticsChatId));
    if (session.pendingApprovals.size || session.pendingUserActions.size) { office.release(session); await office.state(session, 'waiting'); }
  }
}

async function withoutWaitTime(meta, action) {
  const start = performance.now();
  try { return await action(); } finally { if (meta.statisticsClock) meta.statisticsClock.waited += performance.now() - start; }
}

function toolContext(session, meta) {
  return { session, workspace: session.workspace, localServiceUrl: LOCAL_SERVICE_URL,
    lspServiceUrl: LSP_SERVICE_URL, searchServiceUrl: SEARCH_SERVICE_URL, skills: session.skills || [],
    signal: meta.signal, userContext: session.userContext || '',
    onDesktop: payload => store.append(session, 'desktop.started', payload, meta) };
}

function normalizeSkillCatalog(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(item => item && /^[a-z0-9-]{1,63}$/.test(String(item.name || ''))
    && typeof item.body === 'string' && item.body.trim() && typeof item.description === 'string' && item.description.trim())
    .filter(item => !seen.has(item.name) && seen.add(item.name))
    .map(item => ({ name: String(item.name), display_name: String(item.display_name || item.name),
      description: String(item.description), body: String(item.body), resources: normalizeSkillResources(item.resources) }));
}

function normalizeSkillResources(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const resources = {};
  for (const [path, content] of Object.entries(value)) {
    const normalized = String(path || '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)
      || normalized.split('/').some(part => !part || part === '.' || part === '..')
      || !normalized.toLowerCase().endsWith('.md') || typeof content !== 'string' || !content.trim()) continue;
    resources[normalized] = content;
  }
  return resources;
}

function normalizeSelectedSkills(value, catalog) {
  const allowed = new Set(catalog.map(item => item.name));
  return [...new Set((Array.isArray(value) ? value : []).map(value => value === 'computer-use' ? 'computer-use-automation' : String(value)))].filter(name => allowed.has(name));
}

function runtimeUserContext(input) {
  const value = String(input?.user_context || '').trim();
  return /^[A-Za-z0-9_:.-]{1,64}$/.test(value) ? value : '';
}

// A browser write can be refused by the desktop gate mid-flight.  The gate
// returns a single-use token bound to (domain, risk, user, session, page
// version, action); the user decides through the same approval card commands
// use, then the exact same request is replayed once with that token.
async function resolveBrowserApproval(session, call, args, challenge, meta) {
  const approvedChallengeKeys = new Set();
  let current = challenge;
  while (isBrowserApprovalChallenge(current)) {
    const token = String(current.approval_token || '');
    const kind = String(current.approval_kind || 'site');
    const browserSessionId = String(current.browser?.session_id || '');
    const action = String(current.action || args.action || '');
    const pageVersion = Number(current.page_version || 0);
    const challengeKey = JSON.stringify([
      kind, String(current.domain || ''), String(current.certificate_fingerprint || ''),
      String(current.risk_category || ''), browserSessionId, pageVersion, action,
    ]);
    if (!token || !browserSessionId) {
      return browserProtocolFailure(args.action, '浏览器服务返回的确认请求缺少令牌或会话信息。');
    }
    if (approvedChallengeKeys.has(challengeKey)) {
      return browserProtocolFailure(args.action, '浏览器服务在授权后重复返回同一确认请求。');
    }
    const allowedDecisions = kind === 'site'
      ? ['allow_once', 'deny', 'block']
      : ['allow_once', 'deny'];
    let sameTarget = false;
    try { sameTarget = new URL(args.url).origin === new URL(current.url).origin && action === args.action; } catch { /* Unknown targets still need approval. */ }
    const decision = meta.browserPermissionGranted && kind === 'site' && sameTarget ? 'allow_once' : await decidePermission(session, call, args, {
      riskLevel: browserEffectAndRisk(args.action).riskLevel,
      effect: browserEffectAndRisk(args.action).effect,
      commandPreview: String(current.url || current.domain || args.url || ''),
      reason: describeChallenge(current),
      allowedDecisions,
      expiresAt: current.expires_at,
      challenge: sanitizeBrowserChallenge(current),
    }, meta);
    if (decision === 'expired') {
      return { success: false, error_code: 'approval_expired', action: args.action, error: '浏览器授权已超时，操作未执行。' };
    }
    if (decision === 'deny' || decision === 'block') {
      await authorizeBrowser({
        browser: args.browser || 'builtin',
        approval_token: token, decision: 'deny', action,
        session_id: browserSessionId, page_version: pageVersion,
      }, toolContext(session, meta));
      return { success: false, error_code: 'approval_denied', action: args.action, error: meta.reviewDenial || '用户拒绝了浏览器操作授权。' };
    }
    const authorized = await authorizeBrowser({
      browser: args.browser || 'builtin',
      approval_token: token,
      decision,
      action,
      session_id: browserSessionId,
      page_version: pageVersion,
    }, toolContext(session, meta));
    if (authorized?.success === false || authorized?.approval_required) {
      return {
        success: false, error_code: authorized?.error_code || 'approval_denied', action: args.action,
        error: authorized?.error || '浏览器授权未通过。',
      };
    }
    approvedChallengeKeys.add(challengeKey);
    const replayArgs = { ...args };
    if (authorized?.approval_token) replayArgs.approval_token = String(authorized.approval_token);
    else delete replayArgs.approval_token;
    meta.signal.throwIfAborted();
    current = await executeTool('browser_automation_control', replayArgs,
      { ...toolContext(session, meta), permissionGrant: toolGrant('browser_automation_control', replayArgs) });
  }
  return current;
}

function isBrowserApprovalChallenge(result) {
  return result?.error_code === 'approval_required' || result?.approval_required === true;
}

function browserProtocolFailure(action, error) {
  return { success: false, error_code: 'invalid_approval_challenge', action, error };
}

function sanitizeBrowserChallenge(challenge) {
  return {
    approval_kind: String(challenge.approval_kind || ''),
    url: String(challenge.url || ''),
    domain: String(challenge.domain || ''),
    reason: String(challenge.reason || ''),
    certificate_fingerprint: String(challenge.certificate_fingerprint || ''),
    risk_category: String(challenge.risk_category || ''),
    action: String(challenge.action || ''),
    page_version: Number(challenge.page_version || 0),
    expires_at: String(challenge.expires_at || ''),
  };
}

function toolFailed(result) {
  const status = String(result?.status || '').toLowerCase();
  return result?.success === false || result?.ok === false || ['error', 'failed', 'rejected'].includes(status);
}

function isAllowedDecision(decision) {
  return decision === 'allow_once' || decision === 'allow_always' || decision === 'allowed';
}

async function recordToolFailure(session, call, name, result, meta) {
  await store.append(session, 'tool.failed', { name, result }, { ...meta, toolCallId: call.id, status: 'error' });
  const projected = projectToolVisuals(name, result, call.id);
  const compact = pruneResult(projected.result);
  return { role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(compact), _images: projected.images };
}

async function decidePermission(session, call, args, permission, meta) {
  if (meta.approvalMode === 'full_access') return 'allow_once';
  if (meta.approvalMode === 'high_risk') {
    if (session.permissionReviewDeniedTurn === meta.turn) {
      meta.reviewDenial = '本轮已有操作被自动审核拒绝，不能改换工具自动重试。请采用无需额外权限的更安全方案，或向用户说明原因并等待新指示。';
      return 'deny';
    }
    const root = store.get(session.rootSessionId || session.id) || session;
    const model = root.permissionModel || session.permissionModel;
    const userRequest = root.events.filter(event => event.event === 'user.message' && !event.payload.source)
      .slice(-3).map(event => messageText(event.payload.content).slice(0, 4000));
    const evidence = session.events.filter(event => event.event === 'tool.completed').slice(-3)
      .map(event => ({ name: event.payload.name, result: redactReview(event.payload.result, [model?.api_key]).slice(0, 2000) }));
    const reviewed = await withoutWaitTime(meta, () => office.waiting(session, () => reviewPermission({
      model, userRequest, evidence,
      operation: { name: call.function.name, arguments: args, reason: permission.reason, challenge: permission.challenge },
      signal: meta.signal, onBilling: billing => store.append(session,'credits.updated',billing,{turn:session.turn}), onMetrics: record => recordModelStatistics(session, record),
    })));
    await store.append(session, 'permission.reviewed', { name: call.function.name, ...reviewed }, { ...meta, toolCallId: call.id });
    if (reviewed.decision === 'allow') return 'allow_once';
    if (reviewed.decision === 'deny') {
      session.permissionReviewDeniedTurn = meta.turn;
      meta.reviewDenial = '自动审核拒绝：' + reviewed.reason + '。操作未执行；不要改换工具绕过拒绝，仅采用更安全方案或询问用户。';
      return 'deny';
    }
    permission = { ...permission, reason: reviewed.reason + '\n' + (permission.reason || '') };
  }
  return waitForApproval(session, call, args, permission, meta);
}

async function waitForApproval(session, call, args, preflight, meta) {
  const id = randomUUID();
  const approvalMeta = { ...meta, toolCallId: call.id, status: 'pending' };
  const configuredDeadline = Date.parse(String(preflight.expiresAt || ''));
  const fallbackTimeout = Number(process.env.MOONYA_APPROVAL_TIMEOUT_MS || DEFAULT_APPROVAL_TIMEOUT_MS);
  const expiresAt = Number.isFinite(configuredDeadline) ? configuredDeadline
    : Date.now() + (Number.isFinite(fallbackTimeout) && fallbackTimeout > 0 ? fallbackTimeout : DEFAULT_APPROVAL_TIMEOUT_MS);
  const payload = {
    id, status: 'pending', tool_key: call.function?.name || 'execute_command',
    reason: preflight.reason
      || `风险等级：${preflight.riskLevel || preflight.risk_level || 'high'}；影响：${preflight.effect || 'unknown'}`,
    allowed_decisions: Array.isArray(preflight.allowedDecisions) ? preflight.allowedDecisions : ['allow_once', 'deny'],
    expires_at: new Date(expiresAt).toISOString(),
    challenge: preflight.challenge || null,
    arguments: {
      ...args, shell: preflight.shell || args.shell || '', phase: args.phase || 'act',
      command_preview: preflight.commandPreview || preflight.command_preview || args.command || args.path || '',
      risk_reason: preflight.error || preflight.reason || ''
    }
  };
  let finish;
  const expire = async () => {
    // Claim settlement before awaiting the log write. A decision or cancellation
    // that already removed this approval must not also produce an expiry event.
    if (!session.pendingApprovals.has(id)) return;
    session.pendingApprovals.delete(id);
    await store.append(session, 'approval.decided', { approval_id: id, status: 'expired' }, { ...approvalMeta, status: 'expired' });
    finish('expired');
  };
  const decisionPromise = new Promise((resolve, reject) => {
    const timeout = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(expire, timeout);
    const onAbort = () => finish(null, meta.signal.reason || new Error('Cancelled by user'));
    finish = (decision, error) => {
      clearTimeout(timer);
      meta.signal?.removeEventListener('abort', onAbort);
      session.pendingApprovals.delete(id);
      if (error) reject(error); else resolve(decision);
    };
    session.pendingApprovals.set(id, {
      id, meta: approvalMeta, expiresAt, expire, allowedDecisions: payload.allowed_decisions,
      resolve: decision => finish(decision),
    });
    meta.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await store.append(session, 'approval.required', payload, approvalMeta);
  } catch (error) {
    finish(null, error);
  }
  return withoutWaitTime(meta, () => office.waiting(session, () => decisionPromise));
}

async function waitForUserAction(session, call, args, meta) {
  const actionType = String(args.type || '');
  const displayMessage = String(args.display_message || '').trim();
  if (!['browserControl', 'fileUpload', 'desktopControl'].includes(actionType) || !displayMessage) {
    return { success: false, error_code: 'invalid_user_action', error: '用户接管需要有效的 type 和 display_message。' };
  }
  if (session.pendingUserActions.size > 0) {
    return { success: false, error_code: 'user_action_already_pending', error: '当前会话已有一个待处理的用户接管请求。' };
  }
  const id = randomUUID();
  if (actionType === 'desktopControl') await desktopRequest(toolContext(session, meta), 'control', { command: 'takeover' });
  const actionMeta = { ...meta, toolCallId: call.id, status: 'pending' };
  const payload = {
    id, status: 'pending', tool_key: 'interaction_request_action', action_type: actionType,
    browser: actionType === 'browserControl' ? (args.browser || 'builtin') : undefined,
    display_message: displayMessage, allowed_decisions: ['complete', 'skip'], expires_at: null,
  };
  let finish;
  const decisionPromise = new Promise((resolve, reject) => {
    const configured = Number(process.env.MOONYA_USER_ACTION_TIMEOUT_MS
      || process.env.MOONYA_APPROVAL_TIMEOUT_MS || DEFAULT_APPROVAL_TIMEOUT_MS);
    const timeout = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_APPROVAL_TIMEOUT_MS;
    payload.expires_at = new Date(Date.now() + timeout).toISOString();
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      meta.signal?.removeEventListener('abort', onAbort);
      session.pendingUserActions.delete(id);
    };
    const onAbort = () => finish(null, meta.signal.reason || new Error('Cancelled by user'));
    finish = (decision, error) => {
      if (settled) return false;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(decision);
      return true;
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      void store.append(session, 'user_action.decided', {
        action_id: id, status: 'expired', decision: 'expired',
      }, { ...actionMeta, status: 'expired' }).then(() => resolve('expired'), reject);
    }, timeout);
    session.pendingUserActions.set(id, {
      id, meta: actionMeta, allowedDecisions: payload.allowed_decisions,
      resolve: decision => finish(decision),
    });
    meta.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await store.append(session, 'user_action.required', payload, actionMeta);
  } catch (error) {
    finish(null, error);
  }
  const decision = await withoutWaitTime(meta, () => office.waiting(session, () => decisionPromise));
  if (actionType === 'desktopControl' && decision !== 'complete') await closeDesktop(toolContext(session, {}));
  if (decision === 'skip') {
    await store.append(session, 'user_action.decided', {
      action_id: id, status: 'skipped', decision,
    }, { ...actionMeta, status: 'skipped' });
    return { success: false, status: 'skipped', error_code: 'user_action_skipped', error: '用户跳过了当前接管步骤；停止依赖该步骤的操作。' };
  }
  if (decision === 'expired') {
    return { success: false, status: 'expired', error_code: 'user_action_expired', error: '用户接管等待已超时；停止依赖该步骤的操作。' };
  }
  let observation;
  try {
    if (actionType === 'desktopControl') {
      await desktopRequest(toolContext(session, meta), 'control', { command: 'resume' });
      const frame = await desktopRequest(toolContext(session, meta), 'rpc', { method: 'screenshot', args: {} });
      observation = { success: true, screenshots: [frame] };
    } else {
      observation = await executeTool('browser_automation_control', { action: 'inspect', browser: args.browser || 'builtin' }, toolContext(session, meta));
    }
  } catch (error) {
    await store.append(session, 'user_action.decided', {
      action_id: id, status: 'failed', decision: 'complete', error: error.message || String(error),
    }, { ...actionMeta, status: 'failed' });
    throw error;
  }
  await store.append(session, 'user_action.decided', {
    action_id: id, status: 'completed', decision: 'complete', observation_success: !toolFailed(observation),
  }, { ...actionMeta, status: 'completed' });
  if (toolFailed(observation)) {
    return {
      success: false, status: 'completed', error_code: 'post_handoff_observation_failed',
      error: '用户已交回控制，但 Harness 无法重新观察目标画面。', observation,
    };
  }
  return {
    success: true, status: 'completed', action_type: actionType,
    requires_fresh_observation: true, observation,
  };
}

async function recordJobEvent(session, name, result, meta) {
  const jobId = result.command_id || result.commandId;
  if (!jobId) return;
  const status = String(result.status || 'running').toLowerCase();
  session.backgroundCommands ||= new Set();
  if (['completed', 'success', 'exited', 'error', 'failed', 'killed', 'stopped', 'cancelled'].includes(status) || name === 'stop_command') session.backgroundCommands.delete(jobId);
  else session.backgroundCommands.add(jobId);
  let event = 'job.progress';
  if (name === 'execute_command') event = 'job.started';
  else if (name === 'stop_command' || status === 'killed') event = 'job.stopped';
  else if (['completed', 'success', 'exited'].includes(status)) event = 'job.completed';
  else if (['error', 'failed'].includes(status)) event = 'job.failed';
  await store.append(session, event, { job_id: jobId, status, result }, { ...meta, status });
}

async function refreshBackgroundCommands(workspace) {
  for (const session of store.sessions.values()) {
    if (session.workspace !== workspace) continue;
    for (const id of session.backgroundCommands || []) {
      const result = await executeTool('get_command_status', { command_id: id }, toolContext(session, {}));
      if (toolFailed(result)) throw new Error('background_command_status_unavailable');
      await recordJobEvent(session, 'get_command_status', result, { turn: session.turn });
    }
  }
}

async function callModel(model, messages, reasoningEffort, signal, onDelta, options = {}) {
  validateModelMessages(messages);
  return requestModel(model, messages, reasoningEffort, signal, onDelta, { ...options, tools: options.tools || [...CODING_TOOLS, ...office.schemas()] });
}

function hasUserContent(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.length > 0;
}

function validateUserContent(content) {
  if (typeof content === 'string') return;
  if (!Array.isArray(content)) throw new Error('user_content_must_be_string_or_array');
  let images = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object' || !['text', 'image_url', 'file'].includes(part.type)) {
      throw new Error('invalid_user_content_part');
    }
    if (part.type === 'image_url' || part.type === 'file') images++;
  }
  if (images > 600) throw new Error('too_many_images_maximum_is_600');
}

function validateModelMessages(messages) {
  validateToolExchanges(messages);
  let images = 0;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type !== 'image_url' && part?.type !== 'file') continue;
      if (message.role !== 'user') throw new Error('images_are_only_allowed_in_user_messages');
      images++;
    }
  }
  if (images > 600) throw new Error(`too_many_images_in_request:${images};maximum_is_600`);
}

function normalizeReasoningEffort(value) {
  if (value === undefined || value === null) return 'high';
  const effort = String(value || '').trim().toLowerCase();
  if (['minimal', 'low'].includes(effort)) return 'low';
  if (['medium', 'high', 'xhigh'].includes(effort)) return 'high';
  if (['max', 'ultra'].includes(effort)) return 'max';
  throw new Error(`invalid_reasoning_effort:${effort || '(empty)'}`);
}

function streamEmployeeSessions(req, res, root, children) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const attached = new Map(); let closed = false;
  const attach = () => {
    if (closed) return;
    for (const [id, after] of Object.entries(children)) {
      const child = store.get(id); if (!child || attached.has(id)) continue;
      const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
      child.subscribers.add(send); attached.set(id, { child, send });
      child.events.filter(event => event.seq > after).forEach(send);
    }
  };
  const onRoot = event => { if (event.event === 'office/cleared') res.end(); };
  root.subscribers.add(onRoot); attach();
  const waiting = setInterval(attach, 250);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  const cleanup = () => {
    if (closed) return; closed = true; clearInterval(waiting); clearInterval(heartbeat);
    root.subscribers.delete(onRoot); attached.forEach(({ child, send }) => child.subscribers.delete(send));
  };
  req.on('close', cleanup); res.on('close', cleanup);
}

function streamEvents(req, res, session, after) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = event => res.write(`id: ${event.seq}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
  session.events.filter(event => event.seq > after).forEach(send);
  const subscriber = event => send(event); session.subscribers.add(subscriber);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => { clearInterval(heartbeat); session.subscribers.delete(subscriber); });
}

async function body(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(res, status, value) { res.setHeader('content-type', 'application/json; charset=utf-8'); end(res, status, JSON.stringify(value)); }
function end(res, status, value) { res.statusCode = status; res.end(value); }

// ── Process lifecycle ──────────────────────────────────────────────────────
// An unhandled 'error' event used to crash the runtime with a raw Node
// backtrace (EADDRINUSE) that the C# parent could only surface as a stack dump.
// Failures are now reported as one actionable line plus a non-zero exit code.
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  const forced = setTimeout(() => process.exit(0), 3000);
  forced.unref?.();
  server.close();
  for (const run of chatRuns.runs.values()) if (!run.done) run.controller.abort(new Error('Runtime shutting down'));
  void (async () => {
    const roots = [...store.sessions.values()].filter(session => !session.parentSessionId && office.pendingRoots.has(session.id));
    await Promise.all(roots.map(session => office.cancelRoot(session)));
    await Promise.all([...store.sessions.values()].map(session => closeDesktop(toolContext(session, {}))));
    await office.dispose();
    await Promise.allSettled([...chatRuns.runs.values()].map(run => run.promise));
    await Promise.all([...chatRuns.runs.values()].map(run => run.queue));
    await Promise.all([...store.sessions.values()].map(session => session.writeQueue));
    clearTimeout(forced); process.exit(0);
  })().catch(error => { process.stderr.write(`Runtime shutdown: ${error.message}\n`); process.exit(1); });
}

server.on('error', error => {
  if (error?.code === 'EADDRINUSE') {
    process.stderr.write(`MoonYa Agent Runtime: ${HOST}:${PORT} is already in use by another process; refusing to start.\n`);
  } else {
    process.stderr.write(`MoonYa Agent Runtime: server error: ${error?.message || String(error)}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => process.stdout.write(`MoonYa Agent Runtime listening on http://${HOST}:${PORT}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
