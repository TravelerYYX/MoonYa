# MoonYa Agent Runtime architecture

## Runtime path

1. MoonYa Windows starts the existing file, execution, LSP, Computer Use and browser services.
2. `AgentRuntimeService` starts the bundled `moonya-agent-runtime.exe` and requires `/health` to succeed.
3. All ordinary Work-mode requests are sent to `harness_api.php`, including requests without a selected project and requests containing authenticated image attachments or structured desktop paths. Chat remains a tool-free PHP direct-model route.
4. PHP injects the selected model endpoint and credential into the loopback-only runtime. Credentials never enter browser JavaScript or the session event log.
5. The runtime assembles controlled prompt sections, runs the model/tool loop, delegates tools to MoonYa's existing local services, and appends every durable event to versioned JSONL.
6. PHP translates runtime events into the established MoonYa SSE vocabulary. The main conversation receives concise reasoning/content deltas and the right panel receives the complete tool trajectory.

## Local API

- `GET /health`: runtime readiness and protocol version.
- `GET /v1/tools`: model-facing coding tool catalog.
- `POST /v1/prompt`: rendered controlled system prompt for diagnostics.
- `POST /v1/sessions`: create a durable workspace session.
- `GET /v1/sessions/{id}`: materialized state and event history.
- `POST /v1/sessions/{id}/messages`: start a model/tool turn.
- `GET /v1/sessions/{id}/events?after=N`: replayable SSE event stream.
- `POST /v1/sessions/{id}/cancel`: cancel the model stream and delegated tool work.
- `POST /v1/sessions/{id}/approvals`: resolve a pending high-risk tool call with `allow_once` or `deny`.

Every event carries protocol version, session id, monotonically increasing sequence, timestamp, turn, optional step/tool/parent identifiers, status and payload. The protocol includes turn, reasoning/content delta, tool, approval, job, cancellation and error events. An interrupted open turn is repaired with `turn.interrupted` during startup; committed generations are never overwritten.

## DeepSeek request contract

The main route is fixed to `deepseek-flash`. PHP validates authenticated Web attachment ids and structured desktop paths, then sends ordered text/image/file content blocks to the runtime. JPEG, PNG, GIF and WebP are validated from their bytes; images occur only in user messages and the complete request is capped at 600 images. Inline blocks carry `detail=low|high`; requests near the JSON body limit use the Files API, with low-detail sources resized to a 512-pixel bound before upload. The durable `user.message` keeps block order for later turns and SSE resume, while browser-facing replay replaces encoded image data with safe placeholders.

Work always enables thinking and supplies normalized `low`, `high` or `max` effort. Chat does not enter this runtime and receives no tool definitions.

The runtime accepts server-to-server calls only: it binds to loopback and rejects requests that carry a browser Origin. The PHP gateway authenticates MoonYa users, releases the PHP session lock before opening SSE, keeps model credentials out of JavaScript and forwards approval decisions. Tool paths are checked lexically and through their nearest existing real path against the selected workspace.

## Source foundation

`foundation/` contains the complete MoonYa-namespaced plugin foundation used for continued migration of session, tool, plan, compaction, workflow, skill, terminal and subagent capabilities. Its original external telemetry provider is disabled in the MoonYa base composition. Legal attribution remains in the repository licenses and `THIRD_PARTY_NOTICES.md`, not in product UI or runtime protocol names.

The future subagent/office projection contract is documented in [Harness 子代理与办公室后续开发约定](docs/SUBAGENT_OFFICE_DEVELOPMENT.zh.md); it is intentionally documentation-only in this release.
