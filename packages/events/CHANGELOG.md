# @opengeni/events

## 0.3.6

### Patch Changes

- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.
- Updated dependencies [77d65f9]
- Updated dependencies
- Updated dependencies [dbb6232]
  - @opengeni/db@0.8.0
  - @opengeni/contracts@0.12.0

## 0.3.5

### Patch Changes

- Updated dependencies [28290a0]
  - @opengeni/db@0.7.5

## 0.3.4

### Patch Changes

- Updated dependencies [14ce2e3]
- Updated dependencies [053c5df]
- Updated dependencies [ec0697a]
  - @opengeni/db@0.7.4
  - @opengeni/contracts@0.11.0

## 0.3.3

### Patch Changes

- Updated dependencies [b9dbb63]
  - @opengeni/db@0.7.3

## 0.3.2

### Patch Changes

- @opengeni/db@0.7.2

## 0.3.1

### Patch Changes

- Updated dependencies [ea52b39]
  - @opengeni/db@0.7.1

## 0.3.0

### Minor Changes

- a0cb58f: Streaming exec to Connected Machines over the op-stream protocol (server half).
  When a runner advertises the `op_stream` capability (persisted from its connect
  Hello onto the enrollment) and `OPENGENI_AGENT_OP_STREAM_ENABLED` is on
  (default off), selfhosted exec streams as sequenced, acked, credit-flowed
  frames: no reply-size wall (retention-bounded, typed on overflow), blip-proof
  collection (re-attach + replay, blake3-verified byte-exact), and idempotent
  starts keyed by a durable per-tool-call op id so a re-dispatched turn attaches
  to the already-running command instead of re-running it. The legacy monolithic
  exec remains the permanent fallback wire form. The events bus gains an
  op-stream subscribe/publish accessor on the same managed NATS connection.

### Patch Changes

- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- 8fef500: Instrument the token-streaming pipeline with SLIs so "streaming is sluggish" resolves to a number and its layer is attributable. New worker Prometheus series: `opengeni_stream_ttft_seconds{provider}` (time from a model (re)start to its first streamed content delta, re-armed after every non-content event so a post-tool response measures the model's restart, not our tool time), `opengeni_stream_inter_delta_gap_seconds{provider,class}` (gap between consecutive same-class deltas, reset across boundaries), `opengeni_stream_batch_flush_events` + `opengeni_stream_batch_flush_duration_seconds` (the runtime batcher's coalescing shape), `opengeni_session_event_append_seconds` (durable DB write path) and `opengeni_session_event_publish_seconds` (best-effort NATS delivery path) split so a p99 climb points at Postgres vs. NATS, plus `opengeni_model_input_tokens{provider}` and `opengeni_context_compactions_total{trigger}` (the context-pressure pair that makes "compaction never firing while contexts run hot" queryable). All labels are bounded — never a session id or raw user-supplied model string. `appendAndPublishEvents` gains an optional timing observer (no new dependency on the observability package) and `createRuntimeBatcher` an optional `onFlush` hook; both fire on success and failure.
- Updated dependencies [332ac15]
- Updated dependencies [ad4502a]
- Updated dependencies [477b2bb]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [faf1487]
- Updated dependencies [13d0889]
- Updated dependencies [b125213]
- Updated dependencies [b804fd4]
- Updated dependencies [4a25bfc]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [a0cb58f]
- Updated dependencies [e4d3569]
- Updated dependencies [810542f]
- Updated dependencies [5942493]
- Updated dependencies [a5f58f9]
- Updated dependencies [9d4283d]
  - @opengeni/db@0.7.0
  - @opengeni/contracts@0.10.0

## 0.2.8

### Patch Changes

- @opengeni/db@0.6.1

## 0.2.7

### Patch Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

- Updated dependencies [602db89]
  - @opengeni/contracts@0.9.0
  - @opengeni/db@0.6.0

## 0.2.6

### Patch Changes

- 550b055: Fresh-eyes review fixes: sandbox command output uses its canonical `chunk` wire field end-to-end — the projection and the compact coalescer previously read only legacy `text`/`output`, so compact history windows dropped terminal output entirely (and the resume cursor skipped the raw events that carried it); coalesced sandbox runs now also break on stream and commandId so stdout/stderr never merge. Live-cluster folding is re-based on the true invariants: a cluster with running/streaming items never folds, and folding happens only when the NEXT group is agent progress (activity/turn/narration) — so a pending queued message or an approval pause no longer folds the work the reader needs in view.
- Updated dependencies [7bfe593]
- Updated dependencies [db468cc]
  - @opengeni/contracts@0.8.0
  - @opengeni/db@0.5.0

## 0.2.5

### Patch Changes

- Updated dependencies [5ca067f]
  - @opengeni/contracts@0.7.0
  - @opengeni/db@0.4.1

## 0.2.4

### Patch Changes

- Updated dependencies [e513236]
  - @opengeni/contracts@0.6.0
  - @opengeni/db@0.4.0

## 0.2.3

### Patch Changes

- Updated dependencies [15deca0]
  - @opengeni/contracts@0.5.0
  - @opengeni/db@0.3.0

## 0.2.2

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/db@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [548e307]
  - @opengeni/contracts@0.4.0
  - @opengeni/db@0.2.1

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/db@0.2.0
