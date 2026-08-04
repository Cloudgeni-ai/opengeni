# @opengeni/config

## 0.10.12

### Patch Changes

- Updated dependencies [4502474]
  - @opengeni/contracts@0.38.2

## 0.10.11

### Patch Changes

- Updated dependencies [c9d8b69]
  - @opengeni/contracts@0.38.1

## 0.10.10

### Patch Changes

- b6e39fc: Polish session chrome and apply_patch rendering; clarify realtime voice-end handoff.

  SessionChrome gets denser selected-chip UX and Codex function-tool apply_patch shapes render in the specialized diff UI. Solo goal_continuation machine-input rows are suppressed in favor of the GoalRow landmark. The realtime transcript-tail instruction now keeps in-flight work going after voice ends.

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/contracts@0.38.0

## 0.10.9

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/contracts@0.37.0

## 0.10.8

### Patch Changes

- abe0de6: Persist timesliced composer voice recordings in browser storage with reload-safe document ownership, opener/duplicate-tab fencing, oldest-first recovery, byte-ceiling enforcement, and durable transcript-before-draft handoff. Interrupted audio retries reuse the same recording, uncertain saved transcripts require explicit insertion instead of automatic retranscription or duplicate append, and transient handed-off cleanup failures are retried and garbage-collected owner-safely.
- Updated dependencies [abe0de6]
  - @opengeni/contracts@0.36.1

## 0.10.7

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/contracts@0.36.0

## 0.10.6

### Patch Changes

- Updated dependencies [b121e7c]
  - @opengeni/contracts@0.35.0

## 0.10.5

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/contracts@0.34.0

## 0.10.4

### Patch Changes

- 74bd3a5: Project image content and image-only tools from the model capability catalogue without mutating durable session history.
- Updated dependencies [d1f0c3d]
- Updated dependencies [1d0f2ae]
- Updated dependencies [3e4842d]
  - @opengeni/contracts@0.33.0

## 0.10.3

### Patch Changes

- Updated dependencies [13b961e]
- Updated dependencies [ecc4288]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [3baaebd]
  - @opengeni/contracts@0.32.0
  - @opengeni/codex@0.2.10

## 0.10.2

### Patch Changes

- b4982fa: Pin DeepSeek V4 Flash and Kimi K3 to ordered, approved Vercel AI Gateway
  provider routes, meter managed usage from Gateway-reported cost, and preserve
  Kimi Responses tool continuity without exposing provider details in the UI.
- b4982fa: Expose GPT-5.6 Max reasoning end to end for managed and connected Codex models.
- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
  - @opengeni/contracts@0.31.2

## 0.10.1

### Patch Changes

- 9c4d73d: Add curated OpenGeni-credit and workspace-key Vercel AI Gateway model paths for
  DeepSeek V4 Flash and Kimi K3, including exact provider routing, cache-aware
  pricing and metering, Responses tool continuity, provider-blind catalog UX, and
  stable remote-compaction cache prefixes.
- Updated dependencies [9c4d73d]
  - @opengeni/contracts@0.31.1

## 0.10.0

### Minor Changes

- 8b3e46f: Allow a digest-pinned capability-pack sandbox image to bind an immutable Modal image ID. OpenGeni now preserves the logical OCI digest on the lease, starts the provider-native image through `ModalImageSelector.fromId`, records the actual ID in the Modal session envelope, clears lower-precedence IDs when a rig overrides the image, and keeps catalog image metadata aligned with the runtime manifest.

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/contracts@0.31.0

## 0.9.3

### Patch Changes

- Updated dependencies [2321119]
  - @opengeni/contracts@0.30.0

## 0.9.2

### Patch Changes

- Updated dependencies [dd71248]
  - @opengeni/contracts@0.29.0

## 0.9.1

### Patch Changes

- Updated dependencies [659b3ff]
  - @opengeni/contracts@0.28.1

## 0.9.0

### Minor Changes

