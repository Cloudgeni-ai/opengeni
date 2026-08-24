# @opengeni/core

## 2.1.0

### Minor Changes

- 4be2055: `requireSessionAuthorization` denies `session.approval.write` to every agent attempt on every surface: tool approvals stay human-only, while structured human input (`session.human_input.write`) remains answerable by a live attempt. The React queue chrome and timeline label the new child lifecycle notice kinds (`child_requires_action`, `child_requires_action_resolved`, `child_paused`, `child_waiting_capacity`, `child_progress`) instead of dropping them.
- de3f376: Bound and shape the durable text an agent authors on a user's behalf. The budget
  follows the destination, on every agent surface that reaches it. A mandatory
  workspace rule is composed verbatim into the prompt of every session it applies
  to, so `remember`, `instruction_policy_propose`, and `task_note_promote_instruction_policy`
  are all capped at 600 characters; the preference destination is capped at 1,200
  across its three surfaces, because only its short descriptor is composed and the
  content is retrieved on demand. Task-note promotion is checked in the database
  layer, where the content is the note rather than a request field, and is rejected
  rather than truncated before any evidence, claim, or proposal row is written.
  `company_profile_propose`, the largest always-on surface, is capped for agents at
  400 characters per scalar, 200 per list entry, and 4,096 UTF-8 bytes total. The
  Knowledge lane keeps its 4,000-character retrieval-evidence ceiling, and every
  human editor limit is unchanged so nothing a person already typed becomes
  invalid. Tool descriptions now state the prompt cost and the authoring shape, and
  the `remember` confirmation card names the character count and destination so a
  human can judge the cost before saving. Existing stored revisions are never
  rewritten.
- 0b3b8df: Add an explicit organization-owner-confirmed agent path for company-profile and
  strategic-goal administration. The two-step MCP flow stages an immutable inactive
  full-profile proposal, binds activation to the initiating human's exact
  structured confirmation, revalidates current organization authority and profile
  CAS in PostgreSQL under the canonical workspace/session lock order, and remains
  independent of workspace learning mode. The manual `account:admin` route keeps
  its admission contract, and the earlier proposal-only `company_profile_propose`
  tool (`durable_learning` provenance) is retired in favor of this path.
- bbd19e0: Add an owner/admin organization setting that enables Only-me chats in shared
  workspaces for organizations holding the session-tenancy readiness receipt
  (`GET`/`PATCH /v1/organizations/:organizationId/private-session-settings`,
  `@opengeni/sdk/organization-private-session-settings`, and the organization
  settings page). Already activated organizations are backfilled enabled.

### Patch Changes

- 72f8fc6: Add GitHub App repository-binding resolution for bare `https://github.com/<owner>/<repo>` resources: parse coordinates, list the workspace's auditable installation allowlists under RLS, and stamp `githubInstallationId`/`githubRepositoryId` only when exactly one bound allowlist holds the repository id reported through an injected provider lookup. Unbound, non-allowlisted, ambiguous, and unavailable outcomes leave the resource bare and are reported so callers can warn without failing.
- 45bffc3: Return empty personal-resource authority pages before session-tenancy activation while keeping mutations and runtime use activation-gated. Allow managed humans to read their personal Rig catalog without granting Rig administration.
- Updated dependencies [4be2055]
- Updated dependencies [4be2055]
- Updated dependencies [4be2055]
- Updated dependencies [1fc235b]
- Updated dependencies [de3f376]
- Updated dependencies [c5c7e5a]
- Updated dependencies [a9cd9e7]
- Updated dependencies [e6ffdc7]
- Updated dependencies [e6ffdc7]
- Updated dependencies [e6ffdc7]
- Updated dependencies [0b3b8df]
- Updated dependencies [5e9795c]
- Updated dependencies [bbd19e0]
- Updated dependencies [3398c2f]
- Updated dependencies [acd38d1]
- Updated dependencies [e91d89e]
- Updated dependencies [8e2361b]
- Updated dependencies [5d664d8]
- Updated dependencies [45bffc3]
  - @opengeni/config@0.19.0
  - @opengeni/contracts@2.2.0
  - @opengeni/db@3.1.0
  - @opengeni/runtime@1.3.0
  - @opengeni/documents@0.6.9
  - @opengeni/storage@0.2.105
  - @opengeni/events@0.3.123
  - @opengeni/observability@0.8.3

## 2.0.1

### Patch Changes

- b2dd2f7: Bound the remaining request-scoped workspace control-row mutations and make the lock budget a first-class setting: `updateWorkspaceSettings`, `deleteSessionTreeIfQuiescent`, queue move/edit/delete, composer draft save, and the MCP agent message accept an optional `controlLockTimeoutMs` that API routes and core commands pass (lifecycle callers keep the unbounded wait), so a busy workspace yields the same typed retryable 503 `WORKSPACE_CONTROL_BUSY`. `OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS` is now parsed and validated once at boot by `@opengeni/config` (`workspaceControlLockTimeoutMs`, positive integer ms, default 20000), installed into `@opengeni/db` by `createApp` through `configureWorkspaceControlRequestLockTimeoutMs`, and rendered by the deployment runtime-env generator as an optional passthrough.
- Updated dependencies [b2dd2f7]
- Updated dependencies [ab81e47]
  - @opengeni/db@3.0.1
  - @opengeni/config@0.18.1
  - @opengeni/contracts@2.1.1
  - @opengeni/documents@0.6.8
  - @opengeni/events@0.3.122
  - @opengeni/runtime@1.2.1
  - @opengeni/storage@0.2.104
  - @opengeni/observability@0.8.2

## 2.0.0

### Major Changes

- fba437f: Resolve a managed human's personal-workspace authority in the connection grant layer on top of the session-surface prerequisite's canonical workspace-authority resolver.

  A managed human's personal workspace deliberately has no `workspace_memberships` row (migration 0219 raises on one); the owner's access is the `organization_memberships.personal_workspace_id` pointer. `getWorkspaceGrant` is a bare membership join, so every seam using it as a "does this subject still hold workspace authority here" predicate denied the one human who always belongs. In their own personal workspace, `freezePersonalConnectionDelegations` returned no delegations at all and Google Drive publication resolved no target. Those seams now use the pointer-aware resolver.

  The landed session-surface prerequisite renamed the public database oracle to `namedSubjectHasLiveWorkspaceAuthority`, extracted the canonical in-scope authority rule, and declared the one required `@opengeni/db` major. This change consumes that landed API rather than declaring the same database break again. The named-subject wrapper continues to restore the caller's prior `opengeni.subject_id`; calling it on a transaction handle must never redefine who the rest of that transaction runs as.

  **BREAKING (`@opengeni/core`):** `PersonalConnectionDelegationSource`'s `subject` variant now requires `accountId` — the personal-workspace pointer lives on an organization membership, so the account is part of the question. `personalConnectionDelegationSourceForGrant` supplies it.

  **BREAKING behaviour change (`@opengeni/core`):** a delegated/bearer grant (`metadata.delegated === true`) now yields no personal-connection delegations **in any workspace**, including ordinary shared workspaces where it previously worked through a real membership row. A delegated payload's `subjectId` and `workspaceId` are signed token fields with no database row behind them, so treating that subject as authority to borrow a user's private provider credentials is not a boundary worth holding — in a shared workspace any more than a personal one. Embedding hosts minting user-facing delegated tokens lose personal X/Reddit/Atlassian/Google Drive delegation for those sessions; workspace-owned connections are unaffected. See `docs/embedding.md`.

### Minor Changes

- 3e1ad07: Add turn-atomic personal Variable Set and Rig attachments for create, Send, and
  Steer, including logical-turn once receipts, recovery-safe snapshots, warning
  acknowledgement, and SDK contracts.
- dc8c73f: Add professional organization administration with canonical rename and a
  Personal-safe shared-workspace access inventory, explicit Organization /
  Workspace / Only-me scope at Rig and Variable Set creation, and activation-gated
  atomic private visibility when creating sessions.
- 650d6f9: Add an optional OpenSandbox Kubernetes sandbox backend with exact ID-addressed
  resume, renewable provider TTL, portable workspace archives, private server
  proxy support, pinned upstream deployment artifacts, and Azure sandbox-pool
  capacity isolation. Existing backend defaults, including Modal, remain
  unchanged unless `opensandbox` is selected explicitly.
- f7497fd: Add a disabled-by-default, user-owned personal GitHub OAuth lifecycle with
  separate deployment credentials, signed PKCE state, encrypted token custody,
  verified GitHub identity, typed SDK routes, reconnect fencing, and idempotent
  disconnect.
- ba0be3d: Add activation-gated owner management for personal-resource session and standing grants, with kind-derived actions and permissions, exact session authority epochs, route-workspace-fenced revocation, RFC3339 lifecycle timestamps, bounded keyset pages, complete credential-free delegation receipts, FORCE-RLS-safe expiry and invalid-action settlement, and SDK methods that intentionally exclude standalone `once` and custom expiry.
- c7cafb1: Activate owner-only session visibility changes and same-workspace private forks
  through the public API and SDK after per-organization tenancy activation.

  Expose activation-gated session tenancy metadata, typed quiescence and
  idempotency conflicts, exact durable event fanout, and explicit retry fences.

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
- 3825727: Normalize legacy or malformed workspace-membership permissions before member listing and authorization, without restoring any obsolete authority.
- 9530e19: Let a managed human use the session surface inside their own personal workspace, without widening the owner-only exception to anyone else.

  A managed human's personal workspace deliberately has no `workspace_memberships` row (migration 0219 raises on one) — their access is the `organization_memberships.personal_workspace_id` pointer. Three session seams fenced on a bare membership probe and therefore denied the one human who always belongs: `GET /v1/workspaces/:id/sessions` returned **403** so the workspace looked empty, `PUT …/sessions/:id/pin` returned **403**, and `PUT …/new-session-draft` returned **403**.

  `subjectHasLiveWorkspaceAuthorityInScope` (`packages/db/src/workspace-authority.ts`) is now the single implementation of the corrected rule. It refuses to set `opengeni.subject_id`, which makes the arbitrary-subject oracle shape unrepresentable at these seams and keeps the authority read inside the caller's transaction and advisory fence.

  **The authorization is not that resolver.** Neither it nor the exported `namedSubjectHasLiveWorkspaceAuthority` establishes who the caller is — both answer "does subject X hold authority here". The one thing that authorizes the exception is `AccessGrantAuthorization.canonicalManagedHumanSession`, stamped only inside the branch of `resolveAccessContext` that verified a Better Auth cookie. Inspecting the grant would not do: a delegated bearer chooses its own `principalKind`, `metadata.delegated`, `serviceInitiator`, and `subjectId`. Bearer/delegated principals, API keys, service initiators, same-organization co-members, organization admins and owners, and account administrators all fail closed, as does any authentication path added later.

  The public helper is renamed `subjectHasLiveWorkspaceAuthority` → `namedSubjectHasLiveWorkspaceAuthority`, and it now restores `opengeni.subject_id` after probing (`withRlsContext` restores account/workspace but not subject, so the probed subject leaked out of the savepoint). This changeset declares the required `@opengeni/db` **major** at the first PR that lands the breaking rename; the companion connection-authority change retains its own `@opengeni/core` major for its separate public break.

- d8ba09d: Make private children inherit their parent's visibility through an exact live-attempt capability, expose effective tool policy in session monitoring, keep late child results from restarting settled parents, and preserve private-owner authority on internal-update turns.
- 48b9f09: Allow organization administrators to invite an email before registration, bind
  the invitation only after exact Better Auth email verification, and apply its
  initial shared-workspace access when the invited user joins without creating a
  redundant fallback organization.
