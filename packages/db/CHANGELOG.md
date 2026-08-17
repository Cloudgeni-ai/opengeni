# @opengeni/db

## 1.1.0

### Minor Changes

- ca75ed9: Add the governed-learning activation controller with exact authority revalidation, destination-native workspace activation, immutable content-free receipts, and supersession-safe append-only undo.
- c297fc0: Add permission-first Company Brain guidance, Knowledge, proposal, and content-free accepted-turn context inspection surfaces.
- 02e21fa: Accept an optional curated `category` on registry capability catalog imports instead of forcing every imported connector into the registry-wide default.
- c297fc0: Route derived Company Brain proposals through the immutable workspace learning-policy snapshot before destination admission.
  Add exact rooted Task-note to proposed workspace Knowledge promotion with immutable value-free provenance and replay-safe MCP tools.
  Add atomic Task-note correction/revert with immutable old/new lineage, strict attempt/version fencing, and replay-safe first-party tooling.
- db758f3: Publish governed-learning activations and undos to the configured workspace Slack channel through the existing durable publication outbox. The dead durable-learning adapter (`publishDurableLearningOutcomeToSlack`) is replaced by `publishGovernedLearningEventToSlack`, which projects only content-free receipt facts, uses `governed-learning:<event>:<receiptId>` idempotency, and fails closed for Slack-derived evidence.
- e9aabaa: Wire the governed-learning evaluator and activation controller into the Company Brain learning-policy router. Ways-of-working proposals now record a content-free decision receipt after they commit; under `automatic`, an eligible preference decision is activated through the destination lifecycle (instruction policy keeps a human activation boundary). The route receipt gains `learning`, `learningFailure`, and activation receipt/destination facts; `activation.activated` is no longer always `false`.
- c297fc0: Add atomic rooted Task-note promotion into inactive instruction-policy and
  preference proposals while preserving exact source evidence, replay identity,
  and human-only activation.
- 22c0c21: Add the managed-human organization invitation, role, suspension, offboarding,
  and retention lifecycle with revision-fenced APIs and SDK methods. Self
  invitation history is exposed only through bounded keyset pages, and acceptance
  resolves one exact subject-bound invitation. Already-open session,
  workspace-control, live, and interaction streams periodically recheck current
  membership authority and close after revocation. A bounded operator command
  commits expired offboarded personal database deletion together with a closed,
  exact-key cleanup-obligation set before deleting external objects. Provider
  failures retry only unfinished obligations, retained references abort before
  external bytes are touched, File bucket identity stays frozen across retries,
  and immutable lifecycle evidence survives cleanup.
- 4eb7abd: `remember` with `lane: knowledge` now returns `confirmation_required` bound to the Knowledge claim, and `remember_confirm` (`claimId`) approves the claim through the Knowledge review lifecycle after the exact initiating human answered the bound canonical question with `save` (rolling migration 0274, `confirm_remember_knowledge_claim`, immutable `remember_knowledge_confirmation_receipts`). `remember_confirm` accepts either `proposalId` + `decisionReceiptId` (preference / instruction policy) or `claimId` (knowledge); the confirm receipt carries `claimId` and a `knowledge` activation summary with `undo: knowledge_review`.
- 89d4ab3: Add the explicit user-directed `remember` / `remember_confirm` agent tools. Content becomes exact task-note evidence promoted through the learning-policy router; a preference activates immediately under `automatic`, Knowledge stays proposal-only, and everything else returns a bound `request_human_input` payload whose `save` answer authorizes activation through the new rolling migration 0272 `activate_human_confirmed_learning_decision` capability (`authority_kind = human_confirmed`, human-input request id recorded on the receipt).
- 16cbd7b: Make `retrieval_only` the default Company Brain memory prompt mode. An absent or unrecognized workspace `memoryPromptMode` now removes the broad Memory V1 standing block, excludes legacy preference-kind rows from agent search, and omits the company profile from child prompts; an explicit `legacy_standing` remains the per-workspace rollback opt-out. Rolling migration 0271 applies the same fallback at turn acceptance so frozen snapshots and the contracts resolver agree.
- f72563d: Slack now has exactly two authorities: the personal hosted Slack MCP grant and the OpenGeni workspace bot. The workspace-owned hosted Slack MCP connection is removed: OAuth start, reconnect, the callback fence, and capability enablement reject an explicit non-personal ownership for `https://mcp.slack.com/mcp`, an omitted ownership on that resource defaults to personal, and `listEnabledMcpCapabilityServers` no longer runs a workspace-scoped Slack MCP installation enabled by an earlier release. The bot manifest and canonical bot allowlist gain the bot-token Real-time Search scopes `search:read.public`, `search:read.files`, and `search:read.users` as requested-but-not-required extras; apply them to the Slack app before deploying, since the install URL requests every requested scope. The bot search tool itself is a separate change.
- c297fc0: Add deterministic governed-learning evaluation over exact accepted policy and evidence authority, with immutable content-free decision receipts and no activation capability.

### Patch Changes

- 91d5caf: Add a provider-neutral operational instruction contract for consistent agent collaboration, execution safety, file editing, and skill usage across every OpenGeni persona. Keep persistent system instructions free of mutable display metadata and append each accepted turn's frozen goal to its newest durable model-input item.
- c297fc0: Add the permission-filtered Company Brain read and deterministic OKF export
  surface, subject-scoped full guidance history, and the Company Brain discovery
  and export experience.
- 987742d: Reduce turn-start overhead without reducing admitted history, rig variables, or
  user-visible content. Active history loads in one admitted query, automatic
  compaction skips duplicate history work below threshold, unchanged Codex
  credential pointers avoid redundant session-activity writes, rig defaults
  load at bounded concurrency for admitted worker attempts, and the attempt-scoped
  MCP wrapper no longer reuses a broader process-global tool list.

  Improve large-session interaction by measuring rich-message disclosure without
  a second React commit, showing truthful pending queue actions immediately, and
  replacing the false zero-step placeholder with the session's real lifecycle.

- d168b8f: Allow exact scheduled service turns to materialize organization- and workspace-scoped Variable Sets while preserving causal-human and personal-grant checks for user-scoped sets.
- 6860c5f: Add organization, workspace, and owner-private scopes for Rigs and Connected Machines. Personal machine use and Rig materialization now revalidate exact-attempt grants, membership, workspace access, authority epochs, and generations before runtime access.
- c297fc0: Freeze Company Brain mode and bounded legacy instructions when a turn is
  accepted, then bind them to a content-free first-attempt selection receipt whose
  candidate and rendered-budget subsets make replacement recovery shrink-only.
- c297fc0: Complete governed goal rewrites with strict agent change metadata, immutable
  proposal rejection and CAS-fenced rollback, bounded revision pagination, and
  accepted-turn root constraints that child agents may inherit or narrow. The
  original raw-array goal-revision list remains unchanged; bounded pagination is
  available through a separately named API and SDK surface.
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
- Updated dependencies [d168b8f]
- Updated dependencies [6860c5f]
- Updated dependencies [f72563d]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
  - @opengeni/contracts@1.2.0
  - @opengeni/codemode@0.4.6
  - @opengeni/config@0.16.6

## 1.0.2

### Patch Changes

- a551666: Fix local Gmail provider OAuth callbacks, Google scope equivalence, stable
  Discovery compilation, and installed API integration visibility in session
  tool selection.
- 90c0c3e: Persist bounded, content-free Company Brain prompt contribution estimates on authoritative model-call facts and expose their source breakdown and coverage in Workspace Insights.
- e0e0102: Unify browser, computer, identity, realtime, and Codemode behavior across managed sandboxes and connected machines.
- 4d1ed07: Preserve complete bounded lazy-search tool schemas across durable model history, expose Linux desktop application launch when the image supports it, suppress the managed Chrome sandbox warning, label Computer sessions as Desktops in the UI, and keep AnyDoc available in headed desktop sandboxes.
- ce3b370: Restore the MPL-2.0 license and notice for the curated HashiCorp Terraform Skills in the published runtime package, and forward-repair the persisted Terraform Stacks provenance URL.
- b2af2df: Bind Integration facet idempotency receipts to the subject that created them so another workspace administrator cannot replay a personal facet result.
- e9e1016: Allow agent `goal_set` to replace completed goals while continuing to protect
  active and paused goal intent.
- ffbbf4c: Add organization, workspace, and owner-private Variable Set scopes with independent metadata, plaintext-read, write, attachment, and runtime-use authority. Runtime secret materialization now revalidates the exact live attempt and personal grant immediately before ciphertext egress while audits remain value-free.
- 3843825: Prevent workspace administrators from rebinding another subject's personal API Integration instance.
- 1ab8023: Deduplicate scheduled alert deliveries onto one atomic responder session per scheduled task and canonical alert occurrence while preserving separate roots for distinct tasks and reopened occurrences.
- 886682d: Fail closed when a persisted Terraform Stacks Pack component resolves to an unrelated, inactive, cross-tenant, or digest-mismatched Plugin installation.
- 234a5e7: Replay exact completed Integration facet configure receipts before mutable instance, Connection, or provider validation while preserving request conflicts and exact-subject isolation.
- d2f172c: Add fail-closed, metadata-only capability, exact rig-version health, exact alert-selector data-source checks, and source/claim authority fencing for scheduled incident telemetry responders before expensive retrieval.
- 04b1a1f: Add exact-attempt, workspace-local governed Knowledge proposal/correction
  routing and inactive instruction-policy and preference proposal adapters while
  preserving human activation authority and immutable Knowledge provenance.
