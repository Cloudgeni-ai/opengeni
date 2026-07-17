# @opengeni/worker-bundle

## 0.7.3

### Patch Changes

- ea52b39: Recover retryable provider failures as new fenced attempts of the same accepted turn, independent of goal state, while preserving durable tool history and pause controls.
- Updated dependencies [ea52b39]
  - @opengeni/db@0.7.1
  - @opengeni/core@0.4.8
  - @opengeni/documents@0.2.10
  - @opengeni/events@0.3.1

## 0.7.2

### Patch Changes

- 477b2bb: Add a "sharded" codex rotation strategy: session-sharded account affinity. Each session is assigned a deterministic HOME account (`hash(sessionId) % healthy-accounts`) at its first codex turn, written as a `policy` pin (a new `sessions.codex_pin_source` discriminator distinguishes it from a user's `manual` pin). A session stays on its one home account for prompt-cache warmth while load spreads ~1/N across the pool.

  Both rotation guards (proactive turn-start and reactive 429) now allow a `policy`-pinned session to rebalance when its account caps — never a `manual` pin, which stays sacred. A rebalance durably REWRITES the session pin (re-sharding over the healthy survivors so capped-account cohorts spread instead of re-concentrating on one failover) rather than moving only the workspace active pointer, because credential selection returns a pinned account with no exhaustion check.

  Pin lifecycle: a `manual` pin is honored under every strategy; a `policy` pin is meaningful only while the sharded policy is active. When a workspace runs a non-sharded strategy (or rotation is disabled), a leftover policy pin is ignored and lazily cleared on the session's next turn — so the session converges to the active strategy instead of idling on a capped ex-home. The strategy is selectable alongside `most_remaining`/`round_robin`/`drain_then_next` via the existing rotation-settings API; unpinned behavior under the other strategies is unchanged.

- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
- faf1487: Add workspace-local, holder-fenced Codex subscription leases with deterministic
  fairness across worker replicas, explicit allocator eligibility, and
  failure-classified same-turn failover. All-exhausted active goals now persist one
  generation- and policy-fenced capacity waiter, wake from authoritative reset
  timers or revisioned capacity mutations, survive Temporal restart and
  continue-as-new, and enqueue at most one normal continuation without synthetic
  user messages, full-turn replay, provider/model rewriting, or automatic
  entitlement redemption.

  Expose a generic accepted-turn policy-scope and per-scope unavailable-diagnostic
  seam for future named pools while resolving exact live/frozen same-turn reuse
  before membership filtering. Preserve manual versus policy pin semantics and
  session-sharded cache affinity without moving an in-flight lease or the legacy
  workspace pointer for policy homes.

- b125213: Proactively renew GitHub, GitLab, and Azure DevOps credentials during multi-day managed-sandbox turns, atomically replacing stable token files without model action or manifest mutation.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- 39dae14: Make prompt-cache efficiency measurable per model call. The worker now reads `cached_tokens` from the same usage frame that feeds input-token accounting and emits two provider-labelled Prometheus series: `opengeni_model_cached_tokens_total{provider}` (cumulative prompt tokens served from the provider's cache) and `opengeni_model_cache_hit_ratio{provider}` (per-call cached/prompt ratio, bucketed around the alerting threshold). A provider that does not report cached tokens records a real 0 ratio rather than nothing — "the cache did nothing" is the signal — and never a phantom counter increment. Labels stay bounded (provider only; never a session id or account).

  Each per-call `model call usage` log line gains two log-only research dimensions: `servingAccountHash` (an opaque, non-reversible tag for the serving codex credential — the credential row id hashed, never a token) and `accountChangedFromPrevCall` (whether the serving account changed versus the session's previous call — the account-rotation-cold-starts-the-cache hypothesis). These are log-only and never leak into the durable `agent.model.usage` event, which already carries `cachedTokens`. The non-codex credit-debit ledger record additionally carries `cachedTokens` (additive).

  A new starter alert `OpenGeniCodexPromptCacheHitRatioLow` fires when the codex-subscription cache-hit ratio p50 falls below 40% over 30m while codex calls are flowing (traffic-gated with the `or vector(0)` empty-vector guard, promtool-validated).

- 5942493: Repair missing file-upload usage records on idempotent finalize retries, reclaim abandoned direct-upload objects through a fenced Temporal cleanup schedule, and preserve accessible provider-backed image previews across reloads.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

- 8fef500: Instrument the token-streaming pipeline with SLIs so "streaming is sluggish" resolves to a number and its layer is attributable. New worker Prometheus series: `opengeni_stream_ttft_seconds{provider}` (time from a model (re)start to its first streamed content delta, re-armed after every non-content event so a post-tool response measures the model's restart, not our tool time), `opengeni_stream_inter_delta_gap_seconds{provider,class}` (gap between consecutive same-class deltas, reset across boundaries), `opengeni_stream_batch_flush_events` + `opengeni_stream_batch_flush_duration_seconds` (the runtime batcher's coalescing shape), `opengeni_session_event_append_seconds` (durable DB write path) and `opengeni_session_event_publish_seconds` (best-effort NATS delivery path) split so a p99 climb points at Postgres vs. NATS, plus `opengeni_model_input_tokens{provider}` and `opengeni_context_compactions_total{trigger}` (the context-pressure pair that makes "compaction never firing while contexts run hot" queryable). All labels are bounded — never a session id or raw user-supplied model string. `appendAndPublishEvents` gains an optional timing observer (no new dependency on the observability package) and `createRuntimeBatcher` an optional `onFlush` hook; both fire on success and failure.
- 4fbd8a1: Treat transient upstream model-provider failures as retryable so a goal-bearing session recovers automatically instead of going terminal. A provider 5xx (500/502/503/529), a generic "server had a bad minute" body, or a dropped/again-able network connection (ECONNRESET/ETIMEDOUT/EAI_AGAIN/…) now classifies `retryable` and routes into the existing idle + goal-continuation path (auto-continue after the backpressure delay for goal-bearing sessions; wait for the next user message otherwise). Previously only 429/rate-limit and MCP-timeout were retryable, so a generic provider 5xx fell through to a hard `session.failed` that required a manual nudge — during an upstream provider degradation window this needlessly hard-failed a fleet of live sessions. HTTP status is authoritative (every 5xx retryable, 4xx still hard-fails); the ChatGPT/Codex usage-cap 429 stays non-retryable since a retry would just re-hit the cap.
- Updated dependencies [332ac15]
- Updated dependencies [ad4502a]
- Updated dependencies [ec508d4]
- Updated dependencies [58c78c6]
- Updated dependencies [477b2bb]
- Updated dependencies [477b2bb]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [1132866]
- Updated dependencies [faf1487]
- Updated dependencies [13d0889]
- Updated dependencies [832f84c]
- Updated dependencies [b125213]
- Updated dependencies [b804fd4]
- Updated dependencies [37ade2c]
- Updated dependencies [4a25bfc]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [a0cb58f]
- Updated dependencies [e4d3569]
- Updated dependencies [63f9113]
- Updated dependencies [f4a25d9]
- Updated dependencies [810542f]
- Updated dependencies [5942493]
- Updated dependencies [726cf2c]
- Updated dependencies [0f10413]
- Updated dependencies [3148404]
- Updated dependencies [1d57c33]
- Updated dependencies [a5f58f9]
- Updated dependencies [8fef500]
- Updated dependencies [27a114c]
- Updated dependencies [9d4283d]
  - @opengeni/core@0.4.7
  - @opengeni/db@0.7.0
  - @opengeni/config@0.5.0
  - @opengeni/runtime@0.7.0
  - @opengeni/codex@0.2.2
  - @opengeni/contracts@0.10.0
  - @opengeni/documents@0.2.9
  - @opengeni/events@0.3.0
  - @opengeni/storage@0.2.9

## 0.7.1

### Patch Changes

- ac924ca: Fix Modal private-registry sandbox image handling for embedded deployments and republish the observability API surface.

  Modal registry Secrets are resolved through the authenticated OpenGeni Modal client, and Modal private-registry images are now warmed at turn time for pack-scoped sandbox images, not only at worker boot for the deployment-global image ref.

  `@opengeni/observability` is minor-bumped so the already-source-shipped `setGauge`, `incrementCounter`, `observeHistogram`, and `debug` methods are available to external consumers. The published direct dependents are patch-bumped so their 0.x caret ranges resolve to the new observability minor in a coherent install.

- Updated dependencies [ac924ca]
  - @opengeni/observability@0.3.0
  - @opengeni/runtime@0.6.1
  - @opengeni/core@0.4.6

## 0.7.0

### Minor Changes

- 1e7a243: Support PRIVATE-registry Modal sandbox images via `OPENGENI_MODAL_IMAGE_REGISTRY_SECRET`.

  The Agents-extension Modal backend resolves `OPENGENI_MODAL_IMAGE_REF` (and any pack
  `sandboxImage` that overrides it) with `Image.fromRegistry(tag)` and no secret, so it could
  only pull PUBLIC images. New optional setting `modalImageRegistrySecret` (env
  `OPENGENI_MODAL_IMAGE_REGISTRY_SECRET`) names a Modal Secret holding `REGISTRY_USERNAME` +
  `REGISTRY_PASSWORD`; when set, the runtime resolves that Secret and pre-builds
  `fromRegistry(tag, secret)` ONCE per worker process (`ensureModalRegistryImage`, awaited in
  `createOpenGeniWorker` boot) and the Modal provider selects it via
  `ModalImageSelector.fromImage(...)`. When unset the behavior is byte-identical to today's
  public-image path (and the modal SDK is never loaded for it). Resume/attach turns never pull
  the image, so they are unaffected.

### Patch Changes

- Updated dependencies [1e7a243]
  - @opengeni/config@0.4.0
  - @opengeni/runtime@0.6.0
  - @opengeni/core@0.4.5
  - @opengeni/db@0.6.1
  - @opengeni/documents@0.2.8
  - @opengeni/storage@0.2.8
  - @opengeni/events@0.2.8

## 0.6.0

### Minor Changes

- b34b912: Toolspace: selfhosted parity + generic programmatic-calling agent instructions.

  Connected-machine (selfhosted) turns now receive the toolspace token like every other backend. The git-token skip does not transfer: the platform GitHub token is inert on a user machine, but the toolspace token is the machine's only path to programmatic tool calling. It is safe to deliver because it grants no more than the machine owner's own authority — `toolspace:call` only, bound to its own session, turn TTL, budgeted, approval-tools excluded. Delivery mirrors the docker path: the token is seeded to `$OPENGENI_TOOLSPACE_TOKEN_FILE` over the machine's exec channel, off-manifest, targeting the public sandbox-routable API URL; the platform setup hooks (repository clone, az login) still never run against the user's machine.

  When a toolspace token is minted for a turn (feature enabled, any backend), the agent's composed instructions carry a short, generic substrate note: every MCP tool is also callable programmatically from the sandbox via `ogtool` (or MCP JSON-RPC to `$OPENGENI_TOOLSPACE_URL` with the bearer from `$OPENGENI_TOOLSPACE_TOKEN_FILE`), prefer programmatic calls for loops/polling/bulk filtering because those results do not consume model context, and approval-required tools must still be invoked normally. The note composes after the workspace persona + CORE but before the per-session instructions. The `@opengeni/core` and `@opengeni/api-router` bumps are the dependent-closure patch for the runtime minor.

### Patch Changes

- Updated dependencies [b34b912]
  - @opengeni/runtime@0.5.0
  - @opengeni/core@0.4.4

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