- 3b6b30e: Make the workspace control prefix fair and bounded: `lockWorkspaceInferenceControl` takes a FIFO transaction advisory lock before the row lock so Pause/Resume cannot be starved by continuous shared claim/settlement/append traffic, Send/Steer/queued Steer/realtime sync hold the prefix shared while the target branch is active and escalate through a savepoint only for a paused branch, and request-scoped API mutations fail with a typed retryable `WorkspaceControlBusyError` (HTTP 503) instead of parking a pooled connection and snapshot when the prefix stays busy.
- Updated dependencies [7d15265]
- Updated dependencies [3e1ad07]
- Updated dependencies [e57ce11]
- Updated dependencies [438e476]
- Updated dependencies [3825727]
- Updated dependencies [1cd0eb0]
- Updated dependencies [ebb3669]
- Updated dependencies [dc8c73f]
- Updated dependencies [3999dd5]
- Updated dependencies [9b4d5d5]
- Updated dependencies [492fb71]
- Updated dependencies [66593eb]
- Updated dependencies [fbc760e]
- Updated dependencies [650d6f9]
- Updated dependencies [cc2fa1b]
- Updated dependencies [e9ff652]
- Updated dependencies [3141b5d]
- Updated dependencies [650d6f9]
- Updated dependencies [fe54954]
- Updated dependencies [8cb165d]
- Updated dependencies [f7497fd]
- Updated dependencies [ff011e6]
- Updated dependencies [ba0be3d]
- Updated dependencies [9530e19]
- Updated dependencies [d8ba09d]
- Updated dependencies [f51adf8]
- Updated dependencies [009b947]
- Updated dependencies [72736ef]
- Updated dependencies [5b509be]
- Updated dependencies [6909443]
- Updated dependencies [c7cafb1]
- Updated dependencies [5a651c8]
- Updated dependencies [29a44c2]
- Updated dependencies [c83c590]
- Updated dependencies [48b9f09]
- Updated dependencies [3b6b30e]
  - @opengeni/runtime@1.2.0
  - @opengeni/contracts@2.1.0
  - @opengeni/db@3.0.0
  - @opengeni/config@0.18.0
  - @opengeni/codex@0.2.18
  - @opengeni/documents@0.6.7
  - @opengeni/events@0.3.121
  - @opengeni/observability@0.8.1
  - @opengeni/storage@0.2.103

## 1.5.1

### Patch Changes

- 4f9b2a9: Let a live agent read, message, and control peer workspace sessions instead of denying siblings and other roots.
- Updated dependencies [81d2da0]
- Updated dependencies [3e60b2a]
- Updated dependencies [f275cc7]
- Updated dependencies [b230459]
- Updated dependencies [8fa9820]
- Updated dependencies [323db7f]
- Updated dependencies [4f9b2a9]
- Updated dependencies [2a70d94]
- Updated dependencies [3d451bf]
- Updated dependencies [18474f1]
- Updated dependencies [c19fad8]
- Updated dependencies [093c17f]
  - @opengeni/config@0.17.1
  - @opengeni/db@2.1.0
  - @opengeni/storage@0.2.102
  - @opengeni/documents@0.6.6
  - @opengeni/runtime@1.1.3
  - @opengeni/events@0.3.120

## 1.5.0

### Minor Changes

- 1c78ed0: Separate new-session and established-session composer policy authority. Exact draft submission now atomically freezes queued-turn text, resources, model, reasoning, and latency, then rotates the server draft; queue Edit restores that exact snapshot and stale revisions surface as conflicts instead of silent rebases.

### Patch Changes

- a7df809: Harden the four `remember` instruction-policy edges.

  A moved policy head is now one typed, actionable `RememberError` (`baseline_stale`) on both the propose and confirm sides instead of an untyped error or a raw SQLSTATE 40001. The activation baseline no longer contributes to operation identity, so an ordinary turn-recovery replay of the same `operationId` stays idempotent across a head change; staleness is still enforced by the compare-and-set and by the activation function. A governed write that fails now archives the evidence task note it created instead of stranding it.

  A confirmation stranded by a head that moved after the human already answered now rebaselines onto the current head and completes, instead of hard-failing and forcing the human to answer again. Proposal uniqueness moves from one-per-source to one-per-source-per-baseline to admit that successor; the successor reuses the same knowledge proposal, so the human's confirmation stays bound to exactly the content they approved.

  Two consequences worth stating plainly:

  - Activating a rule replaces the whole active policy document, so confirming a second rule discards a first rule that a human also approved, without asking again. That is the existing whole-document-replacement design of this lane rather than something the rebaseline introduces - previously the stale baseline forced a round trip that would have clobbered anyway - and the audit trail stays exact, with the activation event naming the revision it replaced and `undo` restoring it. The rebaseline removes the round trip, which makes the behaviour easier to reach.
  - Excluding the baseline from operation identity changes both the proposal request fingerprint and the governed-write input hash (which derives the service actor subject id). A `remember` operation that durably wrote rows under the previous release and is replayed under this one computes a different identity and fails as an operation-reuse conflict. This is bounded to operations in flight across the deploy and self-heals with a fresh operation id; no dual-identity compatibility path was added.

- 6d22ab5: Widen the task-note expiry ceiling from 30 to 90 days. Task notes are pure agent-to-agent coordination within one root session tree; resuming a paused root session/task tree after a longer gap previously lost all coordination notes silently. `TASK_NOTE_MAX_LIFETIME_DAYS` is now the single source of truth, referenced by the application-layer bound checks and `remember`'s evidence note instead of a hardcoded literal. Fully backward compatible: every existing row and every caller supplying 1-30 days keeps working unchanged.
- Updated dependencies [5dc88ef]
- Updated dependencies [1c78ed0]
- Updated dependencies [f4afa19]
- Updated dependencies [f4afa19]
- Updated dependencies [d581eef]
- Updated dependencies [994a743]
- Updated dependencies [a7df809]
- Updated dependencies [51123b4]
- Updated dependencies [8583779]
- Updated dependencies [a99ef33]
- Updated dependencies [79ee99b]
- Updated dependencies [368ee6c]
- Updated dependencies [2cb04e0]
- Updated dependencies [f4afa19]
- Updated dependencies [4541ab2]
- Updated dependencies [747222a]
- Updated dependencies [7bc1cd1]
- Updated dependencies [6d22ab5]
  - @opengeni/db@2.0.0
  - @opengeni/contracts@2.0.0
  - @opengeni/runtime@1.1.2
  - @opengeni/config@0.17.0
  - @opengeni/observability@0.8.0
  - @opengeni/documents@0.6.5
  - @opengeni/events@0.3.119
  - @opengeni/storage@0.2.101

## 1.4.1

### Patch Changes

- Updated dependencies [a03b86f]
  - @opengeni/db@1.5.0
  - @opengeni/documents@0.6.4
  - @opengeni/events@0.3.118

## 1.4.0

### Minor Changes

- b05130a: Hard-cut editable spreadsheets to authored-only canonical state, deterministic formula projections, and explicit current compatibility protocols. Preserve React compatibility with artifact-tool 0.1 and 0.2 while adding the 0.3 line.

### Patch Changes

- Updated dependencies [0a6c577]
- Updated dependencies [f804057]
- Updated dependencies [6937eaf]
- Updated dependencies [e6c2fee]
- Updated dependencies [b05130a]
- Updated dependencies [418b531]
- Updated dependencies [55e0417]
  - @opengeni/config@0.16.8
  - @opengeni/db@1.4.0
  - @opengeni/storage@0.2.100
  - @opengeni/contracts@1.4.0
  - @opengeni/documents@0.6.3
  - @opengeni/runtime@1.1.1
  - @opengeni/events@0.3.117
  - @opengeni/observability@0.7.11

## 1.3.0

### Minor Changes

- 4c2d958: Google Drive publication freezes its exact output destination on the accepted delegation, so a later connection-settings change fails an already-accepted turn's publication closed instead of silently redirecting it. Every publication sits behind exactly one durable execute-once connector fence (the attempt connector-action wrapper for model callers, the tool's own registration for Codemode callers): a failure before the first mutating provider request settles not_executed with a retry-safe message, while a failure after it settles uncertain and surfaces the unknown outcome.

### Patch Changes

- Updated dependencies [4c2d958]
- Updated dependencies [4c2d958]
- Updated dependencies [4c2d958]
  - @opengeni/contracts@1.3.0
  - @opengeni/db@1.3.0
  - @opengeni/runtime@1.1.0
  - @opengeni/config@0.16.7
  - @opengeni/documents@0.6.2
  - @opengeni/events@0.3.116
  - @opengeni/observability@0.7.10
  - @opengeni/storage@0.2.99

## 1.2.1

### Patch Changes

- Updated dependencies [a65505d]
  - @opengeni/db@1.2.0
  - @opengeni/documents@0.6.1
  - @opengeni/events@0.3.115

## 1.2.0

### Minor Changes

- ca75ed9: Add the governed-learning activation controller with exact authority revalidation, destination-native workspace activation, immutable content-free receipts, and supersession-safe append-only undo.
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
- 30ba620: Make every accepted scheduled agent occurrence an immutable, credential-free
  execution snapshot bound to one run, session, scheduled update, logical turn,
  and attempt chain. Agent tasks accept explicit `connectionAuthorities`
  (omitted preserves, `[]` clears, an array replaces), execution-affecting edits
  require the same causal human, `once` grants are consumed exactly once per
  run, cold reusable sessions converge on one revision-bound materialization
  receipt, and task deletion becomes a one-way paused tombstone with durable
  connector cleanup. Create/update requests are byte-bounded at ingress while
  stored rows stay readable. Migration `0275` is a maintenance cutover.
- f72563d: Slack now has exactly two authorities: the personal hosted Slack MCP grant and the OpenGeni workspace bot. The workspace-owned hosted Slack MCP connection is removed: OAuth start, reconnect, the callback fence, and capability enablement reject an explicit non-personal ownership for `https://mcp.slack.com/mcp`, an omitted ownership on that resource defaults to personal, and `listEnabledMcpCapabilityServers` no longer runs a workspace-scoped Slack MCP installation enabled by an earlier release. The bot manifest and canonical bot allowlist gain the bot-token Real-time Search scopes `search:read.public`, `search:read.files`, and `search:read.users` as requested-but-not-required extras; apply them to the Slack app before deploying, since the install URL requests every requested scope. The bot search tool itself is a separate change.
- c297fc0: Add deterministic governed-learning evaluation over exact accepted policy and evidence authority, with immutable content-free decision receipts and no activation capability.
- cac85bc: Every persistable /workspace writer admission and retained process now freezes its exact authority tuple (causal initiator, initiating human, organization-membership grant identity with observed revision, and session tenancy epoch/visibility/owner). Direct and process actors are fenced like turns: a revoked or suspended grant, or an unattributed pre-0277 tenancy half, fails a new mutation closed before any workspace generation is consumed, and the running provider process is never terminated or re-owned.

### Patch Changes

- 987742d: Skip the redundant in-box rig marker probe when a live Modal session reports
  the exact immutable image that already passed the rig's content, source,
  provider-binding, and independent cold-boot verification. Missing or mismatched
  image identity retains the existing fail-closed marker and setup path.
- 987742d: Reduce turn-start overhead without reducing admitted history, rig variables, or
  user-visible content. Active history loads in one admitted query, automatic
  compaction skips duplicate history work below threshold, unchanged Codex
  credential pointers avoid redundant session-activity writes, rig defaults
  load at bounded concurrency for admitted worker attempts, and the attempt-scoped
  MCP wrapper no longer reuses a broader process-global tool list.

  Improve large-session interaction by measuring rich-message disclosure without
  a second React commit, showing truthful pending queue actions immediately, and
  replacing the false zero-step placeholder with the session's real lifecycle.

- 5cd7b46: `remember` with `lane: instruction_policy` now binds the draft to the target's current activation baseline (active head revision and CAS version, including a deactivated-to-null boundary) instead of assuming an empty workspace, so a user-directed rule can be proposed and confirmed in a workspace that already has an active policy.
- 6860c5f: Add organization, workspace, and owner-private scopes for Rigs and Connected Machines. Personal machine use and Rig materialization now revalidate exact-attempt grants, membership, workspace access, authority epochs, and generations before runtime access.
- c297fc0: Complete governed goal rewrites with strict agent change metadata, immutable
  proposal rejection and CAS-fenced rollback, bounded revision pagination, and
  accepted-turn root constraints that child agents may inherit or narrow. The
  original raw-array goal-revision list remains unchanged; bounded pagination is
  available through a separately named API and SDK surface.
- 6c45ceb: Start fresh progressive-disclosure turns with only local tools, `tool_search`,
  and MCP servers explicitly marked eager by the session. Prepare every other
  strict or optional MCP concurrently, join the exact catalog only when searched
  or invoked, and keep worker first-party MCP traffic on an internal endpoint
  instead of a sandbox-facing public route while preserving the distinct root,
  documents, and files MCP paths.
