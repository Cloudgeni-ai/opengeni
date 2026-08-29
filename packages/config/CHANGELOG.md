# @opengeni/config

## 0.22.3

### Patch Changes

- Updated dependencies [699477a]
- Updated dependencies [ddce5cc]
- Updated dependencies [132c8d3]
- Updated dependencies [88b6b48]
  - @opengeni/contracts@2.9.0

## 0.22.2

### Patch Changes

- 595939e: Add managed Google and GitHub sign-in through fenced browser session-set transactions, server-side OAuth state, provider-aware canonical login bindings, and isolated popup UI flows.
- Updated dependencies [595939e]
- Updated dependencies [80d7594]
  - @opengeni/contracts@2.8.0

## 0.22.1

### Patch Changes

- 17d253b: Complete personal GitHub identity support across managed, self-hosted, and local modes. Add a compact connect-and-repository UI, exact local-human authority persistence, Docker-safe credential brokering, durable child and goal propagation, and reviewed GitHub tools for pull-request reviews and merges without exposing provider tokens to agents.
- Updated dependencies [c116379]
  - @opengeni/contracts@2.7.1

## 0.22.0

### Minor Changes

- 7238fa4: Add permission-scoped advisory work discovery, durable non-exclusive typed work claims, bounded related-work projections, independent rollout controls, observability, and SDK topology filters.

### Patch Changes

- Updated dependencies [7238fa4]
  - @opengeni/contracts@2.7.0

## 0.21.0

### Minor Changes

- a7912ea: Add a one-click, owner-authorized OpenGeni Lens GitHub App installation flow for the PR Review Pack, backed by durable single-use OAuth authority, shared signed-webhook routing, and exact-repository least-privilege installation tokens. Keep bring-your-own GitHub App, GitLab, and Azure DevOps registration as the provider-neutral advanced path.
- 986f5fe: Add provider-neutral browser login session sets with bounded independently revocable slots, explicit actor switching, isolated add and re-authentication, scoped logout, non-enumerating cross-slot deep-link recovery, and rolling legacy/dual/broker compatibility.

### Patch Changes

- Updated dependencies [a7912ea]
- Updated dependencies [9ef491b]
- Updated dependencies [986f5fe]
- Updated dependencies [6e12f3a]
  - @opengeni/contracts@2.6.0

## 0.20.1

### Patch Changes

- Updated dependencies [76d6396]
- Updated dependencies [b5071cf]
  - @opengeni/contracts@2.5.0

## 0.20.0

### Minor Changes

- dc6cfff: Turn per-channel and per-DM Slack workspace routing on by default, and stop counting a personal workspace as a routing choice in a channel.

  A personal workspace is now a candidate only in that person's own bot DM. It is the wrong destination for a channel - a shared thread routed into one member's private space is invisible to everyone else in the channel - and because managed tenancy provisions a personal workspace for every member, counting it meant nobody ever had exactly one candidate. That defeated the sole-candidate rule, so an organization with a single shared workspace would have been asked to choose in every channel despite having no choice to make.

  With that fixed, an organization with one shared workspace sees no change. For an organization with several, an unrouted channel asks the first person who uses it and remembers the answer, and a bot DM goes to that person's own personal workspace. Two things are worth knowing before upgrading: someone who has lost live organization authority in the routed workspace now receives a refusal in their bot DM where the previous code failed silently, and someone whose only workspace is their own personal one is now refused in a channel rather than having channel work land somewhere nobody else can see. Apply migrations through 0342 before running the new image. Set `OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED=false` to restore the short-circuit to the installation's own workspace.

### Patch Changes

- Updated dependencies [47b88d3]
- Updated dependencies [c5e4684]
- Updated dependencies [977fa0f]
- Updated dependencies [9d251cb]
- Updated dependencies [dc10a36]
  - @opengeni/contracts@2.4.0

## 0.19.1

### Patch Changes

- Updated dependencies [1b21135]
- Updated dependencies [f30555c]
- Updated dependencies [47ccfab]
- Updated dependencies [b74e557]
- Updated dependencies [b2cd0f0]
  - @opengeni/contracts@2.3.0
  - @opengeni/codex@0.2.19
  - @opengeni/xai-subscription@0.1.2