- c056063: Project exact Integration Facet ownership so shared or externally managed bindings are read-only and direct removal reports retained owners truthfully.
- Updated dependencies [79f57b5]
- Updated dependencies [90c0c3e]
- Updated dependencies [9c4e0b8]
- Updated dependencies [e0e0102]
- Updated dependencies [d7dfc01]
- Updated dependencies [ec00479]
- Updated dependencies [ffbbf4c]
- Updated dependencies [d34dd9a]
- Updated dependencies [79f57b5]
- Updated dependencies [eeb7cb6]
- Updated dependencies [c3f0598]
- Updated dependencies [d2f172c]
- Updated dependencies [04b1a1f]
- Updated dependencies [c056063]
  - @opengeni/codemode@0.4.5
  - @opengeni/contracts@1.1.0
  - @opengeni/config@0.16.5

## 1.0.1

### Patch Changes

- 448117d: Enforce fresh per-object Google Drive ACL authorization across Knowledge
  retrieval and every file-byte consumer, and project only reauthorized,
  principal-free provider citations.
- Updated dependencies [448117d]
  - @opengeni/contracts@1.0.1
  - @opengeni/codemode@0.4.4
  - @opengeni/config@0.16.4

## 1.0.0

### Major Changes

- 083387e: Replace the removed per-turn `turnInstructions` system-prefix contract with generic per-message `modelContext` content. This is a breaking release-train cutover: old mutating clients are rejected after migration 0240. Context now enters canonical user history without standard timeline rendering, preserves the persistent prompt-cache prefix, and works across initial, queued, steer, realtime delegation, and transcript handoff paths.

### Patch Changes

- 11913b7: Add separately consented Google Drive editable-artifact publishing with an explicit writable destination, connector-action approval policy, Google-native conversion, and retry-safe provider reconciliation.
- Updated dependencies [083387e]
- Updated dependencies [11913b7]
  - @opengeni/contracts@1.0.0
  - @opengeni/codemode@0.4.3
  - @opengeni/config@0.16.3

## 0.36.1

### Patch Changes

- 499c70c: Retry transient pre-inference attempt claims atomically, durably re-wake a
  logical turn when its activity failed before creating an attempt, and preserve
  the requested backoff deadline once older workflow-wake revisions are delivered.
  Still-open legacy workflow histories and every effectively active durable work
  shape whose prior wake was delivered now retain the same recovery obligation:
  queued/recovering turns, accepted approval responses, released capacity waits,
  manual compaction, and pending internal updates. Held, paused, live-attempt, and
  already-pending wake states remain untouched.
  Terminal failure retries also close the workflow without synthesizing an
  active-goal continuation.
- Updated dependencies [944be7f]
  - @opengeni/codemode@0.4.2
  - @opengeni/codex@0.2.17
  - @opengeni/config@0.16.2

## 0.36.0

### Minor Changes

- 478d7fe: Add explicit, bounded root-task-tree coordination note tools with exact-attempt authority, private-session visibility, expiry, immutable create/archive receipts, and safe retry semantics.
- 478d7fe: Persist exact accepted-turn goal authority, separate semantic goal revisions
  from execution progress, and add policy-controlled rewrite proposals with API,
  SDK, MCP, and runtime support.

### Patch Changes

- d86610d: Show elapsed UTC-hour buckets for the Insights Today range while retaining UTC-day buckets for longer ranges.
- 478d7fe: Add a reversible workspace memory prompt mode that removes the legacy standing memory block, keeps preference observations out of agent behavioral authority, contains company-profile context for child agents, and reports metadata-only model-context contribution telemetry.
- Updated dependencies [d86610d]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
  - @opengeni/contracts@0.50.0
  - @opengeni/config@0.16.1
  - @opengeni/codemode@0.4.1

## 0.35.1

### Patch Changes

- Updated dependencies [b0b2bed]
  - @opengeni/codemode@0.4.0
  - @opengeni/config@0.16.0
  - @opengeni/contracts@0.49.0

## 0.35.0

### Minor Changes

- 8beed26: Add workspace-governed Slack shared-conversation task policies with durable enforcement and public contracts, and enforce vertical-only agent session authority across core and persistence.
- 8beed26: Add managed-human organization membership discovery. Expose the exact active
  self-membership and personal-workspace identity returned by the existing
  narrow provisioning capability through a managed-session-only API route and
  typed SDK method, while denying delegated/API-key principals and terminal
  memberships.
- 8beed26: Activate server-authoritative session visibility and content forking. Add user-private session ownership, authority-epoch transitions, explicit cross-workspace fork operations, session-scoped RLS actor propagation, and API authorization that preserves workspace-shared access while enforcing private-session ownership.

### Patch Changes

- 8beed26: Import authorized images from Slack direct messages and existing task-thread replies.
- Updated dependencies [8beed26]
- Updated dependencies [8beed26]
  - @opengeni/contracts@0.48.0
  - @opengeni/codemode@0.3.3
  - @opengeni/config@0.15.1

## 0.34.0

### Minor Changes

- 1e78f58: Replace provider presets and nullable integration identities with immutable Integration Definitions. Curated and workspace-authored integrations now share one definition-based contract, provenance model, OAuth callback, SDK route, runtime projection, and maintenance migration with no legacy API alias or fallback authority.
- 1e78f58: Make Facet definitions and bindings authoritative throughout the Integration domain. Public routes, SDK methods, Pack components, owner identities, physical tables, persisted manifests, and runtime projections now use one Facet vocabulary with a maintenance cutover and no compatibility aliases.
- 746bbbe: Add canonical human identities with multiple verified login bindings, revisioned and audited lifecycle operations, immediate session invalidation, fail-closed recovery and collision handling, and metadata-minimal managed identity API routes.
- 9849e25: Add strict identifier-free xAI provider-account authority snapshots and durable
  SuperGrok/xAI multi-account persistence with live user authority revalidation,
  encrypted credential boundaries, fair exact-turn leases, pool-scoped pins,
  quota/cooldown metadata, capacity waiters, immutable accepted-work snapshots,
  FORCE RLS, and explicit runtime privilege posture.
- 1e78f58: Make normalized Plugin, Version, Skill Facet, and component-owner records authoritative for curated and imported Skills. Add reviewed library install, list, update, preview, and uninstall contracts; preserve Pack and Plugin ownership independently; and retire every non-MCP row from the generic capability catalog and installation ledger through a collision-free maintenance migration.

### Patch Changes

- 1c4ac69: Preserve complete MCP tool results through the runtime, durable database settlement, and worker recovery path without changing model-visible output, including nested prefixed servers, compact approval snapshots, and bounded live-memory retention after durable capture.
- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
- Updated dependencies [746bbbe]
- Updated dependencies [9849e25]
- Updated dependencies [1e78f58]
  - @opengeni/config@0.15.0
  - @opengeni/contracts@0.47.0
  - @opengeni/codemode@0.3.2

## 0.33.0

### Minor Changes

- 3d74340: Add the inert personal Codex provider-account authority foundation and opaque
  accepted-work snapshot contract without activating user-scoped consumption.

### Patch Changes

- Updated dependencies [73d34d6]
- Updated dependencies [3d74340]
  - @opengeni/codex@0.2.16
  - @opengeni/contracts@0.46.0
  - @opengeni/config@0.14.1
  - @opengeni/codemode@0.3.1

## 0.32.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.
- d241d13: Add the managed-human organization-membership and personal-workspace lifecycle
  provisioning capability while preserving legacy workspace access behavior.
- 733c22f: Add the organization-tenancy foundation contracts and inert database scaffolding for organization memberships, user-owned resource authority and grants, personal retention, and generic session visibility, fork provenance, and authority epochs.

### Patch Changes

- d15d3e8: Repair the Slack reaction-task experience with initial-only session links, disabled link/media unfurls, workspace-service-principal delivery, conservative terminal-output coalescing, direct execution of safe specified requests, and bounded deterministic import of exact reacted-message PNG/JPEG/WebP attachments as reference-only workspace files. Preserve fail-closed provider-outcome reconciliation and keep generic model-facing posting unavailable without a trusted durable logical-delivery identity.
- 3f81608: Stage and validate the session-channel foreign key without retaining the column-addition lock across a populated sessions-table scan.
- 42a1242: Raise the serving envelope for active session history so tool-heavy orchestration turns remain compactable.
- Updated dependencies [d2def0c]
- Updated dependencies [5215c0e]
- Updated dependencies [d15d3e8]
- Updated dependencies [733c22f]
  - @opengeni/codemode@0.3.0
  - @opengeni/config@0.14.0
  - @opengeni/contracts@0.45.0