- Updated dependencies [1aa02d4]
- Updated dependencies [ca75ed9]
- Updated dependencies [c297fc0]
- Updated dependencies [91d5caf]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [02e21fa]
- Updated dependencies [c297fc0]
- Updated dependencies [987742d]
- Updated dependencies [987742d]
- Updated dependencies [db758f3]
- Updated dependencies [e9aabaa]
- Updated dependencies [1f860f0]
- Updated dependencies [6a8954f]
- Updated dependencies [c297fc0]
- Updated dependencies [22c0c21]
- Updated dependencies [5cd7b46]
- Updated dependencies [4eb7abd]
- Updated dependencies [89d4ab3]
- Updated dependencies [304462e]
- Updated dependencies [7454580]
- Updated dependencies [16cbd7b]
- Updated dependencies [30ba620]
- Updated dependencies [d168b8f]
- Updated dependencies [6860c5f]
- Updated dependencies [f72563d]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [6c45ceb]
- Updated dependencies [c297fc0]
- Updated dependencies [ea52ff2]
- Updated dependencies [cac85bc]
  - @opengeni/config@0.16.6
  - @opengeni/contracts@1.2.0
  - @opengeni/db@1.1.0
  - @opengeni/documents@0.6.0
  - @opengeni/runtime@1.0.3
  - @opengeni/storage@0.2.98
  - @opengeni/events@0.3.114
  - @opengeni/observability@0.7.9

## 1.1.0

### Minor Changes

- eeb7cb6: Add immutable personal/workspace connection authority contracts and immediate
  pre-use revalidation helpers.

### Patch Changes

- 90c0c3e: Persist bounded, content-free Company Brain prompt contribution estimates on authoritative model-call facts and expose their source breakdown and coverage in Workspace Insights.
- e0e0102: Unify browser, computer, identity, realtime, and Codemode behavior across managed sandboxes and connected machines.
- 4d1ed07: Preserve complete bounded lazy-search tool schemas across durable model history, expose Linux desktop application launch when the image supports it, suppress the managed Chrome sandbox warning, label Computer sessions as Desktops in the UI, and keep AnyDoc available in headed desktop sandboxes.
- ffbbf4c: Add organization, workspace, and owner-private Variable Set scopes with independent metadata, plaintext-read, write, attachment, and runtime-use authority. Runtime secret materialization now revalidates the exact live attempt and personal grant immediately before ciphertext egress while audits remain value-free.
- d2f172c: Add fail-closed, metadata-only capability, exact rig-version health, exact alert-selector data-source checks, and source/claim authority fencing for scheduled incident telemetry responders before expensive retrieval.
- 04b1a1f: Add exact-attempt, workspace-local governed Knowledge proposal/correction
  routing and inactive instruction-policy and preference proposal adapters while
  preserving human activation authority and immutable Knowledge provenance.
- Updated dependencies [a551666]
- Updated dependencies [31231dc]
- Updated dependencies [90c0c3e]
- Updated dependencies [9c4e0b8]
- Updated dependencies [e0e0102]
- Updated dependencies [4d1ed07]
- Updated dependencies [ce3b370]
- Updated dependencies [e98daf6]
- Updated dependencies [b2af2df]
- Updated dependencies [e9e1016]
- Updated dependencies [d7dfc01]
- Updated dependencies [ec00479]
- Updated dependencies [ffbbf4c]
- Updated dependencies [3843825]
- Updated dependencies [1ab8023]
- Updated dependencies [d34dd9a]
- Updated dependencies [79f57b5]
- Updated dependencies [eeb7cb6]
- Updated dependencies [886682d]
- Updated dependencies [234a5e7]
- Updated dependencies [c3f0598]
- Updated dependencies [79f57b5]
- Updated dependencies [d2f172c]
- Updated dependencies [04b1a1f]
- Updated dependencies [c056063]
  - @opengeni/db@1.0.2
  - @opengeni/observability@0.7.8
  - @opengeni/contracts@1.1.0
  - @opengeni/config@0.16.5
  - @opengeni/events@0.3.113
  - @opengeni/runtime@1.0.2
  - @opengeni/documents@0.5.42
  - @opengeni/storage@0.2.97

## 1.0.1

### Patch Changes

- 448117d: Enforce fresh per-object Google Drive ACL authorization across Knowledge
  retrieval and every file-byte consumer, and project only reauthorized,
  principal-free provider citations.
- Updated dependencies [448117d]
  - @opengeni/contracts@1.0.1
  - @opengeni/db@1.0.1
  - @opengeni/documents@0.5.41
  - @opengeni/runtime@1.0.1
  - @opengeni/config@0.16.4
  - @opengeni/events@0.3.112
  - @opengeni/observability@0.7.7
  - @opengeni/storage@0.2.96

## 1.0.0

### Major Changes

- 083387e: Replace the removed per-turn `turnInstructions` system-prefix contract with generic per-message `modelContext` content. This is a breaking release-train cutover: old mutating clients are rejected after migration 0240. Context now enters canonical user history without standard timeline rendering, preserves the persistent prompt-cache prefix, and works across initial, queued, steer, realtime delegation, and transcript handoff paths.

### Patch Changes

- 11913b7: Add separately consented Google Drive editable-artifact publishing with an explicit writable destination, connector-action approval policy, Google-native conversion, and retry-safe provider reconciliation.
- Updated dependencies [083387e]
- Updated dependencies [11913b7]
  - @opengeni/contracts@1.0.0
  - @opengeni/db@1.0.0
  - @opengeni/runtime@1.0.0
  - @opengeni/config@0.16.3
  - @opengeni/documents@0.5.40
  - @opengeni/events@0.3.111
  - @opengeni/observability@0.7.6
  - @opengeni/storage@0.2.95

## 0.28.1

### Patch Changes

- Updated dependencies [944be7f]
- Updated dependencies [499c70c]
  - @opengeni/codex@0.2.17
  - @opengeni/runtime@0.23.1
  - @opengeni/db@0.36.1
  - @opengeni/config@0.16.2
  - @opengeni/documents@0.5.39
  - @opengeni/events@0.3.110
  - @opengeni/storage@0.2.94

## 0.28.0

### Minor Changes

- 6435af7: Add a provider-neutral conversation integration kernel with strict normalized
  identities, inbound envelopes, delivery operations, receipts, outcome safety,
  and deterministic wire projections.

### Patch Changes

- d86610d: Prevent deterministic model-generated worker-spawn failures, hide exhausted nested-agent creation, and show bounded structured session orchestration diagnostics in worker timeline rows while preserving the advanced public REST/SDK create contract.
- d86610d: Show elapsed UTC-hour buckets for the Insights Today range while retaining UTC-day buckets for longer ranges.
- d86610d: Run published HTML artifacts as exact source in an opaque-origin sandbox, raise their UTF-8 ceiling to 4 MiB, and expose reusable React rendering. Add deployment-configurable default and allowed built-in session tools plus configured shared-key delegation fallback.
- Updated dependencies [d86610d]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [d86610d]
- Updated dependencies [d86610d]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
  - @opengeni/contracts@0.50.0
  - @opengeni/runtime@0.23.0
  - @opengeni/db@0.36.0
  - @opengeni/config@0.16.1
  - @opengeni/documents@0.5.38
  - @opengeni/events@0.3.109
  - @opengeni/observability@0.7.5
  - @opengeni/storage@0.2.93

## 0.27.2

### Patch Changes

- Updated dependencies [b0b2bed]
- Updated dependencies [a01170c]
  - @opengeni/config@0.16.0
  - @opengeni/contracts@0.49.0
  - @opengeni/runtime@0.22.0
  - @opengeni/db@0.35.1
  - @opengeni/documents@0.5.37
  - @opengeni/storage@0.2.92
  - @opengeni/events@0.3.108
  - @opengeni/observability@0.7.4

## 0.27.1

### Patch Changes

- Updated dependencies [61e0b89]
  - @opengeni/runtime@0.21.2

## 0.27.0

### Minor Changes

- 8beed26: Activate server-authoritative session visibility and content forking. Add user-private session ownership, authority-epoch transitions, explicit cross-workspace fork operations, session-scoped RLS actor propagation, and API authorization that preserves workspace-shared access while enforcing private-session ownership.

### Patch Changes

- 8beed26: Add workspace-governed Slack shared-conversation task policies with durable enforcement and public contracts, and enforce vertical-only agent session authority across core and persistence.
- Updated dependencies [8beed26]
- Updated dependencies [8beed26]
- Updated dependencies [8beed26]
- Updated dependencies [8beed26]
  - @opengeni/contracts@0.48.0
  - @opengeni/db@0.35.0
  - @opengeni/config@0.15.1
  - @opengeni/documents@0.5.36
  - @opengeni/events@0.3.107
  - @opengeni/observability@0.7.3
  - @opengeni/runtime@0.21.1
  - @opengeni/storage@0.2.91

## 0.26.0

### Minor Changes

- 1e78f58: Make Facet definitions and bindings authoritative throughout the Integration domain. Public routes, SDK methods, Pack components, owner identities, physical tables, persisted manifests, and runtime projections now use one Facet vocabulary with a maintenance cutover and no compatibility aliases.
- 746bbbe: Add canonical human identities with multiple verified login bindings, revisioned and audited lifecycle operations, immediate session invalidation, fail-closed recovery and collision handling, and metadata-minimal managed identity API routes.
- 1e78f58: Make normalized Plugin, Version, Skill Facet, and component-owner records authoritative for curated and imported Skills. Add reviewed library install, list, update, preview, and uninstall contracts; preserve Pack and Plugin ownership independently; and retire every non-MCP row from the generic capability catalog and installation ledger through a collision-free maintenance migration.

### Patch Changes

- Updated dependencies [1e78f58]
- Updated dependencies [1c4ac69]
- Updated dependencies [1e78f58]
- Updated dependencies [746bbbe]
- Updated dependencies [1e78f58]
- Updated dependencies [9849e25]
- Updated dependencies [1e78f58]
  - @opengeni/config@0.15.0
  - @opengeni/contracts@0.47.0
  - @opengeni/db@0.34.0
  - @opengeni/runtime@0.21.0
  - @opengeni/documents@0.5.35
  - @opengeni/storage@0.2.90
  - @opengeni/events@0.3.106
  - @opengeni/observability@0.7.2

## 0.25.1

### Patch Changes

- Updated dependencies [73d34d6]
- Updated dependencies [3d74340]
  - @opengeni/codex@0.2.16
  - @opengeni/contracts@0.46.0
  - @opengeni/db@0.33.0
  - @opengeni/config@0.14.1
  - @opengeni/runtime@0.20.1
  - @opengeni/documents@0.5.34
  - @opengeni/events@0.3.105
  - @opengeni/observability@0.7.1
  - @opengeni/storage@0.2.89

## 0.25.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.
- 5215c0e: Add the first-party Fiken connector: a registered-app OAuth flow (`startFikenOAuth` + public callback, Basic-auth code exchange, broker-owned refresh with rotating refresh tokens) and a verified paste-a-token install route, both storing one workspace-owned `fiken.no` connection; explicit-only `fiken_*` first-party MCP tools (reads plus contact-create and idempotent invoice-draft-create); a serialized single-concurrent-request Fiken client; an `api:fiken` capability tile whose connect sheet leads with OAuth and folds the token form behind a toggle; and operator config `OPENGENI_FIKEN_OAUTH_CLIENT_ID`/`_SECRET`.

### Patch Changes

- Updated dependencies [d2def0c]
- Updated dependencies [314c7ba]
- Updated dependencies [5215c0e]
- Updated dependencies [d15d3e8]
- Updated dependencies [d241d13]
- Updated dependencies [3f81608]
- Updated dependencies [733c22f]
- Updated dependencies [42a1242]
  - @opengeni/config@0.14.0
  - @opengeni/contracts@0.45.0
  - @opengeni/db@0.32.0
  - @opengeni/observability@0.7.0
  - @opengeni/runtime@0.20.0
  - @opengeni/documents@0.5.33
  - @opengeni/storage@0.2.88
  - @opengeni/events@0.3.104

## 0.24.1

### Patch Changes

- 5c5ea4a: Add the universal capabilities platform with named API integration instances,
  provider-specific feature bindings, and local runtime adapters.
