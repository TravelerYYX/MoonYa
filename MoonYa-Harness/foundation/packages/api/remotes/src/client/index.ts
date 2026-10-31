/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@deepseek-ai/cordis'
import agentPresetsRemote from '@moonya/harness-agent-presets/remote'
import commandsRemote from '@moonya/harness-commands/remote'
import settingsControllerRemote from '@moonya/harness-api-settings-controller/remote'
import goalsRemote from '@moonya/harness-goal/remote'
import llmRemote from '@moonya/harness-llm/remote'
import dynamicRemote from '@moonya/harness-cordis-host-runner/remote'
import pluginInventoryRemote from '@moonya/harness-host-plugin-inventory/remote'
import messageFeedbackRemote from '@moonya/harness-message-feedback/remote'
import sessionFeedbackRemote from '@moonya/harness-command-feedback/remote'
import fileUploadsRemote from '@moonya/harness-client-file-upload/remote'
import sessionReferencesRemote from '@moonya/harness-session-reference/remote'
import subagentsRemote from '@moonya/harness-subagent/remote'
import sessionRemote from '@moonya/harness-api-session-controller/remote'
import workspaceRemote from '@moonya/harness-api-workspace-controller/remote'
import workspaceFilesRemote from '@moonya/harness-api-workspace-files/remote'
import type { ClientRemote } from '@moonya/harness-api-gateway/client'

export type { ClientRemote } from '@moonya/harness-api-gateway/client'
export type { PluginInventorySnapshot } from '@moonya/harness-host-plugin-inventory/types'
export type {} from '@moonya/harness-agent-presets/remote'
export type {} from '@moonya/harness-commands/remote'
export type {} from '@moonya/harness-api-settings-controller/remote'
export type {} from '@moonya/harness-goal/remote'
export type {} from '@moonya/harness-llm/remote'
export type {} from '@moonya/harness-host-plugin-inventory/remote'
export type {} from '@moonya/harness-message-feedback/remote'
export type {} from '@moonya/harness-command-feedback/remote'
export type {} from '@moonya/harness-client-file-upload/remote'
export type {} from '@moonya/harness-session-reference/remote'
export type {} from '@moonya/harness-subagent/remote'
export type * from '@moonya/harness-subagent/client'
export type {} from '@moonya/harness-api-session-controller/remote'
export type * from '@moonya/harness-api-session-controller/types'
export type {} from '@moonya/harness-api-workspace-controller/remote'
export type * from '@moonya/harness-api-workspace-controller/types'
export type {} from '@moonya/harness-api-workspace-files/remote'
export type * from '@moonya/harness-api-workspace-files/types'
export type { SessionJob as JobView } from '@moonya/harness-api-session-controller/types'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@moonya/harness-commands/types'
export type {} from '@moonya/harness-cordis-host-runner/types'
export type {} from '@moonya/harness-credentials/types'
export type {} from '@moonya/harness-llm/types'
export type {} from '@moonya/harness-agent-presets/types'
export type {} from '@moonya/harness-settings/types'
export type {} from '@moonya/harness-user-approval/types'
export type {} from '@moonya/harness-user-questions/types'
export type {} from '@moonya/harness-api-session-controller/types'

/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ConnectionHandle, ConnectionSinks, ContentBlock,
  MessageId,
  RpcId, RpcRequest, RpcResponse, RpcResult, SessionId,
  StreamChunk,
} from '@moonya/harness-client-connection/client'
export type {} from '@moonya/harness-api-gateway/client'
export type {} from '@moonya/harness-cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@moonya/harness-cordis-host-runner/types'
// Credential state vocabulary for the credentials namespace (values never ride it).
export type { CredentialInfo } from '@moonya/harness-credentials/types'
// Redacted namespace vocabulary for the settings namespace (secrets never ride
// it). It travels with its seam, whose `./types` the Client face already reads.
export type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
} from '@moonya/harness-settings/types'
// Provider registry and discovery vocabulary for the llm namespace.
export type {
  LlmConfigurableProvider, LlmDiscoveredModel,
  LlmModelDiscoveryRequest, LlmProviderInfo,
} from '@moonya/harness-llm/types'
// Reference-discovery result vocabulary for the fileReferences and
// sessionReferenceResolver namespaces.
export type { FileReferenceCandidate } from '@moonya/harness-file-reference/types'
export type { SessionReferenceMentionCandidate } from '@moonya/harness-session-reference/types'

// The Remote failure vocabulary, re-exported so business packages keep naming
// this assembly alone. Types only: a value export would make spec imports load
// this module's owner /remote artifacts; specs take RemoteError from
// dsh-client-test-runtime instead.
export type {
  RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult,
} from '@moonya/harness-typert-protocol'
export type { RemoteHostFacts } from '@moonya/harness-api-gateway/client'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: ClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      agentPresetsRemote, commandsRemote, settingsControllerRemote, goalsRemote, llmRemote, dynamicRemote,
      pluginInventoryRemote, messageFeedbackRemote, sessionFeedbackRemote, fileUploadsRemote, sessionReferencesRemote,
      subagentsRemote, sessionRemote, workspaceRemote, workspaceFilesRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