## 0.31.1

### Patch Changes

- 5c5ea4a: Add the universal capabilities platform with named API integration instances,
  provider-specific feature bindings, and local runtime adapters.
- Updated dependencies [b57d61f]
- Updated dependencies [5c5ea4a]
  - @opengeni/contracts@0.44.1
  - @opengeni/codemode@0.2.2
  - @opengeni/config@0.13.2

## 0.31.0

### Minor Changes

- aeb07f4: Add durable workspace decision publication to verified Slack bot channels with immutable configuration revisions, outbox attempts and receipts, bounded retries and terminal states, admin review/history UX, typed SDK methods, and a post-persistence governed-learning outcome adapter.

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
- Updated dependencies [87e9ae6]
- Updated dependencies [8b6803a]
- Updated dependencies [aeb07f4]
- Updated dependencies [ff7203c]
  - @opengeni/config@0.13.1
  - @opengeni/contracts@0.44.0
  - @opengeni/codemode@0.2.1

## 0.30.0

### Minor Changes

- b46f4de: Add a compact, cursor-paginated agent-topology read surface with root, direct-child, and search filters for lazy hierarchy browsers.
- 2f4ce5e: Add durable Seedance video generation with workspace model and funding policy,
  secure media references, retained video artifacts, sandbox materialization,
  OpenGeni-credit and workspace-gateway funding, and SDK/React playback surfaces.
- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.
- 31666e2: Add immutable workspace learning-policy revisions, lifecycle-only activation and rollback, accepted-attempt snapshots, and deterministic effective-mode resolution for `off`, `suggest`, and `automatic`.
- a858835: Add unambiguous Slack installation bindings and a token-free, subject-bound workspace access-request lifecycle for signed Slack identity links.

### Patch Changes

- 7954468: Recognize threaded Slack mentions delivered as message events, include bounded invocation context, and avoid duplicate final replies or repeated session links.
- bd5514e: Add explicitly enabled provider-neutral knowledge-source schedules with durable wake provenance, generation-fenced execution checkpoints and index obligations, fail-closed ACL activation seams, no-agent execution, layered pause state, shared schedule administration, and Google Drive source lifecycle integration.
- 90eea29: Make connected-machine removal show every dependent session and support an explicit canonical move-to-default-sandbox confirmation before revocation. Default moves prove managed sandbox readiness through the existing fleet route, active turns remain fail-closed, and typed swap rejections surface as visible errors instead of false success.
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
  - @opengeni/config@0.13.0
  - @opengeni/network@0.2.2
  - @opengeni/codemode@0.2.0
  - @opengeni/codex@0.2.15

## 0.29.1

### Patch Changes

- 2cd6dce: Build and reuse version-bound immutable provider images after clean rig verification, with content-hash invalidation and runtime-setup fallback for missing or unsupported providers.
- Updated dependencies [2cd6dce]
  - @opengeni/contracts@0.42.1
  - @opengeni/config@0.12.10

## 0.29.0

### Minor Changes

- d1189ba: Add the OpenGeni-owned document, spreadsheet, and presentation authoring engine,
  its durable API/domain/live-sync surfaces, first-party React workbench, and
  editable-artifact client SDK. Publish independently lazy, identity-pinned browser
  WASM runtimes for each editor modality.

### Patch Changes

- Updated dependencies [7b2d5ff]
- Updated dependencies [d1189ba]
  - @opengeni/contracts@0.42.0
  - @opengeni/config@0.12.9

## 0.28.18

### Patch Changes

- Updated dependencies [ef78ecf]
  - @opengeni/contracts@0.41.4
  - @opengeni/config@0.12.8

## 0.28.17

### Patch Changes

- 8485ff5: Fence approved session MCP tool execution against worker-shutdown replay.
- 1385585: Bound active turn memory, make worker admission cgroup-aware, and replace paused-prompt queue pressure with eligible Temporal backlog and slot saturation metrics.
- Updated dependencies [dfcf698]
  - @opengeni/contracts@0.41.3
  - @opengeni/config@0.12.7

## 0.28.16

### Patch Changes

- e2edfbc: Add provider-aware image generation with permanent verified artifacts,
  prompt-cache-safe history, sandbox materialization, and SDK/React rendering.
- Updated dependencies [e2edfbc]
- Updated dependencies [7f70d33]
  - @opengeni/codex@0.2.14
  - @opengeni/config@0.12.6
  - @opengeni/contracts@0.41.2
  - @opengeni/network@0.2.1

## 0.28.15

### Patch Changes

- 5806484: Serialize separate read-only Modal Channel-A requests across API replicas while preserving concurrent reads inside each batch.

## 0.28.14

### Patch Changes

- 81a51ac: Settle abandoned turn workspace admissions only after the exact attempt's physical writers drain, while preserving eager cancellation holder release and late sandbox provisioning safety. Add privacy-preserving sandbox lease correlation keys to rendered lifecycle logs.

## 0.28.13

### Patch Changes

- 2727236: Make sandbox draining crash-safe with durable capture and teardown ownership, idempotent Modal snapshots, scoped operator holds, parallel Temporal reaping, exact lifecycle errors, and verified Local/Docker workspace recovery.
- Updated dependencies [2727236]
- Updated dependencies [c8eb465]
  - @opengeni/config@0.12.5
  - @opengeni/contracts@0.41.1

## 0.28.12

### Patch Changes

- bb9a346: Add token and cache coverage plus nullable provider-rate cost comparisons to Workspace Insights, preserving exact Gateway billing while keeping incomplete configured telemetry unpriced.
- Updated dependencies [bb9a346]
  - @opengeni/config@0.12.4
  - @opengeni/contracts@0.41.0

## 0.28.11

### Patch Changes

- Updated dependencies [dec7ada]
  - @opengeni/config@0.12.3

## 0.28.10

### Patch Changes

- Updated dependencies [7d13f51]
- Updated dependencies [7ac558e]
  - @opengeni/config@0.12.2

## 0.28.9

### Patch Changes

- Updated dependencies [fed43cf]
- Updated dependencies [410835e]
  - @opengeni/contracts@0.40.0
  - @opengeni/config@0.12.1

## 0.28.8

### Patch Changes

- Updated dependencies [f8eb9f9]
- Updated dependencies [200586a]
- Updated dependencies [5dfb93d]
- Updated dependencies [5dfb93d]
  - @opengeni/config@0.12.0
  - @opengeni/contracts@0.39.5

## 0.28.7

### Patch Changes

- 377180c: Preserve the deployed migration 0172 bytes and move the connected-machine session default into a forward rolling migration.

## 0.28.6

### Patch Changes

- 70ced80: Add an offline-safe Connected Machine enrollment removal lifecycle with credential revocation, durable audit history, guarded route and lease handling, SDK/MCP support, and accessible active-list reconciliation.
- Updated dependencies [70ced80]
  - @opengeni/contracts@0.39.4
  - @opengeni/config@0.11.5

## 0.28.5

### Patch Changes

- Updated dependencies [43d45c6]
  - @opengeni/codex@0.2.13
  - @opengeni/config@0.11.4

## 0.28.4

### Patch Changes

- 7a84e1b: Retry transient retained-process promotion transactions and hand ambiguous yielded processes to exact-route turn finalization so they cannot strand sandbox leases.
- 5d8bb99: Allow scheduled tasks to target and durably wake one authorized existing session without creating a helper session or replacing its goal.
- 238fb7e: Keep human-to-human Slack DM shortcuts initiating-user-private and route durable acknowledgements, progress, results, and replies through the invoking user's OpenGeni bot DM.
- 34c5cdb: Retain validated computer screenshots as authenticated, integrity-checked session artifacts with bounded event/history receipts, SDK range assembly, and React rendering while preserving historical inline-image compatibility.

  Fence screenshot cleanup and quota accounting across parent deletion, duplicate settlement, expiry, compensation, and garbage-collection races so provider objects are deleted only after durable lifecycle ownership and quota is released exactly once.

- Updated dependencies [5d8bb99]
- Updated dependencies [af24281]
- Updated dependencies [34c5cdb]
  - @opengeni/contracts@0.39.3
  - @opengeni/config@0.11.3

## 0.28.3

### Patch Changes

- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- 23de73b: Add explicitly permissioned, audited plaintext reads for encrypted workspace variable-set values across REST, SDK, React, MCP, and UI surfaces.
- 1503151: Keep capped rotation-off Codex sessions in one durable capacity wait and suppress wakes for identical usage snapshots.
- a296081: Settle abandoned null-outcome direct sandbox mutation admissions when their physically completed request holder is released, preventing a failed settlement callback from blocking workspace checkpoint capture indefinitely. Require an exact physical-quiescence receipt before re-admitting a turn after graceful worker or provider recovery, and reconcile pre-fix attempts from their durable recovery event plus Temporal activity proof.
- Updated dependencies [7dbd057]
- Updated dependencies [30a0b9a]
- Updated dependencies [23de73b]
  - @opengeni/contracts@0.39.2
  - @opengeni/codex@0.2.12
  - @opengeni/config@0.11.2

