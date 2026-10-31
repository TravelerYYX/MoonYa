// DeepSeek Harness source composition. The generated bundle ships with MoonYa.
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@moonya/harness-llm';
import Sessions from '@moonya/harness-session';
import Projections from '@moonya/harness-session-projection';
import SystemPrompt from '@moonya/harness-system-prompt';
import Tools from '@moonya/harness-tools';
import Agents from '@moonya/harness-agent';
import AgentLoop from '@moonya/harness-agent-loop';
import Persistence from '@moonya/harness-session-persistence-jsonl';
import Subagents from '@moonya/harness-subagent';
import * as Spawn from '@moonya/harness-subagent-spawn-in-process';
import * as Delegate from '@moonya/harness-tool-subagent';
import * as Control from '@moonya/harness-tool-subagent-control';

/** Mount the original Agent/Session and continuable-subagent owners around MoonYa's model/tool bridge. */
export async function createFoundationHost({ root, drive, onFact, onLifecycle }) {
  const ctx = new Context();
  try {
    for (const plugin of [LlmRuntime, Sessions, Projections, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin);
    await ctx.plugin(Persistence, { root, compression: 'none' });
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(Subagents);
    await ctx.plugin(Spawn, { providerName: 'spawn' });
    await ctx.plugin(Delegate, { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable', maxDepth: 2 });
    await ctx.plugin(Control);
    ctx.on('session/event', (session, event) => { if (event.type === 'subagent/catalog') onFact(session, event); });
    ctx.on('subagent/start', info => onLifecycle('subagent/start', info, ctx.agents.get(info.id)));
    ctx.on('subagent/end', info => onLifecycle('subagent/end', info));
    class MoonYaBridge extends LlmAdapter {
      async resolveModel(provider, model) { return { provider, id: model, name: model }; }
      async *stream(options) {
        const agent = ctx.agents.requireInitiator();
        const output = await drive(agent, options);
        const text = String(output || '');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['moonya'], new MoonYaBridge());
    const roots = new Map();
    return {
      ctx,
      async catalogs() {
        const stored = await ctx.sessionPersistence.list(), facts = [];
        for (const item of stored) {
          const handle = await ctx.sessionPersistence.open(item.header.id, 'read');
          try {
            const { events } = await handle.read();
            facts.push({ header: item.header, events: events.filter(event => event.type === 'subagent/catalog' && event.seq >= handle.inheritedEventCount) });
          } finally { await handle.close(); }
        }
        return facts;
      },
      async rootAgent(id, workspace) {
        if (roots.has(id)) return roots.get(id).agent;
        const stored = await ctx.sessionPersistence.stat(id);
        const handle = stored
          ? await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'moonya', model: 'deepseek-flash' } })
          : await ctx.agents.create({ sessionId: id, meta: { cwd: workspace }, agentOptions: { provider: 'moonya', model: 'deepseek-flash' } });
        roots.set(id, handle);
        return handle.agent;
      },
      send(agent, text) { agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })); },
      claim(agent, turn) { return agent.inbox.claim('next-step', turn); },
      schemas() { return ctx.tools.schemas(); },
      async execute(agent, name, args, callId, signal) {
        const result = await ctx.tools.execute({ agent, name, arguments: args, callId, signal });
        if (name === 'subagent' && !result.isError) {
          await ctx.sessions.flush(agent.session);
          const child = ctx.agents.get(result.value?.subagentId);
          if (child) await ctx.sessions.flush(child.session);
        }
        return result;
      },
      async closeRoot(id) { const handle = roots.get(id); if (handle) { roots.delete(id); await handle.dispose(); } },
      async dispose() { await ctx.fiber.dispose(); },
    };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
