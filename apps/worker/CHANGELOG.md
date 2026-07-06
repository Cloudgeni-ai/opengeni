# @opengeni/worker-bundle

## 0.5.0

### Minor Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

### Patch Changes

- Updated dependencies [602db89]
  - @opengeni/contracts@0.9.0
  - @opengeni/config@0.3.0
  - @opengeni/db@0.6.0
  - @opengeni/runtime@0.4.0
  - @opengeni/core@0.4.3
  - @opengeni/documents@0.2.7
  - @opengeni/events@0.2.7
  - @opengeni/storage@0.2.7

## 0.4.2

### Patch Changes

- Updated dependencies [7bfe593]
- Updated dependencies [550b055]
- Updated dependencies [db468cc]
  - @opengeni/contracts@0.8.0
  - @opengeni/db@0.5.0
  - @opengeni/events@0.2.6
  - @opengeni/config@0.2.6
  - @opengeni/documents@0.2.6
  - @opengeni/runtime@0.3.2
  - @opengeni/storage@0.2.6

## 0.4.1

### Patch Changes

- Updated dependencies [5ca067f]
  - @opengeni/contracts@0.7.0
  - @opengeni/config@0.2.5
  - @opengeni/db@0.4.1
  - @opengeni/documents@0.2.5
  - @opengeni/events@0.2.5
  - @opengeni/runtime@0.3.1
  - @opengeni/storage@0.2.5

## 0.4.0

### Minor Changes

- e513236: Add an optional per-session `instructions` field to `CreateSessionRequest`: a first-class, system-level agent persona lever composed AFTER the per-workspace `agentInstructions` (session-specific last, non-bypassable CORE preserved). It is org-visible session metadata (returned on the session record) but is never emitted as a timeline event, so hosts can deliver per-agent-type prompts without leaking prompt content into the user-visible timeline or weakening instruction authority. Absent ⇒ byte-identical to today's composition.

### Patch Changes

- Updated dependencies [dbe3a19]
- Updated dependencies [3c223ca]
- Updated dependencies [e513236]
  - @opengeni/config@0.2.4
  - @opengeni/runtime@0.3.0
  - @opengeni/contracts@0.6.0
  - @opengeni/db@0.4.0
  - @opengeni/documents@0.2.4
  - @opengeni/storage@0.2.4
  - @opengeni/events@0.2.4

## 0.3.0

### Minor Changes

- 15deca0: Add per-session third-party MCP servers with write-only encrypted headers, metadata-only responses/events, `mcp_servers:attach` permission gating, and per-message credential rotation.

### Patch Changes

- Updated dependencies [15deca0]
  - @opengeni/contracts@0.5.0
  - @opengeni/db@0.3.0
  - @opengeni/config@0.2.3
  - @opengeni/documents@0.2.3
  - @opengeni/events@0.2.3
  - @opengeni/runtime@0.2.3
  - @opengeni/storage@0.2.3

## 0.2.3

### Patch Changes

- 711edc6: `createOpenGeniWorker` accepts an optional `workflowsPath` so embedded hosts can point Temporal's workflow bundler at a relocated copy of `workflows.ts` — the in-package default under `node_modules` is not transpiled by Temporal's webpack. Standalone behavior is unchanged when unset.

## 0.2.2

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/codex@0.2.1
  - @opengeni/config@0.2.2
  - @opengeni/db@0.2.2
  - @opengeni/documents@0.2.2
  - @opengeni/events@0.2.2
  - @opengeni/observability@0.2.1
  - @opengeni/runtime@0.2.2
  - @opengeni/storage@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [548e307]
  - @opengeni/contracts@0.4.0
  - @opengeni/config@0.2.1
  - @opengeni/db@0.2.1
  - @opengeni/documents@0.2.1
  - @opengeni/events@0.2.1
  - @opengeni/runtime@0.2.1
  - @opengeni/storage@0.2.1

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/codex@0.2.0
  - @opengeni/config@0.2.0
  - @opengeni/db@0.2.0
  - @opengeni/documents@0.2.0
  - @opengeni/events@0.2.0
  - @opengeni/observability@0.2.0
  - @opengeni/runtime@0.2.0
  - @opengeni/storage@0.2.0