## 0.28.2

### Patch Changes

- 110d255: Project paused sessions as idle after their interrupted attempt has quiesced, while preserving the recovering turn for Resume.
- ce823ce: Replace first-party MCP mutation entity echoes with strict, versioned compact
  receipts; add bounded scheduled-task list/detail projections and preserve worker
  session references across receipt and legacy timeline results.
- Updated dependencies [ce823ce]
  - @opengeni/contracts@0.39.1
  - @opengeni/config@0.11.1

## 0.28.1

### Patch Changes

- 55f6ad0: Use one terminal-response ordinal for provider context binding, and clear the
  durable input-token signal when the latest provider response supplies no usable
  usage instead of retaining an older response's count.

## 0.28.0

### Minor Changes

- 6eb0b23: Add production resumable composer transcription with exact-subject durable
  manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
  recording-wide provider pin, persisted retryable segment results, deterministic
  assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
  of transcript metadata after every provider object is confirmed deleted. Legacy
  one-shot voice input remains compatible.

### Patch Changes

- 49c7f9c: Prevent deadlocks between sandbox mutation settlement and retained-process promotion, retry idempotent settlement transactions after transient database conflicts, and clarify that an idle session sandbox can be restored when the next operation needs it.
- 5b6d36e: Use provider-reported usage rather than whole-request approximations for automatic context compaction, preserve provider-only input-token state across context rewrites, and label timeline counts as estimated conversation-history tokens.
- Updated dependencies [5b6d36e]
- Updated dependencies [6eb0b23]
  - @opengeni/config@0.11.0
  - @opengeni/contracts@0.39.0

## 0.27.12

### Patch Changes

- cbf165a: Reconcile settled attempt quiescence while session control remains paused so ancestor sessions do not stay stuck in a stopping transition.

## 0.27.11

### Patch Changes

- 17643a5: Prevent parallel child-session creation from the same agent attempt from deadlocking on the parent session row.
- Updated dependencies [8135dbb]
  - @opengeni/config@0.10.14

## 0.27.10

### Patch Changes

- 69bc207: Keep Codex history canonical across subscriptions and providers, separate optional owner-designated Codex Apps authority from inference allocation, and fence Apps authorization through each remote request.
- 144fd9e: Prevent fully quiesced historical interruptions from upgrading later ordinary workflow wakes to control signals.
- c0f8e40: Prevent model-visible GitHub installation credential exposure and duplicate brokered MCP side effects after ambiguous 401 responses.
- Updated dependencies [69bc207]
- Updated dependencies [c0f8e40]
  - @opengeni/codex@0.2.11
  - @opengeni/contracts@0.38.3
  - @opengeni/config@0.10.13

## 0.27.9

### Patch Changes

- 4502474: Add workspace-default and explicitly personal ownership for first-party social connections, preserve causal personal authority for agent work, and retain actionable structured gateway errors.
- Updated dependencies [4502474]
  - @opengeni/contracts@0.38.2
  - @opengeni/config@0.10.12

## 0.27.8

### Patch Changes

- dfa3aef: Preserve Steer priority through provider recovery and repair interrupted attempts durably.

## 0.27.7

### Patch Changes

- c29fd4c: Bound MCP OAuth callbacks through token exchange and persistence, return safe stage-specific failures to the capabilities UI, and replace incompatible dynamic client registrations with a compare-and-swap update.

## 0.27.6

### Patch Changes

- Updated dependencies [664c1d8]
  - @opengeni/network@0.2.0

## 0.27.5

### Patch Changes

- c9d8b69: Make Connected Machine project paths portable and diagnosable: session responses now expose `workingDir`, and the native agent consistently supports the service user's `~` path across exec, filesystem, git, and terminal operations while reporting missing working directories accurately.
- Updated dependencies [c9d8b69]
  - @opengeni/contracts@0.38.1
  - @opengeni/config@0.10.11

## 0.27.4

### Patch Changes

- b6e39fc: Polish session chrome and apply_patch rendering; clarify realtime voice-end handoff.

  SessionChrome gets denser selected-chip UX and Codex function-tool apply_patch shapes render in the specialized diff UI. Solo goal_continuation machine-input rows are suppressed in favor of the GoalRow landmark. The realtime transcript-tail instruction now keeps in-flight work going after voice ends.

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/config@0.10.10
  - @opengeni/contracts@0.38.0

## 0.27.3

### Patch Changes

- Updated dependencies [4976e1c]
  - @opengeni/network@0.1.2

## 0.27.2

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/contracts@0.37.0
  - @opengeni/config@0.10.9

## 0.27.1

### Patch Changes

- Updated dependencies [abe0de6]
  - @opengeni/config@0.10.8
  - @opengeni/contracts@0.36.1

## 0.27.0

### Minor Changes

- 00f7d3b: Add durable, tenant-isolated onboarding proposals that atomically create inactive instruction-policy drafts with typed replay, stale-baseline, conflict, and audit contracts, plus a bounded Workspace State admin composer.

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/contracts@0.36.0
  - @opengeni/config@0.10.7

## 0.26.0

### Minor Changes

- b121e7c: Add durable Google Drive pause, resume, disconnect, reconnect, revoked-token,
  removed-app, and permission re-consent lifecycle handling with version-fenced
  state transitions, generation-bound disconnect idempotency, stale-replay
  protection, and secret-safe provider error classification.

### Patch Changes

- Updated dependencies [b121e7c]
  - @opengeni/contracts@0.35.0
  - @opengeni/config@0.10.6

## 0.25.0

### Minor Changes

- b83af7a: Add replay-safe workspace instruction policy administration across the API,
  contracts, database, and SDK, including immutable operation receipts that reject
  changed requests reusing the same operation identifier.

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/contracts@0.34.0
  - @opengeni/config@0.10.5

## 0.24.0

### Minor Changes

- 3e4842d: Add subject-authorized accepted-attempt governance inspection to Workspace State,
  including immutable policy/preference snapshot metadata and deterministic current
  drift classification without exposing prompt or personal preference content.

### Patch Changes

- d1f0c3d: Add immutable organization, workspace, and initiating-user personal authority to Documents and chunks; filter retrieval by exact account and authority before ranking; require exact account-admin authority for organization publication; and preserve authority through a drained API, worker, and indexing-workflow cutover.
- 088d7cb: Replay historical three-field document indexing workflows by resolving the immutable stored authority tuple under exact account and workspace RLS before parser, embedding, status, or chunk writes.
- Updated dependencies [d1f0c3d]
- Updated dependencies [1d0f2ae]
- Updated dependencies [74bd3a5]
- Updated dependencies [3e4842d]
  - @opengeni/contracts@0.33.0
  - @opengeni/config@0.10.4

## 0.23.0

### Minor Changes

- 13b961e: Add an atomic terminal session-subtree cancellation command that drains queued work, fences concurrent prompts and child creation, interrupts live attempts, durably reports cancelled children to surviving parents, and exposes the operation through the API/core/SDK control surface.
- e03397d: Freeze workspace instruction policies and structured preference descriptors at
  the accepted logical-turn boundary, add immutable per-session policy roles, and
  compose the resulting exact-attempt governance into agent and compaction prompts.

### Patch Changes

- acfcf38: Preserve one durable task per distinct authorized Slack reaction when concurrent events share a canonical session, including route-bind, acknowledgement, and inbox-settlement recovery.
- Updated dependencies [13b961e]
- Updated dependencies [ecc4288]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [3baaebd]
  - @opengeni/contracts@0.32.0
  - @opengeni/codex@0.2.10
  - @opengeni/config@0.10.3

## 0.22.3

### Patch Changes

- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
- Updated dependencies [b4982fa]
  - @opengeni/contracts@0.31.2
  - @opengeni/config@0.10.2

## 0.22.2

### Patch Changes

- 9c4d73d: Add curated OpenGeni-credit and workspace-key Vercel AI Gateway model paths for
  DeepSeek V4 Flash and Kimi K3, including exact provider routing, cache-aware
  pricing and metering, Responses tool continuity, provider-blind catalog UX, and
  stable remote-compaction cache prefixes.
- Updated dependencies [9c4d73d]
  - @opengeni/config@0.10.1
  - @opengeni/contracts@0.31.1

## 0.22.1

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/config@0.10.0
  - @opengeni/contracts@0.31.0

## 0.22.0

### Minor Changes

- e07eb52: Enforce frozen Allow, Ask, and Block connector action policies before provider execution while persisting metadata-only approval, decision, and outcome evidence.

## 0.21.0

### Minor Changes

- 2321119: Add the provider-neutral scoped knowledge provenance, lifecycle, ACL, and normalized claim foundation for organization, workspace, and initiating-user personal evidence.

### Patch Changes

- Updated dependencies [2321119]
  - @opengeni/contracts@0.30.0
  - @opengeni/config@0.9.3

## 0.20.0

### Minor Changes

