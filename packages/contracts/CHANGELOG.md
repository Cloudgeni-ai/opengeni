# @opengeni/contracts

## 2.1.1

### Patch Changes

- ab81e47: Allow the managed staging Slack app and bot to use the visibly distinct `OpenGeni Staging` identity. The manifest, runtime configuration, installation verification, durable binding contract, SDK, web projection, and deployment artifacts now preserve one closed environment-qualified display-name setting while production continues to default to `OpenGeni`.

## 2.1.0

### Minor Changes

- 3e1ad07: Add turn-atomic personal Variable Set and Rig attachments for create, Send, and
  Steer, including logical-turn once receipts, recovery-safe snapshots, warning
  acknowledgement, and SDK contracts.
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
- ebb3669: Add the agent-facing `company_profile_propose` first-party MCP tool over a new `proposeCompanyProfile` seam: an exact agent attempt records one inactive organization company-profile proposal (durable-learning provenance, `agent-attempt:<attemptId>` source) that an organization account admin reviews and activates from Company Brain → Company profile & goals, which now lists pending proposals with their content.
- dc8c73f: Add professional organization administration with canonical rename and a
  Personal-safe shared-workspace access inventory, explicit Organization /
  Workspace / Only-me scope at Rig and Variable Set creation, and activation-gated
  atomic private visibility when creating sessions.
- fbc760e: Add the first-party `goal_wait` MCP tool and a durable goal continuation hold.
  An orchestrator whose active goal depends on child sessions or an external
  event records a bounded hold (reason plus mandatory deadline, at most 7 days)
  with a `goal.held` timeline fact instead of busy-polling. The continuation
  materializer returns `held` while the declaring turn is still the latest
  finished turn and the deadline is ahead: it never consumes the goal wake
  revision and re-arms a delayed workflow wake at the deadline on every idle
  evaluation. Pending machine input wins with `queue`, and any newer finished
  turn, a passed deadline, or a human/API/agent goal mutation clears the hold.
  The goal projection reports a current hold as `blocked` / `held_for_input`
  with `nextAttemptAt` at the deadline (rolling migration 0317).
- 650d6f9: Add an optional OpenSandbox Kubernetes sandbox backend with exact ID-addressed
  resume, renewable provider TTL, portable workspace archives, private server
  proxy support, pinned upstream deployment artifacts, and Azure sandbox-pool
  capacity isolation. Existing backend defaults, including Modal, remain
  unchanged unless `opensandbox` is selected explicitly.
- fe54954: Add an authorized, quiescence-fenced API and SDK operation for permanently deleting a root session tree.
- f7497fd: Add a disabled-by-default, user-owned personal GitHub OAuth lifecycle with
  separate deployment credentials, signed PKCE state, encrypted token custody,
  verified GitHub identity, typed SDK routes, reconnect fencing, and idempotent
  disconnect.
- ff011e6: Add bounded owner-only personal GitHub repository discovery, immutable selected-repository
  authority storage, full-replacement and verification APIs, typed SDK methods, and exact
  accepted-turn/scheduled-task authority snapshots for explicitly bound repository resources.
  The dedicated `connectionType: "github_personal"` resource discriminator preserves existing
  host-opaque Git credential bindings without reclassifying them as personal OAuth authority.
  Runtime Git and GitHub API execution remain unavailable until their separately audited broker
  and provider-consumer phases land.
- ba0be3d: Add activation-gated owner management for personal-resource session and standing grants, with kind-derived actions and permissions, exact session authority epochs, route-workspace-fenced revocation, RFC3339 lifecycle timestamps, bounded keyset pages, complete credential-free delegation receipts, FORCE-RLS-safe expiry and invalid-action settlement, and SDK methods that intentionally exclude standalone `once` and custom expiry.
- c7cafb1: Activate owner-only session visibility changes and same-workspace private forks
  through the public API and SDK after per-organization tenancy activation.

  Expose activation-gated session tenancy metadata, typed quiescence and
  idempotency conflicts, exact durable event fanout, and explicit retry fences.

- 5a651c8: Add the blocking first-party `session_wait` MCP tool so an agent can wait for new durable events on child or peer sessions, or for its own pending machine input, in one bounded call instead of sleeping and polling `session_events`/`session_get`/`sessions_list`.
- 29a44c2: Spill oversized model-visible tool results to a workspace File instead of failing the tool or stuffing huge JSON into history. Codemode keeps the 16 MiB journal cap.
- 48b9f09: Allow organization administrators to invite an email before registration, bind
  the invitation only after exact Better Auth email verification, and apply its
  initial shared-workspace access when the invited user joins without creating a
  redundant fallback organization.

### Patch Changes

- 9b4d5d5: Create Stripe invoices for prepaid-credit Checkout payments and expose an authorized Stripe Customer Portal session for invoices and payment information.
- 492fb71: Allow foreground session readers to acknowledge an exact rendered event sequence so later unseen events remain unread.
- 650d6f9: Route OpenSandbox browser and computer streams through the API frame-proxy so the workbench can show live JPEG/RFB when the lifecycle proxy cannot carry browserd WebSocket grants.
- 5b509be: Advertise cwd-relative sandbox file paths to the model, and return the SDK execCommand banner (exit code + stdout/stderr) from Connected Machines.

## 2.0.0

### Major Changes

- 2cb04e0: Retire Memory V1's standing prompt block and its agent writes. `memoryPromptMode` is now always `retrieval_only`: no pinned/recency working set is injected into any agent prompt, and the `legacy_standing` rollback opt-out can no longer be selected. The `memory_save` and `memory_correct` first-party tools are removed; durable agent writes go through `remember` (explicit user-directed) and task-note promotion (the agent's own findings), while `memory_search` remains so an agent can still read what a workspace knows.

  Nothing is rewritten or deleted: `knowledge_memories` rows, human REST/UI audit, search, correction, export, and the Memory Slack publication path are unchanged. A workspace that stored `legacy_standing` keeps the stored value in its passthrough settings bag, where it simply stops meaning anything, and already accepted turns keep the mode they recorded because those snapshots are immutable facts about what was composed. Migration 0295 changes no data; it reports whether anything was still relying on the mode rather than assuming it was unused.

### Minor Changes