## 0.19.0

### Minor Changes

- 4be2055: Add `OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED` (default `false`): produce child lifecycle notices (`child_requires_action`, its resolution, `child_paused`, `child_waiting_capacity`, `child_progress`) for parent sessions. Rolling hazard: a worker from before these kinds existed throws on an unknown `session_system_updates` kind, so enable only once the whole fleet runs an image that understands them. The deployment contract carries it as a valueEnv passthrough (`CHILD_LIFECYCLE_NOTICES_PASSTHROUGH_ENV`).
  Once the flag has produced rows, a pre-notice image must never restart while any new-kind row is still pending in `session_system_updates` or `session_system_update_outbox`; turning the flag back off stops production but does not drain already committed rows.
- e6ffdc7: Add `OPENGENI_GOAL_IDLE_BACKOFF_MS` (comma-separated pacing delays before the n-th consecutive no-input goal continuation, default `3000,30000,120000,300000`) and `OPENGENI_GOAL_IDLE_BACKOFF_MAX_MS` (default `600000`), validated at boot. This is pacing, never a cap: any new input wakes the session immediately.

### Patch Changes

- a9cd9e7: Add the default-off first-party GitHub REST MCP bridge with separate workspace-App and personal-OAuth actors, exact accepted-repository authority, reviewed read/write tools, connector-policy defaults for writes, Codemode parity, bounded credential-free results, and no replay after ambiguous mutations.
- Updated dependencies [4be2055]
- Updated dependencies [de3f376]
- Updated dependencies [e6ffdc7]
- Updated dependencies [0b3b8df]
- Updated dependencies [bbd19e0]
- Updated dependencies [e91d89e]
- Updated dependencies [5d664d8]
  - @opengeni/contracts@2.2.0

## 0.18.1

### Patch Changes

- b2dd2f7: Bound the remaining request-scoped workspace control-row mutations and make the lock budget a first-class setting: `updateWorkspaceSettings`, `deleteSessionTreeIfQuiescent`, queue move/edit/delete, composer draft save, and the MCP agent message accept an optional `controlLockTimeoutMs` that API routes and core commands pass (lifecycle callers keep the unbounded wait), so a busy workspace yields the same typed retryable 503 `WORKSPACE_CONTROL_BUSY`. `OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS` is now parsed and validated once at boot by `@opengeni/config` (`workspaceControlLockTimeoutMs`, positive integer ms, default 20000), installed into `@opengeni/db` by `createApp` through `configureWorkspaceControlRequestLockTimeoutMs`, and rendered by the deployment runtime-env generator as an optional passthrough.
- ab81e47: Allow the managed staging Slack app and bot to use the visibly distinct `OpenGeni Staging` identity. The manifest, runtime configuration, installation verification, durable binding contract, SDK, web projection, and deployment artifacts now preserve one closed environment-qualified display-name setting while production continues to default to `OpenGeni`.
- Updated dependencies [ab81e47]
  - @opengeni/contracts@2.1.1

## 0.18.0

### Minor Changes

- 650d6f9: Add an optional OpenSandbox Kubernetes sandbox backend with exact ID-addressed
  resume, renewable provider TTL, portable workspace archives, private server
  proxy support, pinned upstream deployment artifacts, and Azure sandbox-pool
  capacity isolation. Existing backend defaults, including Modal, remain
  unchanged unless `opensandbox` is selected explicitly.
- f7497fd: Add a disabled-by-default, user-owned personal GitHub OAuth lifecycle with
  separate deployment credentials, signed PKCE state, encrypted token custody,
  verified GitHub identity, typed SDK routes, reconnect fencing, and idempotent
  disconnect.

### Patch Changes

- 438e476: Add explicit anonymous OpenAI-compatible model providers with credential-free
  transport, external billing attribution, catalog readiness, and an External
  picker rail while preserving older client parsing by classifying the route from
  existing billing metadata instead of widening closed client enums. Anonymous
  providers reject all configured request headers and query parameters, and the
  runtime strips credential-like headers as a defense in depth. Document the
  temporary OpenCode Zen free-preview configuration.
  Generic Chat Completions routes also reject an `unknown` finish reason before
  accepting a terminal response, so the same accepted turn recovers from durable
  history without executing tools from ambiguous output.