- dd71248: Make workspace-owned MCP OAuth connections the default, add explicit personal
  connection ownership, and preserve exact delegated personal authority across
  turns, child sessions, goals, schedules, retries, and recovery with safe
  tool-level degradation when a personal connection is unavailable.

### Patch Changes

- 03ed7eb: Preserve the linked Slack user's latest effective browser-selected turn model for inbound tasks and surface bounded session admission failures in Slack.
- Updated dependencies [dd71248]
  - @opengeni/contracts@0.29.0
  - @opengeni/config@0.9.2

## 0.19.0

### Minor Changes

- 1a2d41f: Add the typed hierarchical memory governance schema, lifecycle operations, and FORCE-RLS foundation.

## 0.18.1

### Patch Changes

- 659b3ff: Harden Slack-triggered session delivery, identity linking, provider backoff, explicit connection-tool selection, and replay-safe bounded progress/final delivery.
- Updated dependencies [659b3ff]
  - @opengeni/contracts@0.28.1
  - @opengeni/config@0.9.1

## 0.18.0

### Minor Changes

- 5a4c559: Add first-party X and Reddit social connectors: OAuth connect flows (X PKCE
  S256, Reddit permanent grant) with encrypted token storage and just-in-time
  refresh, live first-party MCP tools (search, mentions, thread fetch, own-post
  sync, permission-gated reply publishing), a reddit provider in the marketing
  pack, operator config via OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON, and SDK
  startSocialOAuth/listSocialConnections.

### Patch Changes

- d4d8960: Keep Personal Slack UI, reconnect, and broker credential selection on one deterministic legacy-duplicate ordering.
- Updated dependencies [d4d8960]
- Updated dependencies [ec0bc02]
- Updated dependencies [5a4c559]
  - @opengeni/contracts@0.28.0
  - @opengeni/config@0.9.0

## 0.17.1

### Patch Changes

- Updated dependencies [8243ffe]
  - @opengeni/config@0.8.1

## 0.17.0

### Minor Changes

- 1ec9912: Add generic, versioned workspace artifacts with content-addressed HTML storage, a static HTML/CSS renderer, rollback history, and first-party agent publishing tools. JavaScript and active or navigation-capable markup are removed from the initial renderer until executable artifacts have a stronger isolation boundary.

### Patch Changes

- dcc35c5: Add authenticated Slack mentions, commands, message shortcuts, atomically private bot-DM sessions, durable thread continuation, and globally bounded idempotent progress delivery.
- Updated dependencies [dcc35c5]
- Updated dependencies [1ec9912]
  - @opengeni/config@0.8.0
  - @opengeni/contracts@0.27.0

## 0.16.2

### Patch Changes

- c52acc0: Ship Fast latency mode with turn-column inheritance, Codex ChatGPT honor-skip for response service_tier, and model picker UX polish.
- Updated dependencies [c52acc0]
  - @opengeni/codex@0.2.9
  - @opengeni/config@0.7.22
  - @opengeni/contracts@0.26.1

## 0.16.1

### Patch Changes

- 02fb98c: Reconcile expired draining sandboxes after their exact provider instance has disappeared.

## 0.16.0

### Minor Changes

- f413e6c: Add real Workspace Insights: durable `model_call_facts` after authoritative
  `agent.model.usage`, a `workspace:admin` insights API over usage_events + facts +
  live joins, SDK client, and a web console that drops mock rollups for honest
  UTC credit/token/cache/warm/caps reporting.

### Patch Changes

- b5175a8: Move the unapplied Slack delete-operation migration after the already-deployed
  sandbox migration history, while accepting only the exact legacy staging
  receipt for an idempotent replay.
- Updated dependencies [f413e6c]
  - @opengeni/contracts@0.26.0
  - @opengeni/config@0.7.21

## 0.15.6

### Patch Changes

- 0199108: Harden the workspace Slack bot with one fail-closed scope policy, deterministic legacy connection selection, and durable replay-safe message deletion operation identities.
- 42428a2: Add per-session Codex remote compaction v2 (`remote_v2` / `portable`), with UI landmarks, Codex-only model locking, and opaque token accounting aligned to Codex CLI.
- 7b65614: Keep over-limit viewer-only sandboxes drained until a fresh serialized balance
  or monthly-cap evaluation clears a durable workspace admission gate. Viewer
  reattach can no longer re-arm a draining box or spawn a cold successor, while a
  turn-held sandbox remains viewable.
- Updated dependencies [0199108]
- Updated dependencies [42428a2]
- Updated dependencies [b2e975f]
- Updated dependencies [9f3b931]
  - @opengeni/contracts@0.25.0
  - @opengeni/config@0.7.20

## 0.15.5

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
- Updated dependencies [b7df541]
  - @opengeni/contracts@0.24.3
  - @opengeni/config@0.7.19

## 0.15.4

### Patch Changes

- 84fb671: Prevent a ready file restored during reconnect from being counted twice across the durable composer draft and the still-live attachment card. Canonical duplicate refs are removed before draft persistence and composer submission while custom mounts and exact draft revision/content conflict protection remain intact.
- Updated dependencies [96eb64b]
  - @opengeni/config@0.7.18
  - @opengeni/contracts@0.24.2

## 0.15.3

### Patch Changes

- 510eae3: Keep restored Modal checkpoints valid across live workspace writes, serialize
  lease reaping with concurrent acquisition, and rotate image or rig changes
  through durable checkpoint capture instead of discarding provider ownership.

## 0.15.2

### Patch Changes

- ddff8db: Add the read-only Workspace State inventory with bounded, authorization-scoped
  Documents aggregates and a deterministic metadata-only Memory projection. The
  projection explicitly labels legacy `knowledge_memories` preference-kind counts
  as non-authoritative observations while preserving the structured preference
  registry as the sole active preference authority.
- Updated dependencies [ddff8db]
- Updated dependencies [0a9a6eb]
  - @opengeni/contracts@0.24.1
  - @opengeni/config@0.7.17

## 0.15.1

### Patch Changes

- 6d167f4: Recover exact Codex encrypted-artifact rejections without deleting durable conversation truth, and make maintenance migration protocol activation part of the canonical migration transaction.
- Updated dependencies [6d167f4]
  - @opengeni/codex@0.2.8
  - @opengeni/config@0.7.16

## 0.15.0

### Minor Changes

- 1f6f13f: Add the isolated, versioned organization/workspace/user preference registry,
  including audited proposal and activation flows, deterministic attempt-bound
  descriptors, authorized full-content retrieval, REST/MCP tools, and SDK types.
  Attempt reads revalidate current generation and immutable-human authority in one
  locked transaction; lifecycle writes use scope-version CAS and database-owned
  audit functions that prevent direct head mutation or history erasure. Snapshot
  creation is database-canonical and lifecycle governance requires a signed
  `human_session` principal; expiry filtering and supersession are transactionally
  enforced before bounds or terminal mutation.

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
  - @opengeni/config@0.7.15
  - @opengeni/contracts@0.24.0

## 0.14.7

### Patch Changes

- 848287f: Seed the reviewed integrations capability catalog by default in Helm and local deployments while skipping unchanged snapshots.

## 0.14.6

### Patch Changes

- 2aca964: Allow PostgreSQL 16+ managed-service role provisioning to retain the exact non-runtime-bearing creator-management grant while continuing to reject every privilege-bearing role relationship.

## 0.14.5

### Patch Changes

- ad0bdc3: Surface managed-credit admission rejections with actionable composer recovery guidance while preserving drafts and attachments, and canonicalize default attachment mounts across established-session draft admission and replay.
- Updated dependencies [ad0bdc3]
  - @opengeni/contracts@0.23.1
  - @opengeni/config@0.7.14

## 0.14.4

### Patch Changes

- ea38a4c: Make cold sandbox recovery fail closed for database roles that bypass row-level security, preserving recovery safety before blocker settlement.

## 0.14.3

### Patch Changes

- Updated dependencies [33dc88f]
- Updated dependencies [36451c6]
  - @opengeni/contracts@0.23.0
  - @opengeni/config@0.7.13

## 0.14.2

### Patch Changes

- 1c4018e: Replace one-turn tool overrides with one durable session tool policy, expose
  OpenGeni-native tools in the same selection, default available tools on, and
  render delivered machine inputs as compact typed timeline updates instead of
  raw protocol JSON.
- Updated dependencies [1c4018e]
  - @opengeni/config@0.7.12
  - @opengeni/contracts@0.22.1

## 0.14.1

### Patch Changes

- 6908a7a: Resolve session existence and the latest workspace capture in one RLS-scoped query so capture metadata requests avoid loading the full session projection.

## 0.14.0

### Minor Changes

- 29ad09b: Persist typed machine inputs into canonical model history at turn claim, expose
  authoritative pending-input queue projections and lifecycle events, render
  delivered batches in the timeline, and preserve append-only prompt-cache
  prefixes across tools, later turns, recovery, and explicit compaction.

### Patch Changes