- 1c78ed0: Separate new-session and established-session composer policy authority. Exact draft submission now atomically freezes queued-turn text, resources, model, reasoning, and latency, then rotates the server draft; queue Edit restores that exact snapshot and stale revisions surface as conflicts instead of silent rebases.
- 79ee99b: Preference descriptors now carry `activationAuthority` (`human_confirmed` | `automatic` | `null`) alongside `provenance.trust`. Trust stays the frozen creation-time fact - a revision an agent proposed reads `untrusted_proposal` forever, and both activation adapters still require that value - while the new field answers the separate question of whether a human explicitly confirmed the activation or policy activated it automatically, read from the governed-learning activation receipt at descriptor-build time. Descriptors built before this field existed parse as `null`, which keeps their immutable stored JSON and pinned descriptor hash valid.

### Patch Changes

- f4afa19: Resume requires_action only from the open suffix plus paired history. Pause stores the sentinel instead of a leftover SDK RunState heap.
- 8583779: Resume `requires_action` from paired history plus a bounded open suffix instead of materializing an oversized SDK RunState blob.
- 6d22ab5: Widen the task-note expiry ceiling from 30 to 90 days. Task notes are pure agent-to-agent coordination within one root session tree; resuming a paused root session/task tree after a longer gap previously lost all coordination notes silently. `TASK_NOTE_MAX_LIFETIME_DAYS` is now the single source of truth, referenced by the application-layer bound checks and `remember`'s evidence note instead of a hardcoded literal. Fully backward compatible: every existing row and every caller supplying 1-30 days keeps working unchanged.

## 1.4.0

### Minor Changes

- b05130a: Hard-cut editable spreadsheets to authored-only canonical state, deterministic formula projections, and explicit current compatibility protocols. Preserve React compatibility with artifact-tool 0.1 and 0.2 while adding the 0.3 line.
- 55e0417: Raise the durable per-session system-instruction limit from 32768 to 65536 characters across the public and first-party MCP contracts.

## 1.3.0

### Minor Changes

- 4c2d958: Google Drive publication freezes its exact output destination on the accepted delegation, so a later connection-settings change fails an already-accepted turn's publication closed instead of silently redirecting it. Every publication sits behind exactly one durable execute-once connector fence (the attempt connector-action wrapper for model callers, the tool's own registration for Codemode callers): a failure before the first mutating provider request settles not_executed with a retry-safe message, while a failure after it settles uncertain and surfaces the unknown outcome.
- 4c2d958: Scoped stream tokens (`ogs_`, 120 s TTL unchanged) now carry the authenticated viewer subject and the session's live authority epoch (migration 0281). The viewer lease holder records the same pair monotonically, the API re-verifies a human viewer's current workspace membership at every mint and degrades the stream to `transport:null` when membership is gone, and the selfhosted relay fences an attach whose authority claim is below the channel's recorded floor. Pre-0281 tokens keep working during the rolling window and enforce nothing new.

## 1.2.0

### Minor Changes

- ca75ed9: Add the governed-learning activation controller with exact authority revalidation, destination-native workspace activation, immutable content-free receipts, and supersession-safe append-only undo.
- c297fc0: Add permission-first Company Brain guidance, Knowledge, proposal, and content-free accepted-turn context inspection surfaces.
- c297fc0: Add permission-first Knowledge search selection facts, pre-window relevance floors, deterministic ranking, search/browse response budgets, exact textual-content deduplication, freshness-aware ordering, revision-fenced cursors, and authorization-rechecked document/chunk traversal links.
- c297fc0: Add the permission-filtered Company Brain read and deterministic OKF export
  surface, subject-scoped full guidance history, and the Company Brain discovery
  and export experience.
- c297fc0: Route derived Company Brain proposals through the immutable workspace learning-policy snapshot before destination admission.
  Add exact rooted Task-note to proposed workspace Knowledge promotion with immutable value-free provenance and replay-safe MCP tools.
  Add atomic Task-note correction/revert with immutable old/new lineage, strict attempt/version fencing, and replay-safe first-party tooling.
- e9aabaa: Wire the governed-learning evaluator and activation controller into the Company Brain learning-policy router. Ways-of-working proposals now record a content-free decision receipt after they commit; under `automatic`, an eligible preference decision is activated through the destination lifecycle (instruction policy keeps a human activation boundary). The route receipt gains `learning`, `learningFailure`, and activation receipt/destination facts; `activation.activated` is no longer always `false`.
- 1f860f0: Add durable publication and authenticated download support for session sandbox files. Agents can publish bounded `/workspace` outputs through a first-party tool, raw sandbox links can recover through the session API, retained file receipts render with downloads, and retained screenshots expose an explicit download action.
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
- 7454580: Retire the legacy Memory V1 `memory_save` agent tool from the default retrieval-only surface: it is now compatibility-only, excluded from the default first-party tool catalog, and registered only when a workspace opts into the `legacy_standing` rollback mode. Agents save user-directed knowledge through `remember` and their own findings through task notes and governed promotion; `memory_search` and `memory_correct` remain.
- 16cbd7b: Make `retrieval_only` the default Company Brain memory prompt mode. An absent or unrecognized workspace `memoryPromptMode` now removes the broad Memory V1 standing block, excludes legacy preference-kind rows from agent search, and omits the company profile from child prompts; an explicit `legacy_standing` remains the per-workspace rollback opt-out. Rolling migration 0271 applies the same fallback at turn acceptance so frozen snapshots and the contracts resolver agree.
- 30ba620: Make every accepted scheduled agent occurrence an immutable, credential-free
  execution snapshot bound to one run, session, scheduled update, logical turn,
  and attempt chain. Agent tasks accept explicit `connectionAuthorities`
  (omitted preserves, `[]` clears, an array replaces), execution-affecting edits
  require the same causal human, `once` grants are consumed exactly once per
  run, cold reusable sessions converge on one revision-bound materialization
  receipt, and task deletion becomes a one-way paused tombstone with durable
  connector cleanup. Create/update requests are byte-bounded at ingress while
  stored rows stay readable. Migration `0275` is a maintenance cutover.