- ec0bc02: Add an opt-in browser analytics runtime contract with consent-gated, allowlisted
  Reo, PostHog, and GA4 provider configuration. Self-hosted deployments remain
  disabled by default, and public client configuration exposes no provider
  administrative credentials. Third-party modules load lazily, Reo clipboard/AI
  capture is disabled, query-bearing routes are excluded, and consent can be
  withdrawn without destabilizing the console.
- 5a4c559: Add first-party X and Reddit social connectors: OAuth connect flows (X PKCE
  S256, Reddit permanent grant) with encrypted token storage and just-in-time
  refresh, live first-party MCP tools (search, mentions, thread fetch, own-post
  sync, permission-gated reply publishing), a reddit provider in the marketing
  pack, operator config via OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON, and SDK
  startSocialOAuth/listSocialConnections.

### Patch Changes

- Updated dependencies [d4d8960]
- Updated dependencies [ec0bc02]
- Updated dependencies [5a4c559]
  - @opengeni/contracts@0.28.0

## 0.8.1

### Patch Changes

- 8243ffe: Allow browser SDK clients to call the public API from arbitrary origins with explicit bearer credentials while keeping cross-origin cookie sessions limited to operator-configured trusted origins.

## 0.8.0

### Minor Changes

- 1ec9912: Add generic, versioned workspace artifacts with content-addressed HTML storage, a static HTML/CSS renderer, rollback history, and first-party agent publishing tools. JavaScript and active or navigation-capable markup are removed from the initial renderer until executable artifacts have a stronger isolation boundary.

### Patch Changes

- dcc35c5: Add authenticated Slack mentions, commands, message shortcuts, atomically private bot-DM sessions, durable thread continuation, and globally bounded idempotent progress delivery.
- Updated dependencies [dcc35c5]
- Updated dependencies [1ec9912]
  - @opengeni/contracts@0.27.0

## 0.7.22

### Patch Changes

- c52acc0: Ship Fast latency mode with turn-column inheritance, Codex ChatGPT honor-skip for response service_tier, and model picker UX polish.
- Updated dependencies [c52acc0]
  - @opengeni/codex@0.2.9
  - @opengeni/contracts@0.26.1

## 0.7.21

### Patch Changes

- Updated dependencies [f413e6c]
  - @opengeni/contracts@0.26.0

## 0.7.20

### Patch Changes

- b2e975f: Advance the merged knowledge release train to fresh publication identities without changing runtime behavior. This corrective source is derived from current main and does not reuse generated release output.
- Updated dependencies [0199108]
- Updated dependencies [42428a2]
- Updated dependencies [b2e975f]
- Updated dependencies [9f3b931]
  - @opengeni/contracts@0.25.0

## Unreleased

### Minor Changes

- Add declarative voice-input provider registry settings (`OPENGENI_VOICE_INPUT_*`) and
  `resolveVoiceInputProviderRegistry` / `voiceInputDeploymentConfigured` helpers for
  OpenAI, Azure OpenAI, and experimental Codex transcription.
- Ignore template placeholder STT secrets (`your-key`, etc.) and prefer Codex
  subscription STT by default when `OPENGENI_CODEX_SUBSCRIPTION_ENABLED` is on
  (provider order `codex-subscription,openai,azure-openai`), even if OpenAI/Azure
  keys exist. Omit `codex-subscription` from the order to keep subscription turns
  without Codex voice.

## 0.7.19

### Patch Changes

- b7df541: Prevent provider-native checkpoint capture from racing sandbox operations while
  the provider has paused the source box. Capture now owns a durable
  lease/epoch/instance/generation claim, blocks new holders and mutations, drains
  provider-local reads before entering the exclusive snapshot call, and retains
  ownership through late provider settlement and exact stale-claim recovery.
  Modal's typed completed-exec stdin race is also normalized into a side-effect-free
  terminal poll, so an exec that exits between local lookup and the provider write
  settles its retained process instead of failing the enclosing turn.
- Updated dependencies [710b081]
  - @opengeni/contracts@0.24.3

## 0.7.18

### Patch Changes