- dfc3235: Separate first-party MCP authorization from exact per-session tool visibility, add fail-closed registration policy, and isolate file download URLs on the files MCP surface.
- Updated dependencies [29ad09b]
- Updated dependencies [b2e23f3]
- Updated dependencies [dfc3235]
  - @opengeni/contracts@0.22.0
  - @opengeni/config@0.7.11

## 0.13.4

### Patch Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.
- Updated dependencies [519d93c]
  - @opengeni/contracts@0.21.0
  - @opengeni/config@0.7.10

## 0.13.3

### Patch Changes

- 110bb77: Enforce exact-subject ownership for personal OAuth capabilities and add secure direct OAuth installation for the separate workspace OpenGeni Slack bot.
- Updated dependencies [110bb77]
  - @opengeni/config@0.7.9
  - @opengeni/contracts@0.20.2

## 0.13.2

### Patch Changes

- 8b8545e: Keep every account-scoped workspace grant in bootstrapped access contexts so newly created workspaces remain available after an access refresh.

## 0.13.1

### Patch Changes

- Updated dependencies [ffd246c]
  - @opengeni/contracts@0.20.1
  - @opengeni/config@0.7.8

## 0.13.0

### Minor Changes

- 06a5801: Add the backend workspace instruction-policy revision, activation, rollback, audit, API, and SDK control surface.

### Patch Changes

- Updated dependencies [06a5801]
- Updated dependencies [9326255]
- Updated dependencies [5511c24]
  - @opengeni/contracts@0.20.0
  - @opengeni/config@0.7.7

## 0.12.6

### Patch Changes

- 9a8f793: Add fail-closed GitHub personal/organization owner authority proofs, audited
  workspace installation bindings with explicit repository allowlists, and
  truthful disabled/unbound/bound lifecycle contracts.
- c135339: Persist safe new-session defaults after successful creates while preserving explicit tool-policy semantics and revalidating stale workspace resources before reuse.
- Updated dependencies [9a8f793]
- Updated dependencies [c135339]
  - @opengeni/contracts@0.19.4
  - @opengeni/config@0.7.6

## 0.12.5

### Patch Changes

- Updated dependencies [a0f2442]
  - @opengeni/contracts@0.19.3
  - @opengeni/config@0.7.5

## 0.12.4

### Patch Changes

- Updated dependencies [85cb323]
  - @opengeni/config@0.7.4
  - @opengeni/contracts@0.19.2

## 0.12.3

### Patch Changes

- 1386679: Make context compaction provider-portable with Codex-compatible plaintext checkpoints, drop
  foreign account-bound reasoning during subscription rotation, and preserve the exact logical turn
  through durable all-subscriptions-exhausted capacity waits.
- b7290a3: Index duplicate-event lineage so foreign-key validation and exact session cleanup remain bounded at
  production event-table cardinality.
- dcde939: Allow a cold sandbox lease to elect a new rematerialization attempt after a restore failure explicitly marked retryable, while continuing to block non-retryable degraded and unrecoverable archives.
- 5685f32: Add the restricted runtime database posture contract and workspace-scoped RLS context validation, together with the runtime-role configuration required by standalone API and worker startup.
- de20184: Redact known runtime credentials and recognized authorization, cookie, signed
  URL, assignment, and provider-token shapes before model calls, durable session
  history, events, logs, and telemetry. Disable credential-bearing shell xtrace
  and raw Agents SDK model, tool, and MCP transport payload logging.
- Updated dependencies [5685f32]
- Updated dependencies [de20184]
  - @opengeni/config@0.7.3
  - @opengeni/contracts@0.19.1

## 0.12.2

### Patch Changes

- 7c6aa7c: Keep Codex connected-app MCP tools disabled by default behind the independent
  `OPENGENI_CODEX_CONNECTED_APPS_ENABLED` deployment switch.
- Updated dependencies [7c6aa7c]
  - @opengeni/config@0.7.2

## 0.12.1

### Patch Changes

- Updated dependencies [55c6559]
  - @opengeni/config@0.7.1

## 0.12.0

### Minor Changes

- 46bac05: Enforce a configurable inclusive nested-agent depth at the transactional
  session-creation boundary with a server default of three. Persist immutable
  lineage and policy snapshots, and return idempotent typed denial evidence without
  creating run, workflow, sandbox, usage, or billing artifacts.

### Patch Changes

- c549ed8: Persist and transactionally materialize revisioned active-goal continuation
  obligations, recover their Temporal delivery without human input or model
  polling, preserve authoritative human/Steer ordering, and expose truthful
  scheduled, running, blocked, and invariant-broken continuation state to clients.
  Make agent goal updates revisioned, attempt-recoverable commands so ambiguous
  commit responses reconcile without duplicate mutation or stale overwrites.
- 860de22: Persist actor-private pre-session drafts on the server, consume only the exact accepted revision after durable session initialization, return structured create errors, deduplicate create resources, derive checksums for SDK uploads, restore finalized attachments without browser-local byte authority, and preserve attachments added while an earlier send is in flight.
- 5b57a2d: Make provisioned-sandbox recovery truthful and atomic. Provider existence,
  lease liveness, route attachment, archive availability, restore progress,
  verified workspace readiness, and epochs are exposed separately; attach/swap
  must certify readiness. Definitive provider loss is exact-instance fenced,
  concurrent observers receive typed recovery/superseded outcomes, and ambiguous
  operations are never replayed. Rematerialization selects one verified archive
  revision under the lease lock, verifies archive bytes and restored tree contents,
  and fails closed as degraded or unrecoverable instead of publishing a partial,
  mixed, previous, or clean fallback workspace.

  Unify every persistable workspace mutation under durable turn, API-direct, or
  retained-process authority. Direct requests use exact request UUID holders;
  yielded processes retain their parent admission and exact pinned provider/route
  identity until durable exit/loss settlement. Direct/process authority blocks
  archive capture, process stdin receives a distinct mutation admission, and PTY
  control cannot be rerouted by active-pointer movement.

  Make terminal execution physically synchronous: `terminalExec` always returns a
  numeric `exitCode` with `running: false`, and timeout/error paths return only
  after exact process-group absence and retained settlement. Interactive PTYs open
  only after durable promotion, close only on exact terminal proof, and report
  provider loss truthfully.

  Activate the generation/process schema through maintenance migration 0117. All
  old API/control/turn writers must stop before the one-way cutover and may not
  restart afterward; archive completeness requires the exact closed generation.

- Updated dependencies [c549ed8]
- Updated dependencies [46bac05]
- Updated dependencies [860de22]
- Updated dependencies [5b57a2d]
  - @opengeni/contracts@0.19.0
  - @opengeni/config@0.7.0

## 0.11.0

### Minor Changes

- 0ed0f01: Add per-member session pin preferences with isolated server persistence, bounded/reused stable
  pagination snapshots, snapshot-free pin polling, typed SDK and React reconciliation, and accessible
  list and header controls.

### Patch Changes

- b32938f: Preserve the resolved model tool-output policy across pending-call recovery so
  ordinary and recovered conversation history use one byte-identical bound.
- Updated dependencies [744a93d]
  - @opengeni/config@0.6.10
  - @opengeni/contracts@0.18.1

## 0.10.7

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
  - @opengeni/config@0.6.9
  - @opengeni/contracts@0.18.0
  - @opengeni/network@0.1.1
  - @opengeni/codex@0.2.7

## 0.10.6

### Patch Changes

- 524599e: Normalize model, provider, upstream deployment, credential source, billing,
  capability, health, and pricing identity; expose a secret-safe authenticated
  workspace catalog with separate fail-closed credential readiness for federated
  providers; and persist the accepted model/reasoning execution policy on new
  logical turns.
- Updated dependencies [524599e]
  - @opengeni/config@0.6.8
  - @opengeni/contracts@0.17.3

## 0.10.5

### Patch Changes

- 229902b: Add trustworthy per-subscription Codex quota/reset-credit overview and allocator OCC controls, plus an owning-human managed-cookie-only reset redemption flow with durable ambiguity-safe provider idempotency.
- Updated dependencies [229902b]
  - @opengeni/codex@0.2.6
  - @opengeni/config@0.6.7

## 0.10.4

### Patch Changes

- 4966649: Add bounded authoritative terminal-result projections to session event monitoring APIs and SDK types.
- Updated dependencies [4966649]
- Updated dependencies [cb188f9]
  - @opengeni/contracts@0.17.2
  - @opengeni/config@0.6.6

## 0.10.3

### Patch Changes

- 495c62c: Preserve published host-export migrations and enforce lineage with a bounded forward-only repair.

## 0.10.2

### Patch Changes

- ff23da5: Keep oversized event previews bounded while optionally linking them to integrity-addressed workspace-file evidence, and expose access-controlled metadata plus capped provider-native range retrieval through the API and SDK.
- Updated dependencies [ff23da5]
  - @opengeni/contracts@0.17.1
  - @opengeni/config@0.6.5

## 0.10.1

### Patch Changes

- eed3438: Preserve private per-turn instructions when queue-edited prompts are resubmitted.

## 0.10.0

### Minor Changes