- Updated dependencies [b57d61f]
- Updated dependencies [5c5ea4a]
- Updated dependencies [98e807e]
  - @opengeni/contracts@0.44.1
  - @opengeni/runtime@0.19.2
  - @opengeni/db@0.31.1
  - @opengeni/config@0.13.2
  - @opengeni/documents@0.5.32
  - @opengeni/events@0.3.103
  - @opengeni/observability@0.6.2
  - @opengeni/storage@0.2.87

## 0.24.0

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
  - @opengeni/db@0.31.0
  - @opengeni/contracts@0.44.0
  - @opengeni/runtime@0.19.1
  - @opengeni/documents@0.5.31
  - @opengeni/storage@0.2.86
  - @opengeni/events@0.3.102
  - @opengeni/observability@0.6.1

## 0.23.0

### Minor Changes

- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.

### Patch Changes

- 2f4ce5e: Add durable Seedance video generation with workspace model and funding policy,
  secure media references, retained video artifacts, sandbox materialization,
  OpenGeni-credit and workspace-gateway funding, and SDK/React playback surfaces.
- d1db1d3: Make agent-spawned workers inherit omitted model, reasoning, and latency settings from the exact calling turn so Codex subscription sessions do not silently fall back to OpenGeni-credit models.
- bd5514e: Add explicitly enabled provider-neutral knowledge-source schedules with durable wake provenance, generation-fenced execution checkpoints and index obligations, fail-closed ACL activation seams, no-agent execution, layered pause state, shared schedule administration, and Google Drive source lifecycle integration.
- Updated dependencies [b46f4de]
- Updated dependencies [2f4ce5e]
- Updated dependencies [d55a093]
- Updated dependencies [7954468]
- Updated dependencies [dcfe6eb]
- Updated dependencies [cccc2b3]
- Updated dependencies [96965c2]
- Updated dependencies [a8e44ae]
- Updated dependencies [ad9123b]
- Updated dependencies [eade67f]
- Updated dependencies [31666e2]
- Updated dependencies [bd5514e]
- Updated dependencies [90eea29]
- Updated dependencies [a858835]
- Updated dependencies [5fcad0a]
  - @opengeni/contracts@0.43.0
  - @opengeni/db@0.30.0
  - @opengeni/config@0.13.0
  - @opengeni/runtime@0.19.0
  - @opengeni/observability@0.6.0
  - @opengeni/documents@0.5.30
  - @opengeni/events@0.3.101
  - @opengeni/storage@0.2.85
  - @opengeni/codex@0.2.15

## 0.22.2

### Patch Changes

- 98b94e8: Project physical cancellation immediately from atomic Steer and Pause receipts, then reconcile it against durable queue truth.
- 2cd6dce: Build and reuse version-bound immutable provider images after clean rig verification, with content-hash invalidation and runtime-setup fallback for missing or unsupported providers.
- Updated dependencies [2cd6dce]
  - @opengeni/contracts@0.42.1
  - @opengeni/db@0.29.1
  - @opengeni/runtime@0.18.39
  - @opengeni/config@0.12.10
  - @opengeni/documents@0.5.29
  - @opengeni/events@0.3.100
  - @opengeni/observability@0.5.16
  - @opengeni/storage@0.2.84

## 0.22.1

### Patch Changes

- df985c0: Keep turn-activity heartbeats and the Temporal SDK cancellation throttle at 500
  milliseconds so Pause and Steer retain the full four-second physical-cancellation
  budget for writer drain and receipt-gated replacement admission.

## 0.22.0

### Minor Changes

- 7b2d5ff: Add trust-gated in-session capability recommendations, human-owned authorization
  requests, and a GitHub owner-consent flow that returns to the initiating session.
- d1189ba: Add the OpenGeni-owned document, spreadsheet, and presentation authoring engine,
  its durable API/domain/live-sync surfaces, first-party React workbench, and
  editable-artifact client SDK. Publish independently lazy, identity-pinned browser
  WASM runtimes for each editor modality.

### Patch Changes

- Updated dependencies [7b2d5ff]
- Updated dependencies [d1189ba]
  - @opengeni/contracts@0.42.0
  - @opengeni/db@0.29.0
  - @opengeni/config@0.12.9
  - @opengeni/documents@0.5.28
  - @opengeni/events@0.3.99
  - @opengeni/observability@0.5.15
  - @opengeni/runtime@0.18.38
  - @opengeni/storage@0.2.83

## 0.21.27

### Patch Changes

- Updated dependencies [bea1e89]
  - @opengeni/runtime@0.18.37

## 0.21.26

### Patch Changes

- Updated dependencies [ef78ecf]
  - @opengeni/contracts@0.41.4
  - @opengeni/runtime@0.18.36
  - @opengeni/config@0.12.8
  - @opengeni/db@0.28.18
  - @opengeni/documents@0.5.27
  - @opengeni/events@0.3.98
  - @opengeni/observability@0.5.14
  - @opengeni/storage@0.2.82

## 0.21.25

### Patch Changes

- Updated dependencies [8485ff5]
- Updated dependencies [dfcf698]
- Updated dependencies [1385585]
  - @opengeni/runtime@0.18.35
  - @opengeni/db@0.28.17
  - @opengeni/contracts@0.41.3
  - @opengeni/observability@0.5.13
  - @opengeni/documents@0.5.26
  - @opengeni/events@0.3.97
  - @opengeni/config@0.12.7
  - @opengeni/storage@0.2.81

## 0.21.24

### Patch Changes

- Updated dependencies [435a4f2]
  - @opengeni/runtime@0.18.34

## 0.21.23

### Patch Changes

- Updated dependencies [e627d88]
  - @opengeni/observability@0.5.12

## 0.21.22

### Patch Changes

- 7f70d33: Bound long-running service memory, upgrade the OpenAI Agents SDK to 0.14.3, and preserve exact provider, streaming, and durable-resume semantics.
- Updated dependencies [e2edfbc]
- Updated dependencies [db82911]
- Updated dependencies [7f70d33]
  - @opengeni/codex@0.2.14
  - @opengeni/config@0.12.6
  - @opengeni/contracts@0.41.2
  - @opengeni/db@0.28.16
  - @opengeni/runtime@0.18.33
  - @opengeni/documents@0.5.25
  - @opengeni/storage@0.2.80
  - @opengeni/events@0.3.96
  - @opengeni/observability@0.5.11

## 0.21.21

### Patch Changes

- Updated dependencies [56f612b]
  - @opengeni/observability@0.5.10
  - @opengeni/runtime@0.18.32

## 0.21.20

### Patch Changes

- Updated dependencies [5806484]
  - @opengeni/db@0.28.15
  - @opengeni/documents@0.5.24
  - @opengeni/events@0.3.95

## 0.21.19

### Patch Changes

- Updated dependencies [b59e5bd]
  - @opengeni/runtime@0.18.31

## 0.21.18

### Patch Changes

- Updated dependencies [81a51ac]
  - @opengeni/db@0.28.14
  - @opengeni/observability@0.5.9
  - @opengeni/documents@0.5.23
  - @opengeni/events@0.3.94

## 0.21.17

### Patch Changes

- 2727236: Make sandbox draining crash-safe with durable capture and teardown ownership, idempotent Modal snapshots, scoped operator holds, parallel Temporal reaping, exact lifecycle errors, and verified Local/Docker workspace recovery.
- Updated dependencies [2727236]
- Updated dependencies [c8eb465]
  - @opengeni/config@0.12.5
  - @opengeni/contracts@0.41.1
  - @opengeni/db@0.28.13
  - @opengeni/runtime@0.18.30
  - @opengeni/documents@0.5.22
  - @opengeni/storage@0.2.79
  - @opengeni/events@0.3.93
  - @opengeni/observability@0.5.8

## 0.21.16

### Patch Changes

- Updated dependencies [e1daf06]
  - @opengeni/events@0.3.92

## 0.21.15

### Patch Changes

- bb9a346: Add token and cache coverage plus nullable provider-rate cost comparisons to Workspace Insights, preserving exact Gateway billing while keeping incomplete configured telemetry unpriced.
- Updated dependencies [bb9a346]
  - @opengeni/config@0.12.4
  - @opengeni/contracts@0.41.0
  - @opengeni/db@0.28.12
  - @opengeni/runtime@0.18.29
  - @opengeni/documents@0.5.21
  - @opengeni/storage@0.2.78
  - @opengeni/events@0.3.91
  - @opengeni/observability@0.5.7

## 0.21.14

### Patch Changes

- Updated dependencies [a2099b1]
  - @opengeni/runtime@0.18.28

## 0.21.13

### Patch Changes

- Updated dependencies [74e7a31]
  - @opengeni/runtime@0.18.27

## 0.21.12

### Patch Changes

- Updated dependencies [909daef]
- Updated dependencies [dec7ada]
  - @opengeni/runtime@0.18.26
  - @opengeni/config@0.12.3
  - @opengeni/db@0.28.11
  - @opengeni/documents@0.5.20
  - @opengeni/storage@0.2.77
  - @opengeni/events@0.3.90

## 0.21.11

### Patch Changes

- Updated dependencies [7d13f51]
- Updated dependencies [7ac558e]
  - @opengeni/config@0.12.2
  - @opengeni/db@0.28.10
  - @opengeni/documents@0.5.19
  - @opengeni/runtime@0.18.25
  - @opengeni/storage@0.2.76
  - @opengeni/events@0.3.89

## 0.21.10

### Patch Changes

- Updated dependencies [fed43cf]
- Updated dependencies [410835e]
  - @opengeni/contracts@0.40.0
  - @opengeni/runtime@0.18.24
  - @opengeni/storage@0.2.75
  - @opengeni/config@0.12.1
  - @opengeni/db@0.28.9
  - @opengeni/documents@0.5.18
  - @opengeni/events@0.3.88
  - @opengeni/observability@0.5.6

## 0.21.9

### Patch Changes

- 5dfb93d: Make Connected Machine command duration unbounded by default over replayable op-stream execution, preserve explicit positive deadlines for constrained deployments, wire and finalize streaming across direct and swapped machine routes, remove the generated service's aggregate memory throttle while retaining accounting and OOM isolation, and bound transient reordering memory by bytes without limiting command resources or output.
- 5dfb93d: Let one Connected Machine agent retain and serve independent connections to multiple OpenGeni workspaces and deployments, with additive connection UX and connection-scoped runtime isolation.
- Updated dependencies [f8eb9f9]
- Updated dependencies [5dfb93d]
- Updated dependencies [200586a]
- Updated dependencies [5dfb93d]
- Updated dependencies [5dfb93d]
  - @opengeni/config@0.12.0
  - @opengeni/runtime@0.18.23
  - @opengeni/contracts@0.39.5
  - @opengeni/db@0.28.8
  - @opengeni/documents@0.5.17
  - @opengeni/storage@0.2.74
  - @opengeni/events@0.3.87
  - @opengeni/observability@0.5.5

## 0.21.8

### Patch Changes

- Updated dependencies [377180c]
  - @opengeni/db@0.28.7
  - @opengeni/documents@0.5.16
  - @opengeni/events@0.3.86

## 0.21.7

### Patch Changes

- 43fa8f4: Expose authorized Codex Apps through the server-authoritative tool catalog and make setup recovery actionable without widening explicit session policies.
- 70ced80: Add an offline-safe Connected Machine enrollment removal lifecycle with credential revocation, durable audit history, guarded route and lease handling, SDK/MCP support, and accessible active-list reconciliation.
- Updated dependencies [43fa8f4]
- Updated dependencies [70ced80]
- Updated dependencies [2c83ce5]
  - @opengeni/runtime@0.18.22
  - @opengeni/contracts@0.39.4
  - @opengeni/db@0.28.6
  - @opengeni/config@0.11.5
  - @opengeni/documents@0.5.15
  - @opengeni/events@0.3.85
  - @opengeni/observability@0.5.4
  - @opengeni/storage@0.2.73

## 0.21.6

### Patch Changes

- Updated dependencies [43d45c6]
  - @opengeni/codex@0.2.13
  - @opengeni/config@0.11.4
  - @opengeni/db@0.28.5
  - @opengeni/runtime@0.18.21
  - @opengeni/documents@0.5.14
  - @opengeni/storage@0.2.72
  - @opengeni/events@0.3.84