- 96eb64b: Advance the reviewed knowledge release package graph to fresh publishable identities after the previous version projection was invalidated. This changes release metadata only and does not alter runtime behavior.
- Updated dependencies [96eb64b]
  - @opengeni/contracts@0.24.2

## 0.7.17

### Patch Changes

- 0a9a6eb: Keep browser-facing S3-compatible signed URLs on the public endpoint while routing authenticated API and worker object operations through an optional internal endpoint.
- Updated dependencies [ddff8db]
  - @opengeni/contracts@0.24.1

## 0.7.16

### Patch Changes

- Updated dependencies [6d167f4]
  - @opengeni/codex@0.2.8

## 0.7.15

### Patch Changes

- a19971e: Treat native provider snapshot receipts as typed opaque artifacts instead of tar
  trees; track every Modal Image in a provider-bound, crash-safe checkpoint ledger;
  garbage-collect displaced and publication-losing Images; adopt only provable
  legacy ownership; bind retained processes to their exact Modal namespace and
  reconcile historical terminal boxes without touching successors; rotate finite
  Modal boxes through the canonical checkpoint/drain/rematerialization path before
  their persisted deadline without checkpointing across an active direct API
  mutation; memoize terminal recovery failures; and use Modal's
  documented 24-hour maximum as the default hard box lifetime. Frame confined
  filesystem/Git command output at both boundaries with a fresh attempt nonce and
  strict exit-status parsing so provider diagnostics, truncation, or delayed
  retries cannot corrupt Modal-like `execCommand` control records. Upgrade the
  Modal JavaScript SDK to 0.9.0 and explicitly retain native checkpoint Images
  until the provider-bound artifact ledger proves that their exact ids are safe
  to garbage-collect.
- Updated dependencies [a19971e]
- Updated dependencies [1f6f13f]
  - @opengeni/contracts@0.24.0

## 0.7.14

### Patch Changes

- Updated dependencies [ad0bdc3]
  - @opengeni/contracts@0.23.1

## 0.7.13

### Patch Changes

- 36451c6: Support an explicit shared workspace base directory for containerized Docker workers.
- Updated dependencies [33dc88f]
  - @opengeni/contracts@0.23.0

## 0.7.12

### Patch Changes

- 1c4018e: Replace one-turn tool overrides with one durable session tool policy, expose
  OpenGeni-native tools in the same selection, default available tools on, and
  render delivered machine inputs as compact typed timeline updates instead of
  raw protocol JSON.
- Updated dependencies [1c4018e]
  - @opengeni/contracts@0.22.1

## 0.7.11

### Patch Changes

- b2e23f3: Resolve Connected Machine Toolspace token files against the machine user's real
  home directory instead of the selfhosted capability root.
- dfc3235: Separate first-party MCP authorization from exact per-session tool visibility, add fail-closed registration policy, and isolate file download URLs on the files MCP surface.
- Updated dependencies [29ad09b]
- Updated dependencies [dfc3235]
  - @opengeni/contracts@0.22.0

## 0.7.10

### Patch Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.
- Updated dependencies [519d93c]
  - @opengeni/contracts@0.21.0

## 0.7.9

### Patch Changes

- 110bb77: Enforce exact-subject ownership for personal OAuth capabilities and add secure direct OAuth installation for the separate workspace OpenGeni Slack bot.
- Updated dependencies [110bb77]
  - @opengeni/contracts@0.20.2

## 0.7.8

### Patch Changes

- Updated dependencies [ffd246c]
  - @opengeni/contracts@0.20.1

## 0.7.7

### Patch Changes

- 9326255: Let a single-machine turn worker adapt activity concurrency to whole-system CPU
  and memory targets while preserving fixed per-worker concurrency elsewhere.
- Updated dependencies [06a5801]
- Updated dependencies [5511c24]
  - @opengeni/contracts@0.20.0

## 0.7.6

### Patch Changes

- Updated dependencies [9a8f793]
- Updated dependencies [c135339]
  - @opengeni/contracts@0.19.4

## 0.7.5

### Patch Changes

- Updated dependencies [a0f2442]
  - @opengeni/contracts@0.19.3

## 0.7.4