- d168b8f: Allow exact scheduled service turns to materialize organization- and workspace-scoped Variable Sets while preserving causal-human and personal-grant checks for user-scoped sets.
- f72563d: Slack now has exactly two authorities: the personal hosted Slack MCP grant and the OpenGeni workspace bot. The workspace-owned hosted Slack MCP connection is removed: OAuth start, reconnect, the callback fence, and capability enablement reject an explicit non-personal ownership for `https://mcp.slack.com/mcp`, an omitted ownership on that resource defaults to personal, and `listEnabledMcpCapabilityServers` no longer runs a workspace-scoped Slack MCP installation enabled by an earlier release. The bot manifest and canonical bot allowlist gain the bot-token Real-time Search scopes `search:read.public`, `search:read.files`, and `search:read.users` as requested-but-not-required extras; apply them to the Slack app before deploying, since the install URL requests every requested scope. The bot search tool itself is a separate change.
- c297fc0: Complete governed goal rewrites with strict agent change metadata, immutable
  proposal rejection and CAS-fenced rollback, bounded revision pagination, and
  accepted-turn root constraints that child agents may inherit or narrow. The
  original raw-array goal-revision list remains unchanged; bounded pagination is
  available through a separately named API and SDK surface.
- c297fc0: Add deterministic governed-learning evaluation over exact accepted policy and evidence authority, with immutable content-free decision receipts and no activation capability.

### Patch Changes

- 91d5caf: Add a provider-neutral operational instruction contract for consistent agent collaboration, execution safety, file editing, and skill usage across every OpenGeni persona. Keep persistent system instructions prompt-cache stable, project goal continuations once as canonical user messages, let authoritative human input supersede a pending continuation, and remove the unreliable inferred-progress pause.
- 6860c5f: Add organization, workspace, and owner-private scopes for Rigs and Connected Machines. Personal machine use and Rig materialization now revalidate exact-attempt grants, membership, workspace access, authority epochs, and generations before runtime access.
- 6c45ceb: Start fresh progressive-disclosure turns with only local tools, `tool_search`,
  and MCP servers explicitly marked eager by the session. Prepare every other
  strict or optional MCP concurrently, join the exact catalog only when searched
  or invoked, and keep worker first-party MCP traffic on an internal endpoint
  instead of a sandbox-facing public route while preserving the distinct root,
  documents, and files MCP paths.

## 1.1.0

### Minor Changes

- 9c4e0b8: Add the workspace-bot Slack App Home task inbox with exact linked-user authorization, bounded active/attention/recent task projection, convergent `views.publish` refreshes, access-revocation clearing, and canonical manifest support.
- eeb7cb6: Add immutable personal/workspace connection authority contracts and immediate
  pre-use revalidation helpers.

### Patch Changes

- 90c0c3e: Persist bounded, content-free Company Brain prompt contribution estimates on authoritative model-call facts and expose their source breakdown and coverage in Workspace Insights.
- e0e0102: Unify browser, computer, identity, realtime, and Codemode behavior across managed sandboxes and connected machines.
- d7dfc01: Add typed workspace model-access policy reads and full-replacement updates for admin settings surfaces, plus a provider-private per-model policy verdict in the authenticated catalog.
- ffbbf4c: Add organization, workspace, and owner-private Variable Set scopes with independent metadata, plaintext-read, write, attachment, and runtime-use authority. Runtime secret materialization now revalidates the exact live attempt and personal grant immediately before ciphertext egress while audits remain value-free.
- d34dd9a: Add revision-fenced per-command memory and CPU policies for Connected Machines, exact live runner capability gating, and lifecycle-safe Linux operation accounting without introducing default resource limits.
- c3f0598: Materialize authorized connector attachments as exact, hash-verified sandbox files while keeping provider bytes and private download URLs out of model, Codemode, and durable event output.
- d2f172c: Add fail-closed, metadata-only capability, exact rig-version health, exact alert-selector data-source checks, and source/claim authority fencing for scheduled incident telemetry responders before expensive retrieval.
- 04b1a1f: Add exact-attempt, workspace-local governed Knowledge proposal/correction
  routing and inactive instruction-policy and preference proposal adapters while
  preserving human activation authority and immutable Knowledge provenance.
- c056063: Project exact Integration Facet ownership so shared or externally managed bindings are read-only and direct removal reports retained owners truthfully.

## 1.0.1

### Patch Changes

- 448117d: Enforce fresh per-object Google Drive ACL authorization across Knowledge
  retrieval and every file-byte consumer, and project only reauthorized,
  principal-free provider citations.

## 1.0.0

### Major Changes

- 083387e: Replace the removed per-turn `turnInstructions` system-prefix contract with generic per-message `modelContext` content. This is a breaking release-train cutover: old mutating clients are rejected after migration 0240. Context now enters canonical user history without standard timeline rendering, preserves the persistent prompt-cache prefix, and works across initial, queued, steer, realtime delegation, and transcript handoff paths.

### Patch Changes

- 11913b7: Add separately consented Google Drive editable-artifact publishing with an explicit writable destination, connector-action approval policy, Google-native conversion, and retry-safe provider reconciliation.

## 0.50.0

### Minor Changes

- 478d7fe: Add explicit, bounded root-task-tree coordination note tools with exact-attempt authority, private-session visibility, expiry, immutable create/archive receipts, and safe retry semantics.
- 478d7fe: Add a reversible workspace memory prompt mode that removes the legacy standing memory block, keeps preference observations out of agent behavioral authority, contains company-profile context for child agents, and reports metadata-only model-context contribution telemetry.
- 478d7fe: Persist exact accepted-turn goal authority, separate semantic goal revisions
  from execution progress, and add policy-controlled rewrite proposals with API,
  SDK, MCP, and runtime support.

### Patch Changes

- d86610d: Prevent deterministic model-generated worker-spawn failures, hide exhausted nested-agent creation, and show bounded structured session orchestration diagnostics in worker timeline rows while preserving the advanced public REST/SDK create contract.
- d86610d: Show elapsed UTC-hour buckets for the Insights Today range while retaining UTC-day buckets for longer ranges.
- d86610d: Run published HTML artifacts as exact source in an opaque-origin sandbox, raise their UTF-8 ceiling to 4 MiB, and expose reusable React rendering. Add deployment-configurable default and allowed built-in session tools plus configured shared-key delegation fallback.
- 478d7fe: Add permission-first agent Knowledge search, exact fetch, and cursor-bounded browsing over authorized Documents.

## 0.49.0

### Minor Changes

- b0b2bed: Add unified browser and computer interaction APIs, reusable browser identities, native input, live streaming, and React viewer controls across managed sandboxes and connected machines.