## 0.21.5

### Patch Changes

- fc7cc08: Normalize established-session composer resources through the same canonical boundary used by Send and Steer.
- 5d8bb99: Allow scheduled tasks to target and durably wake one authorized existing session without creating a helper session or replacing its goal.
- Updated dependencies [b783f12]
- Updated dependencies [ece124b]
- Updated dependencies [7a84e1b]
- Updated dependencies [5d8bb99]
- Updated dependencies [238fb7e]
- Updated dependencies [af24281]
- Updated dependencies [34c5cdb]
  - @opengeni/runtime@0.18.20
  - @opengeni/db@0.28.4
  - @opengeni/contracts@0.39.3
  - @opengeni/config@0.11.3
  - @opengeni/documents@0.5.13
  - @opengeni/events@0.3.83
  - @opengeni/observability@0.5.3
  - @opengeni/storage@0.2.71

## 0.21.4

### Patch Changes

- 7dbd057: Preserve provider-defined repository clone paths and centralize provider-declared `.git` alias semantics across resource identity and credential routing.
- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- c3876d4: Preserve sliding managed-session renewal cookies on protected API responses so active browser sessions do not expire at their original sign-in boundary.
- 23de73b: Add explicitly permissioned, audited plaintext reads for encrypted workspace variable-set values across REST, SDK, React, MCP, and UI surfaces.
- Updated dependencies [1fbb6e7]
- Updated dependencies [7dbd057]
- Updated dependencies [78a1577]
- Updated dependencies [30a0b9a]
- Updated dependencies [23de73b]
- Updated dependencies [1503151]
- Updated dependencies [0b23696]
- Updated dependencies [4c7b956]
- Updated dependencies [42c04ce]
- Updated dependencies [a296081]
  - @opengeni/runtime@0.18.19
  - @opengeni/contracts@0.39.2
  - @opengeni/observability@0.5.2
  - @opengeni/codex@0.2.12
  - @opengeni/db@0.28.3
  - @opengeni/events@0.3.82
  - @opengeni/config@0.11.2
  - @opengeni/documents@0.5.12
  - @opengeni/storage@0.2.70

## 0.21.3

### Patch Changes

- 41f7ae3: Treat the SDK's exact UnixLocal missing-workspace proof as provider loss so stale local leases can recover or drain cleanly, and expose ordinary sandbox-operation availability separately from live attach/swap readiness.
- ce823ce: Replace first-party MCP mutation entity echoes with strict, versioned compact
  receipts; add bounded scheduled-task list/detail projections and preserve worker
  session references across receipt and legacy timeline results.
- Updated dependencies [110d255]
- Updated dependencies [41f7ae3]
- Updated dependencies [5d1d0c2]
- Updated dependencies [ce823ce]
  - @opengeni/db@0.28.2
  - @opengeni/runtime@0.18.18
  - @opengeni/events@0.3.81
  - @opengeni/contracts@0.39.1
  - @opengeni/documents@0.5.11
  - @opengeni/config@0.11.1
  - @opengeni/observability@0.5.1
  - @opengeni/storage@0.2.69

## 0.21.2

### Patch Changes

- Updated dependencies [33166b0]
  - @opengeni/observability@0.5.0

## 0.21.1

### Patch Changes

- Updated dependencies [55f6ad0]
- Updated dependencies [18eea76]
  - @opengeni/db@0.28.1
  - @opengeni/runtime@0.18.17
  - @opengeni/documents@0.5.10
  - @opengeni/events@0.3.80

## 0.21.0

### Minor Changes

- 6eb0b23: Add production resumable composer transcription with exact-subject durable
  manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
  recording-wide provider pin, persisted retryable segment results, deterministic
  assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
  of transcript metadata after every provider object is confirmed deleted. Legacy
  one-shot voice input remains compatible.

### Patch Changes

- Updated dependencies [49c7f9c]
- Updated dependencies [5b6d36e]
- Updated dependencies [6eb0b23]
- Updated dependencies [5b6d36e]
  - @opengeni/db@0.28.0
  - @opengeni/config@0.11.0
  - @opengeni/contracts@0.39.0
  - @opengeni/runtime@0.18.16
  - @opengeni/documents@0.5.9
  - @opengeni/events@0.3.79
  - @opengeni/storage@0.2.68
  - @opengeni/observability@0.4.17

## 0.20.17

### Patch Changes

- Updated dependencies [cbf165a]
  - @opengeni/db@0.27.12
  - @opengeni/documents@0.5.8
  - @opengeni/events@0.3.78

## 0.20.16

### Patch Changes

- Updated dependencies [8135dbb]
- Updated dependencies [17643a5]
  - @opengeni/config@0.10.14
  - @opengeni/db@0.27.11
  - @opengeni/documents@0.5.7
  - @opengeni/runtime@0.18.15
  - @opengeni/storage@0.2.67
  - @opengeni/events@0.3.77

## 0.20.15

### Patch Changes

- Updated dependencies [c6c9acb]
  - @opengeni/runtime@0.18.14

## 0.20.14

### Patch Changes

- 69bc207: Keep Codex history canonical across subscriptions and providers, separate optional owner-designated Codex Apps authority from inference allocation, and fence Apps authorization through each remote request.
- Updated dependencies [69bc207]
- Updated dependencies [144fd9e]
- Updated dependencies [c0f8e40]
  - @opengeni/codex@0.2.11
  - @opengeni/db@0.27.10
  - @opengeni/runtime@0.18.13
  - @opengeni/contracts@0.38.3
  - @opengeni/config@0.10.13
  - @opengeni/documents@0.5.6
  - @opengeni/events@0.3.76
  - @opengeni/observability@0.4.16
  - @opengeni/storage@0.2.66

## 0.20.13

### Patch Changes

- Updated dependencies [8105c25]
  - @opengeni/runtime@0.18.12

## 0.20.12

### Patch Changes

- 4502474: Add workspace-default and explicitly personal ownership for first-party social connections, preserve causal personal authority for agent work, and retain actionable structured gateway errors.
- ee79969: Repair release-head recovery when GitHub emits duplicate legacy check projections.
- Updated dependencies [4502474]
- Updated dependencies [1ea5e62]
  - @opengeni/contracts@0.38.2
  - @opengeni/db@0.27.9
  - @opengeni/runtime@0.18.11
  - @opengeni/config@0.10.12
  - @opengeni/documents@0.5.5
  - @opengeni/events@0.3.75
  - @opengeni/observability@0.4.15
  - @opengeni/storage@0.2.65

## 0.20.11

### Patch Changes

- dfa3aef: Preserve Steer priority through provider recovery and repair interrupted attempts durably.
- Updated dependencies [dfa3aef]
  - @opengeni/db@0.27.8
  - @opengeni/documents@0.5.4
  - @opengeni/events@0.3.74

## 0.20.10

### Patch Changes

- c29fd4c: Bound MCP OAuth callbacks through token exchange and persistence, return safe stage-specific failures to the capabilities UI, and replace incompatible dynamic client registrations with a compare-and-swap update.
- Updated dependencies [c29fd4c]
  - @opengeni/db@0.27.7
  - @opengeni/documents@0.5.3
  - @opengeni/events@0.3.73

## 0.20.9

### Patch Changes

- 664c1d8: Bound MCP OAuth setup with an absolute server deadline, abort stalled response streams, and preserve safe stage-specific API error details in SDK clients.
  - @opengeni/db@0.27.6
  - @opengeni/runtime@0.18.10
  - @opengeni/documents@0.5.2
  - @opengeni/events@0.3.72

## 0.20.8

### Patch Changes

- Updated dependencies [c9d8b69]
  - @opengeni/contracts@0.38.1
  - @opengeni/db@0.27.5
  - @opengeni/config@0.10.11
  - @opengeni/documents@0.5.1
  - @opengeni/events@0.3.71
  - @opengeni/observability@0.4.14
  - @opengeni/runtime@0.18.9
  - @opengeni/storage@0.2.64

## 0.20.7

### Patch Changes

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/db@0.27.4
  - @opengeni/config@0.10.10
  - @opengeni/contracts@0.38.0
  - @opengeni/documents@0.5.0
  - @opengeni/events@0.3.70
  - @opengeni/runtime@0.18.8
  - @opengeni/storage@0.2.63
  - @opengeni/observability@0.4.13

## 0.20.6

### Patch Changes

- 4976e1c: Fix DNS-pinned OAuth response streaming under Bun and expose X as a built-in workspace social capability.
- Updated dependencies [d5df927]
  - @opengeni/documents@0.4.1
  - @opengeni/db@0.27.3
  - @opengeni/runtime@0.18.7
  - @opengeni/events@0.3.69

## 0.20.5

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/contracts@0.37.0
  - @opengeni/documents@0.4.0
  - @opengeni/config@0.10.9
  - @opengeni/db@0.27.2
  - @opengeni/events@0.3.68
  - @opengeni/observability@0.4.12
  - @opengeni/runtime@0.18.6
  - @opengeni/storage@0.2.62

## 0.20.4

### Patch Changes

- Updated dependencies [abe0de6]
  - @opengeni/config@0.10.8
  - @opengeni/contracts@0.36.1
  - @opengeni/db@0.27.1
  - @opengeni/documents@0.3.4
  - @opengeni/runtime@0.18.5
  - @opengeni/storage@0.2.61
  - @opengeni/events@0.3.67
  - @opengeni/observability@0.4.11

## 0.20.3

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/contracts@0.36.0
  - @opengeni/db@0.27.0
  - @opengeni/config@0.10.7
  - @opengeni/documents@0.3.3
  - @opengeni/events@0.3.66
  - @opengeni/observability@0.4.10
  - @opengeni/runtime@0.18.4
  - @opengeni/storage@0.2.60

## 0.20.2

### Patch Changes

- Updated dependencies [b121e7c]
  - @opengeni/contracts@0.35.0
  - @opengeni/db@0.26.0
  - @opengeni/config@0.10.6
  - @opengeni/documents@0.3.2
  - @opengeni/events@0.3.65
  - @opengeni/observability@0.4.9
  - @opengeni/runtime@0.18.3
  - @opengeni/storage@0.2.59

## 0.20.1

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/contracts@0.34.0
  - @opengeni/db@0.25.0
  - @opengeni/config@0.10.5
  - @opengeni/documents@0.3.1
  - @opengeni/events@0.3.64
  - @opengeni/observability@0.4.8
  - @opengeni/runtime@0.18.2
  - @opengeni/storage@0.2.58

## 0.20.0

### Minor Changes

- d1f0c3d: Add immutable organization, workspace, and initiating-user personal authority to Documents and chunks; filter retrieval by exact account and authority before ranking; require exact account-admin authority for organization publication; and preserve authority through a drained API, worker, and indexing-workflow cutover.

### Patch Changes

- Updated dependencies [d1f0c3d]
- Updated dependencies [1d0f2ae]
- Updated dependencies [088d7cb]
- Updated dependencies [74bd3a5]
- Updated dependencies [3e4842d]
  - @opengeni/contracts@0.33.0
  - @opengeni/documents@0.3.0
  - @opengeni/db@0.24.0
  - @opengeni/config@0.10.4
  - @opengeni/runtime@0.18.1
  - @opengeni/events@0.3.63
  - @opengeni/observability@0.4.7
  - @opengeni/storage@0.2.57

## 0.19.0

### Minor Changes

- 13b961e: Add an atomic terminal session-subtree cancellation command that drains queued work, fences concurrent prompts and child creation, interrupts live attempts, durably reports cancelled children to surviving parents, and exposes the operation through the API/core/SDK control surface.
- e03397d: Freeze workspace instruction policies and structured preference descriptors at
  the accepted logical-turn boundary, add immutable per-session policy roles, and
  compose the resulting exact-attempt governance into agent and compaction prompts.

### Patch Changes

- Updated dependencies [13b961e]
- Updated dependencies [ecc4288]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [acfcf38]
- Updated dependencies [3baaebd]
  - @opengeni/contracts@0.32.0
  - @opengeni/db@0.23.0
  - @opengeni/runtime@0.18.0
  - @opengeni/codex@0.2.10
  - @opengeni/config@0.10.3
  - @opengeni/documents@0.2.72
  - @opengeni/events@0.3.62
  - @opengeni/observability@0.4.6
  - @opengeni/storage@0.2.56