- 3999dd5: Fail closed when Modal Computer/Browser is enabled without a digest-pinned desktop image, and classify a missing `opengeni-browserd-up` as unsupported instead of a retryable driver failure.
- Updated dependencies [3e1ad07]
- Updated dependencies [438e476]
- Updated dependencies [1cd0eb0]
- Updated dependencies [ebb3669]
- Updated dependencies [dc8c73f]
- Updated dependencies [9b4d5d5]
- Updated dependencies [492fb71]
- Updated dependencies [fbc760e]
- Updated dependencies [650d6f9]
- Updated dependencies [650d6f9]
- Updated dependencies [fe54954]
- Updated dependencies [f7497fd]
- Updated dependencies [ff011e6]
- Updated dependencies [ba0be3d]
- Updated dependencies [5b509be]
- Updated dependencies [c7cafb1]
- Updated dependencies [5a651c8]
- Updated dependencies [29a44c2]
- Updated dependencies [48b9f09]
  - @opengeni/contracts@2.1.0
  - @opengeni/codex@0.2.18

## 0.17.1

### Patch Changes

- 81d2da0: Pin billed GPT-5.6 Sol/Terra/Luna to Codex's 272k/258.4k/244.8k context catalog instead of the 1.05M deployment default.

## 0.17.0

### Minor Changes

- 4541ab2: Named pre-activation opt-out for canonical organization-tenancy authority: `OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED` (`organizationTenancyCanonicalActivationEnabled`) defaults to `false`, the reversible pre-activation posture, and is parsed with `EnvBoolean` so an explicit `false` cannot be coerced into activation. Leaving it unset or false is the supported way to decline or defer the one-way tenancy cutover; it is not a kill switch, and setting it back to false after an activation migration commits restores nothing. The chart's `config` map and `.env.example` pin the same safe default. The rollback boundary, activation preconditions, and operator procedure are documented in `docs/organization-tenancy.md` and `docs/deployment.md`.

### Patch Changes

- f4afa19: Advertise SuperGrok image input so Grok and Gateway Kimi receive attachments, `view_image`, and `computer_*` screenshots. DeepSeek stays text-only.
- Updated dependencies [1c78ed0]
- Updated dependencies [f4afa19]
- Updated dependencies [8583779]
- Updated dependencies [79ee99b]
- Updated dependencies [2cb04e0]
- Updated dependencies [6d22ab5]
  - @opengeni/contracts@2.0.0

## 0.16.8

### Patch Changes

- 0a6c577: Keep periodic workspace snapshots off the first provider-request critical path, clarify the overlapping runtime/model-preparation timing in the session timeline, and promote the complete signed Agent 0.1.16 bundle as the default stable installer target.
- f804057: Remove the arbitrary per-turn Codemode call cap. One turn may journal as many Codemode calls as the work needs; recovery still reuses that same journal rather than minting a new budget.
- Updated dependencies [b05130a]
- Updated dependencies [55e0417]
  - @opengeni/contracts@1.4.0

## 0.16.7

### Patch Changes

- Updated dependencies [4c2d958]
- Updated dependencies [4c2d958]
  - @opengeni/contracts@1.3.0

## 0.16.6

### Patch Changes

- 1aa02d4: Ship the branded macOS Connected Machine icon from every control plane and
  promote the existing signed agent 0.1.15 release as the default stable channel.
- 91d5caf: Add a provider-neutral operational instruction contract for consistent agent collaboration, execution safety, file editing, and skill usage across every OpenGeni persona. Keep persistent system instructions prompt-cache stable, project goal continuations once as canonical user messages, let authoritative human input supersede a pending continuation, and remove the unreliable inferred-progress pause.
- 6c45ceb: Start fresh progressive-disclosure turns with only local tools, `tool_search`,
  and MCP servers explicitly marked eager by the session. Prepare every other
  strict or optional MCP concurrently, join the exact catalog only when searched
  or invoked, and keep worker first-party MCP traffic on an internal endpoint
  instead of a sandbox-facing public route while preserving the distinct root,
  documents, and files MCP paths.