## 0.48.0

### Minor Changes

- 8beed26: Add workspace-governed Slack shared-conversation task policies with durable enforcement and public contracts, and enforce vertical-only agent session authority across core and persistence.
- 8beed26: Add managed-human organization membership discovery. Expose the exact active
  self-membership and personal-workspace identity returned by the existing
  narrow provisioning capability through a managed-session-only API route and
  typed SDK method, while denying delegated/API-key principals and terminal
  memberships.

## 0.47.0

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

## 0.46.0

### Minor Changes

- 3d74340: Add the inert personal Codex provider-account authority foundation and opaque
  accepted-work snapshot contract without activating user-scoped consumption.

## 0.45.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.
- 5215c0e: Add the first-party Fiken connector: a registered-app OAuth flow (`startFikenOAuth` + public callback, Basic-auth code exchange, broker-owned refresh with rotating refresh tokens) and a verified paste-a-token install route, both storing one workspace-owned `fiken.no` connection; explicit-only `fiken_*` first-party MCP tools (reads plus contact-create and idempotent invoice-draft-create); a serialized single-concurrent-request Fiken client; an `api:fiken` capability tile whose connect sheet leads with OAuth and folds the token form behind a toggle; and operator config `OPENGENI_FIKEN_OAUTH_CLIENT_ID`/`_SECRET`.
- 733c22f: Add the organization-tenancy foundation contracts and inert database scaffolding for organization memberships, user-owned resource authority and grants, personal retention, and generic session visibility, fork provenance, and authority epochs.

### Patch Changes

- d15d3e8: Repair the Slack reaction-task experience with initial-only session links, disabled link/media unfurls, workspace-service-principal delivery, conservative terminal-output coalescing, direct execution of safe specified requests, and bounded deterministic import of exact reacted-message PNG/JPEG/WebP attachments as reference-only workspace files. Preserve fail-closed provider-outcome reconciliation and keep generic model-facing posting unavailable without a trusted durable logical-delivery identity.

## 0.44.1

### Patch Changes

- b57d61f: Keep Codex image-tool schemas within the provider-supported regex subset and
  restore all bundled runtime skills to production API and worker process builds.
- 5c5ea4a: Add the universal capabilities platform with named API integration instances,
  provider-specific feature bindings, and local runtime adapters.

## 0.44.0

### Minor Changes

- aeb07f4: Add durable workspace decision publication to verified Slack bot channels with immutable configuration revisions, outbox attempts and receipts, bounded retries and terminal states, admin review/history UX, typed SDK methods, and a post-persistence governed-learning outcome adapter.

### Patch Changes

- 8b6803a: Make Modal sandbox recovery command-ready and accurately diagnosed, use workspace-only snapshots for new sessions, enforce checkpoint cadence, and publish cached rig images only after an independent cold boot.
- ff7203c: Add a read-only Atlassian Jira and Confluence connector with shared OAuth setup, selected-source live agent search and reads, and optional governed knowledge synchronization.

## 0.43.0

### Minor Changes

- b46f4de: Add a compact, cursor-paginated agent-topology read surface with root, direct-child, and search filters for lazy hierarchy browsers.
- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.
- 31666e2: Add immutable workspace learning-policy revisions, lifecycle-only activation and rollback, accepted-attempt snapshots, and deterministic effective-mode resolution for `off`, `suggest`, and `automatic`.
- a858835: Add unambiguous Slack installation bindings and a token-free, subject-bound workspace access-request lifecycle for signed Slack identity links.

### Patch Changes

- 2f4ce5e: Add durable Seedance video generation with workspace model and funding policy,
  secure media references, retained video artifacts, sandbox materialization,
  OpenGeni-credit and workspace-gateway funding, and SDK/React playback surfaces.
- d55a093: Use truthful Google Drive read-only source-sync metadata for new connections while retaining compatibility with the legacy metadata-browser label.
- ad9123b: Pin the Slack reaction shortcut to the OpenGeni genie emoji across contracts and SDK types.
- bd5514e: Add explicitly enabled provider-neutral knowledge-source schedules with durable wake provenance, generation-fenced execution checkpoints and index obligations, fail-closed ACL activation seams, no-agent execution, layered pause state, shared schedule administration, and Google Drive source lifecycle integration.
- 90eea29: Make connected-machine removal show every dependent session and support an explicit canonical move-to-default-sandbox confirmation before revocation. Default moves prove managed sandbox readiness through the existing fleet route, active turns remain fail-closed, and typed swap rejections surface as visible errors instead of false success.
- 5fcad0a: Expose an agent-safe checkpointed listing of newly indexed documents with source and provenance metadata.

## 0.42.1

### Patch Changes

- 2cd6dce: Build and reuse version-bound immutable provider images after clean rig verification, with content-hash invalidation and runtime-setup fallback for missing or unsupported providers.

## 0.42.0

### Minor Changes

- 7b2d5ff: Add trust-gated in-session capability recommendations, human-owned authorization
  requests, and a GitHub owner-consent flow that returns to the initiating session.
- d1189ba: Add the OpenGeni-owned document, spreadsheet, and presentation authoring engine,
  its durable API/domain/live-sync surfaces, first-party React workbench, and
  editable-artifact client SDK. Publish independently lazy, identity-pinned browser
  WASM runtimes for each editor modality.

## 0.41.4

### Patch Changes

- ef78ecf: Separate credential-free capability discovery from exact, permission-checked live-plane grants; mint terminal credentials just in time, preserve first input across connection setup, and bound pre-open terminal memory.

## 0.41.3

### Patch Changes

- dfcf698: Enable Slack's hosted MCP surface in the generated app manifest with its full user-tool scope set.

## 0.41.2

### Patch Changes

- e2edfbc: Add provider-aware image generation with permanent verified artifacts,
  prompt-cache-safe history, sandbox materialization, and SDK/React rendering.

## 0.41.1

### Patch Changes

- 2727236: Make sandbox draining crash-safe with durable capture and teardown ownership, idempotent Modal snapshots, scoped operator holds, parallel Temporal reaping, exact lifecycle errors, and verified Local/Docker workspace recovery.

## 0.41.0

### Minor Changes

- bb9a346: Add token and cache coverage plus nullable provider-rate cost comparisons to Workspace Insights, preserving exact Gateway billing while keeping incomplete configured telemetry unpriced.