- d1dee7a: Let embedding hosts read and update an existing session MCP server's approval
  policy through the public API, SDK, and React session hook. Each claimed
  attempt freezes its policy under the session lock, so updates affect the next
  attempt without reinterpreting work already running; model MCP and
  Toolspace/Code Mode consume the same exact snapshot. Toolspace tokens and
  side-effect receipts bind every proxied call to the exact active attempt, so
  Pause, Steer, recovery, and late outputs preserve one authoritative owner.

### Patch Changes

- Updated dependencies [d1dee7a]
  - @opengeni/contracts@0.17.0
  - @opengeni/config@0.6.4

## 0.9.4

### Patch Changes

- Updated dependencies [b9cec61]
- Updated dependencies [c978676]
  - @opengeni/contracts@0.16.0
  - @opengeni/config@0.6.3

## 0.9.3

### Patch Changes

- 9f84cc9: Add durable host-provided per-turn instructions, headless structured-input hooks, host-local queue
  focus, and reusable approval and human-input surfaces for embedded session consumers.
- Updated dependencies [9f84cc9]
  - @opengeni/contracts@0.15.0
  - @opengeni/config@0.6.2

## 0.9.2

### Patch Changes

- Updated dependencies [136227e]
- Updated dependencies [3aee519]
  - @opengeni/contracts@0.14.0
  - @opengeni/config@0.6.1

## 0.9.1

### Patch Changes

- 1f0ed18: Restore immutable concurrent-index migration history, stage populated-table migrations safely, and reject goal-bearing child sessions whose resulting first-party authority lacks `goals:manage`.
- 00e1cdc: Enforce explicit session-event lock contracts and preserve sanitized PostgreSQL failure classification without replaying external effects.

## 0.9.0

### Minor Changes

- 32011f1: Add an optional durable host event and usage export for embedded deployments: source-transactional bounded snapshots, immutable turn attribution and session-root lineage, named at-least-once checkpoints, multi-replica leases, replay and retention controls, explicit poison-record disposition, an isolated exporter database role, and a worker delivery pump. Standalone deployments keep capture disabled until a host registers a sink.
- 4401ce7: Add a scope-checked host MCP credential resolver to the public embedding port and use it consistently for model-visible MCP tools and Toolspace/Code Mode while preserving the standalone connection broker as the default. Requests carry both the immediate session and its workspace-scoped lineage root so embedded hosts can authorize child sessions through one durable root binding. Provider-neutral bindings now carry a provider family, provider host, opaque host binding id, and exact selected-repository set; successful credentials must echo the complete binding before headers are accepted. Incompatible endpoint authentication and unenforceable resource containment surface as explicit unavailable states instead of starting a duplicate OpenGeni provider connection.
- c389adc: Add a provider-neutral host run-credential port with frozen turn/session lineage,
  off-manifest environment and file generations, proactive renewal, attempt-safe
  cleanup with bounded generation retention, output redaction hints, and structured
  reconnect UI support. Hosts can explicitly opt a frozen target out, and the
  POSIX materializer supports both Linux `flock` and a portable directory-lock
  fallback with cross-platform base64 decoding.
- 1f9305b: Add a host-owned session authorization port for embedded deployments. The port
  receives server-resolved root lineage and live agent-attempt authority, scopes
  session listing inside database queries, distinguishes exact from whole-tree
  projection access, gates HTTP/core/first-party MCP/Toolspace surfaces, and
  periodically reauthorizes idle SSE streams while standalone deployments retain
  their existing behavior when the port is unset.
- 8c66185: Let agent-created child sessions inherit omitted repository, MCP tool, and
  per-session MCP server context from their trusted immediate parent. Explicit
  arrays remain authoritative, mixed Git providers and multiple bindings are
  preserved, and credential headers are copied only as encrypted ciphertext.
- d249403: Allow embedding hosts to preallocate a session UUID before OpenGeni admits the
  initial turn. Session creation preserves idempotent replays of the same UUID and
  returns a conflict for UUID reuse or an idempotency replay that changes identity.
  The additive create response also returns `initialTurnId`, so an embedding host
  can correlate a preallocated host run without misusing the nullable
  `activeTurnId` execution pointer.
- dda6398: Add durable structured human-input tool calls with exact-turn ownership,
  answer/skip/expiry/cancellation outcomes, restart-safe Temporal resumption,
  authorized API and SDK methods, and headless plus styled React embed surfaces.
- e8ca4f6: Let trusted embedding hosts sign a service-only causal initiator separately
  from the delegated subject that authorizes a create, Send, or Steer command.
  Freeze that service and its non-secret provenance onto the new session/turn,
  while rejecting human impersonation, exact agent-attempt replacement, reserved
  lineage fields, the legacy migration sentinel, and oversized provenance.
  Service-provenance HTTP tokens use a prefix-bound `ogd2_` envelope so older
  rolling-deploy verifiers fail closed instead of silently stripping attribution.
- 736f4fe: Persist and expose one immutable subject-or-service initiator for every accepted turn, including creator-safe idempotent repair, queue-edit preservation, exact live-attempt fencing for agent-created sessions, signed agent inheritance, causally dominant Agent Steer attribution, explicit service producers, rolling legacy backfill, and database-enforced immutability.
  Bounded agent provenance now retains its first causal hop together with the
  newest hops, so deep child chains do not discard their root authority when the
  middle of the audit path is truncated.

### Patch Changes

- Updated dependencies [1fcd83d]
- Updated dependencies [32011f1]
- Updated dependencies [3983021]
- Updated dependencies [4401ce7]
- Updated dependencies [c389adc]
- Updated dependencies [1f9305b]
- Updated dependencies [8c66185]
- Updated dependencies [334b63f]
- Updated dependencies [d249403]
- Updated dependencies [a11a7fc]
- Updated dependencies [44ff327]
- Updated dependencies [dda6398]
- Updated dependencies [5529945]
- Updated dependencies [e8ca4f6]
- Updated dependencies [736f4fe]
  - @opengeni/contracts@0.13.0
  - @opengeni/config@0.6.0

## 0.8.0

### Minor Changes

- dbb6232: Support linking an existing GitHub App installation to multiple OpenGeni workspaces with independent repository allowlists.

  - Discover installations through GitHub App user OAuth, require repository-level administrator permission, and configure the OAuth callback in generated App manifests.
  - Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
  - Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
  - Add SDK and web controls to link, rescope, and unlink a workspace without uninstalling the GitHub App or affecting another workspace.

### Patch Changes

- 77d65f9: Use one canonical lock order for session-event persistence and retry only idempotent database transactions after deadlock or serialization failures, including generic event appends and operation-keyed Agent commands.
- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.
- Updated dependencies
- Updated dependencies [dbb6232]
- Updated dependencies [3e65c23]
  - @opengeni/codex@0.2.5
  - @opengeni/config@0.5.3
  - @opengeni/contracts@0.12.0

## 0.7.5

### Patch Changes

- 28290a0: Make context compaction and pending tool-call recovery converge without reactivating superseded history or repeating failed internal turns.

## 0.7.4

### Patch Changes

- 14ce2e3: Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
  for complete current model input, make compaction failure/progress transitions
  durable and convergent, and replace recursive session discovery with a compact
  paginated projection.
- 053c5df: The codex rotation strategy picker is gone: rotation-enabled always behaves as sticky-sharded (sharded-rotation policy). Sessions stick to one subscription each for maximum prompt-cache reuse, spread across all connected accounts, rebalancing only when a plan caps. The legacy strategies (most-remaining, round-robin, drain-then-next) are all strictly dominated post-cache-affinity and are now normalized to sharded at every worker read site; their branch code is kept but unreachable (rollback safety). The API accepts-but-ignores `rotationStrategy` writes (deprecated no-op, no caller breaks) and reports `sharded` as the effective truth; migration 0064 backfills stored legacy values and flips the column default. The web settings surface drops the strategy dropdown for honest copy. Remaining user controls are the real intents: rotation on/off, manual per-session pins, and (with account eligibility policy) per-account allocator include/exclude.
- ec0697a: Ship the production-hardened captured workspace workbench, physically verified Steer/Pause cancellation across cloud, local, and self-hosted model tools, pre-model preparation, sandbox provisioning, and lifecycle/setup commands, durable quiescence admission fencing, cancellation-aware SDK reads and turn cleanup, single-round-trip pruned workspace indexing, truthful shutdown states, a responsive and accessible review dock, Unicode coverage, and package-safe CSS/SSR integration.
- Updated dependencies [14ce2e3]
- Updated dependencies [ec0697a]
  - @opengeni/codex@0.2.4
  - @opengeni/config@0.5.2
  - @opengeni/contracts@0.11.0

## 0.7.3

### Patch Changes

- b9dbb63: Keep failed-child result provenance owned by the atomic turn settlement. Worker activities now read and deliver the exact committed outbox row without rewriting its turn-scoped payload or lineage.

## 0.7.2

### Patch Changes

- Updated dependencies [6882ff2]
  - @opengeni/codex@0.2.3
  - @opengeni/config@0.5.1

## 0.7.1

### Patch Changes