### Patch Changes

- 85cb323: Restore provider-native web search for workspace-default Codex sessions while preserving explicit
  tool narrowing, child policy ceilings, version-fenced policy adoption, and structured URL citations.
- Updated dependencies [85cb323]
  - @opengeni/contracts@0.19.2

## 0.7.3

### Patch Changes

- 5685f32: Add the restricted runtime database posture contract and workspace-scoped RLS context validation, together with the runtime-role configuration required by standalone API and worker startup.
- Updated dependencies [de20184]
  - @opengeni/contracts@0.19.1

## 0.7.2

### Patch Changes

- 7c6aa7c: Keep Codex connected-app MCP tools disabled by default behind the independent
  `OPENGENI_CODEX_CONNECTED_APPS_ENABLED` deployment switch.

## 0.7.1

### Patch Changes

- 55c6559: Retain release-capable source heads with immutable GitHub prereleases and make
  the unbaked agent installer resolve through an explicitly configured stable
  version instead of a mutable release alias.

## 0.7.0

### Minor Changes

- 46bac05: Enforce a configurable inclusive nested-agent depth at the transactional
  session-creation boundary with a server default of three. Persist immutable
  lineage and policy snapshots, and return idempotent typed denial evidence without
  creating run, workflow, sandbox, usage, or billing artifacts.

### Patch Changes

- Updated dependencies [c549ed8]
- Updated dependencies [46bac05]
- Updated dependencies [860de22]
- Updated dependencies [5b57a2d]
  - @opengeni/contracts@0.19.0

## 0.6.10

### Patch Changes

- 744a93d: Add default-off, bounded adaptive Codex fleet decision telemetry with strict deterministic replay, cache-aware and work-conserving policy simulation, secret-safe event/UI observability, and independent future policy gates.
- Updated dependencies [744a93d]
  - @opengeni/contracts@0.18.1

## 0.6.9

### Patch Changes

- 0d60720: Add capability-first session tool policies with omission-as-discovery defaults,
  explicit per-turn narrowing and child inheritance, secret-safe effective-policy
  projections, stable lazy `tool_search` catalogs, and matching API, SDK, React,
  worker, embedding, and audit contracts.

  Harden credential-bearing MCP and OAuth traffic with destination-bound
  credentials, single-resolution DNS-pinned transport, bounded catalogs, schemas,
  results, request and response bodies, and independently validated manual
  redirects. Extend renewable, session-bound Toolspace access to connected
  machines while dynamically fencing every call to the session's active attempt.

- Updated dependencies [0d60720]
- Updated dependencies [bdd531c]
  - @opengeni/contracts@0.18.0
  - @opengeni/codex@0.2.7

## 0.6.8

### Patch Changes

- 524599e: Normalize model, provider, upstream deployment, credential source, billing,
  capability, health, and pricing identity; expose a secret-safe authenticated
  workspace catalog with separate fail-closed credential readiness for federated
  providers; and persist the accepted model/reasoning execution policy on new
  logical turns.
- Updated dependencies [524599e]
  - @opengeni/contracts@0.17.3

## 0.6.7

### Patch Changes

- Updated dependencies [229902b]
  - @opengeni/codex@0.2.6

## 0.6.6

### Patch Changes

- cb188f9: Protect clean rig verification sandboxes with canonical exact-instance leases, make Modal orphan termination revalidate durable ownership immediately before deletion, and add a default-off two-phase rollout flag.
- Updated dependencies [4966649]
  - @opengeni/contracts@0.17.2

## 0.6.5

### Patch Changes

- Updated dependencies [ff23da5]
  - @opengeni/contracts@0.17.1

## 0.6.4

### Patch Changes

- d1dee7a: Let embedding hosts read and update an existing session MCP server's approval
  policy through the public API, SDK, and React session hook. Each claimed
  attempt freezes its policy under the session lock, so updates affect the next
  attempt without reinterpreting work already running; model MCP and
  Toolspace/Code Mode consume the same exact snapshot. Toolspace tokens and
  side-effect receipts bind every proxied call to the exact active attempt, so
  Pause, Steer, recovery, and late outputs preserve one authoritative owner.