## 0.40.0

### Minor Changes

- fed43cf: Make embedded Files and Changes durable and responsive: capture complete branch comparisons, batch file-frontier and multi-repository Git reads behind one sandbox lease, preserve live stream responsiveness during reconciliation, harden portable sandbox reads, and polish the workbench's file tree, resizable panes, machine/terminal states, and embedded composer geometry.

## 0.39.5

### Patch Changes

- 200586a: Allow workspace administrators to disable structured agent human-input requests while preserving ordinary user messages.

## 0.39.4

### Patch Changes

- 70ced80: Add an offline-safe Connected Machine enrollment removal lifecycle with credential revocation, durable audit history, guarded route and lease handling, SDK/MCP support, and accessible active-list reconciliation.

## 0.39.3

### Patch Changes

- 5d8bb99: Allow scheduled tasks to target and durably wake one authorized existing session without creating a helper session or replacing its goal.
- 34c5cdb: Retain validated computer screenshots as authenticated, integrity-checked session artifacts with bounded event/history receipts, SDK range assembly, and React rendering while preserving historical inline-image compatibility.

  Fence screenshot cleanup and quota accounting across parent deletion, duplicate settlement, expiry, compensation, and garbage-collection races so provider objects are deleted only after durable lifecycle ownership and quota is released exactly once.

## 0.39.2

### Patch Changes

- 7dbd057: Preserve provider-defined repository clone paths and centralize provider-declared `.git` alias semantics across resource identity and credential routing.
- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- 23de73b: Add explicitly permissioned, audited plaintext reads for encrypted workspace variable-set values across REST, SDK, React, MCP, and UI surfaces.

## 0.39.1

### Patch Changes

- ce823ce: Replace first-party MCP mutation entity echoes with strict, versioned compact
  receipts; add bounded scheduled-task list/detail projections and preserve worker
  session references across receipt and legacy timeline results.

## 0.39.0

### Minor Changes

- 6eb0b23: Add production resumable composer transcription with exact-subject durable
  manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
  recording-wide provider pin, persisted retryable segment results, deterministic
  assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
  of transcript metadata after every provider object is confirmed deleted. Legacy
  one-shot voice input remains compatible.

## 0.38.3

### Patch Changes

- c0f8e40: Prevent model-visible GitHub installation credential exposure and duplicate brokered MCP side effects after ambiguous 401 responses.

## 0.38.2

### Patch Changes

- 4502474: Add workspace-default and explicitly personal ownership for first-party social connections, preserve causal personal authority for agent work, and retain actionable structured gateway errors.

## 0.38.1

### Patch Changes

- c9d8b69: Make Connected Machine project paths portable and diagnosable: session responses now expose `workingDir`, and the native agent consistently supports the service user's `~` path across exec, filesystem, git, and terminal operations while reporting missing working directories accurately.

## 0.38.0

### Minor Changes

- bef5920: Add subject-scoped Workspace State preference and document-authority inventory
  metadata plus a canonical, explicitly sanitized export API and SDK method.

### Patch Changes

- b6e39fc: Polish session chrome and apply_patch rendering; clarify realtime voice-end handoff.

  SessionChrome gets denser selected-chip UX and Codex function-tool apply_patch shapes render in the specialized diff UI. Solo goal_continuation machine-input rows are suppressed in favor of the GoalRow landmark. The realtime transcript-tail instruction now keeps in-flight work going after voice ends.

## 0.37.0

### Minor Changes

- fd13ba9: Add one immutable organization, workspace, or personal document destination contract for connector configuration, and make Google Drive persist and consume that authority independently from optional collections.

## 0.36.1

### Patch Changes

- abe0de6: Persist timesliced composer voice recordings in browser storage with reload-safe document ownership, opener/duplicate-tab fencing, oldest-first recovery, byte-ceiling enforcement, and durable transcript-before-draft handoff. Interrupted audio retries reuse the same recording, uncertain saved transcripts require explicit insertion instead of automatic retranscription or duplicate append, and transient handed-off cleanup failures are retried and garbage-collected owner-safely.

## 0.36.0

### Minor Changes

- 00f7d3b: Add durable, tenant-isolated onboarding proposals that atomically create inactive instruction-policy drafts with typed replay, stale-baseline, conflict, and audit contracts, plus a bounded Workspace State admin composer.

## 0.35.0

### Minor Changes

- b121e7c: Add durable Google Drive pause, resume, disconnect, reconnect, revoked-token,
  removed-app, and permission re-consent lifecycle handling with version-fenced
  state transitions, generation-bound disconnect idempotency, stale-replay
  protection, and secret-safe provider error classification.

## 0.34.0

### Minor Changes

- b83af7a: Add replay-safe workspace instruction policy administration across the API,
  contracts, database, and SDK, including immutable operation receipts that reject
  changed requests reusing the same operation identifier.

## 0.33.0

### Minor Changes

- d1f0c3d: Add immutable organization, workspace, and initiating-user personal authority to Documents and chunks; filter retrieval by exact account and authority before ranking; require exact account-admin authority for organization publication; and preserve authority through a drained API, worker, and indexing-workflow cutover.
- 1d0f2ae: Expose one effective document retrieval contract across REST, SDK, and MCP that binds the immutable initiating subject outside caller input, filters organization/workspace/personal authority before ranking, and preserves source plus authorization provenance in typed results.
- 3e4842d: Add subject-authorized accepted-attempt governance inspection to Workspace State,
  including immutable policy/preference snapshot metadata and deterministic current
  drift classification without exposing prompt or personal preference content.

## 0.32.0

### Minor Changes

- 13b961e: Add an atomic terminal session-subtree cancellation command that drains queued work, fences concurrent prompts and child creation, interrupts live attempts, durably reports cancelled children to surviving parents, and exposes the operation through the API/core/SDK control surface.
- e03397d: Freeze workspace instruction policies and structured preference descriptors at
  the accepted logical-turn boundary, add immutable per-session policy roles, and
  compose the resulting exact-attempt governance into agent and compaction prompts.
- 3baaebd: Add configurable Slack emoji-reaction summons with a least-privilege manifest, bounded thread context, and workspace-admin settings.

### Patch Changes

