import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@moonya/harness-llm'
import { Session, SessionId } from '@moonya/harness-session'
import AgentRegistry from '@moonya/harness-agent'
import type { Agent } from '@moonya/harness-agent'
import SystemPrompt from '@moonya/harness-system-prompt'
import ToolRuntime from '@moonya/harness-tools'
import TerminalSessionService from '@moonya/harness-terminal'
import SandboxProvider from '@moonya/harness-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@moonya/harness-sandbox'
import SandboxPolicyService from '@moonya/harness-sandbox-policy'
import SessionProjectionRegistry from '@moonya/harness-session-projection'
import LocalSubprocessRuntime from '@moonya/harness-subprocess-local'
import * as TerminalLocal from '@moonya/harness-terminal-bash'
import * as ToolPty from '@moonya/harness-tool-terminal'
import { unsupportedInbox } from '@moonya/harness-agent-loop-testkit'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('pty-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const suite = process.platform === 'linux' || process.platform === 'darwin' ? describe : describe.skip

suite('terminal real Loader composition through cordis.yml', () => {
  it('boots cordis.yml and preserves shell state across real tool calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-pty-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@moonya/harness-agent'",
      "- name: '@moonya/harness-system-prompt'",
      "- name: '@moonya/harness-tools'",
      "- name: '@moonya/harness-terminal'",
      "- name: '@moonya/harness-test-sandbox'",
      "- name: '@moonya/harness-session-projection'",
      "- name: '@moonya/harness-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@moonya/harness-subprocess-local'",
      "- name: '@moonya/harness-terminal-bash'",
      '  config:',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      '    idleSilenceMs: 250',
      '    handoffGraceMs: 250',
      '    timeoutMs: 2000',
      '    disposeGraceMs: 500',
      "- name: '@moonya/harness-tool-terminal'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@moonya/harness-agent', AgentRegistry],
      ['@moonya/harness-system-prompt', SystemPrompt],
      ['@moonya/harness-tools', ToolRuntime],
      ['@moonya/harness-terminal', TerminalSessionService],
      ['@moonya/harness-test-sandbox', PassthroughSandbox],
      ['@moonya/harness-session-projection', SessionProjectionRegistry],
      ['@moonya/harness-sandbox-policy', SandboxPolicyService],
      ['@moonya/harness-subprocess-local', LocalSubprocessRuntime],
      ['@moonya/harness-terminal-bash', TerminalLocal],
      ['@moonya/harness-tool-terminal', ToolPty],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = agent(context)
    const signal = new AbortController().signal
    const spawn = await context.tools.execute({
      signal, callId: ToolCallId('spawn'), name: 'terminal_open', arguments: { type: 'shell', name: 'main', cwd: root }, agent: owner,
    })
    expect(resultText(spawn)).toContain('started terminal session pty-1 (main)')

    await context.tools.execute({
      signal, callId: ToolCallId('state'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'export KEEP=loader; cd /' }, agent: owner,
    })
    const read = await context.tools.execute({
      signal, callId: ToolCallId('read'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'printf "cwd=%s keep=%s\\n" "$PWD" "$KEEP"' }, agent: owner,
    })
    expect(resultText(read)).toContain('cwd=/ keep=loader')
    expect(context.terminals.list(owner)).toHaveLength(1)
  }, 15_000)
})
