# @opengeni/config

## 0.5.0

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

- ad4502a: Make the workbench and console dependency-safe, keep list identities stable, preserve caught error causes, isolate desktop consent tests from real transports, and enforce warning-free repository lint plus aggregate React tests in CI.
- ec508d4: Proactive context compaction now actually fires on the codex-subscription path: codex models declare their real (empirically measured) context window instead of inheriting the 1.05M global default, and the default compaction trigger moves from 60% to 90% of the declared window — compact as late as possible now that the window base is honest, with the reactive compact-on-reject ladder absorbing any overshoot.
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

- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- 726cf2c: Make Connected Machine (selfhosted) control ops resilient: bounded retry of pre-admission DRAINING backpressure (patient ~60s budget for exec, short ~5s for other ops) and of a single transient TIMEOUT (read-only idempotent ops only — a timed-out mutation is never re-issued), a separate exec deadline distinct from the short control timeout (new `OPENGENI_SANDBOX_SELFHOSTED_EXEC_TIMEOUT_MS` / `OPENGENI_SANDBOX_SELFHOSTED_CONTROL_TIMEOUT_MS`, default 2min/30s), and actionable, human-language error copy for over-limit payloads, capacity backpressure, and exec-deadline termination.
- 9d4283d: Per-workspace model/provider hard-block policy. A new `workspace_model_policies` table (NULL = unrestricted) lets a workspace strictly allowlist which providers and/or exact model ids may serve its turns. Enforced twice: a 422 at every API model choke point (user message, queued-turn update, scheduled task, and session creation — where the EFFECTIVE model, `payload.model ?? deployment default`, is vetted, since an omitted model stamps the deployment default onto the session), and authoritatively in the worker immediately after turn model resolution, where a blocked provider/model throws `WorkspaceModelPolicyBlockedError` before any model call — including the legacy null-resolution fallback to the built-in OpenAI/Azure client, which is attributed to the built-in's own provider id so blocking the built-in also closes that path. Goal continuations that inherit a blocked model recover to the session's allowed default or pause the goal visibly with a truthful rationale. New `GET/PUT /v1/workspaces/:workspaceId/model-policy` routes (read / admin) manage the policy. Workspaces without a policy row behave exactly as before. This exists so a codex-subscription workspace can be fail-closed to codex: a turn may wait or fail loud, but can never fall through to a paid provider.
- Updated dependencies [ec508d4]
- Updated dependencies [58c78c6]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [faf1487]
- Updated dependencies [b125213]
- Updated dependencies [b804fd4]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [e4d3569]
- Updated dependencies [5942493]
- Updated dependencies [a5f58f9]
- Updated dependencies [9d4283d]
  - @opengeni/codex@0.2.2
  - @opengeni/contracts@0.10.0

## 0.4.0

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

## 0.3.0

### Minor Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

### Patch Changes

- Updated dependencies [602db89]
  - @opengeni/contracts@0.9.0

## 0.2.6

### Patch Changes

- Updated dependencies [7bfe593]
  - @opengeni/contracts@0.8.0

## 0.2.5

### Patch Changes

- 5ca067f: ClientConfig gains optional `serverVersion` (the release-train version baked into official server images, surfaced on /healthz and /v1/config/client); the unused `PageInfo`/`paginated()` exports are removed — list endpoints deliberately return bare arrays, and the events route's cursor scheme is the documented exception.
- Updated dependencies [5ca067f]
  - @opengeni/contracts@0.7.0

## 0.2.4

### Patch Changes

- dbe3a19: Keep the stock `.env.example` shell-sourceable and aligned with boot-time settings validation.
- Updated dependencies [e513236]
  - @opengeni/contracts@0.6.0

## 0.2.3

### Patch Changes

- Updated dependencies [15deca0]
  - @opengeni/contracts@0.5.0

## 0.2.2

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/codex@0.2.1

## 0.2.1

### Patch Changes

- Updated dependencies [548e307]
  - @opengeni/contracts@0.4.0

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/codex@0.2.0