- ecc4288: Add a deterministic, fail-closed Google Drive OAuth scope-capability contract and
  require recursive selected-source read access before callback persistence or
  source browsing.
- 4f15920: Add an authorized, server-mediated connected-Codex GPT-Live V3 WebRTC SDP path with credential-safe negotiation and browser lifecycle helpers.

## 0.31.2

### Patch Changes

- e62495f: Allow session creators to explicitly opt out of a workspace default rig, and make live release acceptance prove its fixture command completed before waiting for a workspace capture.
- b4982fa: Expose GPT-5.6 Max reasoning end to end for managed and connected Codex models.

## 0.31.1

### Patch Changes

- 9c4d73d: Add curated OpenGeni-credit and workspace-key Vercel AI Gateway model paths for
  DeepSeek V4 Flash and Kimi K3, including exact provider routing, cache-aware
  pricing and metering, Responses tool continuity, provider-blind catalog UX, and
  stable remote-compaction cache prefixes.

## 0.31.0

### Minor Changes

- 8b3e46f: Allow a digest-pinned capability-pack sandbox image to bind an immutable Modal image ID. OpenGeni now preserves the logical OCI digest on the lease, starts the provider-native image through `ModalImageSelector.fromId`, records the actual ID in the Modal session envelope, clears lower-precedence IDs when a rig overrides the image, and keeps catalog image metadata aligned with the runtime manifest.

## 0.30.0

### Minor Changes

- 2321119: Add the provider-neutral scoped knowledge provenance, lifecycle, ACL, and normalized claim foundation for organization, workspace, and initiating-user personal evidence.

## 0.29.0

### Minor Changes

- dd71248: Make workspace-owned MCP OAuth connections the default, add explicit personal
  connection ownership, and preserve exact delegated personal authority across
  turns, child sessions, goals, schedules, retries, and recovery with safe
  tool-level degradation when a personal connection is unavailable.

## 0.28.1

### Patch Changes

- 659b3ff: Harden Slack-triggered session delivery, identity linking, provider backoff, explicit connection-tool selection, and replay-safe bounded progress/final delivery.

## 0.28.0

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

- d4d8960: Keep Personal Slack UI, reconnect, and broker credential selection on one deterministic legacy-duplicate ordering.

## 0.27.0

### Minor Changes

- 1ec9912: Add generic, versioned workspace artifacts with content-addressed HTML storage, a static HTML/CSS renderer, rollback history, and first-party agent publishing tools. JavaScript and active or navigation-capable markup are removed from the initial renderer until executable artifacts have a stronger isolation boundary.

### Patch Changes

- dcc35c5: Add authenticated Slack mentions, commands, message shortcuts, atomically private bot-DM sessions, durable thread continuation, and globally bounded idempotent progress delivery.

## 0.26.1

### Patch Changes

- c52acc0: Ship Fast latency mode with turn-column inheritance, Codex ChatGPT honor-skip for response service_tier, and model picker UX polish.

## 0.26.0

### Minor Changes

- f413e6c: Add real Workspace Insights: durable `model_call_facts` after authoritative
  `agent.model.usage`, a `workspace:admin` insights API over usage_events + facts +
  live joins, SDK client, and a web console that drops mock rollups for honest
  UTC credit/token/cache/warm/caps reporting.

## 0.25.0

### Minor Changes

- 42428a2: Add per-session Codex remote compaction v2 (`remote_v2` / `portable`), with UI landmarks, Codex-only model locking, and opaque token accounting aligned to Codex CLI.

### Patch Changes

- 0199108: Harden the workspace Slack bot with one fail-closed scope policy, deterministic legacy connection selection, and durable replay-safe message deletion operation identities.
- b2e975f: Advance the merged knowledge release train to fresh publication identities without changing runtime behavior. This corrective source is derived from current main and does not reuse generated release output.
- 9f3b931: Add the canonical personal Slack hosted-MCP resource constant and a dedicated account-linking experience that keeps subject-owned OAuth status, reconnect, and disconnect controls separate from workspace bot installation.

## Unreleased

### Minor Changes

- Add native voice-input contracts: `ClientConfig.voiceInput`, `WorkspaceVoiceInputSettings`,
  `TranscribeAudioResponse`, MIME/duration/size ceilings, and
  `resolveWorkspaceVoiceInputEnabled` (maps legacy `transcription.enabled` for one release).
  Expand transcription error codes with `unavailable` / `too_large` / `invalid_audio`.

## 0.24.3

### Patch Changes

- 710b081: Keep sessions usable when a previously selected MCP capability is disconnected or removed. Unavailable historical refs remain visible in effective policy but are omitted from executable tools, and the agent receives a bounded turn-level warning not to claim access to the missing source.

## 0.24.2

### Patch Changes

- 96eb64b: Advance the reviewed knowledge release package graph to fresh publishable identities after the previous version projection was invalidated. This changes release metadata only and does not alter runtime behavior.

## 0.24.1

### Patch Changes

- ddff8db: Add the read-only Workspace State inventory with bounded, authorization-scoped
  Documents aggregates and a deterministic metadata-only Memory projection. The
  projection explicitly labels legacy `knowledge_memories` preference-kind counts
  as non-authoritative observations while preserving the structured preference
  registry as the sole active preference authority.

## 0.24.0

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

## 0.23.1

### Patch Changes

- ad0bdc3: Surface managed-credit admission rejections with actionable composer recovery guidance while preserving drafts and attachments, and canonicalize default attachment mounts across established-session draft admission and replay.

## 0.23.0

### Minor Changes

- 33dc88f: Restore managed GitHub App installation with OAuth-first existing-installation
  discovery, exact owner revalidation, and hosted/operator setup-mode separation.

## 0.22.1

### Patch Changes

- 1c4018e: Replace one-turn tool overrides with one durable session tool policy, expose
  OpenGeni-native tools in the same selection, default available tools on, and
  render delivered machine inputs as compact typed timeline updates instead of
  raw protocol JSON.

## 0.22.0

### Minor Changes

- 29ad09b: Persist typed machine inputs into canonical model history at turn claim, expose
  authoritative pending-input queue projections and lifecycle events, render
  delivered batches in the timeline, and preserve append-only prompt-cache
  prefixes across tools, later turns, recovery, and explicit compaction.

### Patch Changes

- dfc3235: Separate first-party MCP authorization from exact per-session tool visibility, add fail-closed registration policy, and isolate file download URLs on the files MCP surface.