- Updated dependencies [ca75ed9]
- Updated dependencies [c297fc0]
- Updated dependencies [91d5caf]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [e9aabaa]
- Updated dependencies [1f860f0]
- Updated dependencies [c297fc0]
- Updated dependencies [22c0c21]
- Updated dependencies [4eb7abd]
- Updated dependencies [89d4ab3]
- Updated dependencies [7454580]
- Updated dependencies [16cbd7b]
- Updated dependencies [30ba620]
- Updated dependencies [d168b8f]
- Updated dependencies [6860c5f]
- Updated dependencies [f72563d]
- Updated dependencies [c297fc0]
- Updated dependencies [6c45ceb]
- Updated dependencies [c297fc0]
  - @opengeni/contracts@1.2.0

## 0.16.5

### Patch Changes

- e0e0102: Unify browser, computer, identity, realtime, and Codemode behavior across managed sandboxes and connected machines.
- ec00479: Add provider-free Google Drive release-readiness receipts, configurable persisted sync budgets, bounded request retry and timeout handling, and scoped sync health telemetry, dashboards, and alerts.
- 79f57b5: Close terminal SuperGrok SSE streams deterministically; abort any accepted stream after a configurable interval without a complete valid event; and expose metadata-only durable lifecycle audits, bounded metrics, dashboard panels, and timeout alerting without replaying partial work.
- Updated dependencies [90c0c3e]
- Updated dependencies [9c4e0b8]
- Updated dependencies [e0e0102]
- Updated dependencies [d7dfc01]
- Updated dependencies [ffbbf4c]
- Updated dependencies [d34dd9a]
- Updated dependencies [79f57b5]
- Updated dependencies [eeb7cb6]
- Updated dependencies [c3f0598]
- Updated dependencies [d2f172c]
- Updated dependencies [04b1a1f]
- Updated dependencies [c056063]
  - @opengeni/contracts@1.1.0
  - @opengeni/xai-subscription@0.1.1

## 0.16.4

### Patch Changes

- Updated dependencies [448117d]
  - @opengeni/contracts@1.0.1

## 0.16.3

### Patch Changes

- Updated dependencies [083387e]
- Updated dependencies [11913b7]
  - @opengeni/contracts@1.0.0

## 0.16.2

### Patch Changes

- Updated dependencies [944be7f]
  - @opengeni/codex@0.2.17

## 0.16.1

### Patch Changes

- d86610d: Run published HTML artifacts as exact source in an opaque-origin sandbox, raise their UTF-8 ceiling to 4 MiB, and expose reusable React rendering. Add deployment-configurable default and allowed built-in session tools plus configured shared-key delegation fallback.
- 478d7fe: Add permission-first agent Knowledge search, exact fetch, and cursor-bounded browsing over authorized Documents.
- Updated dependencies [d86610d]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
  - @opengeni/contracts@0.50.0

## 0.16.0

### Minor Changes

- b0b2bed: Add unified browser and computer interaction APIs, reusable browser identities, native input, live streaming, and React viewer controls across managed sandboxes and connected machines.

### Patch Changes

- Updated dependencies [b0b2bed]
  - @opengeni/contracts@0.49.0

## 0.15.1

### Patch Changes

- Updated dependencies [8beed26]
- Updated dependencies [8beed26]
  - @opengeni/contracts@0.48.0

## 0.15.0

### Minor Changes

- 1e78f58: Replace provider presets and nullable integration identities with immutable Integration Definitions. Curated and workspace-authored integrations now share one definition-based contract, provenance model, OAuth callback, SDK route, runtime projection, and maintenance migration with no legacy API alias or fallback authority.

### Patch Changes

- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
- Updated dependencies [746bbbe]
- Updated dependencies [9849e25]
- Updated dependencies [1e78f58]
  - @opengeni/contracts@0.47.0

## 0.14.1

### Patch Changes

- Updated dependencies [73d34d6]
- Updated dependencies [3d74340]
  - @opengeni/codex@0.2.16
  - @opengeni/contracts@0.46.0