## 0.18.2

### Patch Changes

- e62495f: Allow session creators to explicitly opt out of a workspace default rig, and make live release acceptance prove its fixture command completed before waiting for a workspace capture.
- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
- Updated dependencies [b4982fa]
- Updated dependencies [70e6d56]
  - @opengeni/contracts@0.31.2
  - @opengeni/config@0.10.2
  - @opengeni/runtime@0.17.2
  - @opengeni/db@0.22.3
  - @opengeni/documents@0.2.71
  - @opengeni/events@0.3.61
  - @opengeni/observability@0.4.5
  - @opengeni/storage@0.2.55

## 0.18.1

### Patch Changes

- 9c4d73d: Add curated OpenGeni-credit and workspace-key Vercel AI Gateway model paths for
  DeepSeek V4 Flash and Kimi K3, including exact provider routing, cache-aware
  pricing and metering, Responses tool continuity, provider-blind catalog UX, and
  stable remote-compaction cache prefixes.
- Updated dependencies [9c4d73d]
  - @opengeni/config@0.10.1
  - @opengeni/contracts@0.31.1
  - @opengeni/db@0.22.2
  - @opengeni/runtime@0.17.1
  - @opengeni/documents@0.2.70
  - @opengeni/storage@0.2.54
  - @opengeni/events@0.3.60
  - @opengeni/observability@0.4.4

## 0.18.0

### Minor Changes

- 8b3e46f: Allow a digest-pinned capability-pack sandbox image to bind an immutable Modal image ID. OpenGeni now preserves the logical OCI digest on the lease, starts the provider-native image through `ModalImageSelector.fromId`, records the actual ID in the Modal session envelope, clears lower-precedence IDs when a rig overrides the image, and keeps catalog image metadata aligned with the runtime manifest.

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/config@0.10.0
  - @opengeni/contracts@0.31.0
  - @opengeni/runtime@0.17.0
  - @opengeni/db@0.22.1
  - @opengeni/documents@0.2.69
  - @opengeni/storage@0.2.53
  - @opengeni/events@0.3.59
  - @opengeni/observability@0.4.3

## 0.17.3

### Patch Changes

- c4a0031: Add a fail-closed, secret-redacted, byte-bounded Workspace Memory Slack
  publication policy and immutable projection contract, including deterministic
  denial for secret-bearing selectors, malformed projection input, and
  self-referential change lineage.
- Updated dependencies [e07eb52]
- Updated dependencies [4fcb6af]
  - @opengeni/db@0.22.0
  - @opengeni/runtime@0.16.3
  - @opengeni/documents@0.2.68
  - @opengeni/events@0.3.58

## 0.17.2

### Patch Changes

- Updated dependencies [6500589]
  - @opengeni/documents@0.2.67

## 0.17.1

### Patch Changes

- Updated dependencies [2321119]
  - @opengeni/contracts@0.30.0
  - @opengeni/db@0.21.0
  - @opengeni/config@0.9.3
  - @opengeni/documents@0.2.66
  - @opengeni/events@0.3.57
  - @opengeni/observability@0.4.2
  - @opengeni/runtime@0.16.2
  - @opengeni/storage@0.2.52

## 0.17.0

### Minor Changes

- dd71248: Make workspace-owned MCP OAuth connections the default, add explicit personal
  connection ownership, and preserve exact delegated personal authority across
  turns, child sessions, goals, schedules, retries, and recovery with safe
  tool-level degradation when a personal connection is unavailable.

### Patch Changes

- Updated dependencies [f4fa05c]
- Updated dependencies [dd71248]
- Updated dependencies [03ed7eb]
  - @opengeni/runtime@0.16.1
  - @opengeni/contracts@0.29.0
  - @opengeni/db@0.20.0
  - @opengeni/config@0.9.2
  - @opengeni/documents@0.2.65
  - @opengeni/events@0.3.56
  - @opengeni/observability@0.4.1
  - @opengeni/storage@0.2.51

## 0.16.3

### Patch Changes

- Updated dependencies [38ba6bc]
  - @opengeni/observability@0.4.0
  - @opengeni/runtime@0.16.0

## 0.16.2

### Patch Changes

- Updated dependencies [1a2d41f]
  - @opengeni/db@0.19.0
  - @opengeni/documents@0.2.64
  - @opengeni/events@0.3.55

## 0.16.1

### Patch Changes

- Updated dependencies [659b3ff]
  - @opengeni/contracts@0.28.1
  - @opengeni/db@0.18.1
  - @opengeni/config@0.9.1
  - @opengeni/documents@0.2.63
  - @opengeni/events@0.3.54
  - @opengeni/runtime@0.15.3
  - @opengeni/storage@0.2.50

## 0.16.0

### Minor Changes

- 5a4c559: Add first-party X and Reddit social connectors: OAuth connect flows (X PKCE
  S256, Reddit permanent grant) with encrypted token storage and just-in-time
  refresh, live first-party MCP tools (search, mentions, thread fetch, own-post
  sync, permission-gated reply publishing), a reddit provider in the marketing
  pack, operator config via OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON, and SDK
  startSocialOAuth/listSocialConnections.

### Patch Changes

- Updated dependencies [d4d8960]
- Updated dependencies [ec0bc02]
- Updated dependencies [3b8d653]
- Updated dependencies [5a4c559]
  - @opengeni/contracts@0.28.0
  - @opengeni/db@0.18.0
  - @opengeni/config@0.9.0
  - @opengeni/runtime@0.15.2
  - @opengeni/documents@0.2.62
  - @opengeni/events@0.3.53
  - @opengeni/storage@0.2.49

## 0.15.1

### Patch Changes

- Updated dependencies [8243ffe]
  - @opengeni/config@0.8.1
  - @opengeni/db@0.17.1
  - @opengeni/documents@0.2.61
  - @opengeni/runtime@0.15.1
  - @opengeni/storage@0.2.48
  - @opengeni/events@0.3.52

## 0.15.0

### Minor Changes

- 1ec9912: Add generic, versioned workspace artifacts with content-addressed HTML storage, a static HTML/CSS renderer, rollback history, and first-party agent publishing tools. JavaScript and active or navigation-capable markup are removed from the initial renderer until executable artifacts have a stronger isolation boundary.

### Patch Changes

- dcc35c5: Add authenticated Slack mentions, commands, message shortcuts, atomically private bot-DM sessions, durable thread continuation, and globally bounded idempotent progress delivery.
- Updated dependencies [dcc35c5]
- Updated dependencies [1ec9912]
  - @opengeni/config@0.8.0
  - @opengeni/contracts@0.27.0
  - @opengeni/db@0.17.0
  - @opengeni/runtime@0.15.0
  - @opengeni/documents@0.2.60
  - @opengeni/storage@0.2.47
  - @opengeni/events@0.3.51

## 0.14.4

### Patch Changes

- Updated dependencies [cb4d78d]
  - @opengeni/runtime@0.14.16

## 0.14.3

### Patch Changes

- c52acc0: Ship Fast latency mode with turn-column inheritance, Codex ChatGPT honor-skip for response service_tier, and model picker UX polish.
- Updated dependencies [c52acc0]
  - @opengeni/codex@0.2.9
  - @opengeni/config@0.7.22
  - @opengeni/contracts@0.26.1
  - @opengeni/db@0.16.2
  - @opengeni/runtime@0.14.15
  - @opengeni/documents@0.2.59
  - @opengeni/storage@0.2.46
  - @opengeni/events@0.3.50

## 0.14.2

### Patch Changes

- Updated dependencies [11cdf20]
  - @opengeni/runtime@0.14.14

## 0.14.1

### Patch Changes

- Updated dependencies [02fb98c]
  - @opengeni/db@0.16.1
  - @opengeni/documents@0.2.58
  - @opengeni/events@0.3.49

## 0.14.0

### Minor Changes

- f413e6c: Add real Workspace Insights: durable `model_call_facts` after authoritative
  `agent.model.usage`, a `workspace:admin` insights API over usage_events + facts +
  live joins, SDK client, and a web console that drops mock rollups for honest
  UTC credit/token/cache/warm/caps reporting.

### Patch Changes

- Updated dependencies [b5175a8]
- Updated dependencies [f413e6c]
  - @opengeni/db@0.16.0
  - @opengeni/contracts@0.26.0
  - @opengeni/documents@0.2.57
  - @opengeni/events@0.3.48
  - @opengeni/config@0.7.21
  - @opengeni/runtime@0.14.13
  - @opengeni/storage@0.2.45

## 0.13.10

### Patch Changes

- 0199108: Harden the workspace Slack bot with one fail-closed scope policy, deterministic legacy connection selection, and durable replay-safe message deletion operation identities.
- 42428a2: Add per-session Codex remote compaction v2 (`remote_v2` / `portable`), with UI landmarks, Codex-only model locking, and opaque token accounting aligned to Codex CLI.
- Updated dependencies [0199108]
- Updated dependencies [42428a2]
- Updated dependencies [7b65614]
- Updated dependencies [b2e975f]
- Updated dependencies [9f3b931]
  - @opengeni/contracts@0.25.0
  - @opengeni/db@0.15.6
  - @opengeni/runtime@0.14.12
  - @opengeni/config@0.7.20
  - @opengeni/storage@0.2.44
  - @opengeni/documents@0.2.56
  - @opengeni/events@0.3.47

## Unreleased

### Minor Changes

- Add `TranscriptionService` / `TranscriptionProvider` port and optional
  `AppDependencies.transcription` for native workspace voice-input transcription.
- Allow `available({ workspaceId })` so providers can require a workspace-attached
  credential during selection (Codex subscription STT).

## 0.13.9

### Patch Changes

- 710b081: Keep sessions usable when a previously selected MCP capability is disconnected or removed. Unavailable historical refs remain visible in effective policy but are omitted from executable tools, and the agent receives a bounded turn-level warning not to claim access to the missing source.
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
  - @opengeni/db@0.15.5
  - @opengeni/runtime@0.14.11
  - @opengeni/documents@0.2.55
  - @opengeni/events@0.3.46
  - @opengeni/storage@0.2.43

## 0.13.8

### Patch Changes

- Updated dependencies [84fb671]
- Updated dependencies [96eb64b]
  - @opengeni/db@0.15.4
  - @opengeni/config@0.7.18
  - @opengeni/contracts@0.24.2
  - @opengeni/runtime@0.14.10
  - @opengeni/storage@0.2.42
  - @opengeni/documents@0.2.54
  - @opengeni/events@0.3.45

## 0.13.7

### Patch Changes

- Updated dependencies [510eae3]
  - @opengeni/db@0.15.3
  - @opengeni/documents@0.2.53
  - @opengeni/events@0.3.44

## 0.13.6

### Patch Changes

- Updated dependencies [3450ee5]
- Updated dependencies [ddff8db]
- Updated dependencies [0a9a6eb]
  - @opengeni/runtime@0.14.9
  - @opengeni/contracts@0.24.1
  - @opengeni/db@0.15.2
  - @opengeni/documents@0.2.52
  - @opengeni/config@0.7.17
  - @opengeni/storage@0.2.41
  - @opengeni/events@0.3.43

## 0.13.5

### Patch Changes

- Updated dependencies [6d167f4]
  - @opengeni/codex@0.2.8
  - @opengeni/db@0.15.1
  - @opengeni/config@0.7.16
  - @opengeni/runtime@0.14.8
  - @opengeni/documents@0.2.51
  - @opengeni/events@0.3.42
  - @opengeni/storage@0.2.40

## 0.13.4

### Patch Changes

- Updated dependencies [a19971e]
- Updated dependencies [1f6f13f]
  - @opengeni/config@0.7.15
  - @opengeni/contracts@0.24.0
  - @opengeni/db@0.15.0
  - @opengeni/runtime@0.14.7
  - @opengeni/documents@0.2.50
  - @opengeni/storage@0.2.39
  - @opengeni/events@0.3.41

## 0.13.3

### Patch Changes

- Updated dependencies [848287f]
- Updated dependencies [2a7900f]
- Updated dependencies [821f664]
  - @opengeni/db@0.14.7
  - @opengeni/runtime@0.14.6
  - @opengeni/documents@0.2.49
  - @opengeni/events@0.3.40