## 0.21.0

### Minor Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.

## 0.20.2

### Patch Changes

- 110bb77: Enforce exact-subject ownership for personal OAuth capabilities and add secure direct OAuth installation for the separate workspace OpenGeni Slack bot.

## 0.20.1

### Patch Changes

- ffd246c: Keep workspace-capture Git status, diffs, and untracked files below provider retained-output limits, and publish an explicit degraded revision instead of an authoritative empty diff when repository reads fail.

## 0.20.0

### Minor Changes

- 06a5801: Add the backend workspace instruction-policy revision, activation, rollback, audit, API, and SDK control surface.
- 5511c24: Add a secure workspace-shared OpenGeni Slack bot connection with schema-backed verified-install eligibility, immutable team/bot identity across reinstall, idempotent post-operation convergence, exact scope validation, first-party channel/history/user/post tools, explicit scheduled-task routing and rebinding, and install/reinstall/recovery UI and documentation.

## 0.19.4

### Patch Changes

- 9a8f793: Add fail-closed GitHub personal/organization owner authority proofs, audited
  workspace installation bindings with explicit repository allowlists, and
  truthful disabled/unbound/bound lifecycle contracts.
- c135339: Persist safe new-session defaults after successful creates while preserving explicit tool-policy semantics and revalidating stale workspace resources before reuse.

## 0.19.3

### Patch Changes

- a0f2442: Return typed correlation-safe API failures, discard bounded non-JSON gateway bodies in the SDK, preserve retryability and ambiguous mutation outcomes, and keep composer drafts stable across transient failures and live policy rerenders.

## 0.19.2

### Patch Changes

- 85cb323: Restore provider-native web search for workspace-default Codex sessions while preserving explicit
  tool narrowing, child policy ceilings, version-fenced policy adoption, and structured URL citations.

## 0.19.1

### Patch Changes

- de20184: Redact known runtime credentials and recognized authorization, cookie, signed
  URL, assignment, and provider-token shapes before model calls, durable session
  history, events, logs, and telemetry. Disable credential-bearing shell xtrace
  and raw Agents SDK model, tool, and MCP transport payload logging.

## 0.19.0

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

## 0.18.1

### Patch Changes

- 744a93d: Add default-off, bounded adaptive Codex fleet decision telemetry with strict deterministic replay, cache-aware and work-conserving policy simulation, secret-safe event/UI observability, and independent future policy gates.

## 0.18.0

### Minor Changes

- 0d60720: Add capability-first session tool policies with omission-as-discovery defaults,
  explicit per-turn narrowing and child inheritance, secret-safe effective-policy
  projections, stable lazy `tool_search` catalogs, and matching API, SDK, React,
  worker, embedding, and audit contracts.

  Harden credential-bearing MCP and OAuth traffic with destination-bound
  credentials, single-resolution DNS-pinned transport, bounded catalogs, schemas,
  results, request and response bodies, and independently validated manual
  redirects. Extend renewable, session-bound Toolspace access to connected
  machines while dynamically fencing every call to the session's active attempt.

### Patch Changes

- bdd531c: Make Codex subscription response timeouts recoverable without blindly replaying partially observed model work. The transport now assigns a durable request identity, records attempt-fenced start/headers/first-byte/terminal metadata, enforces explicit headers, stream-idle, and whole-request deadlines, and retries once only before any response is observed. Exhausted or partial-stream timeouts retain a typed failure class and return the durable session to its existing retryable recovery path instead of hard-failing it with the opaque OpenAI SDK `Request timed out.` error. External cancellation remains authoritative, the SDK retry budget remains disabled, and Codex subscription turns keep their existing zero-credit billing path.

## 0.17.3

### Patch Changes

- 524599e: Normalize model, provider, upstream deployment, credential source, billing,
  capability, health, and pricing identity; expose a secret-safe authenticated
  workspace catalog with separate fail-closed credential readiness for federated
  providers; and persist the accepted model/reasoning execution policy on new
  logical turns.

## 0.17.2

### Patch Changes

- 4966649: Add bounded authoritative terminal-result projections to session event monitoring APIs and SDK types.

## 0.17.1

### Patch Changes

- ff23da5: Keep oversized event previews bounded while optionally linking them to integrity-addressed workspace-file evidence, and expose access-controlled metadata plus capped provider-native range retrieval through the API and SDK.

## 0.17.0

### Minor Changes

- d1dee7a: Let embedding hosts read and update an existing session MCP server's approval
  policy through the public API, SDK, and React session hook. Each claimed
  attempt freezes its policy under the session lock, so updates affect the next
  attempt without reinterpreting work already running; model MCP and
  Toolspace/Code Mode consume the same exact snapshot. Toolspace tokens and
  side-effect receipts bind every proxied call to the exact active attempt, so
  Pause, Steer, recovery, and late outputs preserve one authoritative owner.

## 0.16.0

### Minor Changes

- b9cec61: Let embedding hosts return exact HTTPS smart-Git broker transports for repository
  bindings whose provider credentials cannot be contained to the selected
  repositories. Keep broker bearers off manifests, Git configuration, repository
  metadata, and provider CLIs; renew bearers independently without changing the
  admitted route set.

## 0.15.0

### Minor Changes

- 9f84cc9: Add durable host-provided per-turn instructions, headless structured-input hooks, host-local queue
  focus, and reusable approval and human-input surfaces for embedded session consumers.

## 0.14.0

### Minor Changes

- 136227e: Add an immutable, versioned curated skill library with explicit workspace selection and inspectable provenance, and preserve WCAG AA contrast for dark-theme primary actions.
- 3aee519: Add a workspace-accepted, provider-agnostic transcription policy and host-adapter contract, plus an accessible composer microphone that keeps partials ephemeral and appends non-empty accepted finals to the editable draft exactly once. Policies explicitly accept automatic language detection and speaker diarization, events can carry strict neutral result metadata, pending starts and cleanup are abortable/bounded, and adapter failures stay behind controlled UI copy with redacted non-UI diagnostics.

## 0.13.0

### Minor Changes

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