- Updated dependencies [d1dee7a]
  - @opengeni/contracts@0.17.0

## 0.6.3

### Patch Changes

- c978676: Cut a release checkpoint that requires staging, production, and the complete
  72-hour canary evidence chain before public package and image publication.
- Updated dependencies [b9cec61]
  - @opengeni/contracts@0.16.0

## 0.6.2

### Patch Changes

- Updated dependencies [9f84cc9]
  - @opengeni/contracts@0.15.0

## 0.6.1

### Patch Changes

- Updated dependencies [136227e]
- Updated dependencies [3aee519]
  - @opengeni/contracts@0.14.0

## 0.6.0

### Minor Changes

- 4401ce7: Add a scope-checked host MCP credential resolver to the public embedding port and use it consistently for model-visible MCP tools and Toolspace/Code Mode while preserving the standalone connection broker as the default. Requests carry both the immediate session and its workspace-scoped lineage root so embedded hosts can authorize child sessions through one durable root binding. Provider-neutral bindings now carry a provider family, provider host, opaque host binding id, and exact selected-repository set; successful credentials must echo the complete binding before headers are accepted. Incompatible endpoint authentication and unenforceable resource containment surface as explicit unavailable states instead of starting a duplicate OpenGeni provider connection.
- 334b63f: Publish the dependency-free Toolspace CLI, consume its canonical source from stock sandbox images, and expose an exact deployment-pinned bootstrap hint so custom rigs and connected machines can install it without ever guessing `latest`.

### Patch Changes

- 1fcd83d: Make repository mount paths provider-neutral and collision-free. Omitted paths
  now resolve to a canonical host-aware default that distinguishes GitHub,
  GitLab, Azure DevOps, and custom hosts, while one shared portable-path validator
  rejects traversal and case-folded collisions before sandbox execution.

  Hosts upgrading sessions persisted without `mountPath` should expect those
  repositories to materialize at the new host-aware location. To preserve an
  existing warm workspace location, stamp the session's former effective
  `repos/<owner>/<repo>` path explicitly before upgrading. Previously accepted
  explicit paths that are non-portable or collide after Unicode normalization and
  case folding now fail validation and must be renamed.

- 5529945: Support Temporal Cloud and secured external Temporal endpoints across every API
  and worker connection. API-key authentication enables TLS automatically, while
  optional server-auth TLS, SNI override, custom root CA, and paired mTLS
  certificate settings share one validated connection policy.
- Updated dependencies [1fcd83d]
- Updated dependencies [32011f1]
- Updated dependencies [3983021]
- Updated dependencies [4401ce7]
- Updated dependencies [c389adc]
- Updated dependencies [1f9305b]
- Updated dependencies [8c66185]
- Updated dependencies [d249403]
- Updated dependencies [a11a7fc]
- Updated dependencies [44ff327]
- Updated dependencies [dda6398]
- Updated dependencies [e8ca4f6]
- Updated dependencies [736f4fe]
  - @opengeni/contracts@0.13.0

## 0.5.3

### Patch Changes

- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.
- 3e65c23: Keep deterministic Codex subscription sharding sticky through 99% usage and
  rotate only after actual exhaustion or a definitive provider refusal. Remove the
  configurable near-exhaustion cutoff so warning presentation cannot strand usable
  subscription allowance.
- Updated dependencies
- Updated dependencies [dbb6232]
  - @opengeni/codex@0.2.5
  - @opengeni/contracts@0.12.0

## 0.5.2

### Patch Changes

- 14ce2e3: Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
  for complete current model input, make compaction failure/progress transitions
  durable and convergent, and replace recursive session discovery with a compact
  paginated projection.
- Updated dependencies [14ce2e3]
- Updated dependencies [ec0697a]
  - @opengeni/codex@0.2.4
  - @opengeni/contracts@0.11.0

## 0.5.1

### Patch Changes

- Updated dependencies [6882ff2]
  - @opengeni/codex@0.2.3

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