## 0.13.2

### Patch Changes

- Updated dependencies [2aca964]
  - @opengeni/db@0.14.6
  - @opengeni/documents@0.2.48
  - @opengeni/events@0.3.39

## 0.13.1

### Patch Changes

- Updated dependencies [ad0bdc3]
  - @opengeni/contracts@0.23.1
  - @opengeni/db@0.14.5
  - @opengeni/config@0.7.14
  - @opengeni/documents@0.2.47
  - @opengeni/events@0.3.38
  - @opengeni/runtime@0.14.5
  - @opengeni/storage@0.2.38

## 0.13.0

### Minor Changes

- 1973d2a: Treat provider-native web search as an always-on runtime capability whenever
  the selected provider supports it. Session MCP selection no longer disables
  native search.
- 8478e60: Default workspace-tracking sessions to every configured MCP server while
  preserving exact explicit API allow-lists. Keep OpenGeni's internal carrier and
  default-on Files surface out of the web picker's visible choices and counts.
  Settle provider-native web searches from their own terminal status, render each
  web action truthfully, keep completed searches before the answer they informed,
  and hide unresolved private citation handles from the human timeline.

### Patch Changes

- bcb50cf: Thread the configured Connected Machine control and exec deadlines through
  `run_on`, and return truthful typed timeout/deadline command receipts without
  replaying ambiguous execution.
- Updated dependencies [ea38a4c]
- Updated dependencies [39b1b84]
- Updated dependencies [bcb50cf]
  - @opengeni/db@0.14.4
  - @opengeni/runtime@0.14.4
  - @opengeni/documents@0.2.46
  - @opengeni/events@0.3.37

## 0.12.10

### Patch Changes

- Updated dependencies [33dc88f]
- Updated dependencies [36451c6]
  - @opengeni/contracts@0.23.0
  - @opengeni/config@0.7.13
  - @opengeni/runtime@0.14.3
  - @opengeni/db@0.14.3
  - @opengeni/documents@0.2.45
  - @opengeni/events@0.3.36
  - @opengeni/storage@0.2.37

## 0.12.9

### Patch Changes

- 47a0927: Authorize first-party MCP Pause, Resume, and Agent Steer commands exactly once at the canonical command boundary instead of repeating the embedding host authorization call before persistence.
- 1c4018e: Replace one-turn tool overrides with one durable session tool policy, expose
  OpenGeni-native tools in the same selection, default available tools on, and
  render delivered machine inputs as compact typed timeline updates instead of
  raw protocol JSON.
- Updated dependencies [1c4018e]
  - @opengeni/config@0.7.12
  - @opengeni/contracts@0.22.1
  - @opengeni/db@0.14.2
  - @opengeni/documents@0.2.44
  - @opengeni/runtime@0.14.2
  - @opengeni/storage@0.2.36
  - @opengeni/events@0.3.35

## 0.12.8

### Patch Changes

- Updated dependencies [6908a7a]
  - @opengeni/db@0.14.1
  - @opengeni/documents@0.2.43
  - @opengeni/events@0.3.34

## 0.12.7

### Patch Changes

- f2eebc8: Route Codex Apps through the durable per-session MCP tool policy so exact
  allowlists cannot be widened by a runtime credential overlay.

## 0.12.6

### Patch Changes

- dfc3235: Separate first-party MCP authorization from exact per-session tool visibility, add fail-closed registration policy, and isolate file download URLs on the files MCP surface.
- Updated dependencies [29ad09b]
- Updated dependencies [b2e23f3]
- Updated dependencies [dfc3235]
  - @opengeni/contracts@0.22.0
  - @opengeni/db@0.14.0
  - @opengeni/runtime@0.14.1
  - @opengeni/config@0.7.11
  - @opengeni/documents@0.2.42
  - @opengeni/events@0.3.33
  - @opengeni/storage@0.2.35

## 0.12.5

### Patch Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.
- 7b962a6: Honor valid delegated worker access in local mode so signed session and turn metadata, along with narrowed permissions, reach first-party MCP tools.
- Updated dependencies [519d93c]
  - @opengeni/contracts@0.21.0
  - @opengeni/runtime@0.14.0
  - @opengeni/config@0.7.10
  - @opengeni/db@0.13.4
  - @opengeni/documents@0.2.41
  - @opengeni/events@0.3.32
  - @opengeni/storage@0.2.34

## 0.12.4

### Patch Changes

- 110bb77: Enforce exact-subject ownership for personal OAuth capabilities and add secure direct OAuth installation for the separate workspace OpenGeni Slack bot.
- Updated dependencies [110bb77]
  - @opengeni/config@0.7.9
  - @opengeni/contracts@0.20.2
  - @opengeni/db@0.13.3
  - @opengeni/runtime@0.13.14
  - @opengeni/documents@0.2.40
  - @opengeni/storage@0.2.33
  - @opengeni/events@0.3.31

## 0.12.3

### Patch Changes

- Updated dependencies [8b8545e]
  - @opengeni/db@0.13.2
  - @opengeni/documents@0.2.39
  - @opengeni/events@0.3.30

## 0.12.2

### Patch Changes

- Updated dependencies [f92af07]
  - @opengeni/runtime@0.13.13

## 0.12.1

### Patch Changes

- Updated dependencies [ffd246c]
  - @opengeni/contracts@0.20.1
  - @opengeni/runtime@0.13.12
  - @opengeni/config@0.7.8
  - @opengeni/db@0.13.1
  - @opengeni/documents@0.2.38
  - @opengeni/events@0.3.29
  - @opengeni/storage@0.2.32

## 0.12.0

### Minor Changes

- 5511c24: Add a secure workspace-shared OpenGeni Slack bot connection with schema-backed verified-install eligibility, immutable team/bot identity across reinstall, idempotent post-operation convergence, exact scope validation, first-party channel/history/user/post tools, explicit scheduled-task routing and rebinding, and install/reinstall/recovery UI and documentation.

### Patch Changes

- fd764e0: Route direct file, Git, and terminal calls to a machine-targeted session from the first request without creating a phantom provider lease, and make token-driven agent installation replace stale enrollment credentials.
- Updated dependencies [06a5801]
- Updated dependencies [9326255]
- Updated dependencies [5511c24]
  - @opengeni/contracts@0.20.0
  - @opengeni/db@0.13.0
  - @opengeni/config@0.7.7
  - @opengeni/documents@0.2.37
  - @opengeni/events@0.3.28
  - @opengeni/runtime@0.13.11
  - @opengeni/storage@0.2.31

## 0.11.8

### Patch Changes

- c135339: Persist safe new-session defaults after successful creates while preserving explicit tool-policy semantics and revalidating stale workspace resources before reuse.
- Updated dependencies [9a8f793]
- Updated dependencies [c135339]
- Updated dependencies [543bb26]
- Updated dependencies [8356146]
  - @opengeni/contracts@0.19.4
  - @opengeni/db@0.12.6
  - @opengeni/runtime@0.13.10
  - @opengeni/config@0.7.6
  - @opengeni/documents@0.2.36
  - @opengeni/events@0.3.27
  - @opengeni/storage@0.2.30

## 0.11.7

### Patch Changes

- Updated dependencies [a0f2442]
  - @opengeni/contracts@0.19.3
  - @opengeni/config@0.7.5
  - @opengeni/db@0.12.5
  - @opengeni/documents@0.2.35
  - @opengeni/events@0.3.26
  - @opengeni/runtime@0.13.9
  - @opengeni/storage@0.2.29

## 0.11.6

### Patch Changes

- 85cb323: Restore provider-native web search for workspace-default Codex sessions while preserving explicit
  tool narrowing, child policy ceilings, version-fenced policy adoption, and structured URL citations.
- Updated dependencies [85cb323]
  - @opengeni/config@0.7.4
  - @opengeni/contracts@0.19.2
  - @opengeni/db@0.12.4
  - @opengeni/documents@0.2.34
  - @opengeni/runtime@0.13.8
  - @opengeni/storage@0.2.28
  - @opengeni/events@0.3.25

## 0.11.5

### Patch Changes

- Updated dependencies [1386679]
- Updated dependencies [b7290a3]
- Updated dependencies [dcde939]
- Updated dependencies [5685f32]
- Updated dependencies [de20184]
  - @opengeni/db@0.12.3
  - @opengeni/runtime@0.13.7
  - @opengeni/config@0.7.3
  - @opengeni/contracts@0.19.1
  - @opengeni/documents@0.2.33
  - @opengeni/events@0.3.24
  - @opengeni/storage@0.2.27

## 0.11.4

### Patch Changes

- Updated dependencies [7c6aa7c]
  - @opengeni/config@0.7.2
  - @opengeni/db@0.12.2
  - @opengeni/documents@0.2.32
  - @opengeni/runtime@0.13.6
  - @opengeni/storage@0.2.26
  - @opengeni/events@0.3.23

## 0.11.3

### Patch Changes

- Updated dependencies [d03ee4b]
  - @opengeni/runtime@0.13.5

## 0.11.2

### Patch Changes

- Updated dependencies [55c6559]
- Updated dependencies [ac20b93]
  - @opengeni/config@0.7.1
  - @opengeni/runtime@0.13.4
  - @opengeni/db@0.12.1
  - @opengeni/documents@0.2.31
  - @opengeni/storage@0.2.25
  - @opengeni/events@0.3.22

## 0.11.1

### Patch Changes

- Updated dependencies [43e3503]
  - @opengeni/runtime@0.13.3

## 0.11.0

### Minor Changes

- 46bac05: Enforce a configurable inclusive nested-agent depth at the transactional
  session-creation boundary with a server default of three. Persist immutable
  lineage and policy snapshots, and return idempotent typed denial evidence without
  creating run, workflow, sandbox, usage, or billing artifacts.

### Patch Changes

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
  - @opengeni/db@0.12.0
  - @opengeni/config@0.7.0
  - @opengeni/runtime@0.13.2
  - @opengeni/documents@0.2.30
  - @opengeni/events@0.3.21
  - @opengeni/storage@0.2.24

## 0.10.1

### Patch Changes

- Updated dependencies [744a93d]
- Updated dependencies [0ed0f01]
- Updated dependencies [b32938f]
  - @opengeni/config@0.6.10
  - @opengeni/contracts@0.18.1
  - @opengeni/db@0.11.0
  - @opengeni/documents@0.2.29
  - @opengeni/runtime@0.13.1
  - @opengeni/storage@0.2.23
  - @opengeni/events@0.3.20

## 0.10.0

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

- Updated dependencies [0d60720]
- Updated dependencies [bdd531c]
  - @opengeni/config@0.6.9
  - @opengeni/contracts@0.18.0
  - @opengeni/db@0.10.7
  - @opengeni/runtime@0.13.0
  - @opengeni/codex@0.2.7
  - @opengeni/documents@0.2.28
  - @opengeni/storage@0.2.22
  - @opengeni/events@0.3.19

## 0.9.7

### Patch Changes

- 524599e: Normalize model, provider, upstream deployment, credential source, billing,
  capability, health, and pricing identity; expose a secret-safe authenticated
  workspace catalog with separate fail-closed credential readiness for federated
  providers; and persist the accepted model/reasoning execution policy on new
  logical turns.
- Updated dependencies [524599e]
  - @opengeni/config@0.6.8
  - @opengeni/contracts@0.17.3
  - @opengeni/db@0.10.6
  - @opengeni/runtime@0.12.6
  - @opengeni/documents@0.2.27
  - @opengeni/storage@0.2.21
  - @opengeni/events@0.3.18

## 0.9.6

### Patch Changes

- 229902b: Add trustworthy per-subscription Codex quota/reset-credit overview and allocator OCC controls, plus an owning-human managed-cookie-only reset redemption flow with durable ambiguity-safe provider idempotency.
- Updated dependencies [229902b]
  - @opengeni/codex@0.2.6
  - @opengeni/db@0.10.5
  - @opengeni/config@0.6.7
  - @opengeni/runtime@0.12.5
  - @opengeni/documents@0.2.26
  - @opengeni/events@0.3.17
  - @opengeni/storage@0.2.20

## 0.9.5

### Patch Changes

