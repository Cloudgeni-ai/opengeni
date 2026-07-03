# @opengeni/contracts

## 0.7.0

### Minor Changes

- 5ca067f: ClientConfig gains optional `serverVersion` (the release-train version baked into official server images, surfaced on /healthz and /v1/config/client); the unused `PageInfo`/`paginated()` exports are removed — list endpoints deliberately return bare arrays, and the events route's cursor scheme is the documented exception.

## 0.6.0

### Minor Changes

- e513236: Add an optional per-session `instructions` field to `CreateSessionRequest`: a first-class, system-level agent persona lever composed AFTER the per-workspace `agentInstructions` (session-specific last, non-bypassable CORE preserved). It is org-visible session metadata (returned on the session record) but is never emitted as a timeline event, so hosts can deliver per-agent-type prompts without leaking prompt content into the user-visible timeline or weakening instruction authority. Absent ⇒ byte-identical to today's composition.

## 0.5.0

### Minor Changes

- 15deca0: Add per-session third-party MCP servers with write-only encrypted headers, metadata-only responses/events, `mcp_servers:attach` permission gating, and per-message credential rotation.

## 0.4.0

### Minor Changes

- 548e307: Republish contracts so the registry version carries the current export surface (`MintEnrollTokenRequest` and the machines/enroll types) that `@opengeni/api-router@0.2.x` imports — the previously published 0.3.0 predates them.

## 0.3.0

### Minor Changes

- 48c0d2e: Add session titles. A session now has a short display title that the agent generates itself: on the genesis turn a hidden, non-persisted directive asks the agent to call the new `set_session_title` tool, so the session is named on its own model with no extra LLM call. Users (and agents with `sessions:control`, via `set_other_session_title`) can rename; a user-set title is permanent and is never clobbered by agent writes.

  - `@opengeni/contracts`: `Session.title` / `Session.titleSource`, `UpdateSessionRequest`, and the `session.title_set` event.
  - `@opengeni/sdk`: `client.updateSession(workspaceId, sessionId, { title })`.
  - `@opengeni/react`: `useSession().updateTitle(...)`, live `session.title_set` handling, and `sessionDisplayTitle` now prefers `session.title`.

## 0.2.0

### Minor Changes

- 21c1535: Initial public release of the OpenGeni client packages.

  - `@opengeni/contracts`: shared zod wire-contract schemas and types.
  - `@opengeni/sdk`: zero-dependency, framework-agnostic TypeScript client with typed API, session lifecycle, and SSE streaming (reconnect + replay-by-sequence).
  - `@opengeni/react`: React hooks and styled components built on `@opengeni/sdk`.

  All three now ship ESM + `.d.ts` builds via tsup and are published to npm with provenance.