## 0.14.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.
- 5215c0e: Add the first-party Fiken connector: a registered-app OAuth flow (`startFikenOAuth` + public callback, Basic-auth code exchange, broker-owned refresh with rotating refresh tokens) and a verified paste-a-token install route, both storing one workspace-owned `fiken.no` connection; explicit-only `fiken_*` first-party MCP tools (reads plus contact-create and idempotent invoice-draft-create); a serialized single-concurrent-request Fiken client; an `api:fiken` capability tile whose connect sheet leads with OAuth and folds the token form behind a toggle; and operator config `OPENGENI_FIKEN_OAUTH_CLIENT_ID`/`_SECRET`.

### Patch Changes

- Updated dependencies [d2def0c]
- Updated dependencies [5215c0e]
- Updated dependencies [d15d3e8]
- Updated dependencies [733c22f]
  - @opengeni/contracts@0.45.0

## 0.13.2

### Patch Changes

- Updated dependencies [b57d61f]
- Updated dependencies [5c5ea4a]
  - @opengeni/contracts@0.44.1

## 0.13.1

### Patch Changes

- 87e9ae6: Add durable Google Drive Changes cursors, Shared Drive-aware delta draining,
  bounded full reconciliation, cursor-invalid repair, and a default-off
  Workspace Events wake seam. Normalize My Drive's root alias before ancestry
  checks and preserve cumulative item, provider-request, and elapsed budgets
  across delta, continuation, and full-repair checkpoints. Carry bounded
  per-object revision floors across delta-to-full and checkpointed full scans so
  older or equal Drive revisions cannot regress accepted metadata/current-version
  state, fail closed on conflicting fallback identities, and keep the first
  observation in one scan generation as a durable monotonic floor. Fence item
  version/metadata writes plus checkpoint and terminal cursor settlement to the
  exact lease, initiating subject, scan, checkpoint generation, and accepted
  floor, so a lost full-page checkpoint cannot replay version 8 as version 7.
- 8b6803a: Make Modal sandbox recovery command-ready and accurately diagnosed, use workspace-only snapshots for new sessions, enforce checkpoint cadence, and publish cached rig images only after an independent cold boot.
- ff7203c: Add a read-only Atlassian Jira and Confluence connector with shared OAuth setup, selected-source live agent search and reads, and optional governed knowledge synchronization.
- Updated dependencies [8b6803a]
- Updated dependencies [aeb07f4]
- Updated dependencies [ff7203c]
  - @opengeni/contracts@0.44.0

## 0.13.0

### Minor Changes

- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.

### Patch Changes

- 2f4ce5e: Add durable Seedance video generation with workspace model and funding policy,
  secure media references, retained video artifacts, sandbox materialization,
  OpenGeni-credit and workspace-gateway funding, and SDK/React playback surfaces.
- 5fcad0a: Expose an agent-safe checkpointed listing of newly indexed documents with source and provenance metadata.
- Updated dependencies [b46f4de]
- Updated dependencies [2f4ce5e]
- Updated dependencies [d55a093]
- Updated dependencies [dcfe6eb]
- Updated dependencies [ad9123b]
- Updated dependencies [31666e2]
- Updated dependencies [bd5514e]
- Updated dependencies [90eea29]
- Updated dependencies [a858835]
- Updated dependencies [5fcad0a]
  - @opengeni/contracts@0.43.0
  - @opengeni/codex@0.2.15

## 0.12.10

### Patch Changes

- Updated dependencies [2cd6dce]
  - @opengeni/contracts@0.42.1

## 0.12.9

### Patch Changes

- Updated dependencies [7b2d5ff]
- Updated dependencies [d1189ba]
  - @opengeni/contracts@0.42.0

## 0.12.8

### Patch Changes

- Updated dependencies [ef78ecf]
  - @opengeni/contracts@0.41.4

## 0.12.7

### Patch Changes

- Updated dependencies [dfcf698]
  - @opengeni/contracts@0.41.3

## 0.12.6

### Patch Changes

- e2edfbc: Add provider-aware image generation with permanent verified artifacts,
  prompt-cache-safe history, sandbox materialization, and SDK/React rendering.
- 7f70d33: Bound long-running service memory, upgrade the OpenAI Agents SDK to 0.14.3, and preserve exact provider, streaming, and durable-resume semantics.
- Updated dependencies [e2edfbc]
- Updated dependencies [7f70d33]
  - @opengeni/codex@0.2.14
  - @opengeni/contracts@0.41.2