- Updated dependencies [4966649]
- Updated dependencies [cb188f9]
  - @opengeni/contracts@0.17.2
  - @opengeni/db@0.10.4
  - @opengeni/config@0.6.6
  - @opengeni/runtime@0.12.4
  - @opengeni/documents@0.2.25
  - @opengeni/events@0.3.16
  - @opengeni/storage@0.2.19

## 0.9.4

### Patch Changes

- Updated dependencies [2174006]
- Updated dependencies [4e16410]
  - @opengeni/runtime@0.12.3

## 0.9.3

### Patch Changes

- Updated dependencies [495c62c]
  - @opengeni/db@0.10.3
  - @opengeni/documents@0.2.24
  - @opengeni/events@0.3.15

## 0.9.2

### Patch Changes

- Updated dependencies [ff23da5]
  - @opengeni/contracts@0.17.1
  - @opengeni/db@0.10.2
  - @opengeni/events@0.3.14
  - @opengeni/storage@0.2.18
  - @opengeni/config@0.6.5
  - @opengeni/documents@0.2.23
  - @opengeni/runtime@0.12.2

## 0.9.1

### Patch Changes

- Updated dependencies [eed3438]
  - @opengeni/db@0.10.1
  - @opengeni/documents@0.2.22
  - @opengeni/events@0.3.13

## 0.9.0

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
  - @opengeni/db@0.10.0
  - @opengeni/documents@0.2.21
  - @opengeni/events@0.3.12
  - @opengeni/runtime@0.12.1
  - @opengeni/storage@0.2.17

## 0.8.1

### Patch Changes

- Updated dependencies [b9cec61]
- Updated dependencies [c978676]
  - @opengeni/contracts@0.16.0
  - @opengeni/runtime@0.12.0
  - @opengeni/config@0.6.3
  - @opengeni/db@0.9.4
  - @opengeni/documents@0.2.20
  - @opengeni/events@0.3.11
  - @opengeni/storage@0.2.16

## 0.8.0

### Minor Changes

- 9f84cc9: Add durable host-provided per-turn instructions, headless structured-input hooks, host-local queue
  focus, and reusable approval and human-input surfaces for embedded session consumers.

### Patch Changes

- Updated dependencies [9f84cc9]
  - @opengeni/contracts@0.15.0
  - @opengeni/db@0.9.3
  - @opengeni/runtime@0.11.0
  - @opengeni/config@0.6.2
  - @opengeni/documents@0.2.19
  - @opengeni/events@0.3.10
  - @opengeni/storage@0.2.15

## 0.7.0

### Minor Changes

- 136227e: Add an immutable, versioned curated skill library with explicit workspace selection and inspectable provenance, and preserve WCAG AA contrast for dark-theme primary actions.

### Patch Changes

- Updated dependencies [136227e]
- Updated dependencies [3aee519]
  - @opengeni/contracts@0.14.0
  - @opengeni/runtime@0.10.0
  - @opengeni/config@0.6.1
  - @opengeni/db@0.9.2
  - @opengeni/documents@0.2.18
  - @opengeni/events@0.3.9
  - @opengeni/storage@0.2.14

## 0.6.1

### Patch Changes

- 1f0ed18: Restore immutable concurrent-index migration history, stage populated-table migrations safely, and reject goal-bearing child sessions whose resulting first-party authority lacks `goals:manage`.
- Updated dependencies [1f0ed18]
- Updated dependencies [00e1cdc]
  - @opengeni/db@0.9.1
  - @opengeni/documents@0.2.17
  - @opengeni/events@0.3.8

## 0.6.0

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
- 4401ce7: Add a scope-checked host MCP credential resolver to the public embedding port and use it consistently for model-visible MCP tools and Toolspace/Code Mode while preserving the standalone connection broker as the default. Requests carry both the immediate session and its workspace-scoped lineage root so embedded hosts can authorize child sessions through one durable root binding. Provider-neutral bindings now carry a provider family, provider host, opaque host binding id, and exact selected-repository set; successful credentials must echo the complete binding before headers are accepted. Incompatible endpoint authentication and unenforceable resource containment surface as explicit unavailable states instead of starting a duplicate OpenGeni provider connection.
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

- 3a2258b: Preserve narrowed first-party MCP capability boundaries by inheriting the creating session's effective permissions for child sessions that omit an explicit override.
- Updated dependencies [1fcd83d]
- Updated dependencies [32011f1]
- Updated dependencies [3983021]
- Updated dependencies [4401ce7]
- Updated dependencies [c389adc]
- Updated dependencies [1f9305b]
- Updated dependencies [8c66185]
- Updated dependencies [3ce795b]
- Updated dependencies [334b63f]
- Updated dependencies [d249403]
- Updated dependencies [a11a7fc]
- Updated dependencies [94f2580]
- Updated dependencies [b9d6e58]
- Updated dependencies [44ff327]
- Updated dependencies [dda6398]
- Updated dependencies [5529945]
- Updated dependencies [e8ca4f6]
- Updated dependencies [736f4fe]
  - @opengeni/contracts@0.13.0
  - @opengeni/runtime@0.9.0
  - @opengeni/config@0.6.0
  - @opengeni/db@0.9.0
  - @opengeni/documents@0.2.16
  - @opengeni/events@0.3.7
  - @opengeni/storage@0.2.13

## 0.5.0

### Minor Changes

- dbb6232: Support linking an existing GitHub App installation to multiple OpenGeni workspaces with independent repository allowlists.

  - Discover installations through GitHub App user OAuth, require repository-level administrator permission, and configure the OAuth callback in generated App manifests.
  - Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
  - Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
  - Add SDK and web controls to link, rescope, and unlink a workspace without uninstalling the GitHub App or affecting another workspace.

### Patch Changes

- 77d65f9: Use one canonical lock order for session-event persistence and retry only idempotent database transactions after deadlock or serialization failures, including generic event appends and operation-keyed Agent commands.
- Updated dependencies [77d65f9]
- Updated dependencies
- Updated dependencies [dbb6232]
- Updated dependencies [3e65c23]
  - @opengeni/db@0.8.0
  - @opengeni/codex@0.2.5
  - @opengeni/config@0.5.3
  - @opengeni/contracts@0.12.0
  - @opengeni/events@0.3.6
  - @opengeni/runtime@0.8.2
  - @opengeni/documents@0.2.15
  - @opengeni/storage@0.2.12

## 0.4.12

### Patch Changes

- Updated dependencies [28290a0]
- Updated dependencies [9a7dec2]
  - @opengeni/db@0.7.5
  - @opengeni/runtime@0.8.1
  - @opengeni/documents@0.2.14
  - @opengeni/events@0.3.5

## 0.4.11

### Patch Changes

- Updated dependencies [14ce2e3]
- Updated dependencies [053c5df]
- Updated dependencies [ec0697a]
  - @opengeni/codex@0.2.4
  - @opengeni/config@0.5.2
  - @opengeni/db@0.7.4
  - @opengeni/runtime@0.8.0
  - @opengeni/contracts@0.11.0
  - @opengeni/documents@0.2.13
  - @opengeni/storage@0.2.11
  - @opengeni/events@0.3.4

## 0.4.10

### Patch Changes

- Updated dependencies [b9dbb63]
  - @opengeni/db@0.7.3
  - @opengeni/documents@0.2.12
  - @opengeni/events@0.3.3

## 0.4.9

### Patch Changes

- Updated dependencies [6882ff2]
  - @opengeni/codex@0.2.3
  - @opengeni/config@0.5.1
  - @opengeni/db@0.7.2
  - @opengeni/runtime@0.7.1
  - @opengeni/documents@0.2.11
  - @opengeni/storage@0.2.10
  - @opengeni/events@0.3.2

## 0.4.8

### Patch Changes

- Updated dependencies [ea52b39]
  - @opengeni/db@0.7.1
  - @opengeni/documents@0.2.10
  - @opengeni/events@0.3.1

## 0.4.7

### Patch Changes

- 332ac15: Add workspace-scoped operator session-revival admission helpers and pending-work guards for safe control-plane recovery tooling.
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
- 5942493: Repair missing file-upload usage records on idempotent finalize retries, reclaim abandoned direct-upload objects through a fenced Temporal cleanup schedule, and preserve accessible provider-backed image previews across reloads.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

- 9d4283d: Per-workspace model/provider hard-block policy. A new `workspace_model_policies` table (NULL = unrestricted) lets a workspace strictly allowlist which providers and/or exact model ids may serve its turns. Enforced twice: a 422 at every API model choke point (user message, queued-turn update, scheduled task, and session creation — where the EFFECTIVE model, `payload.model ?? deployment default`, is vetted, since an omitted model stamps the deployment default onto the session), and authoritatively in the worker immediately after turn model resolution, where a blocked provider/model throws `WorkspaceModelPolicyBlockedError` before any model call — including the legacy null-resolution fallback to the built-in OpenAI/Azure client, which is attributed to the built-in's own provider id so blocking the built-in also closes that path. Goal continuations that inherit a blocked model recover to the session's allowed default or pause the goal visibly with a truthful rationale. New `GET/PUT /v1/workspaces/:workspaceId/model-policy` routes (read / admin) manage the policy. Workspaces without a policy row behave exactly as before. This exists so a codex-subscription workspace can be fail-closed to codex: a turn may wait or fail loud, but can never fall through to a paid provider.
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
  - @opengeni/db@0.7.0
  - @opengeni/config@0.5.0
  - @opengeni/runtime@0.7.0
  - @opengeni/codex@0.2.2
  - @opengeni/contracts@0.10.0
  - @opengeni/documents@0.2.9
  - @opengeni/events@0.3.0
  - @opengeni/storage@0.2.9

## 0.4.6

### Patch Changes

- ac924ca: Fix Modal private-registry sandbox image handling for embedded deployments and republish the observability API surface.

  Modal registry Secrets are resolved through the authenticated OpenGeni Modal client, and Modal private-registry images are now warmed at turn time for pack-scoped sandbox images, not only at worker boot for the deployment-global image ref.

  `@opengeni/observability` is minor-bumped so the already-source-shipped `setGauge`, `incrementCounter`, `observeHistogram`, and `debug` methods are available to external consumers. The published direct dependents are patch-bumped so their 0.x caret ranges resolve to the new observability minor in a coherent install.

- Updated dependencies [ac924ca]
  - @opengeni/observability@0.3.0
  - @opengeni/runtime@0.6.1

## 0.4.5

### Patch Changes

- Updated dependencies [1e7a243]
  - @opengeni/config@0.4.0
  - @opengeni/runtime@0.6.0
  - @opengeni/db@0.6.1
  - @opengeni/documents@0.2.8
  - @opengeni/storage@0.2.8
  - @opengeni/events@0.2.8

## 0.4.4

### Patch Changes

- b34b912: Toolspace: selfhosted parity + generic programmatic-calling agent instructions.

  Connected-machine (selfhosted) turns now receive the toolspace token like every other backend. The git-token skip does not transfer: the platform GitHub token is inert on a user machine, but the toolspace token is the machine's only path to programmatic tool calling. It is safe to deliver because it grants no more than the machine owner's own authority — `toolspace:call` only, bound to its own session, turn TTL, budgeted, approval-tools excluded. Delivery mirrors the docker path: the token is seeded to `$OPENGENI_TOOLSPACE_TOKEN_FILE` over the machine's exec channel, off-manifest, targeting the public sandbox-routable API URL; the platform setup hooks (repository clone, az login) still never run against the user's machine.

  When a toolspace token is minted for a turn (feature enabled, any backend), the agent's composed instructions carry a short, generic substrate note: every MCP tool is also callable programmatically from the sandbox via `ogtool` (or MCP JSON-RPC to `$OPENGENI_TOOLSPACE_URL` with the bearer from `$OPENGENI_TOOLSPACE_TOKEN_FILE`), prefer programmatic calls for loops/polling/bulk filtering because those results do not consume model context, and approval-required tools must still be invoked normally. The note composes after the workspace persona + CORE but before the per-session instructions. The `@opengeni/core` and `@opengeni/api-router` bumps are the dependent-closure patch for the runtime minor.

- Updated dependencies [b34b912]
  - @opengeni/runtime@0.5.0

## 0.4.3

### Patch Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

- Updated dependencies [602db89]
  - @opengeni/contracts@0.9.0
  - @opengeni/config@0.3.0
  - @opengeni/db@0.6.0
  - @opengeni/runtime@0.4.0
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