- 32011f1: Add an optional durable host event and usage export for embedded deployments: source-transactional bounded snapshots, immutable turn attribution and session-root lineage, named at-least-once checkpoints, multi-replica leases, replay and retention controls, explicit poison-record disposition, an isolated exporter database role, and a worker delivery pump. Standalone deployments keep capture disabled until a host registers a sink.
- 3983021: Bind every host Git credential request to immutable session, root-session, turn,
  attempt, execution-generation, and initiator authority. The worker fails closed
  when a host broker is configured without that authority and preserves the same
  authority across identity resolution, lazy provisioning, and proactive renewal.
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
- a11a7fc: Support mixed GitHub, GitLab, and Azure DevOps repositories—including multiple
  accounts or installations for one provider—in a single session through bounded,
  host-opaque credential bindings and optional read/write access intent.

  Validate binding/provider/host echoes before token injection, isolate tokens in
  hashed binding files, select Git credentials by remote path, fail provider CLIs
  closed on ambiguous bindings, and renew each binding independently while keeping
  legacy one-binding-per-provider request and file aliases compatible.

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

- 44ff327: Fence queue, composer, and control hook state to the active workspace and session so target switches cannot expose or accept stale private state.

## 0.12.0

### Minor Changes

- dbb6232: Support linking an existing GitHub App installation to multiple OpenGeni workspaces with independent repository allowlists.

  - Discover installations through GitHub App user OAuth, require repository-level administrator permission, and configure the OAuth callback in generated App manifests.
  - Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
  - Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
  - Add SDK and web controls to link, rescope, and unlink a workspace without uninstalling the GitHub App or affecting another workspace.

### Patch Changes

- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.

## 0.11.0

### Minor Changes

- ec0697a: Ship the production-hardened captured workspace workbench, physically verified Steer/Pause cancellation across cloud, local, and self-hosted model tools, pre-model preparation, sandbox provisioning, and lifecycle/setup commands, durable quiescence admission fencing, cancellation-aware SDK reads and turn cleanup, single-round-trip pruned workspace indexing, truthful shutdown states, a responsive and accessible review dock, Unicode coverage, and package-safe CSS/SSR integration.

## 0.10.0

### Minor Changes

- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- e4d3569: Add per-member workspace session pins with stable pinned-first listing, subject-scoped FORCE-RLS persistence, snapshot-backed activity pagination, optimistic OCC-safe pin/unpin updates, and accessible responsive web controls.

### Patch Changes

- 04d7595: Discover repositories at any workspace nesting depth, including linked worktrees whose `.git` marker is a file, while pruning dependency/build residue and enforcing timeout and repository-count bounds. An incomplete discovery now persists an epoch-fenced degraded capture revision, announces its typed reason, and makes clients prefer live workspace data instead of presenting a misleading empty capture.
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
- 4a25bfc: Add the `machine.link.lost`, `machine.link.restored`, and `machine.runner.restarted` session-event types for Connected Machine control-link observability (the failure-visibility doctrine's link plane). These are session-scoped, announce-only diagnostics fanned out only to the sessions that had an active op running on the machine when its control link changed — never to idle or historical sessions. A clean going-offline emits `machine.link.lost` (plus `machine.runner.restarted` when the reason is a self-update restart), and a reconnect Hello that actually cleared a going-offline marker emits `machine.link.restored`. All three project to the timeline's quiet tier (no rendered item) and are mirrored in the SDK event-type list. Adds the `sessionsWithActiveOpOnEnrollment` DB helper (one indexed lookup, no per-op tracking table) that resolves the fan-out target set.
- 3148404: Add the `machine.op.failed` and `machine.op.recovered` session-event types for Connected Machine op-outcome observability (the failure-visibility doctrine's out-of-band plane). These are session-scoped, announce-only diagnostics: `machine.op.failed` fires for infrastructure fault classes only (offline, draining-exhausted, payload-too-large, reconnecting-timeout, OS/stream/protocol) — never for a semantic miss the model asked about (a missing path, a consent gate, a nonzero exit); `machine.op.recovered` is the quiet healed-fault leading indicator. Both project to the timeline's quiet tier (no rendered item), mirrored in the SDK event-type list.
- 5942493: Repair missing file-upload usage records on idempotent finalize retries, reclaim abandoned direct-upload objects through a fenced Temporal cleanup schedule, and preserve accessible provider-backed image previews across reloads.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

- 9d4283d: Per-workspace model/provider hard-block policy. A new `workspace_model_policies` table (NULL = unrestricted) lets a workspace strictly allowlist which providers and/or exact model ids may serve its turns. Enforced twice: a 422 at every API model choke point (user message, queued-turn update, scheduled task, and session creation — where the EFFECTIVE model, `payload.model ?? deployment default`, is vetted, since an omitted model stamps the deployment default onto the session), and authoritatively in the worker immediately after turn model resolution, where a blocked provider/model throws `WorkspaceModelPolicyBlockedError` before any model call — including the legacy null-resolution fallback to the built-in OpenAI/Azure client, which is attributed to the built-in's own provider id so blocking the built-in also closes that path. Goal continuations that inherit a blocked model recover to the session's allowed default or pause the goal visibly with a truthful rationale. New `GET/PUT /v1/workspaces/:workspaceId/model-policy` routes (read / admin) manage the policy. Workspaces without a policy row behave exactly as before. This exists so a codex-subscription workspace can be fail-closed to codex: a turn may wait or fail loud, but can never fall through to a paid provider.

## 0.9.0

### Minor Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

## 0.8.0

### Minor Changes

- 7bfe593: Surface the desktop-capture-blocked reason as server-visible enrollment state.

  A machine can have a display it cannot CAPTURE (macOS Screen Recording / TCC not granted). The agent's connect Hello already withholds the desktop cell in that case; this persists a human, actionable reason alongside it so the Machines dashboard / VM picker can render "display: capture not granted" instead of a bare `display_unavailable`.

  - **Contracts / SDK**: `MachineView` (and `EnrollmentSummary`) gain an additive, nullable `desktopUnavailableReason`. Non-null only when a display exists but capture is blocked; `null` == capture permitted OR genuinely headless. Absent/`null` ⇒ byte-identical to today's shape for existing consumers.
  - **DB**: new nullable `enrollments.desktop_unavailable_reason` column (no backfill — `NULL` preserves the existing "capture-permitted or headless" semantics). The display-cursor writer now persists `has_display` AND the reason together, change-guarded on either field, and self-heals to `null` on the next Hello once the grant is restored.

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