- ea52b39: Recover retryable provider failures as new fenced attempts of the same accepted turn, independent of goal state, while preserving durable tool history and pause controls.

## 0.7.0

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

- 332ac15: Add workspace-scoped operator session-revival admission helpers and pending-work guards for safe control-plane recovery tooling.
- ad4502a: Make the workbench and console dependency-safe, keep list identities stable, preserve caught error causes, isolate desktop consent tests from real transports, and enforce warning-free repository lint plus aggregate React tests in CI.
- 477b2bb: Add a "sharded" codex rotation strategy: session-sharded account affinity. Each session is assigned a deterministic HOME account (`hash(sessionId) % healthy-accounts`) at its first codex turn, written as a `policy` pin (a new `sessions.codex_pin_source` discriminator distinguishes it from a user's `manual` pin). A session stays on its one home account for prompt-cache warmth while load spreads ~1/N across the pool.

  Both rotation guards (proactive turn-start and reactive 429) now allow a `policy`-pinned session to rebalance when its account caps — never a `manual` pin, which stays sacred. A rebalance durably REWRITES the session pin (re-sharding over the healthy survivors so capped-account cohorts spread instead of re-concentrating on one failover) rather than moving only the workspace active pointer, because credential selection returns a pinned account with no exhaustion check.

  Pin lifecycle: a `manual` pin is honored under every strategy; a `policy` pin is meaningful only while the sharded policy is active. When a workspace runs a non-sharded strategy (or rotation is disabled), a leftover policy pin is ignored and lazily cleared on the session's next turn — so the session converges to the active strategy instead of idling on a capped ex-home. The strategy is selectable alongside `most_remaining`/`round_robin`/`drain_then_next` via the existing rotation-settings API; unpinned behavior under the other strategies is unchanged.

- 04d7595: Discover repositories at any workspace nesting depth, including linked worktrees whose `.git` marker is a file, while pruning dependency/build residue and enforcing timeout and repository-count bounds. An incomplete discovery now persists an epoch-fenced degraded capture revision, announces its typed reason, and makes clients prefer live workspace data instead of presenting a misleading empty capture.
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

- 13d0889: Allow independent sessions to persist attempt-fenced work concurrently while preserving an exclusive workspace Pause boundary, and align the durable control constraint with workspace Pause.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- 4a25bfc: Connected Machines read OFFLINE immediately on a clean going-offline. When a machine announces a typed GoingOffline (user-stop / self-update / host-shutdown) it now records a nullable `went_offline_at` + `went_offline_reason` marker on its enrollment, and the liveness derivation gives an un-cleared marker precedence over last_seen aging AND over a lingering liveness probe — so the dashboard and any work-routing decision see the machine as offline right away instead of waiting out the dead-detect window. A lifecycle `revoked` status still trumps the marker, and any newer liveness signal (a reconnect Hello or a fresher heartbeat) clears it back to null. Adds the `setEnrollmentWentOffline` and `clearEnrollmentWentOffline` DB helpers, threads the marker onto `EnrollmentRecord` and the `selfhostedLiveness` input, and clears it inside `touchEnrollmentLastSeen`.
- 4a25bfc: Add the `machine.link.lost`, `machine.link.restored`, and `machine.runner.restarted` session-event types for Connected Machine control-link observability (the failure-visibility doctrine's link plane). These are session-scoped, announce-only diagnostics fanned out only to the sessions that had an active op running on the machine when its control link changed — never to idle or historical sessions. A clean going-offline emits `machine.link.lost` (plus `machine.runner.restarted` when the reason is a self-update restart), and a reconnect Hello that actually cleared a going-offline marker emits `machine.link.restored`. All three project to the timeline's quiet tier (no rendered item) and are mirrored in the SDK event-type list. Adds the `sessionsWithActiveOpOnEnrollment` DB helper (one indexed lookup, no per-op tracking table) that resolves the fan-out target set.
- e4d3569: Add per-member workspace session pins with stable pinned-first listing, subject-scoped FORCE-RLS persistence, snapshot-backed activity pagination, optimistic OCC-safe pin/unpin updates, and accessible responsive web controls.
- 810542f: Commit workspace capture announcements atomically with their revision rows and keep harmless late capture bookkeeping out of the user timeline.
- 5942493: Repair missing file-upload usage records on idempotent finalize retries, reclaim abandoned direct-upload objects through a fenced Temporal cleanup schedule, and preserve accessible provider-backed image previews across reloads.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

- 9d4283d: Per-workspace model/provider hard-block policy. A new `workspace_model_policies` table (NULL = unrestricted) lets a workspace strictly allowlist which providers and/or exact model ids may serve its turns. Enforced twice: a 422 at every API model choke point (user message, queued-turn update, scheduled task, and session creation — where the EFFECTIVE model, `payload.model ?? deployment default`, is vetted, since an omitted model stamps the deployment default onto the session), and authoritatively in the worker immediately after turn model resolution, where a blocked provider/model throws `WorkspaceModelPolicyBlockedError` before any model call — including the legacy null-resolution fallback to the built-in OpenAI/Azure client, which is attributed to the built-in's own provider id so blocking the built-in also closes that path. Goal continuations that inherit a blocked model recover to the session's allowed default or pause the goal visibly with a truthful rationale. New `GET/PUT /v1/workspaces/:workspaceId/model-policy` routes (read / admin) manage the policy. Workspaces without a policy row behave exactly as before. This exists so a codex-subscription workspace can be fail-closed to codex: a turn may wait or fail loud, but can never fall through to a paid provider.
- Updated dependencies [ad4502a]
- Updated dependencies [ec508d4]
- Updated dependencies [58c78c6]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [faf1487]
- Updated dependencies [b125213]
- Updated dependencies [b804fd4]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [a0cb58f]
- Updated dependencies [e4d3569]
- Updated dependencies [5942493]
- Updated dependencies [726cf2c]
- Updated dependencies [a5f58f9]
- Updated dependencies [9d4283d]
  - @opengeni/config@0.5.0
  - @opengeni/codex@0.2.2
  - @opengeni/contracts@0.10.0

## 0.6.1

### Patch Changes

- Updated dependencies [1e7a243]
  - @opengeni/config@0.4.0

## 0.6.0

### Minor Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

### Patch Changes

- Updated dependencies [602db89]
  - @opengeni/contracts@0.9.0
  - @opengeni/config@0.3.0

## 0.5.0

### Minor Changes

- 7bfe593: Surface the desktop-capture-blocked reason as server-visible enrollment state.

  A machine can have a display it cannot CAPTURE (macOS Screen Recording / TCC not granted). The agent's connect Hello already withholds the desktop cell in that case; this persists a human, actionable reason alongside it so the Machines dashboard / VM picker can render "display: capture not granted" instead of a bare `display_unavailable`.

  - **Contracts / SDK**: `MachineView` (and `EnrollmentSummary`) gain an additive, nullable `desktopUnavailableReason`. Non-null only when a display exists but capture is blocked; `null` == capture permitted OR genuinely headless. Absent/`null` ⇒ byte-identical to today's shape for existing consumers.
  - **DB**: new nullable `enrollments.desktop_unavailable_reason` column (no backfill — `NULL` preserves the existing "capture-permitted or headless" semantics). The display-cursor writer now persists `has_display` AND the reason together, change-guarded on either field, and self-heals to `null` on the next Hello once the grant is restored.

### Patch Changes

- db468cc: Repair embedded-schema database migrations by re-granting `opengeni_app` table and sequence privileges in the active schema and setting schema-scoped default privileges for future objects.
- Updated dependencies [7bfe593]
  - @opengeni/contracts@0.8.0
  - @opengeni/config@0.2.6

## 0.4.1

### Patch Changes

- Updated dependencies [5ca067f]
  - @opengeni/contracts@0.7.0
  - @opengeni/config@0.2.5

## 0.4.0

### Minor Changes

- e513236: Add an optional per-session `instructions` field to `CreateSessionRequest`: a first-class, system-level agent persona lever composed AFTER the per-workspace `agentInstructions` (session-specific last, non-bypassable CORE preserved). It is org-visible session metadata (returned on the session record) but is never emitted as a timeline event, so hosts can deliver per-agent-type prompts without leaking prompt content into the user-visible timeline or weakening instruction authority. Absent ⇒ byte-identical to today's composition.

### Patch Changes

- Updated dependencies [dbe3a19]
- Updated dependencies [e513236]
  - @opengeni/config@0.2.4
  - @opengeni/contracts@0.6.0

## 0.3.0

### Minor Changes

- 15deca0: Add per-session third-party MCP servers with write-only encrypted headers, metadata-only responses/events, `mcp_servers:attach` permission gating, and per-message credential rotation.

### Patch Changes

- Updated dependencies [15deca0]
  - @opengeni/contracts@0.5.0
  - @opengeni/config@0.2.3

## 0.2.2

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/codex@0.2.1
  - @opengeni/config@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [548e307]
  - @opengeni/contracts@0.4.0
  - @opengeni/config@0.2.1

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/codex@0.2.0
  - @opengeni/config@0.2.0