## 0.12.5

### Patch Changes

- 2727236: Make sandbox draining crash-safe with durable capture and teardown ownership, idempotent Modal snapshots, scoped operator holds, parallel Temporal reaping, exact lifecycle errors, and verified Local/Docker workspace recovery.
- c8eb465: Add explicit provider-contained lazy-tool transports: preserve Codex native search, use native client tool search for direct OpenAI/Azure Responses, and use a cache-stable ordinary search/invoke dispatcher for other function-calling providers.
- Updated dependencies [2727236]
  - @opengeni/contracts@0.41.1

## 0.12.4

### Patch Changes

- bb9a346: Add token and cache coverage plus nullable provider-rate cost comparisons to Workspace Insights, preserving exact Gateway billing while keeping incomplete configured telemetry unpriced.
- Updated dependencies [bb9a346]
  - @opengeni/contracts@0.41.0

## 0.12.3

### Patch Changes

- dec7ada: Promote the immutable OpenGeni connected-machine agent 0.1.14 release through the default stable install and update channel.

## 0.12.2

### Patch Changes

- 7d13f51: Promote the immutable OpenGeni connected-machine agent 0.1.13 release through the default stable install and update channel.
- 7ac558e: Continuously enforce resource-based turn-worker memory headroom through the existing graceful checkpoint and drain lifecycle.

## 0.12.1

### Patch Changes

- 410835e: Promote the immutable OpenGeni connected-machine agent 0.1.12 release through the default stable install and update channel.
- Updated dependencies [fed43cf]
  - @opengeni/contracts@0.40.0

## 0.12.0

### Minor Changes

- f8eb9f9: Serve signed stable and beta Connected Machine update manifests from each enrolled deployment, with explicit release promotion pointers.

### Patch Changes

- 5dfb93d: Make Connected Machine command duration unbounded by default over replayable op-stream execution, preserve explicit positive deadlines for constrained deployments, wire and finalize streaming across direct and swapped machine routes, remove the generated service's aggregate memory throttle while retaining accounting and OOM isolation, and bound transient reordering memory by bytes without limiting command resources or output.
- 5dfb93d: Let one Connected Machine agent retain and serve independent connections to multiple OpenGeni workspaces and deployments, with additive connection UX and connection-scoped runtime isolation.
- Updated dependencies [200586a]
  - @opengeni/contracts@0.39.5

## 0.11.5

### Patch Changes

- Updated dependencies [70ced80]
  - @opengeni/contracts@0.39.4

## 0.11.4

### Patch Changes

- Updated dependencies [43d45c6]
  - @opengeni/codex@0.2.13

## 0.11.3

### Patch Changes

- af24281: Keep Connected Machine outages inside the agent loop and reserve automatic Toolspace setup for managed sandboxes.
- Updated dependencies [5d8bb99]
- Updated dependencies [34c5cdb]
  - @opengeni/contracts@0.39.3

## 0.11.2

### Patch Changes

- Updated dependencies [7dbd057]
- Updated dependencies [30a0b9a]
- Updated dependencies [23de73b]
  - @opengeni/contracts@0.39.2
  - @opengeni/codex@0.2.12

## 0.11.1

### Patch Changes

- Updated dependencies [ce823ce]
  - @opengeni/contracts@0.39.1

## 0.11.0

### Minor Changes

- 6eb0b23: Add production resumable composer transcription with exact-subject durable
  manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
  recording-wide provider pin, persisted retryable segment results, deterministic
  assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
  of transcript metadata after every provider object is confirmed deleted. Legacy
  one-shot voice input remains compatible.

### Patch Changes

- 5b6d36e: Enable progressive Codex MCP tool disclosure by default while retaining an explicit operator opt-out.
- Updated dependencies [6eb0b23]
  - @opengeni/contracts@0.39.0

## 0.10.14

### Patch Changes

- 8135dbb: Promote the default stable Connected Machine agent release to 0.1.9.

## 0.10.13

### Patch Changes

- Updated dependencies [69bc207]
- Updated dependencies [c0f8e40]
  - @opengeni/codex@0.2.11
  - @opengeni/contracts@0.38.3

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
