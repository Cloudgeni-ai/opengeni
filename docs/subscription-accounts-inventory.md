# Subscription accounts: entry-point inventory and Codex audit

> Historical inventory: M3 PR4 removes the executable Codex allocator and fleet
> shadow producer. Their references below now point to test-only historical
> fixtures; they are not current runtime authority. Current deployment requires
> the drained, codec-aware 0689 receipt/readiness gate.


Baseline: `origin/main` at `0d7075e` (7 October 2026). Research and documentation only; no product code was changed.

This document is the evidence base for the provider-neutral subscription behaviour contract. It records what the code does today for Codex (ChatGPT subscription), Claude (Claude subscription) and SuperGrok (xAI subscription, `xai` in code), and where that differs from the documented Codex contract and from the agreed target model recorded in [subscription-accounts.md](subscription-accounts.md) (agreed 2026-10-07).

## How to read this

- **Parts.** Part 1 inventories entry points. Part 2 is a per-provider capability matrix. Part 3 audits the Codex contract against code. Part 4 inventories the data model.
- **IDs.** Entry points use stable IDs grouped by area: `EP-T..` turn-time and accepted work, `EP-N..` non-chat consumers, `EP-S..` API, SDK and UI surfaces. Codex audit findings are `CA-..`. The IDs are stable so later work items and reviews can cite them; the behaviour contract states target behaviour and does not cite them.
- **References.** Paths are repo-relative; `file:line` refers to `0d7075e`. Where a function name is given, prefer it over the line number if the file has moved. Part 3 abbreviates `packages/db/src/index.ts` as `db`, `docs/codex-subscription-rotation.md` as `rot.md` and `docs/codex-provider-account-authority.md` as `auth.md`.
- **Confidence.** Claims come from reading code and migrations. Nothing was executed against a database or provider. Points that could not be confirmed are marked **uncertain** with the reason, and collected in the appendix.
- **Flags.** **CONTRADICTION**: doc and code disagree. **TARGET-CONFLICT**: current behaviour conflicts with the agreed target model (organization-owned connections scoped to the organization, chosen workspaces or chosen people; organization accounts preferred; personal accounts only by explicit choice or by the owner's opt-in fallback when the organization pool is exhausted, trying the same model on the personal account before another provider (SUB-SEL-02, D-03, D-12); session-level account stickiness while the prompt cache is warm; automatic same- and cross-provider failover; organization settings with lockable workspace overrides; pools never change session visibility).

## Summary: most important divergences and risks

1. **Private sessions cannot arm or recover a Claude or SuperGrok capacity wait, and both call sites are pinned down.** Reactive arming after a refused Claude or SuperGrok request runs in `settleTurnFailure`, which is called outside the turn's session access context (`apps/worker/src/activities/agent-turn/run.ts:1915-1921`), under the synthetic `worker:<provider>-workspace` subject; background recovery (`apps/worker/src/activities/codex-capacity.ts:313-361`) does the same. RESTRICTIVE `session_visibility_isolation` policies on the Claude/SuperGrok waiter and pin tables (`packages/db/drizzle/0236_session_visibility_slack_policy.sql:41-70`, copied to Claude by `0598_claude_subscription_account_pools.sql:136-146`) then hide private sessions. Codex escapes only because its database calls run with an empty subject, which sees every session (CA-05). Neither behaviour matches the target rule "re-establish the initiating human" (EP-T07, EP-T09).
2. **Accepted pool scope drifts between turns.** Only a direct human prompt resolves the pool at acceptance; operator, service (API key) and agent-attempt prompts get a hard-coded workspace snapshot (`packages/db/src/session-queue-commands.ts:2129-2146`), and at least eight writers and three readers silently fall back to workspace when authority is missing or not visible (EP-T11, EP-S20, EP-S22, EP-S23). On a session that runs on an organization or personal pool this selects a different, possibly empty, pool. This is a plausible cause of a resumed turn running under the wrong authority scope (code-path finding; not reproduced). Codex freezes nothing at acceptance; its source is frozen at the first lease (CA-04).
3. **Pool precedence is the opposite of the target.** Claude/SuperGrok: an active personal pool wins, then any workspace-owned row, then the organization pool (`packages/db/src/subscription-account-repository.ts:775`); any workspace row, whatever its status, hides the organization pool. Codex `automatic`: any workspace-local credential beats the organization pool, including a person's own credentials in their Personal workspace (CA-01). Personal accounts are bound to one workspace. There are no organization defaults, locks, or personal-fallback settings for any provider (CA-06, Part 4 §4.4.2).
4. **Stickiness is a per-session hash home, not a cache-aware session account.** Selection is "policy pin, else FNV hash of the session id over eligible accounts" for all three providers; the documented Codex `most_remaining` ranking and burst spreading are unreachable (CA-09, **CONTRADICTION**). No code looks at prompt-cache warmth; child agents, schedules and forks start with a fresh home (CA-14, CA-15); a Codex source-mode change clears every pin in the workspace; Claude/SuperGrok pins are keyed by pool scope, so scope drift (item 2) also changes the account.
5. **Failover is narrow and inconsistent.** Codex fails over within the pool with a bound (`codex_credential_failover_exhausted`); Claude and SuperGrok fail over through wait-plus-reconcile with no bound; Claude never rotates on 403. No provider fails over on 5xx, network errors or empty partial streams (CA-21). There is no cross-provider failover, and Codex `remote_v2` compaction (the default for new Codex sessions) locks a session to Codex for life (EP-T16, CA-34).
6. **Codex documentation is partly stale.** Besides CA-09: `AGENTS.md` describes a hard source-change fence that the code never throws (CA-04); organization pools with rotation off silently switch to a default account when the accepted active account disappears, while waiter reconciliation keeps waiting, so acquisition and reconciliation disagree (CA-12).
7. **Non-chat consumers bypass leases and accepted authority.** Codex transcription uses only the active pointer; Codex realtime uses pin-then-active; SuperGrok transcription, realtime and video selection take no lease; SuperGrok realtime and video funding resolve the caller's live pool and write the session pin that later turns use (EP-N02, EP-N03, EP-N06, EP-N07, EP-N12). SuperGrok video from an organization pool is admitted and then rejected at reconciliation (EP-N13), and video recovery refreshes a copied token outside the serialized refresh (EP-N14).
8. **Codex Apps and reset credits cannot work with organization-owned connections.** Both require a workspace-owned credential connected by the acting person (CA-29, CA-33). Two Apps defects are confirmed in code: errors are labelled `refresh_failed`, and "turn Apps off" returns 409 when the workspace source is organization or disabled, leaving a stale designation that keeps failing (EP-N16, EP-N17).
9. **The product surface is Codex-first.** Only Codex has a session account projection, manual pin API, account-switch events and the session account indicator; Claude/SuperGrok waits show only a generic "Waiting for capacity" (EP-S08, EP-S27, EP-S29, EP-S31). Permissions differ (`connections:write` for Codex, `workspace:admin` for Claude/SuperGrok), Claude has no status endpoint, and the SDK has no organization Codex methods (EP-S26).
10. **Two data models, and the Claude copy can drift.** Codex has bespoke tables; Claude and SuperGrok share a factory, but Claude's SQL functions, policies and triggers are a one-time text clone of xAI made in 0598, so later xAI-only changes do not reach Claude (examples: 0263 membership lifecycle, 0275/0478 scheduled-run checks, both **uncertain**). Codex has unused authority-snapshot columns from 0226 (Part 4 §4.4.1).
11. **Usability is checked late.** Only top-level session creation checks that a subscription account can serve the model; sends, child sessions and scheduled tasks defer to the worker (EP-S18–EP-S24). Billing bypass uses a live account check for Codex but a static catalog flag for Claude/SuperGrok (EP-N19).
12. **The Codex fleet shadow is not a cutover harness as built.** It records an alternative policy's decision beside the live one but not the live selector's inputs (session id, account order, pins, rotation, source, failure history, model and plan filters), covers only turn admission, uses unlinkable aliases, and is Codex-only. The pattern (default-off, post-decision, fail-open, bounded, attempt-fenced event, fixed-label metrics) is reusable with a new record version (Part 3, answer (c)).

## Part 1. Entry-point inventory

### 1.1 Turn-time and accepted-work entry points (EP-T)

These run inside or around the worker's `runAgentTurn` activity and the session workflow. Paths are under `apps/worker/src/activities/agent-turn/` unless stated.

#### Background: how authority reaches a turn

- **Claude and SuperGrok** freeze an opaque pool snapshot (`{scope: workspace | organization}` or `{scope: user, authorityGeneration}`) on every accepted row: `session_turns`, `sessions.initial_*`, `scheduled_tasks`, `session_system_updates`, `session_system_update_outbox` (Part 4, §4.2.2). The user-scope subject is not in the snapshot; it comes from `initiating_human_subject_id` (`packages/db/src/accepted-subscription-authority.ts:13` `subscriptionExecutionAuthorityFromTurn`).
- The live resolver used at acceptance is `resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptanceInTransaction` (`packages/db/src/subscription-account-repository.ts:775`). Order: the caller's personal pool if its rotation row has an active pointer to an active user credential; else, if **no** workspace-scoped credential row exists and the org pool has an active pointer, `organization`; else `workspace`. A personal pool therefore wins automatically, and any workspace-owned row (any status) hides the organization pool.
- **Codex** freezes nothing at acceptance. Its source and policy (`CodexCredentialPolicySnapshotV1`: source, active pointer, rotation, pin, last account) are written into `session_turns.metadata` at the turn's first lease and reused on recovery (`packages/db/src/index.ts:26291-26310` inside `acquireCodexCredentialLease`; sidecar `codex_turn_source_bindings`, migration 0492).
- Many writers fall back to the **workspace** snapshot when no authority is supplied: `createScheduledTask` (`packages/db/src/index.ts:17747`), `createSessionInTransaction` for non-subject creators (`:34654`), `materializeGoalContinuation` with no causal turn (`:69781`), `enqueueSessionTurn` (`:70904`), the compaction turn in `claimSessionWorkForAttempt` (`:74039`), `settleSessionInputWaitInActivity` (`:77008`), `addSessionSystemUpdateWithSourceMutation` (`:84396`), `backgroundCommandTerminalMutation` (`:84969`). The read helpers `getAcceptedSubscriptionTurnAuthority`, `getAcceptedSubscriptionTaskAuthority` and `getAcceptedSubscriptionParentAuthority` also return workspace when the row is missing or not visible (`accepted-subscription-authority.ts:64`, `:102`, `:124`), so an RLS miss becomes a silent scope change rather than an error.

#### EP-T01 — Turn claim: model policy, provider identification, run admission
- Consumer: every turn (chat, API, schedule, child, goal continuation, agent update, compaction). Providers: all three.
- Refs: `claim.ts:400-442` (`settingsForAcceptedSubscriptionTurn`, `assertTurnExecutionPolicyMatchesConfigV1`, `assertSessionAllowsProductModel` at `:434`, `turnExecutionPolicyBillingIdentity` sets `isCodexTurn`/`isXaiTurn` at `:440-441`; `isClaudeTurn` from provider kind `claude-subscription-workspace|organization` at `:442`); `ensureRunAllowed` (`claim.ts:485`, billing bypass via `packages/core/src/billing/limits.ts:65` `modelFundingForAdmission`, see EP-N19).
- Authority/pool: none chosen here; the provider is fixed by the accepted turn execution policy. Claude has two registry provider kinds keyed by pool scope (`packages/config/src/index.ts:2657-2659`), so a Claude model id encodes workspace versus organization billing labels (`packages/config/src/index.ts:7466-7480` legacy accounting exception).
- Failure: a non-Codex model on a `remote_v2` session throws `CodexCompactionV2ProviderLockedError` (`packages/core/src/domain/sessions.ts:1701`).
- Gaps: provider is decided before any account is looked at; there is no failover target list. Bypass: no.

#### EP-T02 — Codex turn capacity phase (select, pin, lease)
- Refs: `run.ts:506-567` runs all capacity phases inside `withSessionRlsActorContext({subjectId: "service:agent-turn", initiatingHumanSubjectId})`; `codex-capacity.ts:132` `selectCodexTurnCapacity`; `packages/db/src/index.ts:26071` `acquireCodexCredentialLease` (passes `advanceActivePointer: true`, `codex-capacity.ts:211`, but the selector never sets it, CA-10); `codex-rotation.ts` `selectCodexCredentialLeaseForTurn` (Codex audit, Part 3).
- Authority/pool: workspace effective source (`resolve_workspace_codex_subscription_source`, migration 0422) on the first lease, then the accepted policy in turn metadata on recovery. No per-person scope.
- DB subject: the ambient actor (`service:agent-turn` + initiating human); Codex DB functions themselves set only account and workspace GUCs. Private access preserved.
- Selection: model allowlist filter and manual-pin model check (`codex-capacity.ts:166-196`); `allCapped` → `refreshCappedCodexUsageRows` then one reselection (`:224-247`); plan-entitlement block → `recheckCodexCredentialPlan` for up to 4 accounts, then reselect or `CodexPlanEntitlementError` (`:254-319`); policy pin written through `withSessionCodexCapacityMutation` + `signalCodexCapacityWakeTargets` (`:333-388`); `recordSessionCodexSelectionForTurnAttempt` emits account selection events for the indicator (`:413-433`); shadow decision `publishCodexFleetShadowDecisionV1` (`:455`).
- No account: zero accounts → `CodexReloginRequired` (terminal, `:658`); manual pin / active pointer / policy pool / credential unavailable → typed codes `codex_manual_pin_unavailable`, `codex_active_pointer_unavailable`, `codex_policy_pool_unavailable`, `codex_credential_unavailable` (`:660-688`) and `armAndReconcileCodexCapacityWait` with `resetKind: "mutation_only"` (`:720-745`); compaction turns are cancelled with `requestPreserved` instead of waiting (`:690-716`).
- Status: `codex.credential.selected`, `codex.account.switched`, `codex.capacity.waiting` events; indicator (EP-S29).
- Bypass: no (this is the Codex reference path).

#### EP-T03 — Claude and SuperGrok turn capacity phase
- Refs: `xai-capacity.ts:22` `selectScopedSubscriptionTurnCapacity` (wrappers `:297-300`); generic lease `packages/db/src/subscription-account-repository.ts:1359` `acquireSubscriptionCredentialLease`; selection `packages/config/src/subscription-account-selection.ts:18` `selectSubscriptionAccount`.
- Authority/pool: the turn's frozen snapshot (`xai-capacity.ts:52-55`).
- DB subject: initiating human for `user` scope, else the synthetic `worker:claude-workspace` / `worker:xai-workspace` (`xai-capacity.ts:57-60`). Private access is preserved on this path only because the call runs inside the ambient actor from `run.ts:506`, which sets `opengeni.initiating_human_subject_id` (`packages/db/src/database.ts:442-451` `setRlsContext`).
- Selection: reads the session pin (`:64`); SuperGrok refreshes exhausted quota first (`:71`, `apps/worker/src/activities/xai-quota.ts:6`); manual pin is binding even when unavailable; rotation off uses the active pointer only, with no failover; rotation on keeps the policy pin, else an FNV hash of the session id over eligible accounts; never moves the active pointer (`subscription-account-selection.ts:13-35`). Codex passes `advanceActivePointer: true`, but every reachable branch of its selector returns `false`, so neither stack moves the pointer automatically (Codex audit CA-10).
- Pin writes: policy pin set when rotation is on (`:242-264`), cleared when rotation is off (`:265-283`); last account recorded (`:284`).
- No account: every account model-disabled → plain `Error` (`:126`); zero accounts → `Error` with code `<provider>_not_connected` (`:129-134`), a terminal failure, not a reconnect state; compaction cancelled (`:135-162`); otherwise `armClaudeCapacityWait` / `armXaiCapacityWait` with code `<provider>_capacity_unavailable` or `<provider>_allocator_disabled` and one generic detail string (`:178-198`). A manual pin to an unavailable account produces the same generic code (Codex has `codex_manual_pin_unavailable`). If arming does not return `waiting`, the turn fails with `<provider>_capacity_wait_stale` and `recovery: "user_message"` (`:216-239`).
- Reset time: Claude uses `leased.nextCheckAt`; SuperGrok uses the earliest `exhaustedUntil` (`:169-173`).
- Status: `turn.capacity_waiting` (generic, no timeline notice, EP-S27); no account-selection events, no indicator.
- Gaps: no fleet shadow; no plan-entitlement recheck; no selection receipt. Bypass: no (shared Claude/SuperGrok path), but it duplicates Codex logic rather than sharing it.

#### EP-T04 — Credential materialization, token refresh and the provider request
- Codex: `buildCodexTokenResolver(db, settings, workspaceId, effectiveCodexCredentialId, undefined, {turnId, holderId, generation})` (`run.ts:672-683`; `packages/db/src/index.ts:88423` wrapping `packages/db/src/codex-token-resolver.ts:259`). `beforeProviderDispatch` asserts the lease (`run.ts:704`). `prompt_cache_key` and the session header are both the session id (`run.ts:697`).
- Claude: `resolveClaudeAccountCredential` (`run.ts:572-591`, `packages/db/src/claude-subscription-account-tokens.ts:23`) under the lease subject; `reconnectRequired` → `ClaudeSubscriptionReconnectRequired`; the credential is injected into run settings with scope `organization` or `workspace` — a `user` snapshot is labelled `workspace` (`run.ts:593`). Usage headers captured by `withClaudeUsageObserver` (EP-N25). Prompt cache TTL is set by Opengeni (`packages/runtime/src/anthropic-messages.ts:435`, default `5m`).
- SuperGrok: `buildXaiTurnRequestAuthorization` (`apps/worker/src/activities/xai-auth.ts:24`, called `run.ts:857`) → `materializeXaiCredentialForRun` + serialized refresh.
- Model access recheck: `assertModelConnectionAllowsTurn` with subject `initiatingHumanSubjectId ?? "worker:model-access"` (`run.ts:618-626`).
- Gaps: three token paths with different refresh failure semantics (Codex stamps `needs_relogin`; the shared Claude/SuperGrok refresh does not, EP-N03). Bypass: provider adapters (expected).

#### EP-T05 — Lease heartbeat, loss and dispatch fence
- Refs: `subscription-lease.ts:16` `SubscriptionTurnLease` (shared: 60 s heartbeat or TTL/5, late confirmations discarded, `assertUsable` before dispatch); `credential-leases.ts` `CodexTurnLease` (heartbeat keyed by account + workspace) and `ScopedSubscriptionTurnLease` (keyed by subject; returns "not found" if the subject was never set). `renewServing` renews all three (`credential-leases.ts:175`).
- Failure: `codex_credential_lease_lost`, `claude_credential_lease_lost`, `xai_credential_lease_lost`; Codex lease-checkpoint failure `codex_lease_checkpoint_failed` (`failure-settlement.ts:803`).
- This is already a shared component; only the DB calls differ.

#### EP-T06 — Codex failure settlement (same-turn failover, quarantine, wait)
- Refs: `failure-settlement.ts:155` `codexDefinitiveFailureDisposition` (failover when rotation is on, no manual pin and another account is selectable; plan entitlement waits only if the other accounts are capped; quota/rate-limit/manual pin/rotation off → wait); `:199` `codexCredentialFailoverLimit` (allocatable accounts minus the serving one); `:211` `codexCapacityWaitFailurePayload` (codes `codex_plan_entitlement`, `codex_usage_limit_reached`, `codex_account_rate_limited`, `codex_relogin_required`, `codex_account_forbidden`); `:1057-1310` `quarantineCodexCredentialForLease` fenced on credential version, then failover or wait, `codex_credential_failover_exhausted` after the bound; usage-limit fallback when no lease existed (`:1809-1840`, `recovery: "user_message"`).
- Status: `turn.failed` or `codex.capacity.waiting`; failed child turns delivered to the parent (`codex-capacity.ts` `deliverFailedChildTurnToParent`).
- Classification details and doc comparison: Codex audit (Part 3).

#### EP-T07 — Claude and SuperGrok failure settlement
- Refs: `failure-settlement.ts:1488-1808`; `errors.ts:1417` `classifyXaiCredentialFailure` (401/`unauthorized`/`invalid_token` → auth; 403 → forbidden; rate-limit diagnostic incl. HTTP 200 SSE capacity terminals → rate_limit); `errors.ts:2264` `classifyClaudeCredentialFailure` (reconnect-required, 401 → auth; 429 → rate_limit; 403 is **not** rotated).
- Claude-only: matches the failing request to a captured usage receipt; forced token refresh may recover the same turn as `claude_token_renewed`; a changed credential version recovers as `claude_credential_changed`; rate limits record a per-model cooldown instead of quarantining the account (`:1553-1673`, `:1722-1741`).
- Both: `armClaudeCapacityWait` / `armXaiCapacityWait` with a lease fence and `credentialQuarantine` (auth → `needs_relogin`; forbidden → `error`; rate limit → cooldown), then an immediate in-activity reconcile that either resumes on another account (`recovering`) or waits (`:1699-1771`). If arming is refused, the turn is requeued through `requestSessionTurnRecovery` with reason `<provider>_credential_recheck` (`:1773-1795`).
- **Private sessions: reactive arming fails (present on `0d7075e`).** `settleTurnFailure` is called from the `catch` at `run.ts:1916-1921`, outside the `withSessionRlsActorContext` block that ends at `run.ts:1915`, and `failure-settlement.ts` never re-establishes it. `armClaudeCapacityWait` / `armXaiCapacityWait` then run under `worker:<provider>-workspace` (lease subject, `xai-capacity.ts:100`) with no initiating-human GUC, so for a workspace- or organization-scope pool a private session is invisible and arming fails ("Session not found", surfaced as a generic activity failure). The proactive arm in EP-T03 is inside the actor block and works. Codex's reactive arm (`failure-settlement.ts:1427`) has the same placement but runs with an empty subject, which sees every session (CA-05).
- Divergences: no failover counter or bound (Codex has `codex_credential_failover_exhausted`); no plan-entitlement concept; codes are `<provider>_relogin_required`, `<provider>_account_forbidden`, `<provider>_account_rate_limited`. Provider overload (Claude 529) is a separate bounded provider-recovery lane, not account rotation (AGENTS.md, `0380bc5`).

#### EP-T08 — Turn finalization: usage recording and lease release
- Refs: `finalization.ts:423-445` records Claude usage receipts (`recordClaudeAccountUsage`); `:457-516` records Codex usage headers (`recordCodexAccountUsageForFinalization`, signals wake targets) and releases the Codex lease; `:518-545` SuperGrok fetches quota with the turn's request context and updates quota metadata (skipped if the credential was quarantined); `:546-567` releases Claude/SuperGrok leases.
- Gaps: three different post-turn quota observers; SuperGrok makes an extra provider call per turn. Usage is not attributed to an account in Insights (EP-N20).

#### EP-T09 — Durable capacity wait and recovery (workflow + control activities)
- Refs: `apps/worker/src/workflows/session.ts:527` `waitForProviderCapacity` (timer or `codexCapacityChanged` signal `:418`, jitter patch `session-capacity-wake-jitter-v1` `:82`, continue-as-new backstop `:627-650`); `apps/worker/src/activities/codex-capacity.ts:272` `getCodexCapacityWait` (probes Codex, then SuperGrok, then Claude waiters); `:309` `reconcileCodexCapacityWait`.
- Claude/SuperGrok branch (`codex-capacity.ts:313-361`): reads the waiter via `getClaudeCapacityWaitForSession` / `getXaiCapacityWaitForSession`, refreshes SuperGrok quota, then `reconcileClaudeCapacityWait` / `reconcileXaiCapacityWait` (`packages/db/src/index.ts:28118` `createScopedSubscriptionCapacityWaiters`). No ambient session actor is established.
- DB subject: the waiter subject comes from `resolveXaiWaiterSubject` (`packages/db/src/index.ts:28162`): initiating human for `user` scope, else `worker:<provider>-workspace`; waiter reads run under `withWorkspaceSubjectRls` with that subject (`:28766-28787`).
- **Private sessions: background recovery cannot see them (present on `0d7075e`).** `xai_capacity_waiters` and `xai_session_account_pins` carry a RESTRICTIVE `session_visibility_isolation` policy using `session_reference_visible` (`packages/db/drizzle/0236_session_visibility_slack_policy.sql:41-70`); Claude tables receive the same policies because 0598 copies every policy on `xai_*` tables (`0598_claude_subscription_account_pools.sql:136-146`). `sessions.session_visibility_isolation` admits a row when the subject GUC is empty, the session is shared, or the subject or initiating human owns it (`0345_tenant_scoped_session_tenancy_fence.sql:709-718`). In the background reconcile the subject is `worker:*-workspace` and no initiating human GUC is set, so private sessions are hidden: the waiter read returns null and reconcile returns `stale`. Between `4cccd3358` and `0d7075e`, the only commit touching `codex-capacity.ts`, `xai-capacity.ts`, `failure-settlement.ts` or `subscription-account-repository.ts` is #3740 (Claude overload recovery), and `packages/db/src/index.ts` changed by one unrelated line, so the defect is unchanged.
- Why Codex does not hit it: Codex waiter and pin state lives in `codex_capacity_waiters` (no `session_reference_visible` policy) and in columns on `sessions`, and Codex DB functions run with no subject GUC outside a turn, which `session_visibility_isolation` treats as visible. Codex therefore avoids the bug by running background work **without** a subject, which is broader than the target ("re-establish the initiating human"), not narrower. Detail in Part 3.
- Status: Codex `codex.capacity.resumed/superseded`; Claude/SuperGrok `turn.recovery.requested` / `turn.superseded` (EP-S31). A recovery that returns `stale` leaves the turn in `waiting_capacity` with no user-visible reason.
- Bypass: Claude/SuperGrok recovery is routed through a Codex-named activity; the shared part is the workflow loop only.

#### EP-T10 — Capacity wake signalling
- Refs: Codex `apps/worker/src/activities/codex-capacity.ts:57` `signalCodexCapacityWakeTargets`, `:85` `signalPendingCodexCapacityWakeTargets` (outbox-driven); API `signalCodexCapacityTargets` (`apps/api/src/routes/codex.ts:847`). Claude/SuperGrok: `wakeSubscriptionCapacityWaiters` (`subscription-account-repository.ts:2370`) and `wakeOrganizationPool` (`packages/db/src/organization-subscription-repository.ts:108`) bump `wake_revision` in the database; `getCodexCapacityWait` turns a pending revision into an immediate check (`codex-capacity.ts:296-301`).
- Gaps: two wake mechanisms; org wakes for Claude/SuperGrok fan out per workspace using `list_organization_codex_workspace_ids` (Part 4, §4.3).

#### EP-T11 — Accepted authority for human prompts and session creation
- Refs: `packages/db/src/session-queue-commands.ts:2129-2146` in `submitHumanPromptInTransaction`; `packages/db/src/index.ts:34654-34680` in `createSessionInTransaction`.
- Behaviour: `actor.type === "human"` → live acceptance resolver under the RLS subject; edited queued turn → copied from the edited turn; `operator`, `service` (API keys), and agent attempts posting through this path → hard-coded workspace snapshot. Session create resolves live only for a subject creator.
- Gaps: an API-key or operator message on a session running on an organization or personal pool is accepted as workspace scope, which can select an empty pool. This can make a resumed turn run under the wrong authority scope (surfaces EP-S20, EP-S22). Codex: no snapshot at all.

#### EP-T12 — Goal continuations
- Refs: `packages/db/src/index.ts:69305` `materializeGoalContinuation` (snapshots from the causal turn at `:69781-69795`, workspace fallback); model and goal admission `packages/core/src/goal-admission.ts:68` (pauses with `model_policy` when a `remote_v2` session's model is not Codex).
- Authority: inherited from the causal turn; Codex re-resolves its source live at the first lease of the continuation turn.
- Status: goal paused with a blocked reason.

#### EP-T13 — Child agents and parent wakes
- Refs: `packages/core/src/domain/sessions.ts:2778-2795` (child snapshot copied from the calling turn when created by an agent); `packages/db/src/child-outbox-authority.ts:8` `parentOutboxAuthorityTx` (child notices carry the parent turn's snapshots, workspace fallback when no parent turn); `apps/worker/src/activities/parent-wake.ts:87-119` (`getSessionParentXaiProviderAccountAuthority`, `getSessionParentClaudeProviderAccountAuthority`, which return workspace if the child row is not visible).
- Gaps: children have no API-side subscription usability check (EP-S19). Codex children pick their pool live at first lease. Session account stickiness across parent and child does not exist for any provider.

#### EP-T14 — Agent messages, steer and batched internal updates
- Refs: `packages/db/src/session-queue-commands.ts:419` `subscriptionAuthorityForAgentActor` (copies the caller turn's snapshot; throws if the turn is missing); `sendAgentMessageInTransaction` `:2642`; claim-time batching `packages/db/src/index.ts:74220-74245` (receiver context turn snapshot when present, else the first update's frozen snapshot) and `packages/db/src/inbox-execution-context.ts:58`.
- Gaps: receiver-owned batches do not compare provider snapshots (EP-S22); Codex carries nothing.

#### EP-T15 — Scheduled tasks
- Refs: create `packages/core/src/domain/scheduled-tasks.ts:525-550` (agent creator → creating turn snapshot; human → live resolver); fire `apps/worker/src/activities/scheduled-tasks.ts:945-1020` (reads the task's frozen snapshots, validates the user-scope subject: SuperGrok from `task.createdBy`, Claude from `task.ownerSubjectId`), then passes them to session create (`:1416`) or system updates (`:1716`, `:1848`); Codex compaction mode frozen per generated session (`:758-774`).
- Gaps: no Codex authority on schedules; SuperGrok and Claude resolve the responsible person from different fields (EP-N27).

#### EP-T16 — Context compaction (portable and Codex remote_v2)
- Refs: mode frozen at create `packages/db/src/index.ts:34839-34843` (Codex model → workspace `codexCompactionDefault`, default `remote_v2`, `packages/contracts/src/index.ts:2508`); `compaction-prep.ts:232-389` (portable path for every provider; `remote_v2` only for Codex turns); `apps/worker/src/activities/context-compaction.ts:119` fails closed if a `remote_v2` session runs a non-Codex turn; compaction turn authority copied from the latest started turn (`packages/db/src/index.ts:74039`).
- Account: compaction uses the same turn capacity phase and lease (EP-T02/EP-T03); when no account is available the compaction turn is cancelled with `requestPreserved` rather than waiting (`codex-capacity.ts:690-716`, `xai-capacity.ts:135-162`).
- Target conflict: `remote_v2` locks the session to Codex for life (`assertSessionAllowsProductModel`, picker `codexOnly`), which blocks cross-provider failover.

#### EP-T17 — In-turn media credentials
- Image: Codex and SuperGrok turns reuse the serving credential and lease (`agent-build.ts:305-372`; EP-N08, EP-N09). Claude turns have no subscription image adapter.
- Video (SuperGrok funding): subject `leases.xai.subjectId ?? turn.initiatingHumanSubjectId`; snapshot `providerTurn.xaiAuthoritySnapshot ?? ` **live** `resolveXaiProviderAccountAuthoritySnapshotForAcceptance` (`agent-build.ts:429-438`), i.e. a Codex or Claude turn ignores its own frozen `turn.xaiProviderAccountAuthoritySnapshot`; selection without a lease; writes a policy pin (`:450-478`). Detail EP-N12/EP-N13.

#### EP-T18 — Agent `list_models` tool
- Refs: `tool-environment.ts:935-951` (`loadWorkspaceModelSelectionInput` with the turn's frozen Claude/SuperGrok snapshots and subject `initiatingHumanSubjectId ?? credentialSubjectId ?? "worker:model-access"`).
- Divergence: Codex availability is live per workspace; Claude/SuperGrok per accepted snapshot.

### 1.2 Non-chat consumers (EP-N)

Scope: every place outside the chat-turn path (`apps/worker/src/activities/agent-turn/`, `codex-rotation.ts` and `codex-capacity.ts` are covered in 1.1 and Part 3) where a Codex, Claude or SuperGrok (`xai`) subscription account is selected, materialized, refreshed, used for a provider request, settled, recovered, waited on or reported.

#### Shared building blocks referenced below

- **xAI/Claude pool resolution (live)**: `packages/db/src/subscription-account-repository.ts:754` `resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance` → `:775` `...InTransaction`. Order: the caller's personal (`user`) pool if it has an active pointer to an active credential; else `workspace` if any workspace-scoped credential row exists; else `organization` if the org rotation row has an active credential; else `workspace`. A personal pool therefore wins automatically (conflicts with the target model).
- **xAI/Claude selection without a lease**: `subscription-account-repository.ts:1634` `selectSubscriptionCredentialForUse` (exported for xAI as `selectXaiCredentialForUse`, `packages/db/src/xai-subscription.ts:75`). Reads rotation settings + capacity, applies pin/active/shard, returns a credential id. Takes no lease, writes no pin, has no wait.
- **xAI/Claude lease**: `subscription-account-repository.ts:1359` `acquireSubscriptionCredentialLease` (5-minute TTL `:100`). Used only by the chat-turn path; no non-chat consumer below calls it.
- **xAI/Claude materialize + refresh**: `:1074` `materializeSubscriptionCredentialForRun` (revalidates authority via SQL `revalidate_<provider>_subscription_authority`, `:1021` `withAuthorizedSubscriptionCredential`), `:1187` `refreshSubscriptionCredentialSerialized`. The serialized refresh writes `status: "active"` on success only; it never stamps `needs_relogin` on failure (`:1187-1330`).
- **Session pins (xAI/Claude)**: `:2153` `setSubscriptionSessionAccountPin` / `:2227` `getSubscriptionSessionAccountPin`, keyed by (session, authority scope, owner membership).
- **Codex pool**: `packages/db/src/index.ts:24009` `effectiveCodexCredentialPoolCondition` (workspace source `workspace` → rows with `workspace_id = ws` and scope `workspace|user`; source `organization` → org rows, which have `workspace_id` null per `packages/db/drizzle/0381_organization_codex_subscription_inheritance.sql:716`; `disabled` → nothing).
- **Codex token resolver**: `packages/db/src/index.ts:88423` `buildCodexTokenResolver` (wraps `packages/db/src/codex-token-resolver.ts:259`). Without an `authority` argument it loads through `index.ts:25079` `codexCredentialUseCondition` → the *effective model pool condition*. Missing row → `CodexReloginRequired("No Codex subscription is connected for this workspace.")` (`codex-token-resolver.ts:404`). A refresh that hits `CodexReloginRequired` stamps `needs_relogin` on the shared credential (`codex-token-resolver.ts:345`).
- **Session HTTP access**: every `/v1/workspaces/:workspaceId/sessions/:sessionId/*` route passes `apps/api/src/routes/sessions.ts:581` `authorizeSessionHttp`, which enforces private-session rules before the handler runs.

---

#### Transcription

##### EP-N01 — Transcription service: provider selection and fallback
- Consumer: voice input (one-shot and resumable recordings). Providers: Codex, SuperGrok (plus deployment-funded OpenAI/Azure, not subscriptions). No Claude.
- Refs: `apps/api/src/transcription/service.ts:29` `createTranscriptionService`; `:416` `orderedProviders`; `:434` `firstAvailable`; `:231` exact `providerId` path; `:327-343` fallback on `fallbackSafe`; registry `packages/config/src/index.ts:1909` `resolveVoiceInputProviderRegistry` (allowed ids: `openai`, `azure-openai`, `azure-mai`, `codex-subscription`, `supergrok-subscription`, `:1966-1972`).
- Authority/pool: none at this layer; each provider's `available(context)` decides (live lookups, see N02/N03).
- DB subject / private session: passes `workspaceId`, `subjectId`, `accountId` (Opengeni billing account) through; not session-bound.
- Selection/pin/lease: picks a *provider*, not an account; workspace `voiceInput.preferredProvider` + `fallbackEnabled` order it.
- Failure/settlement: `TranscriptionServiceError.fallbackSafe` moves to the next provider unless a provider was pinned or fallback is off. Subscription providers are never charged (`:173-176` `chargeable` requires `deploymentFunded`).
- Durable wait/recovery: none (in-process settlement retries only apply to deployment-funded providers, `:124-153`).
- User sees: HTTP error code (`unavailable`, `timeout`, …).
- Gaps: provider order is a workspace setting, not an org-defined fallback order. Bypass: n/a (provider router).

##### EP-N02 — Codex transcription provider
- Refs: `apps/api/src/transcription/providers/codex-subscription.ts:13` `workspaceHasActiveCodexAccount`; `:42` `transcribe`; `:53` `buildCodexTokenResolver`; `:89-92` single refresh on 401; URL `chatgpt.com/backend-api/transcribe` (`:11`).
- Authority/pool: live `listCodexAccountStatuses(db, workspaceId)` (`packages/db/src/index.ts:29783`), workspace RLS only (`withWorkspaceRls`, no subject).
- Selection: the row with `isActive && status === "active"` — the workspace/org **active pointer only**. Ignores rotation, allocator eligibility, exhaustion, plan exclusions, session pins. No lease.
- DB subject: none (workspace scope). The request is not tied to a session.
- Failure: no active account or token error → `unavailable` + `fallbackSafe` (falls to next provider). Provider non-2xx → `responseError(status)` from `providers/openai.ts`. Refresh failure with relogin stamps `needs_relogin` on the shared model credential (resolver side effect).
- Durable wait: none. User sees: transcription falls back or fails `unavailable`.
- Gaps: an exhausted active account is still used; personal/org preference rules are not applied. **Bypasses shared selection** (own active-pointer path).

##### EP-N03 — SuperGrok transcription provider
- Refs: `apps/api/src/transcription/providers/xai-subscription.ts:29` `available` (→ `workspaceXaiSubscriptionActive`, `packages/db/src/xai-subscription.ts:60`); `:40` `transcribe`; `:52` `buildXaiSubscriptionAuthorization` (`apps/api/src/xai-subscription-auth.ts:26`); `:105` refresh on 401 or 403 with `[WKE=unauthenticated:bad-credentials]` (`:125` `isXaiInvalidCredentialResponse`); URL `api.x.ai/v1/stt`.
- Authority/pool: **live** acceptance snapshot for the calling subject (`xai-subscription-auth.ts:43-48`) → personal pool wins.
- Selection: shared `selectXaiCredentialForUse` with `shardKey = requestId` (client correlation id or random UUID; attempt id for recordings). No pin read or written, no lease.
- DB subject: caller's `subjectId` (subject RLS). Not session-bound.
- Failure: any selection/materialize error → `unavailable` `fallbackSafe`; token error → "Reconnect the SuperGrok account…" `fallbackSafe`. Never marks the credential `needs_relogin` (shared refresh does not).
- Durable wait: none. User sees: fallback to another provider or `unavailable`.
- Gaps: per-request shard means no stickiness; a dead credential stays `active` and keeps being selected. Uses shared selection but **bypasses the lease**.

##### EP-N04 — Transcription HTTP routes (one-shot and resumable recordings)
- Refs: `apps/api/src/routes/transcriptions.ts:20` POST `/transcriptions` (grant `sessions:create`, `requestId` from `x-opengeni-correlation-id` `:59`); `apps/api/src/routes/transcription-recordings.ts:431-511` segment processing (provider pinned per segment via `claim.segment.providerId`, `requestId = attemptId` `:475-486`), `:513-531` fallback provider chosen with `selectProvider` and persisted by `failTranscriptionRecordingSegment`.
- Authority: request grant (`grant.subjectId`); recordings carry a durable `authority` (subject, attribution).
- Pin: the **provider** (not account) is durably pinned per recording segment; the account is reselected on every attempt.
- Durable wait/recovery: recording segments are durable (start fence `startTranscriptionRecordingSegmentProviderCall`), retries re-run selection.
- User sees: per-segment error codes; billing refusal 402-shaped body (`apps/api/src/transcription/billing-refusal.ts:9`), irrelevant for subscriptions.

#### Realtime voice

##### EP-N05 — Realtime model catalog, begin, billing
- Refs: `apps/api/src/routes/workspaces.ts:1101` GET `/realtime-model-catalog` (availability via `workspaceCodexSubscriptionActive` and `workspaceXaiSubscriptionActive(..., grant.subjectId)` `:1104-1106`); `apps/api/src/routes/sessions.ts:1370` POST `/realtime` (begin; `freezeSessionRealtimeConnectionAccounts` freezes MCP connection accounts only, `packages/core/src/domain/session-connection-accounts.ts:18`); voice billing `packages/core/src/domain/realtime-voice-billing.ts:66` `deploymentRealtimeVoice` returns null for `gpt-live-1-boulder-alpha` and `supergrok/grok-voice-think-fast-2.0`, so subscription voice is never charged (`:256` `admit`).
- Model setting: ids are constants `CODEX_REALTIME_MODEL_ID` / `SUPERGROK_REALTIME_MODEL_ID` (`packages/config/src/index.ts:3510-3511`); the chosen model is stored per session realtime mode (DB check `packages/db/drizzle/0238_supergrok_realtime_model.sql`). The upstream xAI model is hard-coded `grok-voice-think-fast-2.0` (`apps/api/src/xai-realtime.ts:22`). Client transport is picked by model id (`packages/sdk/src/realtime.ts:58` `sessionRealtimeTransportKind`); the SDK never touches credentials.
- Gaps: catalog availability is computed for the *viewer* (xAI: their live pool; Codex: workspace), not for the session's accepted authority. No Claude realtime model exists.

##### EP-N06 — Codex realtime WebRTC broker
- Refs: `apps/api/src/routes/sessions.ts:1522` POST `/realtime/webrtc` (grant `sessions:control`); `apps/api/src/codex-realtime.ts:257` `buildSessionCodexRealtimeBroker`, `:268-289` `loadSelection` (`getSessionCodexState` pin, `getCodexCredentialStatus` active, `listCodexAccountStatuses` connected set); `:181` `brokerSessionCodexRealtime`; `packages/codex/src/realtime.ts:345` `selectCodexCredentialId` (pin if connected, else active).
- Authority/pool: live workspace Codex source; ignores any accepted turn source.
- DB subject / private session: workspace RLS; session access enforced by `authorizeSessionHttp`.
- Selection: session `codexPinnedCredentialId` (manual **or** policy pin) else active pointer. No allocator capacity/exhaustion/plan checks, no lease. The comment says "Selection is identical to a turn" (`:177-179`), but turns now use the lease allocator — this is no longer true.
- Failure: provider 401 → one forced refresh + one retry (`:232-253`); errors mapped to `CodexRealtimeBrokerFailureReason` (`:26-38`, `:324` `brokerProviderError`); `CodexReloginRequired` → `reconnect_required`, others → `credential_unavailable`. Failure persisted on the connection row (`failSessionRealtimeConnectionInTransaction`, `sessions.ts:1702-1716`).
- Durable wait: none; client must retry with a new operation.
- User sees: JSON error `{code, reason, providerStatus}` (`apps/api/src/routes/sessions.ts:5206` `codexRealtimeHttpFailure`).
- **Bypasses shared selection** (own pin→active rule, no lease).

##### EP-N07 — SuperGrok realtime client-secret broker
- Refs: `apps/api/src/routes/sessions.ts:1881` POST `/realtime/supergrok`; `apps/api/src/xai-realtime.ts:48` `createXaiRealtimeConnectionSecret`; `:64` live acceptance snapshot for the caller; `:68` reads session pin; `:76` `buildXaiSubscriptionAuthorization` with `shardKey = sessionId`; `:89-127` writes a **policy pin** to the session (rotation on, not manual) and handles a manual-pin race; `:152` `mintXaiClientSecret` (`api.x.ai/v1/realtime/client_secrets`, 120 s TTL).
- Authority/pool: **caller's live** pool, not the session's accepted pool. A second member opening voice in a shared session uses (and pins) their own pool's account.
- Selection: shared `selectXaiCredentialForUse` + pin read/write; no lease (the minted token outlives the call; usage is not fenced).
- Failure: any selection/auth error → `credential_unavailable` (409); 401 → one refresh; 401/403 after → `credential_unavailable`; other → `provider_error` (502, retryable). Code prefix `SUPERGROK_REALTIME_*` (`sessions.ts:1981-1992`). No `needs_relogin` stamping.
- Durable wait: none. Replay refused (single-use token, `sessions.ts:1923-1928`).
- Gaps: realtime mutates the same session pin turns use; selection uses shared code but **bypasses the lease**.

#### Image generation

##### EP-N08 — Image tool provider choice + Codex image
- Refs: `apps/worker/src/activities/agent-turn/agent-build.ts:290` `imageGenerationOption`: native hosted binding → Codex branch (`resolvedModel.provider.kind === "codex-subscription"`, `:305-338`) → SuperGrok branch (`:340-373`) → workspace AI Gateway fallback (`:375-412`). `apps/worker/src/activities/agent-turn/tool-policy.ts:256` `connectedSubscriptionImageGenerationAuthority`. `apps/worker/src/activities/codex-image-generation.ts:18` `executeCodexImageGeneration`; model `gpt-image-2.5-sunburst` (`packages/codex/src/images.ts:6`).
- Selection: **inherits the turn's leased credential** (`providerTurn.effectiveCodexCredentialId` + `codexContext`); provider follows the turn's model. Claude turns get no subscription image adapter (gateway only, if configured).
- Lease: the turn lease; `beforeProviderDispatch` fence, and a `CodexCredentialLeaseLostError` before dispatch resets the operation instead of marking it unknown (`codex-image-generation.ts:43-55`).
- Uses shared turn selection (no bypass).

##### EP-N09 — SuperGrok image
- Refs: `apps/worker/src/activities/xai-image-generation.ts:27` `executeXaiSubscriptionImageGeneration`; model `grok-imagine-image-quality` (`packages/xai-subscription/src/constants.ts:41`).
- Selection: turn's `effectiveXaiCredentialId` + `xaiRequestContext` (`agent-build.ts:341-344`).
- Divergence: no `isProviderDispatchRejected` hook, so any pre-dispatch error is recorded as outcome-unknown (Codex resets instead). Whether the xAI request context checks the turn lease before dispatch is **uncertain** (not verified in `agent-turn/run.ts`, out of scope).

##### EP-N10 — Image operation ledger (crash recovery)
- Refs: `apps/worker/src/activities/image-generation-operation.ts:100` `executeImageGenerationOperation`; identity includes `providerBindingHash` (`:104-114`, `:234` `imageProviderBindingHash(providerId, credentialId)`); `:161-183` outcome-unknown vs reset; `:187-219` retention failure.
- Recovery: same identity → `recover` replays the stored artifact. Because the identity contains the credential id, a retry that lands on a different account gets a new operation and can generate (and spend quota) again. Status surfaced: `ImageGenerationOutcomeUnknownError` / `ImageGenerationRetentionFailedError`.

#### Video generation (SuperGrok only)

##### EP-N11 — Video policy routes (funding choice)
- Refs: `apps/api/src/routes/video-generation.ts:31` GET and `:63` PUT `/video-generation/policy`; `supergrok_subscription` offered when `workspaceXaiSubscriptionActive(..., grant.subjectId)` is true (`:37`, `:70`).
- Gap: funding is a workspace setting validated against the **saving admin's** live pool (their personal pool counts), but runtime selection uses the turn's subject (N12). Funding sources are `opengeni_credits | workspace_gateway | supergrok_subscription` (`apps/worker/src/activities/video-generation-admission.ts:43`) — no Codex or Claude video.

##### EP-N12 — Video credential selection at turn build
- Refs: `agent-build.ts:429-494`: subject = `leases.xai.subjectId ?? turn.initiatingHumanSubjectId`; authority = turn's frozen `xaiAuthoritySnapshot` if the turn is an xAI turn, else **live** acceptance for that subject (`:433-437`); credential = turn's leased xAI credential if any, else `selectXaiCredentialForUse(shardKey = sessionId)` (`:450`); writes a **policy session pin** (`:466`); `materializeXaiCredentialForRun` (`:480`); `xaiVideoGenerationCredentialLease` (`:487`).
- Lease: none when the turn is not an xAI turn (a Codex/Claude turn can fund video from an un-leased xAI account).
- Private session: initiating human re-established from the turn row. Uses shared selection, **bypasses the lease** for non-xAI turns.

##### EP-N13 — Video admission and credential envelope
- Refs: `apps/worker/src/activities/video-generation-admission.ts:87` `xaiVideoGenerationCredentialLease` copies the access **and refresh token** into an encrypted per-operation envelope (`apps/worker/src/activities/video-generation-credential.ts:22` `encryptVideoGenerationXaiCredential`); `:116` `admitVideoGenerationRequest`.
- Divergence: the envelope is a second copy of a rotating refresh token outside the credential row.
- **Org pools broken (likely bug)**: `decryptVideoGenerationCredential` (`video-generation-credential.ts:89-93`) only accepts `workspace` and `user` scope; `XaiProviderAccountAuthoritySnapshotV1` also allows `organization` (`packages/contracts/src/xai-provider-account-authority.ts:14`). An org-pool SuperGrok video is admitted, then reconciliation throws "credential lease is malformed" before any provider call. No test covers org scope (rg found none). What happens after the workflow's 3 activity attempts is **uncertain** (the operation appears to stay non-terminal).

##### EP-N14 — Video reconciliation after crash
- Refs: `apps/worker/src/workflows/video-generation.ts:19` `videoGenerationWorkflow` (loop, `continueAsNew` after 100); activity retry max 3 (`apps/worker/src/workflows/activities.ts:134-144`); `apps/worker/src/activities/video-generation-reconciliation.ts:80` `reconcileVideoGenerationOperation`; `:630` `durableXaiVideoAuth`; `:643` re-materialize the account (errors swallowed so disconnect does not cancel a paid job); `:663` shared serialized refresh; **`:709` fallback: direct `refreshXaiToken(current.refreshToken)` when the account no longer materializes**; `:716-725` envelope rotated with CAS (`rotateVideoGenerationCredential`).
- Failure: `:732` `isPermanentProviderFailure` (relogin or 4xx except 408/429 → permanent); otherwise retried until `recoveryDeadlineAt` (`:257`, `:356`).
- Gap: the direct refresh at `:709` rotates the provider token family outside the shared lock; if the account row still exists but the subject lost authority, the row's refresh token may be invalidated (**uncertain**: depends on whether xAI revokes the old refresh token). Recovery authority is the frozen envelope, not the pool — intentionally independent of selection.

#### Workspace tool gateway and Codex Apps

##### EP-N15 — Workspace tool gateway (Codex Apps only)
- Refs: `apps/api/src/workspace-tool-gateway.ts:366-399`: `resolveCodexAppsCredentialIdForRun` then `buildCodexTokenResolver(..., codexAppsCredentialId)` (default deps) and `withCodexAppsRequestAuthorization` per request. No other subscription credential is used by the gateway (rg found only Codex Apps).
- Selection: the explicit Apps designation (see N17), not the model allocator. No lease.
- Token loading goes through the **effective model pool condition** (shared resolver without authority). Only `getToken` is exposed; no refresh-and-retry on a 401 from Apps.
- Subject: `grant.subjectId` is recorded but the credential is workspace-designated; private-session not applicable.

##### EP-N16 — Turn-time Codex Apps registration and auth
- Refs: `apps/worker/src/activities/agent-turn/claim.ts:371` `resolveCodexAppsCredentialIdForRun` (`packages/core/src/domain/capabilities.ts:991`: designation + active credential + owner still has `connections:write`; **does not check the workspace Codex source**); `apps/worker/src/activities/agent-turn/tool-environment.ts:561-583` same resolver pattern as N15; `packages/runtime/src/index.ts:7311` `codexAppsAuthFetch`.
- Failure classification (verified in code): any error from `withAuthorization` — designation revoked (`CodexAppsAuthorizationRevokedError`, `packages/db/src/index.ts:24750`), credential outside the effective model pool, or a real refresh failure — is published as `reason: "refresh_failed"` (`runtime/src/index.ts:7325-7328`). 401 → `expired`, 403 → `insufficient_scope` (`:7342-7347`). Missing designation → `missing_connection`.
- Verified mechanism: `buildCodexTokenResolver` without authority → `loadCodexCredentialForRun` → `effectiveCodexCredentialPoolCondition`. If the workspace Codex source is `organization` or `disabled`, the designated workspace-owned Apps credential is outside the condition → `CodexReloginRequired("No Codex subscription is connected…")` → shown as `refresh_failed`. It goes through model **pool membership**, not through allocator selection/lease. A relogin during an Apps refresh also stamps `needs_relogin` on the shared model credential.
- Durable wait: none. User sees: tool auth-needed card for `codex_apps`.

##### EP-N17 — Codex Apps designation, "turn Apps off", setup cards
- Refs: `apps/api/src/routes/codex.ts:1464` POST `/codex/apps` and `:1518` DELETE `/codex/apps` (both call `:383` `requireWorkspaceCodexManagementSource` and `:550` `requireCodexAppsHuman`: managed browser human, no bearer, same-origin, `connections:write`); `packages/db/src/index.ts:24854` `designateCodexAppsCredential` (credential must have `workspace_id = ws` and `connectedBySubjectId = caller`), `:24973` `clearCodexAppsCredential`; `:31947` `disconnectCodexAccount` clears a designation on disconnect. Catalog/card: `capabilities.ts:1263` `codexAppsCatalogItem`; readiness card `apps/api/src/mcp/server.ts:6526` ("A workspace admin must designate…"); excluded from the setup chooser `apps/api/src/routes/connect.ts:1396`.
- Gaps: (1) org-owned Codex accounts (`workspace_id` null) can never be designated; designation is bound to a workspace-owned account owned by the connecting person. (2) When the workspace source is `organization`/`disabled`, **DELETE `/codex/apps` returns 409** ("managed in Organization settings" / "disabled"), so Apps cannot be turned off from the workspace, while the still-active designation keeps registering the MCP and failing with `refresh_failed` (N16). Changing the source does not clear `codex_apps_settings` (only `index.ts:24727-25034` and `:31967-32020` touch it).

#### Codex reset-credit redemption

##### EP-N18 — Reset-credit prepare/redeem (web and organization MCP)
- Refs: `apps/api/src/routes/codex.ts:1954` POST `.../reset-credits/prepare`, `:2068` POST `.../reset-credits/redeem`; `:503` `requireRedemptionHuman` (managed mode only; browser human with no bearer + same-origin, **or** an agent acting as the person via verified delegated-human proof, `apps/api/src/http/acting-person.ts:21`, `:54`); HMAC confirmation `apps/api/src/codex-redemption-security.ts:52`/`:60`. Organization MCP reaches it through the generic `opengeni_action_call` (`apps/api/src/organization-mcp.ts:107`, `:311` `callAction`; catalog entries `apps/api/src/mcp/action-catalog.gen.ts:4555-4567`, not `browserOnly`).
- Account: explicit credential id from the URL; must be in `listCodexAccountStatuses` and connected by the same human; org-source accounts refused (`codex.ts:1971-1975`). Token via `buildCodexTokenResolver` default deps (pool condition) `:2190`.
- Idempotency: client logical `attemptId` row (`claimCodexResetRedemption`, `adoptCodexResetRedemptionAttempt`), send fence `fenceCodexResetRedemptionSend`, provider `idempotencyKey = upstreamIdempotencyKey` (`:2242-2251`), `provider_started` attempts are resumable, completed outcomes replay without another consume. Disconnect is blocked while an attempt is `provider_started` (`index.ts:32000-32014`).
- Human-only boundary: only the connecting person or their acting agent; no worker/scheduled/allocator path (comment `:2066-2067`, verified no other callers of `consumeCodexRateLimitResetCredit` in apps/worker).
- Failure: `preflight_unavailable` 503, `not_actionable` 409, `provider_unavailable` 503, `ambiguous` 503 (retryable), `confirmation_expired` 403. Completion wakes Codex capacity waiters via outbox (`signalCodexCapacityTargets`).
- Gaps: org-owned accounts cannot redeem from any surface found. Own path (**bypass**, by design).

#### Billing, limits, usage attribution

##### EP-N19 — Funding predicate at admission
- Refs: `packages/codex/src/billing.ts:13` `isCodexBilledModel` (prefix `codex/`); `packages/db/src/index.ts:25626` `isCodexBilledTurn` → live `workspaceCodexSubscriptionActive`; `packages/core/src/billing/limits.ts:65` `modelFundingForAdmission`, `:101` `checkLimit`; also `packages/core/src/billing/agent-run-admission.ts:34`, `packages/core/src/application/session-commands.ts:181`.
- Asymmetry: Codex is funded-without-credits only if a workspace Codex account is live-active (workspace-level, no subject); SuperGrok/Claude are funded-without-credits from the static model overlay (`resolvedModel.cost !== "credits"`) with no live account check (comment `limits.ts:74-77`). Neither consults the session's accepted pool.

##### EP-N20 — Usage attribution
- Refs: `packages/db/src/schema.ts:12307` `modelCallFacts` has `provider`, `model`, `billingPath`, initiator fields but **no credential/connection id**; `packages/db/src/insights.ts:1233-1238` labels subscription calls `billingPath = "external"`.
- Gap: Insights cannot attribute usage to a specific subscription account or pool. Account attribution exists only in lease rows and session "last account" fields (chat path).

#### Quota observers and refreshers outside turns

##### EP-N21 — Codex usage/overview routes
- Refs: `apps/api/src/routes/codex.ts:1740` GET `/codex/usage` (active account), `:1756` GET `/codex/accounts/:id/usage`, `:1776` POST `/codex/usage/refresh` (all accounts, concurrency 4), `:1819` GET `/codex/overview` (usage + reset details); `packages/db/src/index.ts:88453` `fetchCodexUsageForAccount` (→ `codex-token-resolver.ts` usage path), `:88497` `fetchCodexRateLimitResetCreditsForAccount`.
- Authority: grant `workspace:read`; workspace RLS (no subject). Explicit credential ids from `listCodexAccountStatuses`.
- Side effects: may refresh tokens (and stamp `needs_relogin`), writes usage cache and can clear quota cooldowns; signals pending capacity wake targets (`signalPendingCodexCapacityTargets`). No lease.
- Gap: whether a workspace reader can trigger refresh of another member's `user`-scope Codex account depends on RLS for `codex_subscription_credentials` under `withWorkspaceRls` — **uncertain** (not verified in SQL policies).

##### EP-N22 — SuperGrok exhausted-quota refresh
- Refs: `apps/worker/src/activities/xai-quota.ts:6` `refreshExhaustedXaiQuota`, called from `apps/worker/src/activities/codex-capacity.ts:324` (capacity-wait reconciliation) and `agent-turn/xai-capacity.ts`.
- Behaviour: lists every RLS-visible xAI account (`listXaiSubscriptionAccountsMetadata`, not filtered to the frozen pool), skips non-exhausted/recently checked (30 s), materializes with the given authority (accounts in other pools fail and are silently skipped), calls the billing endpoint, CAS-updates quota metadata. Never runs inference; errors swallowed ("durable timer retries").

##### EP-N23 — SuperGrok status probe
- Refs: `apps/api/src/routes/supergrok.ts:570` GET `/supergrok/status`; `:168` `materializedAuthContext` (a third copy of the xAI auth context, with `refreshXaiSubscriptionCredentialSerialized` `:217`); calls `fetchXaiSubscriptionModels` on the active pointer.
- Authority: caller's live pool. May refresh tokens. Result is a `valid` boolean only.

##### EP-N24 — Claude account usage refresh
- Refs: `apps/api/src/routes/claude-subscription-accounts.ts:163-199` GET/POST `.../claude/accounts/:accountId/usage[/refresh]` (workspace and organization variants); `apps/api/src/claude-subscription-account-usage.ts:14` `refreshClaudeAccountUsage`; `packages/db/src/claude-subscription-account-tokens.ts:23` `resolveClaudeAccountCredential` (shared serialized refresh, `refreshClaudeSubscriptionAccountSerialized` / organization variant); provider `api.anthropic.com/api/oauth/usage` (`apps/api/src/claude-subscription-usage.ts:24`).
- Divergence: Claude records `reconnect` in the usage snapshot (`recordClaudeAccountUsage`) instead of changing credential status; requires `user:profile` scope or reports `scope_required`.
- Dead code: `apps/api/src/claude-subscription-usage.ts:63` `refreshClaudeSubscriptionUsage` / `packages/db/src/claude-subscription-tokens.ts:85` `resolveClaudeSubscriptionCredential` (legacy connection-based Claude subscription) have no production callers (rg); new legacy connections are rejected with 410 (`apps/api/src/claude-workspace-connection.ts:21-22`).

##### EP-N25 — Claude response-header usage observer (in turn, reporting only)
- Refs: `packages/runtime/src/claude-subscription-usage.ts:26` `withClaudeUsageObserver`, used at `apps/worker/src/activities/agent-turn/run.ts:1016`. Listed for completeness; owned by the chat-turn inventory.

#### Readiness, background authority, telemetry

##### EP-N26 — Readiness probes for catalogs/default model
- Refs: `packages/core/src/default-session-model.ts:328` `connectionRestrictionsAndXaiReadiness`, `:385` `loadWorkspaceClaudeSubscriptionReadiness`, `:437` Codex; `apps/api/src/routes/workspaces.ts:580-586` model catalog; `apps/worker/src/activities/capabilities.ts:172` Codex provider injection.
- Behaviour: metadata-only; xAI/Claude use the frozen snapshot when supplied, else the subject's live pool; Codex is workspace-level only.

##### EP-N27 — Scheduled-task and parent-wake authority re-establishment
- Refs: `apps/worker/src/activities/scheduled-tasks.ts:945-1020` (frozen xAI and Claude snapshots per task; xAI causal human = `task.createdBy.subjectId`, Claude = `task.ownerSubjectId`; refuses mismatches); `apps/worker/src/activities/parent-wake.ts:87-119` (parent session's xAI/Claude authority carried to the wake).
- Asymmetry: no frozen Codex authority on schedules (Codex follows the live workspace source). There is **no scheduled token-refresh or quota-polling job** for any provider (no subscription references in `apps/worker/src/workflows/*` except Codex capacity wait).

##### EP-N28 — Codex fleet shadow telemetry
- Refs: `apps/worker/test/fixtures/legacy-codex/fleet-shadow.ts:102` `publishCodexFleetShadowDecisionV1`, `:146` `buildCodexFleetShadowPayloadV1`. Shadow comparison of allocator decisions; no credential use. Codex only.

### 1.3 API, SDK, React and web surfaces (EP-S)

Providers: **Codex** (ChatGPT subscription), **Claude** (Claude subscription), **SuperGrok** (xAI subscription, code says `xai`).
"Shared pool" means the provider-generic repository/route factory used by Claude and SuperGrok
(`apps/api/src/routes/subscription-account-pools.ts` + `packages/db/src/subscription-account-repository.ts`).
Codex has its own separate stack (`apps/api/src/routes/codex.ts` + Codex functions in `packages/db/src/index.ts`).

Fields per entry: consumer · providers · refs · authority/pool resolution · DB subject / private-session access ·
selection/pin/lease · failure + settlement · durable wait/recovery · status surfaced · gaps/divergences · bypasses shared logic.
"n/a" means the entry point does not do that thing (for example a list route never leases).

---

#### API routes

##### Permission helpers used below

| Helper | What it requires | Ref |
|---|---|---|
| `requireOrganizationCodexHuman` | Managed browser cookie human, or an agent acting as a person with org-settings permission, or local admin. Authorization itself is enforced in the DB: it calls `getOrganizationCodexRotationSettings(actorSubjectId)` and maps SQLSTATE 42501→403, P0002→404. With `providerConsent: true` it refuses agents (`requireNotAgent`). Used by **all** org routes for all three providers despite the Codex name. | `apps/api/src/routes/codex.ts:328` |
| `requireSameOriginBrowserMutation` (two copies) | JSON content type + `Origin` = public base URL + `Sec-Fetch-Site: same-origin`; skipped for agents acting as a person in the pool copy. | `apps/api/src/routes/codex.ts` (export, used by codex/claude-oauth), `apps/api/src/routes/subscription-pool-access.ts:33` |
| `requireSubscriptionScopeMutation` | `organization` → 409 "Manage this subscription in organization settings"; `user` → same-origin + `requirePrivateSubscriptionHuman`; `workspace` → `workspace:admin`. | `apps/api/src/routes/subscription-pool-access.ts:109` |
| `requirePrivateSubscriptionHuman` | Bearer: only an external-actor continuation whose effective subject equals the grant subject; cookie/agent: `connections:write` grant whose subject equals the browser human; plus an ordinary (non-Personal) workspace membership (`getWorkspaceGrant`), else 409. | `apps/api/src/routes/subscription-pool-access.ts:59` |
| `requireWorkspaceCodexManagementSource` | 409 when the workspace's effective Codex source is `organization` or `disabled`. | `apps/api/src/routes/codex.ts:383` |
| `requireRedemptionHuman` / `requireCodexAppsHuman` | Managed mode, no bearer, same-origin, browser human (or agent acting as person) whose subject equals the `connections:write` grant subject. | `apps/api/src/routes/codex.ts:503`, `:550` |

Note: `subscription-pool-access.ts` registers **no routes**; it only holds the helpers above.

##### EP-S01 — Codex workspace connect (device code)
- Consumer: web `useCodexSubscriptions` (`apps/web/src/components/codex-connection.tsx:701`), SDK `codexConnectStart/Poll` (`packages/sdk/src/client.ts:9324`, `:9332`).
- Providers: Codex.
- Routes:

  | Method + path | Handler | Permission | DB subject |
  |---|---|---|---|
  | POST `/v1/workspaces/:workspaceId/codex/connect/start` | `codex.ts:1183` | `connections:write` | none (no DB write) |
  | POST `/v1/workspaces/:workspaceId/codex/connect/poll` | `codex.ts:1209` | `connections:write` | `withSessionCodexCapacityMutation` (workspace RLS, no subject); `connectedBySubjectId` stored only if the cookie human equals the grant subject (`:1297`) |
- Authority/pool: always writes a **workspace**-scope credential (`upsertCodexSubscriptionCredential`, `:1278`); then `ensureCodexRotationSettings`, `setInitialActiveCodexCredential`, and keeps the existing source mode (comment: "Automatic naturally prefers the newly connected workspace pool", `:1311`).
- Selection/pin/lease: sets the initial active pointer only.
- Failure: 502 on device/exchange errors; 409 "active turns are using it"; 409 unresolved reset redemption.
- Wait/recovery: wakes Codex capacity waiters via `signalCodexCapacityTargets` (`codex.ts:847`, Temporal signal).
- Status: `{status, plan, accountId, isActive}`.
- Divergences: signed state binds only `workspaceId` (no actor subject, unlike the org flow and SuperGrok, which bind the subject). Permission is `connections:write`, while Claude/SuperGrok workspace-scope connect needs `workspace:admin`. No "user" (personal) scope option. No reconnect-in-place parameter (re-login upserts by provider account).
- Bypasses shared logic: yes (Codex-only stack).

##### EP-S02 — Codex organization connect (device code)
- Consumer: web `useOrganizationCodexSubscriptions` via raw `client.requestJson` (`apps/web/src/components/organization-codex-subscriptions.tsx:78`, `:91`). No typed SDK method.
- Routes: POST `/v1/organizations/:organizationId/codex/connect/start` (`codex.ts:950`), POST `.../connect/poll` (`codex.ts:978`). Permission: `requireOrganizationCodexHuman(providerConsent: true)` + same-origin. DB subject: `actorSubjectId` = org admin human.
- Authority/pool: `upsertOrganizationCodexSubscriptionCredential` (org scope); `ensureOrganizationCodexRotationSettings`.
- Wait/recovery: `signalCodexCapacityTargets(upserted.wakeTargets)`.
- Status: `{status, plan, accountId, isActive}`; email stored as `accountEmail` and default label.
- Divergences: org account reach to workspaces is controlled separately by EP-S16 access policy; no per-person scoping.

##### EP-S03 — Codex workspace list / status / source

| Method + path | Handler | Permission | DB subject |
|---|---|---|---|
| GET `/v1/workspaces/:id/codex/source` | `codex.ts:886` | `workspace:read` | workspace RLS, no subject |
| PATCH `/v1/workspaces/:id/codex/source` (`automatic|workspace|organization|disabled`) | `codex.ts:892` | `connections:write` | `grant.subjectId` passed to `setWorkspaceCodexSubscriptionMode` |
| GET `/v1/workspaces/:id/codex/status` | `codex.ts:1349` | `workspace:read` | workspace RLS; live `/codex/models` call with the **active** account's token |
| GET `/v1/workspaces/:id/codex/accounts` | `codex.ts:1423` | `workspace:read` | workspace RLS |

- Authority/pool: live lookup of the effective pool. `listCodexAccountStatuses` (`packages/db/src/index.ts:29783`) returns only the effective source's rows (workspace **or** organization, never both), via `effectiveCodexCredentialPoolCondition`. Effective source comes from SQL `resolve_workspace_codex_subscription_source` (`packages/db/drizzle/0422_personal_workspace_organization_codex_inheritance.sql:198`): a non-automatic mode wins; `automatic` returns `workspace` when any workspace/user credential exists, else organization.
- Emails: yes, `codexAccountJson` (`codex.ts:93`) returns `email`, `label`, `plan`, cached `fiveHour`/`weekly`, plan exclusions, allocator fields, `source`.
- Status surfaced: `/status` returns `connected, valid, activeAccountValid, poolReady, workerRoutable, models, activeAccount{id,label,chatgptAccountId}, accountCount, source`.
- Divergences: Codex automatic precedence is workspace > organization; Claude/SuperGrok precedence is user > workspace > organization (EP-S10). Both conflict with "organization preferred". `/status` does a live provider call on a read route.

##### EP-S04 — Codex organization account management

| Method + path | Handler | Permission | DB subject |
|---|---|---|---|
| GET `/v1/organizations/:orgId/codex/accounts` | `codex.ts:926` | org admin human | `actorSubjectId` |
| POST `.../codex/accounts/:accountId/activate` | `codex.ts:1088` | org admin + same-origin | `actorSubjectId` |
| PATCH `.../codex/settings` `{rotationEnabled}` | `codex.ts:1105` | org admin + same-origin | `actorSubjectId` |
| PATCH `.../codex/accounts/:accountId` `{label}` | `codex.ts:1129` | org admin + same-origin | `actorSubjectId` |
| DELETE `.../codex/accounts/:accountId` | `codex.ts:1152` | org admin + same-origin | `actorSubjectId` |

- All mutations call `signalCodexCapacityTargets` with DB-returned wake targets.
- Divergences: no org allocator route (shared pool has `PATCH .../accounts/:id/allocator` for org), no org usage/refresh route, no org Apps designation. Rotation default when no row: `false` (shared pool workspace list defaults `true`, `subscription-account-pools.ts:265`).

##### EP-S05 — Codex workspace account mutations

| Method + path | Handler | Permission | Extra |
|---|---|---|---|
| POST `/v1/workspaces/:id/codex/accounts/:accountId/activate` | `codex.ts:1550` | `connections:write` | `requireWorkspaceCodexManagementSource`; `withCodexCapacityMutation` |
| PATCH `/v1/workspaces/:id/codex/settings` | `codex.ts:1576` | `connections:write` | `rotationStrategy` accepted and ignored |
| PATCH `/v1/workspaces/:id/codex/accounts/:accountId` (rename) | `codex.ts:1624` | `connections:write` | |
| PATCH `/v1/workspaces/:id/codex/accounts/:accountId/allocator` | `codex.ts:1646` | `connections:write` | OCC on `expectedVersion` |
| DELETE `/v1/workspaces/:id/codex/accounts/:accountId` | `codex.ts:1685` | `connections:write` | blocked by unresolved redemption |
| DELETE `/v1/workspaces/:id/codex` (legacy disconnect all) | `codex.ts:1714` | `connections:write` | deprecated |

- DB subject: workspace RLS; `grant.subjectId` passed for disconnect/allocator audit. Wake: `signalCodexCapacityTargets`.
- Divergence: Claude/SuperGrok workspace-scope mutations need `workspace:admin`; Codex needs only `connections:write`.

##### EP-S06 — Codex usage, quota and reset-credit redemption

| Method + path | Handler | Permission | Notes |
|---|---|---|---|
| GET `/v1/workspaces/:id/codex/usage` | `codex.ts:1740` | `workspace:read` | active account only; deprecated; live call |
| GET `/v1/workspaces/:id/codex/accounts/:accountId/usage` | `codex.ts:1756` | `workspace:read` | live call, writes cache |
| POST `/v1/workspaces/:id/codex/usage/refresh` | `codex.ts:1776` | `workspace:read` | live batch, concurrency 4, writes cache |
| GET `/v1/workspaces/:id/codex/overview` | `codex.ts:1819` | `workspace:read` | usage + reset credits; recoveries only for the `connections:write` human |
| POST `/v1/workspaces/:id/codex/accounts/:accountId/reset-credits/prepare` | `codex.ts:1954` | `requireRedemptionHuman` | HMAC confirmation; only the human who connected (`connectedBySubjectId`) |
| POST `.../reset-credits/redeem` | `codex.ts:2068` | `requireRedemptionHuman` | irreversible provider call |

- Wait/recovery: every usage read calls `signalPendingCodexCapacityTargets` so a quota reset can wake waiters.
- Divergences: a read permission (`workspace:read`) can trigger live provider calls and cache writes. Redemption is workspace-credential-only (doc `docs/codex-provider-account-authority.md`, last paragraph). No equivalent for Claude/SuperGrok.

##### EP-S07 — Codex Apps designation
- Routes: POST/DELETE `/v1/workspaces/:id/codex/apps` (`codex.ts:1464`, `:1518`). Permission: `requireCodexAppsHuman` + `requireWorkspaceCodexManagementSource` (409 when source is organization) + deployment flag. Only the human who connected the account may designate it.
- Divergence vs target: bound to a workspace-owned account; unavailable for organization-owned accounts.

##### EP-S08 — Codex session account projection and pin (the only session pin API)
- Consumer: React `useCodexAccounts` (`packages/react/src/hooks/use-codex-accounts.ts:145`), web `CodexAccountIndicator`.
- Routes:

  | Method + path | Handler | Permission | DB |
  |---|---|---|---|
  | GET `/v1/workspaces/:id/sessions/:sessionId/codex-accounts` | `apps/api/src/routes/sessions.ts:2320` | `sessions:read` + `workspace:read`; comment says private-session/agent scope already enforced by `authorizeSessionHttp` | `getSessionCodexAccounts` (`packages/db/src/index.ts:29893`) |
  | POST `/v1/workspaces/:id/sessions/:sessionId/codex-account` `{target:"auto"|<id>}` | `sessions.ts:2350` | `sessions:control` + `requireSessionAuthorization(session.codex_account.write)` when no session-auth middleware | `switchSessionCodexAccount` (`packages/db/src/index.ts:31594`) with `grant.subjectId` |
- Authority/pool: the pin target must belong to the session's accepted rotation source (`index.ts:31651-31668`); `appliedTo: waiting_turn | next_turn`. Pin is "manual"; a capacity-blocked turn is overridden and woken.
- Events: publishes `codex.account.selection.changed` / `codex.account.switched` (`index.ts:31759`, `:31875`).
- Divergence: **no session pin/indicator route for Claude or SuperGrok.** Their pins exist only internally (`setSubscriptionSessionAccountPin`, `packages/db/src/subscription-account-repository.ts:2153`, keyed by session + authority scope + owner membership, written by the worker and by SuperGrok realtime).

##### EP-S09 — Shared pool: organization account routes (Claude, SuperGrok)
- Factory: `registerSubscriptionAccountPoolRoutes` (`apps/api/src/routes/subscription-account-pools.ts:53`), registered by `registerClaudeSubscriptionAccountRoutes` (`claude-subscription-accounts.ts:69`) and SuperGrok (`supergrok.ts:257`). `{route}` = `claude` or `supergrok`.

  | Method + path | Line | Permission | DB subject |
  |---|---|---|---|
  | GET `/v1/organizations/:orgId/{route}/accounts` | `:146` | org admin human | `actorSubjectId` |
  | PATCH `.../{route}/settings` | `:168` | org admin + same-origin | `actorSubjectId` |
  | POST `.../{route}/accounts/:accountId/activate` | `:206` | same | same |
  | DELETE `.../{route}/accounts/:accountId` | `:209` | same | same |
  | PATCH `.../{route}/accounts/:accountId` (rename) | `:212` | same | same |
  | PATCH `.../{route}/accounts/:accountId/allocator` | `:217` | same | same |
- Wake: done inside the org repository (`wakeOrganizationPool`, `packages/db/src/organization-subscription-repository.ts:108`, called after policy/credential writes), not in the route.
- Emails: yes (`email` field). Claude list adds per-account usage via `listClaudeAccountUsage`; SuperGrok adds cached `quota` + `exhaustedUntil` (`supergrok.ts:138`).
- Divergence: org routes for these providers do not use `requireOrganizationCodexHuman(providerConsent)`; only the connect routes do.

##### EP-S10 — Shared pool: workspace account routes (Claude, SuperGrok), incl. personal ("user") accounts

| Method + path | Line | Permission | DB subject |
|---|---|---|---|
| GET `/v1/workspaces/:id/{route}/accounts` | `:227` | `workspace:read`; if the caller's acceptance snapshot is `user`, also the private human | `grant.subjectId` |
| POST `.../{route}/accounts/:accountId/activate` | `:272` | `requireSubscriptionScopeMutation(account scope)` | `grant.subjectId` + account's snapshot |
| PATCH `.../{route}/settings` | `:297` | scope mutation for the **caller's effective** scope | same |
| PATCH `.../{route}/accounts/:accountId/allocator` | `:338` | scope mutation for account scope | same |
| PATCH `.../{route}/accounts/:accountId` (rename) | `:378` | same | same |
| DELETE `.../{route}/accounts/:accountId` | `:403` | same | same |

- Authority/pool: live lookup. `resolveReadAuthority` (`:105`) calls `resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance` (`packages/db/src/subscription-account-repository.ts:754`): returns `user` if the caller has a user-scope rotation row whose **active pointer** is an active user credential; else `workspace` if any workspace credential exists; else `organization` if the org pool has an active pointer; else `workspace`. So an active personal pool automatically wins (conflicts with target).
- The list filters rows by that snapshot (`:248-252`): organization snapshot → only org rows; otherwise all non-org rows visible under RLS (workspace + caller's own user rows). Rotation settings returned/changed are those of the caller's effective pool, so a user with an active personal pool sees and edits **their personal** pool's rotation on the workspace page.
- DB subject: `grant.subjectId` with workspace+subject RLS (`withWorkspaceSubjectRls`, seen at `subscription-account-repository.ts:758`; assumed for the other repository functions, **uncertain** — not read individually).
- Wake: `wakeSubscriptionCapacityWaiters` per mutation with reason `${provider}_..._changed`. Delete of a user account wakes **before** disconnect; delete of a workspace account wakes after with a hard-coded workspace snapshot (`:408-430`).
- Divergences: rotation default when no row is `true` (`:265`) vs Codex `false`. Organization-scope accounts → 409 (manage in org settings).

##### EP-S11 — Claude OAuth connect / reconnect
- Routes: POST `/v1/workspaces/:id/model-providers/claude_subscription/oauth/start|complete` and POST `/v1/organizations/:orgId/model-providers/claude_subscription/oauth/start|complete` (`apps/api/src/routes/claude-subscription-oauth.ts:83-140`).
- Permission: workspace → `connections:write` grant + managed cookie human (or local mode) **and** `requireSubscriptionScopeMutation(scope)`; org → `requireOrganizationCodexHuman(providerConsent: true)`. Complete re-checks with `requireFreshAccessGrant` and requires same subject + browser session hash (`:127-135`).
- Logic: `startClaudeSubscriptionOAuth` / `completeClaudeSubscriptionOAuth` (`apps/api/src/claude-subscription-oauth.ts:97`, `:141`). Reconnect = `reconnectAccountId` with generation fence; reconnect to a different provider account → 409 (`:248-256`). Stores email from profile (`accountEmail`, `:281`), plan, OAuth scopes.
- Scope: workspace path accepts `workspace` or `user`; org path requires body `scope:"workspace"` and stores organization scope (`claude-subscription-oauth.ts` route `:92`) — odd but intentional-looking.
- Wake: `wakeClaudeCapacityWaiters` for workspace path only (org path relies on repository wake, **uncertain** whether `upsertOrganizationClaudeSubscription` wakes; SuperGrok's org repository does).

##### EP-S12 — Claude setup-token connect / replace
- Routes: POST `/v1/workspaces/:id/claude/accounts/setup-token`, POST `/v1/organizations/:orgId/claude/accounts/setup-token` (`apps/api/src/routes/claude-subscription-accounts.ts:202-333`).
- Permission: same-origin; workspace → `requireSubscriptionScopeMutation(scope)`; org → `requireOrganizationCodexHuman` **without** `providerConsent`.
- Stores `accountEmail: null`, `planType: null`, provider id = HMAC of token (`:270-279`). Replace via `reconnectAccountId` + `expectedCredentialVersion`.
- Divergence: setup-token accounts never show an email; org connect path allows an agent acting as a person while OAuth/device connects refuse agents.

##### EP-S13 — Claude per-account usage
- Routes: GET/POST-refresh `/v1/workspaces/:id/claude/accounts/:accountId/usage[/refresh]` and org equivalents (`claude-subscription-accounts.ts:163-200`). Workspace: `workspace:read` (+ private human for user accounts; refresh adds scope mutation). Org: org admin.
- Refresh: `refreshClaudeAccountUsage` (`apps/api/src/claude-subscription-account-usage.ts:14`) — "never selects a different account"; 30-second throttle; needs `user:profile` scope.
- Legacy aggregate usage routes return 410: `/v1/workspaces/:id/model-providers/claude_subscription/usage[/refresh]` (`workspace-model-providers.ts:61-75`) and org equivalent (`organization-model-providers.ts:120-142`). SDK still exposes them (EP-S28).

##### EP-S14 — SuperGrok connect (device code)
- Workspace: POST `/v1/workspaces/:id/supergrok/connect/start` (`supergrok.ts:369`), `/poll` (`:419`). Body `scope: workspace|user` (default workspace). Permission: `requireScopeMutation(scope)` + `requireAccessGrantAuthorization(workspace:admin or connections:write)`. State binds `workspaceId`, `scope`, `subjectId`, optional encrypted external continuation; poll re-checks live authority twice and fails on identity change.
- Org: POST `/v1/organizations/:orgId/supergrok/connect/start|poll` (`:291`, `:311`), `providerConsent: true`, state binds org + actor.
- Persists `accountEmail` from token identity and returns `email` in the poll response.
- Wake: workspace path `wakeXaiCapacityWaiters` (`:533`); org path via repository.

##### EP-S15 — SuperGrok status
- GET `/v1/workspaces/:id/supergrok/status` (`supergrok.ts:570`). `workspace:read`; user snapshot needs private human. Live model fetch with the active account (`materializedAuthContext` + `fetchXaiSubscriptionModels`).
- Returns `activeAccount{id,label,subject,scope}` (no email). There is **no** SuperGrok usage/quota endpoint; quota is only in cached account rows.
- There is **no** Claude status endpoint at all.

##### EP-S16 — Model connection access policy (which workspaces/models an account serves)
- Routes: GET/PUT `/v1/{organizations|workspaces}/:scopeId/model-connections/:kind/:connectionId/access` (`apps/api/src/routes/model-connection-access.ts:59-220`), kinds include `codex`, `supergrok`, `claude_subscription`.
- Org scope: org admin. Workspace scope: `workspace:read`; SuperGrok/Claude user-scope rows need the owner (SuperGrok uses `managedHumanOrAgent`, Claude uses `requirePrivateSubscriptionHuman` — different helpers); mutation needs `workspace:admin` or scope mutation. Codex rows in workspace scope get no per-credential scope check (Codex has no user scope).
- Policy shape: `allowedModels`, `allowedWorkspaces`, `allowPersonalWorkspaces` (`packages/contracts/src/model-connection-access.ts:3`). No per-person audience.
- `personalWorkspacesSupported` true for codex, supergrok **and** claude_subscription (`model-connection-access.ts:191-195`), but the web only offers it for codex and supergrok (EP-S34).

##### EP-S17 — Realtime account selection (outside turns)
- SuperGrok: POST `/v1/workspaces/:id/sessions/:sessionId/realtime/supergrok` (`apps/api/src/routes/sessions.ts:1881`) → `createXaiRealtimeConnectionSecret` (`apps/api/src/xai-realtime.ts:48`). Resolves the caller's **live** acceptance snapshot (`:63`), reads/writes the session pin (`policy` pin when rotation is on).
- Codex: `brokerSessionCodexRealtime` (`apps/api/src/codex-realtime.ts:181`) → `selectCodexCredentialId(sessionPinned, active, connected)` from live session state.
- Claude: no realtime path found.
- Gap: realtime uses the current person's live scope, not the session's accepted scope.

---

#### Session creation, model availability, accepted authority snapshots

Background facts:
- SuperGrok and Claude snapshots are opaque `{version:1, scope:"workspace"|"organization"}` or `{version:1, scope:"user", authorityGeneration}` (`packages/contracts/src/claude-provider-account-authority.ts` reuses the xAI schema). Stored on `session_turns`, `sessions.initial_*`, `scheduled_tasks`, `session_system_updates` (`packages/db/src/schema.ts:4780`, `:7159`, `:8614`, `:8721`, `:11621`).
- **Codex has no snapshot on accepted work.** `CodexProviderAccountAuthoritySnapshotV1` exists only in `packages/contracts/src/codex-provider-account-authority.ts` and is unused elsewhere. Codex freezes its source/policy later: `CodexCredentialPolicySnapshotV1` "accepted with the first durable lease" in turn metadata (`packages/contracts/src/index.ts:18003-18036`) and `codex_turn_source_bindings` (read by `codexSourceForTurn`, `packages/db/src/index.ts:23935`; written by DB functions from migration `0492_codex_accepted_source_authority.sql`; exact write timing **uncertain**, worker side).
- Subject for user-scope: `subscriptionExecutionAuthorityFromTurn` (`packages/db/src/accepted-subscription-authority.ts:13`) uses `initiatingHumanSubjectId` or the subject initiator; throws if a user-scope turn lost it.

##### EP-S18 — Top-level session create: default model + admission + initial snapshot
- Consumer: API/Slack/MCP session create → `createSessionForRequestInFileScope` (`packages/core/src/domain/sessions.ts:2415`).
- Default model: `resolveDefaultSessionModel` (`packages/core/src/default-session-model.ts:558`) when no model and no parent (`sessions.ts:2711-2722`): saved default → selectable subscription model → credits → deployment default (`selectDefaultSessionModel`, `default-session-model.ts:194`).
- Admission: `assertWorkspaceModelPolicyAllows` then, for fresh top-level creates only, `resolveCallerWorkspaceModelSelections` + `admissibleWorkspaceModel` → 422 "model is not selectable" (`sessions.ts:3119-3140`). This is the only API-side check that a subscription pool is "active" for the model.
- What "selectable" means per provider (`loadWorkspaceModelSelectionInput`, `default-session-model.ts:415`):
  - Codex: `workspaceCodexSubscriptionActive(workspaceId)` (`packages/db/src/index.ts:25536`, effective pool, no subject) + optional live `/codex/models` per eligible account (`loadWorkspaceCodexModelAvailability`, `packages/core/src/codex-model-availability.ts:35`) + per-account `allowedModelIds` restrictions (`getWorkspaceConnectionModelRestrictions`, `packages/db/src/index.ts:29754`).
  - SuperGrok: `workspaceXaiSubscriptionActive(workspaceId, subjectId)` or, with a frozen snapshot, `workspaceXaiSubscriptionActiveForAuthority`; an inactive frozen user pool closes SuperGrok instead of swapping pools (`default-session-model.ts:328-383`).
  - Claude: `loadWorkspaceClaudeSubscriptionReadiness` (`:388`) — metadata only, quota left to runtime; splits into `workspace` vs `organization` catalog entries.
  - Create path calls it with `observeAvailability` off, so Codex live discovery is skipped at create (`:521-533`).
- Snapshot capture: `createSessionInTransaction` (`packages/db/src/index.ts:34521`, lines `34653-34680`): if no snapshot was passed and the creator is a subject, resolves the **live** acceptance snapshot under that subject; otherwise workspace default.
- Divergence: Codex readiness ignores the caller (no subject), SuperGrok/Claude depend on the caller's personal pool.

##### EP-S19 — Child session create
- Snapshot: copied from the parent's calling turn (`getSessionTurnXai/ClaudeProviderAccountAuthoritySnapshot`, `sessions.ts:2778-2795`) when the creator is an agent attempt.
- Model: inherited from the calling turn (`sessions.ts:2723-2727`); **no** subscription admission for children (`sessions.ts:3124`, `!parentSession` guard). Worker enforces later.
- Codex: nothing frozen at create; child picks its pool at first lease (live).

##### EP-S20 — Send / steer a message (human, operator, service, agent attempt)
- Path: `acceptSessionUserMessageInFileScope` (`sessions.ts:3993`) builds the command actor (`:4041`: service initiator → `service`; caller attempt claims → `agent_attempt`; else `human`) → `postUserMessageTurn` (`sessions.ts:1941`) → `submitHumanPromptInTransaction` (`packages/db/src/session-queue-commands.ts:1744`).
- Model checks at send: `canonicalConfiguredModel` (`sessions.ts:1631`; admits any `codex/` or SuperGrok-prefixed id when the feature flag is on, deferring connection checks to the worker), `assertWorkspaceModelPolicyAllows`, `assertSessionAllowsProductModel` (remote_v2 Codex lock, `sessions.ts:1704`), and a custom-model lock for workspace custom models (`beforeFreshPromptCommit`, `sessions.ts:2034-2056`). **No check that a subscription account is usable** for the model at send.
- Snapshot (`session-queue-commands.ts:2129-2146`):
  - edit of a queued turn → copied from the edited source turn;
  - `actor.type === "human"` → **live** acceptance snapshot for the RLS subject;
  - every other actor (`operator`, `service`, `agent_attempt`) → hard-coded **workspace** snapshot.
- Finding: an agent attempt that posts through this path (it is supported: locks at `:1831-1835`, auto-resume at `:1971`) does **not** inherit its originating turn's scope, unlike `sendAgentMessageInTransaction` (EP-S21). An API-key/service send to a session that has been running on a personal or organization pool is accepted as workspace scope. Either is a concrete way for a later turn to "carry the wrong scope". Not reproduced; code-path finding only.

##### EP-S21 — Agent-to-agent message and steer (session_send_message / steer)
- `sendAgentMessageInTransaction` (`session-queue-commands.ts:2642`, snapshot at `:2720-2721`) and `steerAgentSessionInTransaction` (`:2911`, `:2992-2993`) copy the **caller's** turn snapshot via `subscriptionAuthorityForAgentActor` (`:421`) into the `session_system_updates` row; lineage carries `xai/claudeAuthoritySubjectId` (`:2779-2781`).
- Minor: `subscriptionAuthorityForAgentActor` returns a subject for any scope, while `subscriptionExecutionAuthorityFromTurn` only for `user`; the lineage therefore carries a subject id even for workspace scope.

##### EP-S22 — Batched internal updates → one turn (claim)
- Planning: `planInboxBatch` (`packages/db/src/index.ts:71269`) loads the receiving session's execution context (`loadInboxExecutionContext`, `packages/db/src/inbox-execution-context.ts:58`). `sessions.execution_context_turn_id` is the latest started `user`/`api` turn (trigger `advance_session_execution_context`, `packages/db/drizzle/0608_receiver_execution_context.sql:92`).
- Two modes:
  - **Receiver-owned** (`index.ts:71332`): the new turn takes `personalConnectionDelegations`, MCP bindings **and both provider snapshots from the receiving context turn** (`index.ts:74225-74238`, inserted at `:74745-74746`). Eligibility for informational agent updates (`agent_message`, `child_*`) checks only same causal human, no external link, no credential restriction (`inbox-execution-context.ts:105-127`) — it does **not** compare the update's frozen xAI/Claude snapshot with the receiver's. Other updates must have an equal authority key (`index.ts:71316-71330`).
  - **Not receiver-owned**: snapshot from `delivered.updates[0]` (`frozenSubscriptionExecutionAuthority`, `index.ts:70972`); coalescing requires equal `systemUpdateExecutionAuthorityKey` (`:71001`, `:71106-71117`).
- Which snapshot an agent-update turn uses: it is either copied from the **receiving session's** last user/api turn (receiver-owned) or from the **sender's** turn (first update). It is never recomputed live and never copied from "the original accepted work" of the receiving session when that session has no user/api context turn (for example a child that only ever ran agent-created turns, **uncertain** whether child turns ever count as `api` source). Concrete risks: (1) receiver-owned eligibility ignores provider snapshots, so a parent update accepted under one scope runs under the receiver's other scope; (2) non-receiver-owned turns take the sender's scope, not the receiver session's.
- Copy bug: the Claude subject mismatch throws "xAI system-update subject does not match turn provenance" (`index.ts:74612`, duplicate of `:74603`).

##### EP-S23 — Other system-originated turns and updates

| Source | Snapshot taken from | Fallback | Ref |
|---|---|---|---|
| Goal continuation | latest finished causal turn | workspace | `materializeGoalContinuation`, `index.ts:69305` (`:69780-69806`) |
| Session wait timeout | causal turn (`sameSessionCausalAuthorityTx`) | workspace | `settleSessionInputWaitInActivity`, `index.ts:76959` (`:77008-77013`) |
| Background command result | launch receipt causal turn | workspace | `backgroundCommandTerminalMutation`, `index.ts:84806` (`:84970-84975`) |
| Child lifecycle notices | parent turn (`parentOutboxAuthorityTx`) | workspace | `packages/db/src/child-outbox-authority.ts:8` |
| Context compaction turn | `latestStarted` turn of the session | workspace | `claimSessionWorkForAttempt`, `index.ts:74040-74045` |
| Generic `enqueueSessionTurn` / `addSessionSystemUpdateWithSourceMutation` | caller input | workspace | `index.ts:70812` (`:70905`), `:84244` (`:84396`) |
| Retry of a failed turn | same turn row (in place) | n/a | `packages/db/src/session-retry.ts:86` |

- Pattern: every path silently falls back to **workspace** when no causal authority is found. For a session that ran on organization or personal pools this is a scope change, not a failure.

##### EP-S24 — Scheduled tasks
- Create: `createValidatedScheduledTask` (`packages/core/src/domain/scheduled-tasks.ts:271`, snapshot at `:525-548`): agent creator → copy from the creating turn; human → live acceptance snapshot. Only a custom-model commit guard runs (`workspaceCustomModelCommitGuard`, `:181`); no subscription usability check.
- Update: `validatedScheduledTaskUpdate` (`:1232`) refuses a material change to a **user-scoped xAI** task by another human (`:1735-1749`). **No equivalent Claude check.**
- Occurrence default model: `resolveScheduledTaskDefaultModel` (`default-session-model.ts:586`) under the task owner + frozen snapshots; worker caller `apps/worker/src/activities/scheduled-tasks.ts:556`.
- Codex: nothing frozen on the task.

##### EP-S25 — Model availability surfaces
- GET `/v1/config/client` (`apps/api/src/app.ts:1269`, selections at `:1326`): `resolveCallerWorkspaceModelSelections(..., observeAvailability: true)` under the caller's grant.
- GET `/v1/workspaces/:id/model-catalog` (`apps/api/src/routes/workspaces.ts:553`): **re-implements** the same inputs inline instead of calling `loadWorkspaceModelSelectionInput` (`workspaces.ts:566-630`). Bypasses shared logic; drift risk.
- Agent `list_models` tool: `createListModelsAttemptToolDefinition` (`apps/worker/src/activities/agent-turn/tool-environment.ts:935-951`) uses `loadWorkspaceModelSelectionInput` with the **turn's frozen** xAI/Claude snapshots and the turn's initiating human; Codex availability is live per workspace.
- Codex catalog via `/codex/status` (EP-S03) and SuperGrok via `/supergrok/status` (EP-S15); Claude has none.

---

#### SDK, React and web

##### EP-S26 — SDK (`packages/sdk/src/client.ts`, types in `packages/sdk/src/types.ts`)

| Area | Codex | Claude | SuperGrok |
|---|---|---|---|
| Workspace list | `listCodexAccounts` `:9378` | `listClaudeSubscriptionAccounts` `:4975` | `listSuperGrokAccounts` `:9671` |
| Status | `codexStatus` `:9316` | none | `supergrokStatus` `:9645` |
| Connect | `codexConnectStart/Poll` `:9324/:9332` | setup token `:5125`; OAuth start/complete `:5146/:5157` | `supergrokConnectStart(scope)` `:9652`, poll `:9663` |
| Activate / rotation / allocator / rename / disconnect | `:9397/:9433/:9449/:9473/:9462` | `:4980/:4990/:4996/:5007/:5018` | `:9678/:9689/:9700/:9712/:9724` |
| Usage | `codexUsage`, `codexAccountUsage`, `refreshCodexUsage`, `codexOverview` `:9341-9365` | per-account `:5028/:5037`; legacy aggregate `:4968/:5190` (server returns 410) | none |
| Org accounts | **none** (type `OrganizationCodexAccountsResponse` exists, `types.ts:4116`, but no method) | `listOrganization...` and mutations `:5048-5114`; org setup token `:5135`, OAuth `:5168/:5179`; legacy org usage `:5200/:5209` (410) | `listOrganizationSuperGrokAccounts` + connect + mutations `:9570-9634` |
| Session | `listSessionCodexAccounts` `:9386`, `pinSessionCodexAccount` `:9486` | none | none |
| Source mode / Apps / redemption | Apps `:9408/:9421`; **no** source GET/PATCH, **no** reset-credit methods | n/a | n/a |
| Access policy | `getModelConnectionAccess` / `updateModelConnectionAccess` `:9500-9560` (generic) | same | same |

- Types: `CodexAccount` has `email`, `source`, usage windows (`types.ts:3978`); `SuperGrokAccount` has `scope`, `email`, `quota`, `exhaustedUntil` (`:4164`); `SessionCodexAccountsResponse` (`:4120`); `CodexAccountSwitchedPayload` (`:4135`). Session type exposes only `codexPinnedCredentialId` (`types.ts:1620`).

##### EP-S27 — React (`packages/react/src`)
- `useCodexAccounts` (`hooks/use-codex-accounts.ts:145`): workspace or session-scoped Codex accounts, pin, live usage refresh; refetches on `isCodexAccountEvent` (`:19`, Codex events + generic turn/status events). Codex-only.
- `useSuperGrokAccounts` (`hooks/use-supergrok-accounts.ts:43`): polls workspace list only; no session scope, no pin.
- No Claude hook in the package.
- Model policy / picker: `model-policy.ts` billing labels per provider (`:31-33`, `:186-241`); `groupPickerRowsByBillingClass` with `codexOnly` (`:399`, `:510`) and `applyCodexOnly` (`model-picker-model.ts:133`) disable non-Codex rows for `remote_v2` sessions (web passes it at `apps/web/src/routes/session.tsx:2571`, `:3465`).
- Timeline: `codex.capacity.waiting` renders a "waiting" notice (`timeline/projection.ts:1088`); `turn.capacity_waiting` (Claude/SuperGrok) is only treated as execution evidence (`:2491`) and gets **no notice**. Fleet decision rows are Codex-only (`timeline/fleet-decision-row.tsx`).
- Status label: generic "Waiting for capacity" for `waiting_capacity` (`session-status-model.ts:14`), no provider shown.

##### EP-S28 — Web: workspace/org models pages (provider pools)
- `useSubscriptionAccountPool` (`apps/web/src/components/models/use-subscription-account-pool.ts:36`): provider-generic list + mutations; used by `useClaudeSubscriptions` (`models/use-claude-subscriptions.ts:6`) and `useSuperGrokSubscriptions` (`apps/web/src/components/supergrok-connection.tsx:41`). `inherited = !organizationId && source === "organization"` disables management (`:146`).
- Codex uses its own hooks: `useCodexSubscriptions` (`apps/web/src/components/codex-connection.tsx:529`, SDK plus raw `requestJson` for `/codex/source` at `:666`, `:723`) and `useOrganizationCodexSubscriptions` (`organization-codex-subscriptions.tsx:22`, all raw `requestJson`).
- Rotation UI: Codex `codex-models.tsx:570-597` ("Sharing work between this workspace's accounts", only when the workspace manages its own pool) and org `organization-models-list.tsx:488`; Claude/SuperGrok via `SubscriptionRotationSettingRows` (`models/subscription-account-ui.tsx:30`). **No UI shows org vs workspace precedence or the source of an effective rotation value**; the workspace page only hides controls when the pool is inherited. Codex shows which pool is in use and "set aside" pools (`codex-models.tsx:125-171`).
- Personal accounts: "Who can use it — Everyone / Only me" (`models/subscription-connect-scope.tsx:4`) used by Claude sign-in (`models/claude-signin.tsx:257`) and SuperGrok (`models/supergrok-models.tsx:357`). Codex has none. Org page tags user accounts "only you" (`organization-models-list.tsx:308`, `:322`).
- Device-code panel: `SubscriptionDeviceCodePanel` supports `codex | supergrok` only (`subscription-device-code-panel.tsx:20`); Claude uses paste-code OAuth / setup token.
- Portable vs remote_v2 Codex chats: `CodexProviderSwitchRow` (`models/codex-provider-switch-row.tsx:22`), workspace setting `codexCompactionDefault`.

##### EP-S29 — Web: session account indicator / switcher
- `CodexAccountIndicator` (`apps/web/src/components/session/codex-account-indicator.tsx:101`) rendered only when the session's model is a Codex product model (`apps/web/src/components/rail/rail-shell.tsx:589`, `isCodexProductModel`; component also checks the `codex/` prefix at `:115`). Shows current/waiting account, usage bars, "Retry with" / "Use for next turn" pin menu (`:263-272`).
- **Codex-only.** No indicator, switcher or waiting account display for Claude or SuperGrok sessions.

##### EP-S30 — Web: organization connection access ("Available in")
- `connect-audience.tsx`: `personalWorkspacesSupported(kind)` returns true only for `codex` and `supergrok` (`:37`), while the API reports true for `claude_subscription` too (EP-S16). Audience is workspaces + one Personal-workspaces toggle; no chosen people.

---

#### Events and status fields

##### EP-S31 — Session events and turn/session status (`packages/contracts/src/index.ts`)

| Signal | Codex | Claude | SuperGrok |
|---|---|---|---|
| Capacity wait event | `codex.capacity.waiting` (emitted `packages/db/src/index.ts:27079`) | `turn.capacity_waiting` with `payload.provider` (`createScopedSubscriptionCapacityWaiters`, `index.ts:28118`, event at `:28657`) | same as Claude |
| Resume / supersede | `codex.capacity.resumed`, `codex.capacity.superseded` | `turn.recovery.requested` / `turn.superseded` (generic) | same |
| Account switched / selection | `codex.account.switched`, `codex.account.selection.changed`, `codex.credential.selected`, `codex.fleet.decision` (`contracts:13917-13930`) | none | none |
| Turn status | `waiting_capacity` (`SessionTurnStatus`, `contracts:6484`) — generic | same | same |
| Session status event | `session.status.changed {status:"waiting_capacity", reason}` | reason `claude_capacity` | reason `xai_capacity` |
| Child notice | `child_waiting_capacity {provider: codex|xai|claude}` (`contracts:8597`) — generic | same | same |
| Session projection fields | `codexPinnedCredentialId`, `codexLastCredentialId`, `codexCurrentSelection`, `codexCompactionMode` (`contracts:13524-13537`) | none | none |
| Event class `provider_account` | lists only Codex events (`contracts:14208-14216`) | — | — |
| Failure codes | Codex allocator codes | `claude_capacity_unavailable`, `claude_allocator_disabled`, `claude_capacity_wait_stale` (`apps/worker/src/activities/agent-turn/xai-capacity.ts:190-226`) | `xai_*` equivalents |
| Quota data | `fiveHour`/`weekly` on account rows | `ClaudeSubscriptionUsage` windows (`packages/contracts/src/claude-subscription-usage.ts:39`) | `quota`, `exhaustedUntil` on account rows |

---

#### (a) Provider-generic vs provider-specific surfaces

Provider-generic (one implementation, several providers):
- Shared pool routes for Claude + SuperGrok (EP-S09, EP-S10) and their repository; permission helpers in `subscription-pool-access.ts`.
- Model connection access policy routes (EP-S16); SDK `get/updateModelConnectionAccess`.
- `requireOrganizationCodexHuman` (Codex-named but used by all org routes).
- Turn status `waiting_capacity`, `child_waiting_capacity`, `turn.capacity_waiting` (Claude + SuperGrok only), generic "Waiting for capacity" label.
- Default model / admission pipeline (`loadWorkspaceModelSelectionInput`, `resolveWorkspaceModelSelection`) — generic shape, provider-specific readiness inputs.
- Web `useSubscriptionAccountPool`, `SubscriptionRotationSettingRows`, `SubscriptionConnectScope`, `SubscriptionAccountRows/Detail` (Claude + SuperGrok).

Provider-specific:
- Codex: entire route stack (`codex.ts`), source mode, Apps, reset-credit redemption, usage/overview, session pin + projection, all `codex.*` events, `useCodexAccounts`, `CodexAccountIndicator`, Codex web hooks, `codexOnly` picker filter, remote_v2 lock.
- Claude: OAuth paste-code and setup-token connect, per-account usage endpoints, Claude-only SDK methods; no status route, no React hook.
- SuperGrok: device-code connect with scope, status route, realtime pin, `useSuperGrokAccounts`.
- `/v1/workspaces/:id/model-catalog` re-implements selection inputs inline (bypasses shared loader).

#### (b) Gaps vs target model

1. **Accounts list parity.** Codex workspace list shows only the effective pool and no personal rows; Claude/SuperGrok list depends on the caller's effective snapshot (user/workspace vs org). No single list of all connections a workspace can use. Codex org has no allocator route; SDK has no org Codex methods; Claude has no status route.
2. **Emails.** Codex OAuth, Claude OAuth and SuperGrok store and return email. Claude setup-token accounts store `null` email. Status `activeAccount` objects (Codex, SuperGrok) omit email.
3. **Multi-account.** All three support multiple accounts with allocator + rotation; defaults differ (Codex rotation `false` when unset; shared pool workspace list reports `true`).
4. **Ownership and scope.** Workspace-owned connections exist for all three (target: none). Codex has no personal (user) scope; Claude/SuperGrok do. No per-person audience on organization connections. Codex Apps and redemption require workspace-owned accounts.
5. **Precedence.** Claude/SuperGrok: active personal pool > workspace > organization, automatically (`subscription-account-repository.ts:775-830`). Codex automatic: workspace > organization. Target: organization preferred, personal only by choice/opt-in.
6. **Rotation precedence display.** No UI shows an organization default with a workspace override or the source of the effective value; workspace controls simply hide when inherited. Workspace rotation edits can silently target a personal pool (EP-S10).
7. **Session indicator/switcher parity.** Only Codex has a session account projection, pin API, events and indicator. Claude/SuperGrok pins exist only internally and are keyed by authority scope, so a scope change between turns also changes the account.
8. **Sticky session account / scope drift.** Accepted scope is not a session property: human sends resolve live; operator/service/agent-attempt sends get hard-coded workspace (EP-S20); internal updates take receiver context or sender scope (EP-S22); system turns fall back to workspace (EP-S23); realtime resolves live (EP-S17). Codex freezes nothing at acceptance.
9. **Waiting/failure display.** Codex waits render a timeline notice and indicator state; Claude/SuperGrok waits only change the generic status (no notice, no account shown).
10. **Personal accounts per provider in UI.** Claude/SuperGrok offer "Only me"; Codex does not. Org "Personal workspaces" toggle offered for Codex/SuperGrok in web but Claude is supported by the API and not offered.
11. **Model availability.** No API-side subscription usability check at send, child create or scheduled task create; only top-level create runs admission. Codex availability is per workspace, SuperGrok/Claude per person.
12. **Codex remote_v2 lock** enforced at send (`assertSessionAllowsProductModel`) and in the picker (`codexOnly`).
13. **Permission asymmetry.** Codex workspace mutations need `connections:write`; Claude/SuperGrok workspace-scope mutations need `workspace:admin`. Claude org setup-token allows an agent acting as a person; other org connects do not. Scheduled-task user-scope edit guard exists for xAI only.

### 1.4 Entry points that bypass shared logic

"Shared logic" today means one of two stacks: the Codex allocator and lease (`acquireCodexCredentialLease`, `codex-rotation.ts`) or the generic Claude/SuperGrok repository (`packages/db/src/subscription-account-repository.ts`). Nothing is shared across all three providers except the lease heartbeat class (EP-T05) and the workflow wait loop (EP-T09).

| Entry point | What it bypasses | Reference |
|---|---|---|
| EP-T03, EP-T07 | Claude/SuperGrok turn selection and settlement duplicate the Codex phases rather than sharing them | `agent-turn/xai-capacity.ts:22`, `agent-turn/failure-settlement.ts:1488` |
| EP-T09 | Claude/SuperGrok recovery is a branch inside the Codex-named activity | `apps/worker/src/activities/codex-capacity.ts:313` |
| EP-T17, EP-N12 | Video funding on non-SuperGrok turns: live pool, no lease, writes the session pin | `agent-turn/agent-build.ts:429-494` |
| EP-N02 | Codex transcription: active pointer only | `apps/api/src/transcription/providers/codex-subscription.ts:43` |
| EP-N03 | SuperGrok transcription: shared selection, no lease, per-request shard | `apps/api/src/transcription/providers/xai-subscription.ts:52` |
| EP-N06 | Codex realtime: own pin→active rule, no capacity checks, no lease | `apps/api/src/codex-realtime.ts:268`, `packages/codex/src/realtime.ts:345` |
| EP-N07 | SuperGrok realtime: caller's live pool, no lease, writes the session pin | `apps/api/src/xai-realtime.ts:64-127` |
| EP-N14 | Video recovery: frozen token envelope and direct refresh outside the serialized refresh | `apps/worker/src/activities/video-generation-reconciliation.ts:709` |
| EP-N15–EP-N17 | Codex Apps: designation instead of selection, but token load gated by the model pool condition | `packages/runtime/src/index.ts:7311-7347` |
| EP-N18 | Reset-credit redemption: explicit account and own ledger (by design) | `apps/api/src/routes/codex.ts:1954`, `:2068` |
| EP-N19 | Funding predicate: live check for Codex, static overlay for others | `packages/core/src/billing/limits.ts:65` |
| EP-N23, EP-T04 | Several copies of SuperGrok auth-context building | `apps/api/src/xai-subscription-auth.ts:26`, `apps/api/src/routes/supergrok.ts:168`, `apps/worker/src/activities/xai-auth.ts:24`, `video-generation-reconciliation.ts:630` |
| EP-S25 | Workspace model catalog route re-implements selection inputs inline | `apps/api/src/routes/workspaces.ts:566-630` |
| EP-S01–EP-S08 | Entire Codex route stack is separate from the shared pool routes | `apps/api/src/routes/codex.ts` vs `apps/api/src/routes/subscription-account-pools.ts:53` |

## Part 2. Per-provider capability matrix

"Yes" means implemented and reachable on `0d7075e`. "Schema only" means storage exists but no code path uses it. References point to the entry point (EP-…) or data-model section (§4.x) that holds the evidence.

| Capability | Codex | Claude | SuperGrok (xAI) |
|---|---|---|---|
| Workspace-owned accounts | Yes (`authority_scope='workspace'`, 0024/0226) | Yes (0598) | Yes (0234) |
| Organization-owned accounts | Yes (0381; `organization_codex_rotation_settings`) | Yes (0598, converted from legacy org connections) | Yes (0423) |
| Personal (user-scope) accounts | Schema only (0226; no writer, RLS has no subject check; Part 4, §4.4.1) | Yes, bound to one workspace (`create_claude_subscription_credential`, 0598) | Yes, bound to one workspace (`create_xai_subscription_credential`, 0234) |
| Org account audience | Workspaces + Personal-workspaces flag (0424); no people | Same (0424 copied); web omits the Personal-workspaces toggle (EP-S30) | Same (0424) |
| Pool precedence when several exist | Workspace-local beats organization in `automatic` mode (`resolve_workspace_codex_subscription_source`, 0422); workspace can force `workspace`/`organization`/`disabled` (EP-S03) | Active personal pool → workspace (if any workspace row exists) → organization → workspace (`subscription-account-repository.ts:775`) | Same as Claude |
| When the pool is frozen | First lease of each turn (turn metadata + `codex_turn_source_bindings`, 0492) | At acceptance, on every accepted row (EP-T11) | At acceptance (EP-T11) |
| Multiple accounts per pool | Yes (0028) | Yes (#3281, 0598) | Yes (0234) |
| Rotation setting | Workspace row and separate org row, `rotation_enabled` default off (0053) | Per pool, default on; migrated pools off (0598) | Per pool, default on (0234) |
| Org default with workspace override and lock | No (independent rows; only the source `mode` is a workspace override) | No | No |
| Allocator enable per account | Yes (0053/0065) | Yes | Yes |
| Selection when rotation on | Policy pin, else FNV hash of session id over eligible accounts, after model and plan filters; documented `most_remaining` ranking is unreachable (CA-09) | Policy pin, else the same hash (`subscription-account-selection.ts:18`) | Same as Claude |
| Active pointer moved by selection | No in practice: requested, but every reachable selector branch returns `false` (CA-10) | No | No |
| Manual session pin | Yes, API + UI (EP-S08, EP-S29) | Honoured by selection; no route or UI sets it (EP-S08) | Same as Claude; realtime respects an existing manual pin (EP-N07) |
| Policy pin storage | `sessions.codex_pinned_credential_id` + `codex_pin_source` | `claude_session_account_pins` per (session, pool) | `xai_session_account_pins` per (session, pool) |
| Leases on turns | Yes (`codex_credential_leases`) | Yes | Yes |
| Leases outside turns | No consumer leases (EP-N02, EP-N06) | n/a | No (EP-N03, EP-N07, EP-N12) |
| Same-turn failover on account refusal | Yes, bounded by `codex_credential_failover_exhausted` (EP-T06) | Yes via wait + immediate reconcile, unbounded; 403 not rotated (EP-T07) | Yes via wait + reconcile, unbounded (EP-T07) |
| Durable capacity wait | Yes (`codex_capacity_waiters`, one per session) | Yes (factory waiters per session and pool); on private sessions reactive arming fails and recovery never resumes (EP-T07, EP-T09) | Same as Claude |
| Wait reason detail | Typed reasons (manual pin, active pointer, policy pool, credential, usage limit, plan) | One generic reason | One generic reason |
| Quota observation | Response headers (`latestCodexUsage`), `/codex/usage*`, two windows, reset credits (EP-T08, EP-N21) | Response headers + `api.anthropic.com/api/oauth/usage`, per-model windows and cooldowns (EP-N24, EP-N25) | Billing endpoint after each turn and for exhausted accounts (EP-T08, EP-N22) |
| Plan entitlement handling | Yes, model-scoped exclusions with 24 h TTL (0524, EP-T02) | No (per-model cooldowns only) | No |
| Reset-credit redemption | Yes, human-only, workspace-owned accounts only (EP-N18) | No | No |
| Connected Apps | Codex Apps, workspace-owned account only (EP-N15–N17) | No | No |
| Realtime voice | Yes, no lease, pin→active (EP-N06) | No | Yes, no lease, caller's live pool (EP-N07) |
| Transcription | Yes, active pointer only (EP-N02) | No | Yes, no lease (EP-N03) |
| Image generation | Yes, turn credential (EP-N08) | No | Yes, turn credential (EP-N09) |
| Video funding | No | No | Yes; organization pools rejected at reconciliation (EP-N13) |
| Compaction mode | `remote_v2` (default for new Codex sessions) or `portable` (EP-T16) | Portable only | Portable only |
| Accepted authority on schedules | No | Yes (`ownerSubjectId`) | Yes (`createdBy`) (EP-T15) |
| Status endpoint | `/codex/status`, `/codex/overview` (EP-S03, EP-S06) | None (per-account usage only) | `/supergrok/status` (EP-S15) |
| Session account projection, events, indicator | Yes (EP-S08, EP-S29, EP-S31) | No | No |
| Fleet shadow / replay | Yes (Part 3, CA section on shadow) | No | No |
| Billing bypass predicate | Live workspace account check (EP-N19) | Static model overlay | Static model overlay |
| Refresh failure marks account `needs_relogin` | Yes, from any resolver use (EP-N02) | Only through turn failure quarantine; usage snapshot records `reconnect` (EP-N24) | Only through turn failure quarantine (EP-N03) |
| Workspace mutation permission | `connections:write` (EP-S05) | `workspace:admin` (EP-S10) | `workspace:admin` (EP-S10, EP-S14) |
| SDK org methods | None (EP-S26) | Yes | Yes |
| Cross-provider failover | No | No | No |

Provider-specific facts that should become capability flags rather than conditionals: Claude setup tokens cannot renew and store no email (EP-S12); Claude OAuth renewal keeps the credential version (`refreshIncrementsVersion: false`, `packages/db/src/claude-subscription-accounts.ts:92`); Codex has plan entitlements and reset credits; SuperGrok funds video and has hosted search on the transport (`agent-turn/web-search.ts:54`); Codex and SuperGrok support realtime, transcription and images; only Codex has a remote compaction format.

## Part 3. Codex audit: documented contract versus code

Sources compared:

- Docs: `docs/codex-subscription-rotation.md` (cited as `rot.md:<line>` plus section), `docs/codex-provider-account-authority.md` (`auth.md:<line>`), `AGENTS.md` Codex bullets (`AGENTS.md:<line>`).
- Code: `apps/worker/test/fixtures/legacy-codex/rotation.ts`, `apps/worker/src/activities/codex-capacity.ts`, `apps/worker/src/activities/agent-turn/{codex-capacity,credential-leases,subscription-lease,failure-settlement}.ts`, Codex accessors in `packages/db/src/index.ts`, `packages/db/src/codex-*.ts`, `packages/contracts/src/codex-provider-account-authority.ts`, `packages/config/src/subscription-account-selection.ts`, plus the helpers and migrations they call (`packages/db/src/database.ts`, migrations 0225, 0304, 0345, 0422 and 0492 in `packages/db/drizzle/`, `apps/worker/src/workflows/session.ts`, `apps/worker/src/activities/agent-turn/run.ts`, `apps/api/src/routes/codex.ts`).

Flags: **CONTRADICTION** = the doc says one thing and the code does another. **TARGET-CONFLICT** = current behaviour conflicts with the agreed target model. **uncertain** = not fully confirmed; reason given.

Abbreviations: `db` = `packages/db/src/index.ts`; `rot.ts` = `apps/worker/test/fixtures/legacy-codex/rotation.ts`; `cap.ts` = `apps/worker/src/activities/codex-capacity.ts`; `turncap.ts` = `apps/worker/src/activities/agent-turn/codex-capacity.ts`; `fs.ts` = `apps/worker/src/activities/agent-turn/failure-settlement.ts`.

---

### 3.1 Security, scope and source authority

#### CA-01 Pool = exactly one source; `automatic` prefers any workspace-local credential

- Intended: `rot.md:11-16` (§Security and scope): source is `automatic | workspace | organization | disabled`; `automatic` uses the workspace pool when any local credential exists, otherwise the organization pool; never union-ranked.
- Actual: SQL `resolve_workspace_codex_subscription_source` (`packages/db/drizzle/0422_personal_workspace_organization_codex_inheritance.sql:198-247`): a non-`automatic` mode is returned as-is; otherwise `workspace` if any row has `workspace_id = <ws>` and `authority_scope IN ('workspace','user')`; else `organization` if any org row exists; else `workspace`. Pool predicate `db:23991 codexCredentialPoolCondition` and candidate query `db:25982 listCodexLeaseCandidatesInTransaction` select exactly one of the two sets. No union.
- Exceptions: a pool with zero credentials still resolves to `workspace` (empty) and fails with `CodexReloginRequired` (`turncap.ts:659`). The legacy fallback `db:23859 queryLegacyWorkspaceCodexSubscriptionSource` (pre-0381 schema) hard-codes `workspace`/`shared`.
- TARGET-CONFLICT: workspace-owned credentials exist (`authority_scope='workspace'`, `workspace_id` set), and `automatic` makes any one of them win over the organization pool for the whole workspace. Target: org-owned connections only, org preferred, local/personal only by explicit choice or opt-in fallback.
- TARGET-CONFLICT: in a Personal workspace the "workspace pool" is the person's own connected credentials, so an active personal pool automatically wins over the organization pool (same SQL function, lines 229-235). This is the Codex form of "personal pool automatically wins".

#### CA-02 `user` authority scope is folded into the workspace pool; the authority snapshot is dead at runtime

- Intended: `auth.md:9-21,49-54`: `user` scope is inert; the opaque `CodexProviderAccountAuthoritySnapshotV1` (`workspace`, or `user` + generation) is stored on accepted turns, tasks and system updates; current writers get the workspace default.
- Actual: `packages/contracts/src/codex-provider-account-authority.ts:13-37` defines the schema, but nothing outside tests imports it. The DB column `codex_provider_account_authority_snapshot` exists with a NOT NULL default (`0226_personal_codex_authority_foundation.sql:186-215`) but is not mapped in `packages/db/src/schema.ts`, so TypeScript never writes or reads it. Every pool predicate includes `'user'` rows next to `'workspace'` rows (`db:23991`, `db:26032-26036`, SQL `codex_credential_serves_turn` in `0492_codex_accepted_source_authority.sql:134-176`).
- Exceptions: if a `user`-scoped Codex row were ever created (the 0226 trigger makes this hard for the runtime role), it would join the workspace pool for every member of that workspace with no subject check. **uncertain** whether such a row can exist today; no lifecycle writer was found.
- Note: Codex source authority actually lives in `session_turns.metadata.codexCredentialPolicySnapshotV1.source` (CA-04), not in this snapshot. xAI/Claude use their own `*ProviderAccountAuthoritySnapshot` columns to choose user vs workspace pools (`db:28162-28202`); Codex does not.

#### CA-03 Organization rows: one shared row, workspace-local leases, pins and waiters

- Intended: `rot.md:17-31`: one encrypted row, usage, cooldown, cursor and org rotation row across inheriting workspaces; pins, leases and waiters stay in the target workspace; schema guards accept an org credential only for the current or accepted organization source.
- Actual: org candidates are `authority_scope='organization' AND organization_id = account_id` (`db:23991-24007`); live lease count uses the cross-workspace SQL `codex_organization_live_lease_count` (`db:26044-26050`); lease insert is guarded by trigger `enforce_codex_lease_source` → `codex_credential_serves_turn` (`0492...sql:134-198,240`). Leases are keyed `(workspace_id, turn_id)` (`db:26495`).
- Matches. Org mutations lock every workspace in `list_organization_codex_workspace_ids` (`db:24027 lockOrganizationCodexSubscriptionSources`), which includes Personal workspaces after 0422 (`rot.md:37-45`).

#### CA-04 Accepted source is frozen per logical turn

- Intended: `rot.md:47-56` (0492) and `rot.md:114-151`: the first allocator decision writes the accepted policy snapshot (including source) to the locked turn; legacy turns get an immutable sidecar binding before a source-changing mutation; source changes are new-work settings, not idle barriers.
- Actual: `db:23935 codexSourceForTurn` reads `codexCredentialPolicySnapshotV1.source`, then `codex_turn_source_bindings`, then falls back to the live source. `db:26407-26440` writes the snapshot on the first decision, even when no credential is chosen. `db:23980 captureLegacyCodexTurnSources` (SQL in `0492...sql:95-131`) runs under the source advisory lock before every source or credential mutation (`db:24070`, `db:27374`).
- Matches the rotation doc.
- CONTRADICTION: `AGENTS.md:362` says an effective source transition "is a hard cutover boundary: the source advisory lock fences it while any Codex turn is running, awaiting action, recovering, waiting for capacity, or still holds a live lease". The code has no such fence: `CodexSubscriptionSourceChangeBlockedError` (`db:23966`) is defined but never thrown, and `setWorkspaceCodexSubscriptionModeInTransaction` (`db:24070`) only captures legacy bindings and writes the preference. The API still maps that error message to 409 (`apps/api/src/routes/codex.ts:914-921`); that handling is now dead. `rot.md:130-138` matches the code; `AGENTS.md:362` is stale.

#### CA-05 Codex worker DB context never sets a subject (service visibility)

- Intended: not documented for Codex. Target (D-10): background work re-establishes the initiating human's session access from durable state.
- Actual: every Codex allocator and waiter accessor uses tenant-only RLS (`accountId` + `workspaceId` GUCs) and never calls `setSubjectRlsContext`: `acquireCodexCredentialLease` (`db:26127 withSessionActivityRlsContext`), `armCodexCapacityWait` (`db:26829 retrySessionActivityRls` → `withWorkspaceSessionActivityRls`), `reconcileCodexCapacityWait` (`db:27650 withSessionActivityRlsContext`), `getCodexCapacityWaitForSession` (`db:27244 withWorkspaceRls`), heartbeat and release (`db:29343`, `db:29386 withRlsContext`). Details in answer (a).
- TARGET-CONFLICT: control-plane reconciliation works because an empty `opengeni.subject_id` switches off the private-session restriction entirely (`0345_tenant_scoped_session_tenancy_fence.sql:715-716`), not because it re-establishes the initiating human. It can see every session in the workspace.

---

### 3.2 Personal vs workspace vs organization pool precedence

#### CA-06 Precedence is a workspace-level preference with no organization lock

- Intended: `rot.md:13-16`; `AGENTS.md:253-261` (0422 Personal inheritance).
- Actual: `workspace_codex_subscription_preferences.mode`, written by `PATCH /v1/workspaces/:workspaceId/codex/source` with `connections:write` on that workspace (`apps/api/src/routes/codex.ts:892-923` → `db:24110 setWorkspaceCodexSubscriptionMode`). There is no organization default, no lock, and no "personal allowed" or "personal fallback" setting.
- TARGET-CONFLICT: the target is organization defaults with lockable workspace overrides (rotation, failover, personal allowed, personal fallback) and a view of the effective value and its source. Today a workspace admin can switch to `workspace` or `disabled` freely, and nothing falls back from one pool to another: the chosen pool is the whole scheduling boundary (CA-01).

#### CA-07 Rotation settings come from the pool owner, not the workspace

- Intended: `rot.md:63-67` (§Atomic selection): lock `codex_rotation_settings` for a workspace pool, or `organization_codex_rotation_settings` for an org pool.
- Actual: `db:26158-26178` reads `active_credential_id, rotation_enabled, rotation_strategy` from the org row when the accepted source is organization, so every inheriting workspace shares one `rotation_enabled` and one active pointer.
- TARGET-CONFLICT: no per-workspace override of rotation or failover for org pools.

---

### 3.3 Atomic selection and fairness

#### CA-08 Lock order and fences match the doc

- Intended: `rot.md:60-88` steps 1-5; `rot.md:90-98` holder identity.
- Actual (`db:26071 acquireCodexCredentialLease`): source advisory lock (`26131`) → rotation row `FOR UPDATE` (`26167`/`26177`) → `lockWorkspaceInferenceControl(share)` (`26183`) → workspace prefix → session `FOR SHARE` (`26214`) → turn `FOR UPDATE` (`26230`) → attempt `FOR SHARE` (`26248`). The exact attempt/run/activity/dispatch/redispatch fence throws `CodexCredentialLeaseAttemptFencedError` (`26283`). Expired leases are reaped per workspace (`26327`). A live same-turn lease is offered first (`26377`); the filter runs only for new allocations (`26391`). Upsert on `(workspace_id, turn_id)` bumps generation when the holder changes (`26495-26505`); `selection_count` is incremented when the lease is not reused (`26515`).
- Matches. **uncertain**: exact holder-id construction (workflow + turn + attempt UUID) not re-read in `claim.ts`.

#### CA-09 The documented `most_remaining` ranking is unreachable; real fairness is session-hash sharding

- Intended: `rot.md:166-169` says legacy strategies normalise to `sharded`, but `rot.md:171-180` then describes the `most_remaining` ranking (fewest live leases, most remaining quota, fewest selections, least recent) and claims "a burst sees earlier reservations and spreads before delayed usage headers move". `rot.md:85-86` describes a "server-held fairness cursor".
- Actual: `rot.ts:72 effectiveRotationStrategy` always returns `"sharded"`. In `rot.ts:521 selectCodexCredentialLeaseForTurn`, rotation-on always classifies as `sharded` (`rot.ts:93-119`) and calls `chooseShardedHome` → `shardCredentialForSession`: FNV-1a `hash(sessionId) % eligibleCount` over eligible rows in `created_at, id` order (`rot.ts:246-258`, `packages/config/src/subscription-account-selection.ts:2-11`). The `chooseRotationActive` call at `rot.ts:679-693` needs rotation on and a pin that is neither manual nor sharded, which cannot happen. `activeLeaseCount`, `selectionCount` and `lastSelectedAt` are loaded, and `selection_count` is still incremented (`db:26515`), but no reachable selector reads them.
- CONTRADICTION: the burst-spreading claim does not hold for live code. Two concurrent new sessions that hash to the same account both land there regardless of live leases. Spreading is statistical (by session id), not reservation-aware.
- Exception: the shard index depends on the size of the eligible set, so a session's first-turn home changes whenever any pool account changes eligibility. Only the persisted `policy` pin (CA-14) makes it sticky afterwards.

#### CA-10 Active pointer never advances automatically

- Intended: `rot.md:85-88`: the pointer advances only when the selector allows it; manual pins and sharded homes veto.
- Actual: every reachable branch of `rot.ts:521` returns `advanceActivePointer: false` (reuse `562`, manual `578-607`, sharded `614-640`, rotation-off `648-676`); only the unreachable fallthrough at `690` leaves it undefined. So although `turncap.ts:217` passes `advanceActivePointer: true`, `db:26478-26482` never moves the pointer. `packages/config/src/subscription-account-selection.ts:16` states the same for xAI/Claude ("Selection never changes the pool's active pointer").
- Note: consistent with the doc's veto wording, but the doc reads as if pointer movement still happens in a normal case. In practice the pointer is set by a person or defaulted (CA-12).

#### CA-11 Downstream policy-scope/filter seams are unused

- Intended: `rot.md:208-220`: generic `resolvePolicyScope` / `filterNewAllocationCandidates` seams for a downstream named-pool policy.
- Actual: accepted by `db:26071` and `db:27622`, but no runtime caller passes them. `fs.ts:1237-1263` re-runs selection after a refusal with `policyScope: null` and no filter, so if a filter is added later, the failover disposition would be computed against the unfiltered pool while acquisition uses the filtered one. Latent divergence.

---

### 3.4 Primary-only (rotation off) vs rotation

#### CA-12 Rotation off = active pointer only; org pools silently default a missing pointer

- Intended: `rot.md:202-206`: with `rotation_enabled=false`, new allocations use only the active account; capped or cooling → durable wait even when another account is healthy. `rot.md:434-437`: restoring a missing active pointer is a `mutation_only` wait.
- Actual: `rot.ts:648-676`: missing pointer → `none`; disabled → `allocatorDisabled`; unhealthy → `allCapped` at `availableAt`; otherwise the pointer. Workspace pools behave this way (`turncap.ts:669-675`, reason `codex_active_pointer_unavailable`).
- CONTRADICTION (org pools only): `db:26354-26356` replaces the org pool's `activeCredentialId`, including the frozen snapshot value, with `assignedConnectionDefault` (`packages/db/src/model-connection-access.ts:44-52`: keep it if present, else the first active, allocator-enabled row). A rotation-off org turn whose accepted pointer was disconnected therefore moves to another account instead of waiting.
- Exception: `reconcileCodexCapacityWait` (`db:27806-27812`) and failure settlement (`fs.ts:1240`) do not apply this default. An org turn already waiting on a capped pointer that is then disconnected reconciles to `none` → `mutation_only` and keeps waiting, while a fresh acquisition would succeed on the defaulted pointer. Acquire and reconcile disagree.
- TARGET-CONFLICT (D-13): the target replaces rotation off ("Primary only") with Primary first. The primary takes new work while it can serve it; when it cannot (capped, cooling, disconnected or missing), work moves to the next eligible account instead of waiting while an idle eligible account exists, and waits only when none can serve (SUB-SEL-03, SUB-WAIT-01). Both current behaviours change: the workspace-pool durable wait on an unavailable pointer becomes ordinary failover, and the organization-pool default becomes that same failover, recorded as a visible account switch (SUB-FAIL-06), with acquisition and reconciliation applying one rule.

#### CA-13 `poolReady` / `workerRoutable` ignore model and plan

- Intended: `rot.md:269-277`.
- Actual: `apps/api/src/routes/codex.ts:163-204 codexWorkerReadiness` checks status, allocator flag, cooldown and windows only. `allowedModelIds` and plan-entitlement exclusions, which the worker applies (`rot.ts:25-34`, `turncap.ts:172-184`), are ignored. Undefined case: status can report routable while every turn for a given model fails or waits.

---

### 3.5 Pins, conversation recency and cache affinity

#### CA-14 Stickiness = persisted `policy` pin while rotation is on; no cache-temperature input

- Intended: `rot.md:193-201`: a manual pin is binding (wait, never fail over); a policy pin is a sharded cache-affinity home, re-sharded only when it caps; CAS-protected writes; ignored and lazily cleared outside `sharded`.
- Actual: `rot.ts:93-119 classifyCodexPin` (a NULL source counts as manual) and `rot.ts:282-302 chooseShardedHome` (keep the pin while eligible, else re-shard). The pin is persisted after selection with an observed-state CAS (`turncap.ts:362-394` → `db:31543 setSessionCodexPinInTransaction`, `expected` predicate). A stale policy pin is cleared when rotation is off (`turncap.ts:395-423`).
- Exceptions: re-shard also happens when the home is allocator-disabled, cooling or `needs_relogin`, and on a proven plan exclusion (model-filtered list, `rot.ts:540-544`). Turning rotation off lazily clears every policy pin, so turning it back on loses all homes.
- TARGET-CONFLICT: the target is "sticky while the prompt cache is warm; re-select only when forced or the cache is cold". The code never looks at cache temperature: a home stays forever while eligible (even after days idle), and is replaced at the next new turn after any eligibility blip.

#### CA-15 Pins are per session; child agents, schedules and new sessions start fresh

- Intended: not documented.
- Actual: nothing copies `codex_pinned_credential_id` / `codex_pin_source` / `codex_last_credential_id` when a session is created (the only writers are `db:31580`, `db:31739`, `db:31899`, `db:31929`). A child agent, scheduled-task session or fork gets its own hash home. Compaction turns and continuations of the same session go through the same `selectCodexTurnCapacity` path and keep the pin.
- TARGET-CONFLICT: the target wants the account to stay with the work across child agents and schedules.

#### CA-16 Background pin writes wake every waiter in the pool

- Intended: `rot.md:139-141`: same-source pointer, rotation and background pin mutations "may wake a waiter for re-evaluation" but never rewrite its snapshot.
- Actual: the policy-pin write runs inside `withSessionCodexCapacityMutation` (`turncap.ts:368`). When it changes something, `db:27374 mutateCodexCapacityInTransaction` bumps `wakeRevision` on every `waiting` waiter in the workspace (`db:27269`) or, for org pools, in every same-org workspace (`db:27332`). One session's first-turn home assignment therefore nudges every capacity-blocked session in the org. Correct but wasteful; the jitter (CA-27) limits the herd.

#### CA-17 Manual pin to a credential outside the current pool waits forever

- Intended: `rot.md:195-197`: a manual pin never fails over.
- Actual: a source switch (`db:24070`) does not clear session pins. For a new turn, `rot.ts:578-582` finds no such row → `none` → `turncap.ts:661-668` `codex_manual_pin_unavailable`, `mutation_only` wait. The pin setter validates against the current pool (`db:31551-31561`), so a person can fix it, but nothing tells them the pin belongs to the other source. Disconnect clears pins through FK SET NULL (comment at `db:24038`), so the case applies only to rows that still exist.
- Undefined case: the doc does not say what happens to manual pins on a source switch.

#### CA-18 Conversation recency

- Intended: `rot.md:831-837`: pool changes, automatic policy assignments and last-used bookkeeping preserve session recency; manual switches count as activity.
- Actual: `db:31585-31587` bumps `sessions.updated_at` only when `source === "manual"`; the `last_credential_id` writers (`db:31899`, `db:31929`) do not touch `updatedAt`. Matches.

---

### 3.6 Leases, heartbeat and fencing

#### CA-19 Shared lease lifecycle; the Codex lease is not subject-scoped

- Intended: `rot.md:99-112,379-394`: 5-minute TTL, 60-second renewal, fail-closed on late confirmation, checkpoint coalescing, a deadline check before dispatch, and lease loss is not a provider failure.
- Actual: `apps/worker/src/activities/agent-turn/subscription-lease.ts:19-124 SubscriptionTurnLease` (renew interval `min(60s, ttl/5)`; late reply → `markLost("deadline")`; a failed renewal keeps the prior deadline); `CODEX_CREDENTIAL_LEASE_TTL_MS` = 5 min (`db:25884`); `assertUsable` before provider dispatch (`run.ts:705`); lease loss is settled before any credential classification (`fs.ts:840-852` → `db:80673 settleCodexCredentialLeaseLoss`). Matches.
- Divergence from xAI/Claude: `credential-leases.ts:41-136 CodexTurnLease` heartbeats with `(accountId, workspaceId)` only, while `ScopedSubscriptionTurnLease` (`credential-leases.ts:90-133`) needs a `subjectId` and returns `null` (treated as lost) without one. A shared core must keep both shapes or unify them.

#### CA-20 Failover budget frozen at first quarantine from the lease-time count

- Intended: `rot.md:524-527`: bounded by the enabled-alternate count frozen by the first accepted failover.
- Actual: `db:25867 codexCredentialFailoverLimitForLease` = `max(1, allocatable − (serving is allocatable ? 1 : 0))`, computed at acquisition (`db:26466`, `db:26553`) and passed to `quarantineCodexCredentialForLease` (`fs.ts:1064`), which persists it (doc comment at `db:29449`). The count covers the whole pool, not just accounts that can serve the model, so the budget can be larger than the number of useful alternates. Selection still excludes failed ids, so this is loose rather than harmful.

---

### 3.7 Failure classification and settlement

#### CA-21 Classification table matches the doc

- Intended: `rot.md:501-513` (§Reset and failure semantics table).
- Actual:

| Failure | Code | Result |
| --- | --- | --- |
| First 401 | `packages/codex/src/fetch.ts:905-906`, one forced refresh and retry | no settlement |
| 401 reaching settlement, or `CodexReloginRequired` | `apps/worker/src/activities/agent-turn/errors.ts:2132-2146,2202` `classifyCodexCredentialFailure` → `auth` | quarantine `needs_relogin` (`fs.ts:1081-1087`) |
| 403 | `errors.ts:2205` → `forbidden` | quarantine `error` |
| `usage_limit_reached`, `insufficient_quota`, `quota_exceeded`, `billing_hard_limit_reached` | `errors.ts:2158-2161,2195-2200` → `quota` | cooldown to the latest binding reset, or the 5-hour fallback (`errors.ts:2071,2080-2124`) |
| Other 429 / rate-limit codes | `errors.ts:2208` → `rate_limit` | retry-after, or 60 s (`PROVIDER_BACKPRESSURE_DELAY_MS`, `errors.ts:116`) |
| Plan entitlement evidence | `packages/codex/src/plan-entitlement.ts` (skips the encrypted-content family at line 56) → re-check in `fs.ts:913-990` | `plan_entitlement` (`fs.ts:1095`) or terminal `codex_request_rejected` |
| Encrypted-content 400 | `fs.ts:1912 classifyCodexEncryptedArtifactRejection` | artifact invalidation path; no credential change |
| Network, 5xx, malformed/partial stream, safety refusal | `errors.ts:2134,2149` return `null` | no failover; generic terminal path |

- Matches. The encrypted-content and entitlement classifiers are disjoint by construction, so the order of checks in `fs.ts` is safe.
- TARGET-CONFLICT: the target wants automatic failover to another account, then another provider. 5xx and network errors never fail over, even when nothing was streamed, and the Codex path has no cross-provider fallback at all.

#### CA-22 Definitive-failure disposition

- Intended: `rot.md:515-547`.
- Actual: `fs.ts:155-192 codexDefinitiveFailureDisposition`: `failover` only when rotation is on, the pin is not manual, and the re-run selector picks a different account. Plan entitlement waits only for rotation-on + `allCapped`, otherwise it is terminal. Quota/rate-limit, `allCapped`, rotation-off or a manual pin → `wait`; anything else is terminal. The re-run selector (`fs.ts:1237-1263`) gets `failedCredentialIds: [serving]` only.
- Exception: earlier failed ids on the same turn are not passed (`fs.ts:1244`), so the disposition can say `failover` toward an account that the next acquisition will exclude through `unresolvedCodexCredentialFailures` (`db:26369`). That acquisition then returns `none` or `allCapped` and arms a wait. Still bounded, but the recorded reason says failover.
- Exception: auth/forbidden under rotation-off or a manual pin → `wait` with `mutation_only` (`fs.ts:1437-1445`), which matches "terminal only when there is nothing to wait for".

#### CA-23 Refusal recovery evidence per kind

- Intended: `rot.md:226-235`: quota needs a newer verified clear; rate limit recovers after the deadline of the same or a newer revision; auth/status needs a newer credential version; legacy ID-only receipts stay excluded.
- Actual: `packages/db/src/codex-failure-eligibility.ts:4-107 unresolvedCodexCredentialFailures` implements those four rules, plus `plan` receipts (eligible again only after a different plan is observed, lines 49-56). Matches.

#### CA-24 Checkpoint before failover; checkpoint failure refuses replay

- Intended: `rot.md:515-521,631-634`.
- Actual: `fs.ts:1010-1013` flushes and runs `reconcileConversationTruth({ requireDurable: true })`; on failure there is no quarantine and the lease-loss path refuses replay (`fs.ts:764`). A credential version change during quarantine goes to recovery (`fs.ts:1108`). Matches.

---

### 3.8 Same-turn capacity recovery, durable waiters, wake signalling, jitter

#### CA-25 Arm plus immediate reconcile at every worker arm site

- Intended: `rot.md:403-426`.
- Actual: `cap.ts:201-240 armAndReconcileCodexCapacityWait` arms (`db:26797`) and then reconciles once. Callers: proactive `turncap.ts:592,720,828` (allocator-disabled, none, all-capped) and reactive `fs.ts:1427` with `leaseFence`. Lock order in `db:26836-26895` matches `rot.md:409-412`. The waiter row (`db:26568`) holds no credential material. Matches.
- Exception (undocumented): compaction turns (`turn.source === "compaction"`) never wait; they cancel with `turn.cancelled` and go idle (`turncap.ts:319-343,562-589,690-717,772-799`). The doc mentions this only for plan entitlement (`rot.md:622`).
- Exception: "This model is disabled for the connected/pinned Codex subscriptions" is a plain `Error` (`turncap.ts:175-184`), not a capacity wait or a typed failure. **uncertain** how the generic failure path presents it.

#### CA-26 Reconcile semantics

- Intended: `rot.md:428-472`.
- Actual: `db:27622 reconcileCodexCapacityWait`: rotation row chosen through the accepted source (`27667`); Pause → `paused` without mutation (`27751-27757`); supersede on cancel, goal, policy hash, active turn or blocked turn change (`27759-27786`); the false-resumption delay is honoured and the wake acknowledged (`27792-27808`); the decision uses frozen snapshot fields (`27810-27870`); `unavailable` updates `nextCheckAt`, `resetKind`, `refreshAttempt` (`27871-27910`); `available` marks the waiter `resumed`, moves the turn to `recovering`, and writes `codex.capacity.resumed` plus a status event. The decision function `cap.ts:95-192 codexCapacityDecision` reuses the same pure selector. Matches.
- Exceptions: a bounded refresh happens only when `cause === "timer"`, the waiter is `bounded_refresh`, and it is due (`cap.ts:369-377`); a signal-triggered reconcile never refreshes usage. Unknown-reset backoff is `60 s · 2^n`, capped at 15 min (`db:26670`), as documented.

#### CA-27 Wake signalling and jitter

- Intended: `rot.md:447-499`; `AGENTS.md:362`.
- Actual: the mutation seam `db:27421 withCodexCapacityMutation` / `db:27432 withSessionCodexCapacityMutation` increments waiter `wakeRevision` and enqueues a durable workflow wake in the same transaction (`db:27269-27330`). Delivery is best-effort (`cap.ts:57-82`: typed signal, else generic wake); repair runs through `db:27442 listPendingCodexCapacityWakeTargets` and `cap.ts:85`. `getCodexCapacityWait` maps an unobserved revision to an epoch `nextCheckAt` (`cap.ts:300-303`). Jitter: `apps/worker/src/workflows/session.ts:82-111` (60 s after a timer, 30 s after a wake, patch `session-capacity-wake-jitter-v1`), applied at `session.ts:571,591`; only interruptions cut it short. Continue-as-new after the check backstop (`session.ts:629`). Matches.
- Exception: `getCodexCapacityWait` checks Codex, then xAI, then Claude waiters (`cap.ts:279-286`). If a session ever had more than one, only the first would be reconstructed. Undefined case.

#### CA-28 False-resumption budget

- Intended: `rot.md:242-262`: 10 attempts, equal jitter starting at 30-60 s and capped at 15 min, cleared only by substantive transport-proven output.
- Actual: `packages/db/src/codex-capacity-recovery.ts:3-47` (`CODEX_CAPACITY_FALSE_RESUMPTION_LIMIT = 10`; `codexFalseResumptionBackoffMs` = `[cap/2, cap]` with cap `60 s · 2^(n−1)` up to 900 s), counted at arm time (`db:26957-26975`). **uncertain**: the clearing rule on a completed model request was not re-read in this audit.

---

### 3.9 Reset credits

#### CA-29 Human-only, workspace-credential-only redemption

- Intended: `rot.md:315-371`; `AGENTS.md:298-302`; `auth.md:53-54` (workspace credentials only).
- Actual: no worker code references redemption; routes are `apps/api/src/routes/codex.ts:1955,2069`; `db:30384 claimCodexResetRedemption` requires `credential.workspace_id = workspaceId` and `connectedBySubjectId === subjectId`. Matches.
- TARGET-CONFLICT: organization credentials (`workspace_id` NULL) can never be redeemed, and "owner" means whoever most recently connected the row (`connected_by_subject_id`), which `auth.md:29-31` says is not ownership authority for scope purposes. Org-owned connections need a new owner rule.

---

### 3.10 Plan entitlement

#### CA-30 Admission and settlement match the doc

- Intended: `rot.md:549-629`; `AGENTS.md:360`.
- Actual: model filter `rot.ts:25-34 codexAccountServesModel` + `packages/db/src/codex-plan-entitlement.ts:106 codexPlanExcludesModel`; at admission, a re-check of up to 4 blocked accounts and one re-acquire (`turncap.ts:259-346`); settlement re-checks under the live holder (`fs.ts:917-990` → `db:88479 recheckCodexCredentialPlan`); `plan_entitlement` quarantine (`fs.ts:1095`); terminal `codex_plan_entitlement` / `codex_request_rejected`. Matches.
- Exception: the admission re-check stops at the first 4 blocked accounts (`turncap.ts:273`); a pool with more plan-excluded accounts fails without re-reading the rest. Not in the doc.

---

### 3.11 Quota observation and status semantics

#### CA-31 No near-exhaustion cliff in the allocator; 90 % lives only in the shadow

- Intended: `rot.md:182-191`: eligible through 99 %, excluded at 100 %; a refusal installs the authoritative cooldown; usage reads may clear an older typed quota cooldown under the revision fence.
- Actual: `rot.ts:162 CODEX_USAGE_EXHAUSTED_PCT = 100`; an elapsed window reset counts as 0 % (`rot.ts:164-170`); the cooldown clear is fenced by `clearQuotaCooldownRevision === exhaustedRevision` (`db:31060`). `settings.codexRotationNearExhaustionPct` (default 90, `packages/config/src/index.ts:892`) is used only as the shadow `placementUsageCeilingPercent` (`turncap.ts:490`, `codex-fleet-shadow.ts:229-232`). Matches.
- All-capped admission does one live refresh of capped rows and then re-acquires (`turncap.ts:221-253`), as documented.

---

### 3.12 Allocator control

#### CA-32 `allocator_enabled` is separate from health

- Intended: `rot.md:279-285,308-314`.
- Actual: `rot.ts:203-214` splits health from eligibility; live same-turn lease reuse checks health only (`rot.ts:552-566`); a disabled manual pin or rotation-off pointer gives an `allocatorDisabled` wait (`rot.ts:586-591,658-663`, `turncap.ts:555-647`); the writer is `db:30005 updateCodexAllocatorEligibility`. Matches.

---

### 3.13 Codex Apps designation

#### CA-33 Apps is bound to a workspace-local credential

- Intended: `AGENTS.md:361`; `auth.md:53-54`.
- Actual: `db:24720 getCodexAppsSettings` (one row per workspace); `db:24758 getCodexAppsCredentialAuthorizationForRun` joins on `codex_subscription_credentials.workspace_id = workspaceId` and treats `connected_by_subject_id` as owner; `db:24854 designateCodexAppsCredential` accepts only a credential with `workspace_id = input.workspaceId`.
- TARGET-CONFLICT: org-owned credentials (`workspace_id` NULL) cannot be designated at all. Under the target model (no workspace-owned connections), Apps would be unusable until designation is re-answered on org-owned scoped connections.

---

### 3.14 Compaction lock

#### CA-34 `remote_v2` sessions are Codex-only for life

- Intended: `AGENTS.md:349`.
- Actual: `packages/core/src/goal-admission.ts:68-73` blocks non-Codex models; `apps/worker/src/activities/context-compaction.ts:119-124` fails closed when a `remote_v2` session is not on a Codex subscription turn.
- TARGET-CONFLICT: the target says this lock must change. Because `remote_v2` is the default for new Codex sessions, it blocks cross-provider failover for most Codex work.

---

### 3.15 Rollout and rollback

#### CA-35 0403 / 0422 / 0492 / jitter patch

- Intended: `rot.md:37-56,491-499,645-690`; `AGENTS.md:245-265`.
- Actual: 0403 removed the cutover bits (`db:26158-26178` reads no `lease_rotation_enabled`); the 0422 source function includes Personal workspaces; 0492 adds `codex_turn_source_bindings`, `capture_legacy_codex_turn_sources`, `codex_credential_serves_turn` and the lease trigger (`0492...sql:53-240`). All are forward-only maintenance cutovers. The jitter patch is replay-gated with `patched()` (`session.ts:571,591`), so rolling back past it is unsafe, as documented.
- Note: compatibility code for pre-0383 and pre-0381 schemas is still present (`db:26019` `to_jsonb(c) ->> 'exhausted_kind'`, `db:23859` legacy source). A shared core would have to carry or drop these branches.

---

### 3.16 Observability

#### CA-36 Events, counters and alerts

- Intended: `rot.md:692-717`.
- Actual: `codex.credential.selected` from `db:31816 recordSessionCodexSelectionForTurnAttempt`, with diagnostics from `packages/db/src/codex-selection-diagnostics.ts:2-25` (`assigned / unchanged / switched`, `manual_pin | allocator`, `lease_reused | affinity_reused | …`). Counters `opengeni_codex_credential_selections_total`, `opengeni_codex_pool_observations_total` and `opengeni_codex_pool_low_total`, plus failure, failover and lease counters (`turncap.ts:534-553,874-885`; `fs.ts:1001,1015`). Alerts at `deploy/helm/opengeni/templates/prometheusrule.yaml:1356,1372`. Matches.
- Exceptions: `eligibleCount` for pool-depth metrics is computed over `leased.accounts` without the model/plan filter (`turncap.ts:439-441`), so a pool that cannot serve this model can still report "many". Pool-low series are labelled by `workspace_key` even for an org pool, so one org pool produces one alert series per workspace.

---

### Answers to three audit questions

#### (a) Why Codex recovery does not hit the private-session "Session not found" bug

How visibility works: the RESTRICTIVE policy `session_visibility_isolation` on `sessions` (latest form `packages/db/drizzle/0345_tenant_scoped_session_tenancy_fence.sql:709-725`) admits a row when `opengeni.subject_id` is empty, or the session is `workspace_shared`, or `session_private_actor_visible(...)` is true. That function (`0304_personal_workspace_private_session_reads.sql:13-60`) returns true only when `opengeni.subject_id` or `opengeni.initiating_human_subject_id` equals the session owner.

Codex never sets a subject itself:

- Proactive arming in the turn activity (`turncap.ts:592/720/828`) runs inside `withSessionRlsActorContext({ subjectId: "service:agent-turn", initiatingHumanSubjectId: turn.initiatingHumanSubjectId, ... })` (`apps/worker/src/activities/agent-turn/run.ts:506-525`; capacity phase called at `run.ts:563`; `fileAuthoritySubjectId` comes from `claim.ts:280`). `setRlsContext` copies that actor into the GUCs (`packages/db/src/database.ts:442-452`), so a private session stays visible through the initiating-human branch.
- Reactive arming in failure settlement (`fs.ts:1427`) is called from the `catch` at `run.ts:1916-1921`, outside that actor block, and the DB call passes only `{accountId, workspaceId}` (`db:26829 retrySessionActivityRls` → `database.ts:979-987`). With no actor, `opengeni.subject_id` is empty, and the empty-subject branch admits every session.
- Reconciliation in the control activity (`cap.ts:361-410`) calls `getCodexCapacityWaitForSession` (`db:27244 withWorkspaceRls`) and `reconcileCodexCapacityWait` (`db:27650 withSessionActivityRlsContext({accountId, workspaceId})`). Again no actor and no `setSubjectRlsContext`, so the subject is empty and private sessions are visible.

xAI/Claude differ: `createScopedSubscriptionCapacityWaiters` resolves a subject (`db:28162-28202 resolveXaiWaiterSubject`: the initiating human for a `user` snapshot, otherwise the fixed `workerSubject` `"worker:xai-workspace"` / `"worker:claude-workspace"`, `db:29278,29296`) and then runs `withWorkspaceSubjectRls` / `withWorkspaceSubjectSessionActivityRls` (`db:28775`, `db:28931`; `database.ts:1017-1066`), which sets a non-empty `opengeni.subject_id`. In the control activity there is no actor, so `initiating_human_subject_id` is empty; with the worker subject, a private session fails `session_private_actor_visible` and its row is invisible. That matches the reported symptom for workspace-scope pools. For `user`-scope pools the subject is the initiating human, so it works only when that person owns the session. **uncertain**: whether all reported cases were workspace-scope, and the exact line that throws the "Session not found" string was not traced.

In short, Codex avoids the bug by running with tenant-only RLS (empty subject = service visibility), not by carrying the initiating human. CA-05 explains why that is itself a TARGET-CONFLICT.

#### (b) Is the Claude/xAI branch still inside `reconcileCodexCapacityWait`, and does it now preserve the initiating human?

- Yes, it is still there on `0d7075e`: `cap.ts:313-360` (`input.provider === "xai" || "claude"` → `getXaiCapacityWaitForSession` / `getClaudeCapacityWaitForSession`, `resolveXaiWaiterSubject` / `resolveClaudeWaiterSubject`, `refreshExhaustedXaiQuota` for xAI, then `reconcileXaiCapacityWaitDb` / `reconcileClaudeCapacityWaitDb`). The workflow routes to it through `current.provider` (`session.ts:621`).
- Not fixed. The branch does not call `withSessionRlsActorContext`. `git log -S withSessionRlsActorContext -- apps/worker/src/activities/codex-capacity.ts apps/worker/src/activities/agent-turn/codex-capacity.ts apps/worker/src/activities/xai-quota.ts` returns no commits, and `git log -S withWorkspaceSubjectSessionActivityRls -- apps/worker/src/activities/codex-capacity.ts` is empty too. The latest commits touching `cap.ts` are `8ce490f` (Claude pools, 2026-10-03) and `bb52f56`. The initiating human survives only as the RLS subject for `user`-scope snapshots (`db:28197-28198`); workspace-scope waiters use a fixed worker subject with no initiating-human GUC.

#### (c) Adaptive-fleet shadow and deterministic replay

What it is: a default-off observer (`OPENGENI_CODEX_FLEET_POLICY_SHADOW_ENABLED`, `packages/config/src/index.ts:888,4551`). After the real allocator has decided, it evaluates an alternative "adaptive" policy on a bounded, anonymised snapshot and records both results as one session event, `codex.fleet.decision`. Doc: `rot.md:719-792`.

Where the code is:

- Call site: `turncap.ts:479-532`, once per `selectCodexTurnCapacity` (proactive admission only), after the lease is acquired and the selection receipt written.
- Payload builder and publisher: `apps/worker/test/fixtures/legacy-codex/fleet-shadow.ts:102-245` (`publishCodexFleetShadowDecisionV1`, `buildCodexFleetShadowPayloadV1`; `compareDecision` at `247-267`).
- Pure policy, record and replay: `packages/contracts/src/codex-fleet-policy.ts` (`createCodexFleetReplayRecordV1` `277`, `replayCodexFleetDecisionV1` `298`, `readCodexFleetReplayRecordV1` `338`, `evaluateCodexFleetDecisionV1` `391`, `DEFAULT_CODEX_FLEET_POLICY_V1` `161`).
- Persistence: the attempt-fenced `eventing.publish` (session event, workspace RLS); SDK type at `packages/sdk/src/types.ts:2217`; a React timeline projection. Tests: `apps/worker/test/codex-fleet-shadow.test.ts`, `packages/contracts/test/codex-fleet-policy.test.ts`, `packages/db/test/codex-fleet-shadow-events.test.ts`. The repo has no offline replay script or job; `replayCodexFleetDecisionV1` is only called from tests.

What it records (`CodexFleetShadowPayloadV1`):

- `actual`: outcome `selected | waiting | none`, the alias of the chosen account, and a reason (from selection diagnostics, or `all_capped` / `allocator_disabled` / `none`).
- `replay`: schema and policy version, the full normalised policy config, the normalised input, `truncatedCandidateCount`, the shadow decision (outcome, selected alias, reason, admission decision, per-candidate scores), and SHA-256 fingerprints of policy, input (including truncation count) and decision.
- `comparison`: `match | different_candidate | different_outcome | not_comparable_truncated`.
- Input per candidate (at most 32): an event-local alias `c00…` ordered by HMAC-SHA-256 with a fresh random seed per event (`codex-fleet-shadow.ts:151-160,274-280`), status, `allocatorEnabled`, cooldown remaining, `activeLeaseCount`, both quota windows (used %, time to reset), usage age and a derived confidence. Cache, observed burn and inferred burn are always `unknown`/null (`codex-fleet-shadow.ts:205-225`). Request: `new` vs `fenced_in_flight`, the current alias (lease, or pin/last-used), priority always `standard`, no overlay. Admission: `inUseUnits` = sum of live leases; capacity unknown.

How replay works: `replayCodexFleetDecisionV1` strictly parses the record (it rejects unknown fields, non-canonical policy or input, truncated input, malformed decisions and non-SHA-256 digests), recomputes the three fingerprints, re-runs `evaluateCodexFleetDecisionV1` on the recorded input and policy, and returns `matches` plus per-fingerprint booleans and the recomputed decision. It checks the shadow evaluator's determinism and the record's integrity against its own recorded input. Input: one stored payload's `replay` object. Output: `CodexFleetReplayVerdictV1`.

Could it serve as a shadow-comparison harness for cutover to a shared core?

- What it can do: the pattern is reusable for running a shared-core selector beside the live Codex selector and counting `match / different_candidate / different_outcome` per admission. That pattern is: default-off, runs after the real decision, fails open except for fencing and cancellation errors, bounded payload, fixed-label metrics (`opengeni_codex_fleet_shadow_decisions_total`, at most 288 series), attempt-fenced durable event.
- What it cannot do as built:
  - It does not record the inputs the live Codex selector uses: session id (needed for the shard hash), `created_at` order (aliases are shuffled per event), manual/policy pin and its source, `rotation_enabled`, the active pointer, the accepted source, the failed-credential ledger, the failover budget, `allowedModelIds`, plan-entitlement exclusions, cooldown kind/revision, and credential version. So the live decision cannot be recomputed offline from the record; only the adaptive evaluator can. `actual` is stored as a label, not as something replayable.
  - The candidate list is `leased.accounts`, which is not filtered by model or plan (`turncap.ts:482`), so it is not even the candidate set the live selector saw.
  - It runs only at proactive admission. It does not capture the decision inputs of failure settlement (`fs.ts:1237`), waiter reconciliation (`cap.ts:95`), the all-capped refresh path, or lease reuse after a redispatch.
  - It is Codex-only. xAI/Claude selection (`packages/db/src/subscription-account-repository.ts:1556,1721`) has no equivalent hook.
  - Aliases are deliberately unlinkable across events, so per-session stickiness, switch rate, or "same account across turns" cannot be measured from these records.
  - No offline tooling exists to collect and aggregate the records.
- To use it for cutover, a new record version would need the live selector's full metadata input (still alias-safe), stable per-session aliases (or a per-session seed), coverage of the settlement and reconcile decision points, and a second evaluator slot for the shared core, instead of or beside the adaptive policy.

---

### Summary of flags

- CONTRADICTION: CA-04 (AGENTS.md's hard-cutover fence vs no fence in code), CA-09 (`most_remaining` ranking and burst spreading documented but unreachable in code), CA-12 (org pools default a missing rotation-off pointer instead of waiting).
- TARGET-CONFLICT: CA-01, CA-05, CA-06, CA-07, CA-14, CA-15, CA-21, CA-29, CA-33, CA-34.
- Notable exceptions and undefined cases: CA-02, CA-11, CA-12 (acquire vs reconcile divergence), CA-13, CA-16, CA-17, CA-20, CA-22, CA-25, CA-27, CA-30, CA-36.

## Part 4. Data-model inventory

Migrations live in `packages/db/drizzle/NNNN_*.sql` (cited as `0NNN`). Drizzle schema: `packages/db/src/schema.ts` (cited `schema.ts:LINE`).
"DEFINER" = `SECURITY DEFINER`. `wrv(a,w)` = `opengeni_private.workspace_rls_visible(account_id, workspace_id)`.
`scope_visible(a)` / `admin_visible(a)` = `opengeni_private.codex_organization_scope_visible` / `codex_organization_admin_visible` (Codex-named, reused by xAI and Claude).
Items marked **uncertain** were not confirmed by reading every caller or by running the code.

---

### 4.1 Summary: concern × provider

| Concern | Codex (ChatGPT) | xAI / SuperGrok | Claude |
|---|---|---|---|
| Credentials | `codex_subscription_credentials` (bespoke, `schema.ts:1553`; 0024) | `xai_subscription_credentials` (factory `subscription-pool-schema.ts:27`; 0234) | `claude_subscription_credentials` (same factory; cloned from xAI in 0598) |
| Ownership scopes | `authority_scope` workspace / user (0226, inert) / organization (0381, `organization_id`, `workspace_id` NULL) | workspace / user (0234) / organization (0423, `workspace_id` NULL) | same as xAI (0598) |
| Workspace rotation / active pointer | `codex_rotation_settings` (`schema.ts:4426`; 0028) one row per workspace | `xai_rotation_settings` row per pool `(workspace_id, scope, owner_membership)` (0234) | `claude_rotation_settings` (0598) |
| Organization rotation | `organization_codex_rotation_settings` (`schema.ts:1709`; 0381) | `xai_rotation_settings` row with `scope='organization'`, `workspace_id` NULL (0423) | same (0598) |
| Workspace source choice | `workspace_codex_subscription_preferences.mode` automatic/workspace/organization/disabled (`schema.ts:1682`; 0381, 0422) | none (derived at acceptance) | none (derived at acceptance) |
| Leases | `codex_credential_leases` (`schema.ts:4489`; 0053) | `xai_credential_leases` (0234) | `claude_credential_leases` (0598) |
| Session pin / last account | columns on `sessions`: `codex_pinned_credential_id`, `codex_pin_source`, `codex_last_credential_id` (`schema.ts:4870-4882`; 0028, 0051) | `xai_session_account_pins` per (session, pool) (0234) | `claude_session_account_pins` (0598) |
| Capacity waiters | `codex_capacity_waiters` one per session (`schema.ts:9000`; 0053) | `xai_capacity_waiters` per (session, pool) (0234) | `claude_capacity_waiters` (0598) |
| Usage / quota | credential columns `primary_*`, `secondary_*`, `usage_checked_at` (0031), `exhausted_until` (0032), `exhausted_kind`/`exhausted_revision` (0383), reset-credit counts (0065) | credential columns `quota_used_percent`, `quota_reset_at`, `quota_checked_at`, `exhausted_until` (0234) | same credential columns + `claude_subscription_account_usage` (snapshot + `model_cooldowns`) (`schema.ts:4550`; 0598). Legacy `connections.claude_usage_snapshot` / `organization_model_provider_connections.claude_usage_snapshot` (0549) now dead |
| Accepted authority on work | **Effective**: `session_turns.metadata.codexCredentialPolicySnapshotV1` (+ `codex_turn_source_bindings` sidecar, 0492). **Inert**: `codex_provider_account_authority_snapshot` on turns/scheduled_tasks/system updates/outbox (0226, not in `schema.ts`) | `xai_provider_account_authority_snapshot` on `session_turns`, `scheduled_tasks`, `session_system_updates`, `session_system_update_outbox`; `sessions.initial_xai_…` (0234) | `claude_provider_account_authority_snapshot` on the same tables + `scheduled_task_revision_authorities`; `sessions.initial_claude_…` (0598) |
| Plan entitlement exclusions | `plan_checked_at`, `plan_previous_type`, `plan_changed_at`, `plan_entitlement_exclusion` (0524) | none | none (per-model cooldowns in usage table instead) |
| Apps designation | `codex_apps_settings` (`schema.ts:1735`; 0173) | n/a | n/a |
| Reset-credit redemption | `codex_reset_redemption_attempts` (`schema.ts:1781`; 0065) | n/a | n/a |
| Access policy (models/workspaces) | `allowed_model_ids`, `allowed_workspace_ids`, `allow_personal_workspaces`, `access_policy_*` (0424) | same (0424) | same (copied by 0598 from legacy rows) |
| Personal (user-scope) accounts | schema only (0226); no writer found | live: `create_xai_subscription_credential` (0234) + `organization_user_resource_authorities` | live: `create_claude_subscription_credential` (0598 clone) |
| Other | `sessions.codex_compaction_mode` (0143); `session_goals.continuation_suppressed_turn_id` (0403) | realtime model `supergrok/grok-voice-think-fast-2.0` (0238); video `funding_source='supergrok_subscription'` (0239) | legacy rows rejected by trigger (0598) |

---

### 4.2 Per-provider detail

#### 4.2.1 Codex

##### Tables and key columns

- **`codex_subscription_credentials`** (`schema.ts:1553`)
  - Created 0024 (one row per workspace, unique `workspace_id`). 0028: multi-account (`label`, `account_email`; unique `(workspace_id, chatgpt_account_id)`).
  - Identity/secret: `id`, `account_id`, `workspace_id` (nullable since 0381), `organization_id` (0381), `credential_encrypted`, `chatgpt_account_id`, `scopes`, `plan_type`, `is_fedramp`, `expires_at`, `last_refresh_at`, `status` (active/needs_relogin/error), `last_error`, `version` (refresh OCC).
  - Authority (0226, widened 0381): `authority_scope` workspace/user/organization; `owner_organization_membership_id`, `organization_user_resource_authority_id`, `organization_user_resource_kind`='codex_subscription', `organization_user_resource_authority_generation`. Shape check `codex_credentials_authority_shape_chk` (0381): workspace ⇒ `workspace_id` set; user ⇒ `workspace_id` set + full authority tuple; organization ⇒ `workspace_id` NULL, `organization_id = account_id`.
  - Allocator (0053): `allocator_enabled`, `selection_count`, `last_selected_at`. 0065: `allocator_version`, `allocator_updated_by_subject_id`, `allocator_updated_at`, `reset_credit_available_count`, `reset_credits_checked_at`, `connected_by_subject_id` (check `user:%`).
  - Quota: 0031 `primary_used_percent`, `primary_reset_at`, `secondary_used_percent`, `secondary_reset_at`, `usage_checked_at`; 0032 `exhausted_until`; 0383 `exhausted_kind` (quota/rate_limit), `exhausted_revision`.
  - Plan entitlement (0524): `plan_checked_at`, `plan_previous_type`, `plan_changed_at`, `plan_entitlement_exclusion` jsonb `{planType, models:[{modelId, excludedAt}]}` (shape check `codex_credentials_plan_entitlement_exclusion_shape_chk`). Helpers `packages/db/src/codex-plan-entitlement.ts:41` `readCodexPlanEntitlementExclusion`, `:144` `mergeCodexPlanEntitlementExclusion`.
  - Access policy (0424): `allowed_model_ids`, `allowed_workspace_ids`, `allow_personal_workspaces`, `access_policy_version/updated_by/updated_at`.
  - Removed: `connector_namespaces`, `connectors_checked_at` (added 0033, dropped 0173).
  - Indexes: `…_ws_account_idx` (0028), `…_workspace_id_idx` (0053), `…_workspace_account_id_idx` (0173, FK target for Apps), `…_organization_account_idx`, `…_account_id_idx`, `…_organization_lookup_idx` (0381).
- **`codex_rotation_settings`** (`schema.ts:4426`; 0028): `account_id`, `workspace_id` (unique), `active_credential_id` (FK SET NULL), `rotation_enabled` (default false since 0053), `rotation_strategy` (default `sharded` since 0064; comment says legacy residue). `lease_rotation_enabled` added 0053, dropped 0403.
- **`organization_codex_rotation_settings`** (`schema.ts:1709`; 0381): `account_id` (unique), `active_credential_id` (FK SET NULL), `rotation_enabled`, `rotation_strategy`. `lease_rotation_enabled` dropped 0403. No fairness cursor.
- **`workspace_codex_subscription_preferences`** (`schema.ts:1682`; 0381): PK `workspace_id`, `account_id`, `mode` ∈ automatic/workspace/organization/disabled, `updated_by_subject_id`. 0422 extends it to Personal workspaces.
- **`codex_turn_source_bindings`** (0492; **not declared in `schema.ts`**, read via raw SQL `index.ts:23951`, `index.ts:27289`): PK `turn_id`, `account_id`, `workspace_id`, `source` ∈ workspace/organization/disabled. Sidecar capturing the pre-change source for turns accepted before a source-bearing policy snapshot.
- **`codex_credential_leases`** (`schema.ts:4489`; 0053): `account_id`, `workspace_id`, `credential_id`, `turn_id` (unique per workspace), `holder_id`, `generation`, `leased_until`. FK to `session_turns(workspace_id,id)` (0053); credential FK changed to `(account_id, credential_id)` in 0381 so org credentials can be leased from any workspace.
- **`codex_capacity_waiters`** (`schema.ts:9000`; 0053): unique `(workspace_id, session_id)`; `goal_id`/`goal_version` (optional since 0122), `blocked_turn_id`, `blocked_turn_generation` (0122), `workflow_id`, `generation`, `status` waiting/resumed/superseded, `policy_hash`, `earliest_reset_at`, `next_check_at`, `reset_kind` authoritative/bounded_refresh/mutation_only (0403), `refresh_attempt`, `wake_revision`, `observed_wake_revision`, `last_wake_reason`, `resumed_update_id` (renamed from `resumed_turn_id` in 0057). `control_generation` dropped 0063.
- **`sessions` Codex columns** (`schema.ts:4870-4886`): `codex_pinned_credential_id` + `codex_last_credential_id` (0028, FK SET NULL), `codex_pin_source` manual/policy (0051, check `sessions_codex_pin_source_check`), `codex_compaction_mode` remote_v2/portable frozen at create (0143). Shared: `sessions.active_turn_id` (`schema.ts:4830`) is used by the 0492 pin guard.
- **Accepted turn policy** (not a column): `session_turns.metadata.codexCredentialPolicySnapshotV1` = `{schemaVersion, activeCredentialId, rotationEnabled, rotationStrategy, source?, pinnedCredentialId, pinSource, lastCredentialId}` (`packages/contracts/src/index.ts:18011` `CodexCredentialPolicySnapshotV1`). Read by `index.ts:23936` `codexSourceForTurn` (falls back to the sidecar, then the live source).
- **Inert Codex snapshot columns** (0226): `codex_provider_account_authority_snapshot` NOT NULL default `{"version":1,"scope":"workspace"}` on `session_turns`, `scheduled_tasks`, `session_system_updates`, `session_system_update_outbox`; checks `*_codex_authority_snapshot_chk`. Not in `schema.ts`; only referenced in `packages/contracts/src/codex-provider-account-authority.ts` and migration tests. 0234's outbox claim preserves the column. No `sessions.initial_codex_…` column.
- **`codex_apps_settings`** (`schema.ts:1735`; 0173): `account_id`, `workspace_id` (unique), `credential_id`, `version`, `designated_at`. FK `codex_apps_settings_credential_scope_fk (workspace_id, account_id, credential_id)` → credential `(workspace_id, account_id, id)`, so only workspace-owned (workspace/user scope) credentials can be designated; 0381 comment confirms organization credentials are excluded.
- **`codex_reset_redemption_attempts`** (`schema.ts:1781`; 0065): `account_id`, `workspace_id`, `credential_id` (**no FK**), `subject_id` (check `user:_%`), `browser_session_hash`, `credit_id`, `upstream_idempotency_key`, `status` processing/provider_started/completed, `outcome`, claim columns, `retry_count`. Claim requires `credential.workspace_id = workspace` and `connected_by_subject_id = subject` (`index.ts:30384` `claimCodexResetRedemption`, checks near `index.ts:30432` and `index.ts:30461`).
- **Historical**: `agent_run_states.frozen_codex_credential_id` (0030, dropped 0173); `session_history_items.producer_codex_credential_id` (dropped 0173); provider-artifact invalidation columns on `session_history_items` and `agent_run_states` (0139).
- **Adjacent**: `workspace_model_policies` (`schema.ts:4462`; 0056) allowlists providers/models so a Codex workspace can fail closed; `session_goals.continuation_suppressed_turn_id` (0403).

##### SQL functions (current definition first, then history)

| Function | Kind | Purpose | Assumes | Migrations |
|---|---|---|---|---|
| `resolve_workspace_codex_subscription_source(acct, ws)` | INVOKER | Effective pool: explicit mode, else workspace if any workspace/user credential exists in the workspace, else organization if any org credential exists, else workspace | caller GUC `account_id`/`workspace_id` must equal args | 0381 (Personal forced to `workspace`), 0422 (Personal no longer forced), 0492 (search_path pinned) |
| `opengeni_private.codex_organization_scope_visible(acct)` | DEFINER | With workspace GUC: workspace belongs to account. Without: subject `user:*` (or local `dev`) is active owner/admin. Sets `opengeni.organization_tenancy_lifecycle` temporarily | GUCs `account_id`, `workspace_id`, `subject_id` | 0381 (excluded Personal workspaces), 0386 (local `dev`), 0422 (includes Personal) |
| `opengeni_private.codex_organization_admin_visible(acct)` | DEFINER, sql | `workspace_id` GUC is NULL and scope_visible | as above | 0381 |
| `opengeni_private.codex_credential_serves_workspace(acct, ws, cred)` | DEFINER | Credential is in the workspace's *current* effective pool | none beyond args | 0381, 0422, 0492 (search_path) |
| `opengeni_private.codex_credential_serves_turn(acct, ws, cred, turn)` | DEFINER | Credential is in the turn's *accepted* pool (`metadata…source` or sidecar; falls back to serves_workspace) | GUC account/workspace must match | 0492 |
| `capture_legacy_codex_turn_sources(acct, ws)` | DEFINER | Takes source advisory lock, inserts sidecar rows for live codex turns lacking an accepted source; **clears `opengeni.subject_id` for that statement** so other people's private turns are covered | exact account/workspace GUC | 0492 |
| `opengeni_private.enforce_codex_lease_source()` | DEFINER trigger fn | Lease credential must serve the turn | — | 0381 (workspace), 0492 (turn) |
| `opengeni_private.enforce_codex_credential_workspace()` | DEFINER trigger fn | Rotation active pointer must be workspace-owned (workspace table) or org-owned (org table); session pin/last must serve workspace **or** the session's `active_turn_id` | — | 0053, 0381, 0492 |
| `opengeni_private.codex_organization_live_lease_count(acct, cred, exclude_turn)` | DEFINER | Cross-workspace live lease count for an org credential | GUC account + workspace set | 0381, 0403 (`clock_timestamp`), 0492 (turn-aware) |
| `opengeni_private.prevent_organization_codex_disconnect_with_live_leases()` | DEFINER trigger fn | Block org credential delete while any lease is live | — | 0381, 0403 |
| `opengeni_private.enforce_organization_codex_runtime_update()` | DEFINER trigger fn | With a workspace GUC, org credential rows may only change refresh/health/quota/fairness columns | — | 0381, 0524 (plan observation columns) |
| `opengeni_private.clear_workspace_codex_session_affinity()` | DEFINER trigger fn | On preference mode insert/change, NULL all session pins/last in the workspace | — | 0381, 0426 (keep session recency) |
| `opengeni_private.codex_cooldown_revision_guard()` | INVOKER trigger fn | `exhausted_revision` must advance exactly once per cooldown change | — | 0383, 0384 (revoke PUBLIC) |
| `list_organization_codex_workspace_ids(acct)` | DEFINER | Content-free list of all org workspace ids (incl. Personal) for source fences/wakes; requires no workspace GUC | account GUC | 0422; also used by xAI/Claude org wakes (`organization-subscription-repository.ts:111`) |
| `validate_personal_codex_credential_authority()` | INVOKER trigger fn | user-scope rows need an exact active membership + authority tuple | — | 0226, 0381 |
| `codex_provider_account_authority_snapshot_v1_valid(jsonb)`, `prevent_codex_provider_account_authority_snapshot_mutation()` | IMMUTABLE / trigger | Inert snapshot validation and immutability | — | 0226 |

##### Triggers

- `codex_subscription_credentials`: `codex_credentials_validate_user_authority_trg` (0226, recreated 0381); `codex_credentials_organization_runtime_update_guard` (0381); `codex_credentials_organization_live_lease_disconnect_guard` (0381, `WHEN OLD.authority_scope='organization'`); `codex_cooldown_revision_guard` (0383); `model_connection_access_update_guard` (0424); `product_lifecycle_fact_model_connected` (0532).
- `codex_rotation_settings`: `codex_rotation_settings_workspace_guard` (0053). `organization_codex_rotation_settings`: `organization_codex_rotation_settings_credential_guard` (0381).
- `sessions`: `sessions_codex_pinned_workspace_guard`, `sessions_codex_last_workspace_guard` (0053; function body changed 0381/0492).
- `codex_credential_leases`: `codex_credential_leases_source_guard` (0381; recreated 0492 to also fire on `turn_id`).
- `workspace_codex_subscription_preferences`: `workspace_codex_subscription_preference_affinity_reset` (0381).
- Inert snapshot immutability: `session_turns_codex_authority_snapshot_immutable_trg`, `scheduled_tasks_…`, `session_updates_…`, `system_update_outbox_…` (0226).

##### RLS (all tables ENABLE + FORCE)

| Table | Policy | Cmd | Predicate | Migr. |
|---|---|---|---|---|
| codex_subscription_credentials | `workspace_isolation` | ALL | scope ∈ (workspace,user) AND `workspace_id` NOT NULL AND `wrv` | 0024, replaced 0381 |
| | `organization_scope_select` | SELECT | scope org AND `organization_id=account_id` AND scope_visible | 0381 |
| | `organization_scope_update_admin` | UPDATE | org AND admin_visible | 0381 |
| | `organization_scope_update_runtime` | UPDATE | org AND workspace GUC set AND scope_visible (column-limited by trigger) | 0381 |
| | `organization_scope_insert` / `_delete` | INSERT / DELETE | org AND admin_visible | 0381 |
| | `model_connection_workspace_access` | SELECT, RESTRICTIVE | org rows: no workspace GUC ⇒ admin_visible; Personal workspace ⇒ `allow_personal_workspaces`; else `allowed_workspace_ids` NULL or contains workspace | 0424 |
| | `lifecycle_backfill_read` | SELECT | owner-run backfill capability (restrictive policies amended) | 0570 |
| codex_rotation_settings | `workspace_isolation` | ALL | `wrv` | 0028 |
| organization_codex_rotation_settings | `organization_scope` | ALL | scope_visible | 0381 |
| workspace_codex_subscription_preferences | `workspace_isolation` | ALL | `wrv` | 0381 |
| codex_turn_source_bindings | `workspace_isolation` | SELECT | `wrv` | 0492 |
| | `capture_insert` | INSERT | `current_user` = migration owner AND `wrv` (app role only gets SELECT) | 0492 |
| codex_credential_leases | `workspace_isolation` | ALL | `wrv` | 0053 |
| codex_capacity_waiters | `workspace_isolation` | ALL | `wrv` | 0053 (FORCE toggled off/on inside 0120) |
| codex_apps_settings | `workspace_isolation` | ALL | `wrv` | 0173 |
| codex_reset_redemption_attempts | `workspace_isolation` | ALL | `wrv` | 0065 |

Note: Codex user-scope rows are governed only by `workspace_isolation` (no subject check), unlike xAI/Claude user rows.

##### Main TS repositories (all in `packages/db/src/index.ts` unless noted)

Source: `:23914` `getWorkspaceCodexSubscriptionSource`, `:24070` `setWorkspaceCodexSubscriptionModeInTransaction` (calls `captureLegacyCodexTurnSources`). Credentials: `:24137` `upsertCodexSubscriptionCredential`, `:24323` `upsertOrganizationCodexSubscriptionCredential`, `:25108` `loadCodexCredentialForRun`, `:25231` `recordCodexTokenRefresh`, `codex-token-resolver.ts:259` `buildCodexTokenResolver`. Leases: `:26071` `acquireCodexCredentialLease`, `:29334`/`:29355` heartbeat, `:29378` release, `:29449` `quarantineCodexCredentialForLease`, `:80673` `settleCodexCredentialLeaseLoss`, `:80941` `settleCodexCredentialFailover`. Waiters: `:26797` `armCodexCapacityWait`, `:27442` `listPendingCodexCapacityWakeTargets`, `:27622` `reconcileCodexCapacityWait`. Pins: `:31543` `setSessionCodexPinInTransaction`, `:31594` `switchSessionCodexAccount`, `:31816` `recordSessionCodexSelectionForTurnAttempt`, `:31920` `recordSessionActiveCodexCredential`. Quota: `:30900`/`:30929` `recordCodexAccountUsage*`, `:31361` `setCodexCredentialExhausted`, `codex-token-resolver.ts:452` `fetchCodexUsageForAccount`, `:568` `recheckCodexCredentialPlan`. Rotation: `:31212`…`:31435`, org `:24514`…`:24645`. Apps: `:24720`…`:24973`. Reset: `:30179`…`:30781`.

#### 4.2.2 xAI / SuperGrok

##### Tables (factory `createSubscriptionPoolTables`, `subscription-pool-schema.ts:17`; instantiated `schema.ts:4531`; DDL in 0234)

- **`xai_subscription_credentials`** (`subscription-pool-schema.ts:27`): `id`, `account_id`, `workspace_id` (nullable since 0423), `credential_encrypted` (`{accessToken, refreshToken, sessionToken, cookie}`, `xai-subscription.ts:4`), `provider_account_id`, `label`, `account_email`, `plan_type`, `status` active/needs_relogin/error/disabled, `expires_at`, `last_refresh_at`, `last_error`, `version`, `allocator_enabled`, `allocator_version`, `allocator_updated_at`, `quota_used_percent`, `quota_reset_at`, `quota_checked_at`, `exhausted_until`, `selection_count`, `last_selected_at`, `authority_scope` + user authority tuple (resource kind `xai_subscription`), `connected_by_subject_id`, access-policy columns (0424). Checks: `xai_credential_scope_workspace_shape` (org ⇔ `workspace_id` NULL, 0423), authority shape, status, quota 0–100. Unique `provider_identity_uq (account, workspace, scope, owner, provider_account_id) NULLS NOT DISTINCT` (0423). FK owner membership `ON DELETE RESTRICT`.
- **`xai_rotation_settings`** (`:141`): `account_id`, `workspace_id` (NULL for org, 0423), `authority_scope`, `owner_organization_membership_id`, `active_credential_id`, `rotation_enabled` (default true), `fairness_cursor`, `version`. Unique per pool `(account, workspace, scope, owner) NULLS NOT DISTINCT` (0423).
- **`xai_credential_leases`** (`:181`): `workspace_id` NOT NULL even for org credentials, `authority_scope`, `owner_organization_membership_id`, `credential_id`, `turn_id` (unique per workspace; FK to `session_turns`), `holder_id`, `generation`, `leased_until`. Credential FK `(account_id, credential_id)` since 0423.
- **`xai_session_account_pins`** (`:224`): one row per **(workspace, session, scope, owner)** (NULLS NOT DISTINCT per schema comment): `pinned_credential_id`, `pin_source` manual/policy, `last_credential_id`, `version`.
- **`xai_capacity_waiters`** (`:267`): per (workspace, session, scope, owner); `goal_id`, `goal_version`, `blocked_turn_id`, `blocked_turn_generation`, `workflow_id`, `status`, `generation`, `earliest_reset_at`, `next_check_at`, `wake_revision`, `observed_wake_revision`, `last_wake_reason`. No `reset_kind`, `policy_hash`, `refresh_attempt`, `resumed_update_id` (Codex-only).
- **`opengeni_private.xai_subscription_runtime_capabilities`** (0234): transaction-bound capability rows (`backend_pid`, `transaction_id`, `capability_kind` lifecycle/resolve) that let the DEFINER routines read `organization_memberships` / `organization_user_resource_authorities`. No app-role grants.
- **Snapshot columns** (0234): `session_turns.xai_provider_account_authority_snapshot` (`schema.ts:7159`), `sessions.initial_xai_provider_account_authority_snapshot` (`:4780`), `scheduled_tasks.xai_…` (`:11621`), `session_system_updates.xai_…` (`:8614`), `session_system_update_outbox.xai_…` (`:8721`). Values: `{version:1, scope:"workspace"}` | `{version:1, scope:"organization"}` (0423) | `{version:1, scope:"user", authorityGeneration:n}`. The user-scope **subject** is not in the snapshot: turns use `initiating_human_subject_id` (or `initiator_subject_id` when kind=subject) (`accepted-subscription-authority.ts:13` `subscriptionExecutionAuthorityFromTurn`); system updates use `lineage.xaiAuthoritySubjectId` (`index.ts:70972` `frozenSubscriptionExecutionAuthority`); scheduled runs use `accepted_execution_snapshot.xaiAuthoritySubjectId` (checked by DB trigger fns in 0275/0478).
- **Realtime** (0238): `session_realtime_modes.model` admits `supergrok/grok-voice-think-fast-2.0` (`schema.ts:5229`). No credential/pool column on the realtime row; the API selects per request (`apps/api/src/xai-subscription-auth.ts:26` `buildXaiSubscriptionAuthorization` → `selectXaiCredentialForUse`, no lease; resolves acceptance snapshot live if none passed).
- **Video** (0239): `workspace_video_generation_policies.funding_source` and `video_generation_operations.funding_source` admit `supergrok_subscription` with `connection_id` NULL, zero price (`schema.ts:6190`, `:6261`). The account is frozen in `video_generation_operations.credential_encrypted` as `{kind:"xai-subscription", accessToken, refreshToken, userId, credentialId, subjectId, authoritySnapshot}` (`apps/worker/src/activities/video-generation-credential.ts:4`); reconciliation keeps using it after disconnect (`video-generation-reconciliation.ts:630` `durableXaiVideoAuth`).

##### SQL functions

| Function | Kind | Purpose | Assumes | Migr. |
|---|---|---|---|---|
| `xai_provider_account_authority_snapshot_v1_valid(jsonb)` | IMMUTABLE | Snapshot shape | — | 0234, 0423 (+organization) |
| `xai_subscription_authority_live(acct, ws, subject, cred, scope, owner, authority, gen)` | DEFINER | workspace ⇒ no owner; user ⇒ subject is active member with workspace grant and exact live authority | args must equal GUC `account_id`, `workspace_id`, `subject_id` | 0234 |
| `xai_subscription_pool_visible(acct, ws, subject, scope, owner)` | DEFINER | Pool-row visibility: org ⇒ scope_visible; workspace ⇒ owner NULL; user ⇒ subject owns membership + workspace grant | same GUC equality | 0234, 0423 |
| `create_xai_subscription_credential(...)` | DEFINER | Insert workspace row, or user row + new `organization_user_resource_authorities` row (kind `xai_subscription`, `origin_workspace_id`) | GUC equality; subject must have a workspace grant | 0234 |
| `resolve_xai_authority_pool(acct, ws, subject, snapshot)` | DEFINER | For a user snapshot return the owner membership id if still live at that generation | GUC equality | 0234 |
| `revalidate_xai_subscription_authority(ws, subject, cred, snapshot)` | DEFINER sql | Return credential id if active and matches the frozen scope | GUC equality | 0234, 0423 (+org) |
| `disconnect_xai_subscription_credential(...)` | DEFINER | Delete credential, revoke user authority | GUC equality | 0234, 0432 (also clears pins) |
| `prevent_xai_authority_mutation()`, `prevent_xai_snapshot_mutation()` | trigger | Authority tuple and snapshots immutable | — | 0234 |
| `opengeni_private.enforce_xai_organization_runtime_update()` | INVOKER trigger | Non-admin writers on org rows: only refresh/health/quota/fairness columns; refresh needs `version+1` | — | 0423 |
| `opengeni_private.enforce_xai_credential_pool_reference()` | DEFINER trigger | Rotation/lease/pin credential references must be in the same pool tuple | — | 0423, 0424 (unchanged refs allowed) |
| `opengeni_private.prevent_organization_xai_live_disconnect()` | DEFINER trigger | Block org credential delete with live leases | — | 0423 |

##### Triggers

Credentials: `xai_subscription_credentials_authority_immutable_trg` (0234), `xai_organization_runtime_update_guard` (0423), `xai_organization_live_disconnect_guard` (0423), `model_connection_access_update_guard` (0424), `product_lifecycle_fact_model_connected` (0532). Rotation: `xai_organization_rotation_update_guard`, `xai_rotation_credential_pool_guard` (0423). Leases: `xai_lease_credential_pool_guard`; pins: `xai_pin_credential_pool_guard` (0423). Snapshot immutability: `session_turns_xai_authority_snapshot_immutable_trg`, `sessions_initial_xai_authority_snapshot_immutable_trg`, `scheduled_tasks_…`, `session_system_updates_…`, `system_update_outbox_xai_snapshot_immutable_trg` (0234).

##### RLS (all ENABLE + FORCE, 0234)

| Table | Policy | Cmd | Predicate | Migr. |
|---|---|---|---|---|
| xai_subscription_credentials | `xai_subscription_scope` | ALL | `wrv` AND (scope workspace OR `xai_subscription_authority_live(… current subject …)`) | 0234 |
| | `organization_scope_select` / `_update` | SELECT / UPDATE | org, `workspace_id` NULL, scope_visible | 0423 |
| | `organization_scope_insert` / `_delete` | INSERT / DELETE | org, admin_visible | 0423 |
| | `model_connection_workspace_access` | SELECT RESTRICTIVE | as Codex | 0424 |
| | `lifecycle_backfill_read` | SELECT | backfill capability | 0571 |
| xai_rotation_settings | `xai_subscription_pool_scope` | ALL | `wrv` AND pool_visible(current subject) | 0234 |
| | `organization_scope_*` (4) | per cmd | as credentials | 0423 |
| xai_credential_leases | `xai_subscription_pool_scope` | ALL | as above | 0234 |
| | `organization_lease_lifecycle_read` | SELECT | org, `current_user` = table owner, admin_visible | 0423 |
| xai_session_account_pins, xai_capacity_waiters | `xai_subscription_pool_scope` | ALL | as above | 0234 |
| organization_memberships, organization_user_resource_authorities | `xai_subscription_capability_read` (SELECT), `xai_subscription_capability_insert` (INSERT, authorities) | | table owner + live capability row | 0234 |

Note: org-scope pool rows use `wrv(account, workspace_id)` with `workspace_id` NULL; visibility comes from the org policies (credentials, rotation) or the patched `pool_visible` (leases/pins/waiters keep a workspace id). **Uncertain** whether `wrv` returns true for a NULL workspace; not needed for org rows because separate permissive policies exist.

##### TS repositories

`packages/db/src/subscription-account-repository.ts:24` `createSubscriptionAccountRepository` (shared with Claude): `:210` `resolvePoolOwnerMembershipId`, `:236` `assertTurnAuthoritySnapshot`, `:293` `createSubscriptionCredential`, `:775` acceptance resolver, `:1021` `withAuthorizedSubscriptionCredential`, `:1074` `materializeSubscriptionCredentialForRun`, `:1359` `acquireSubscriptionCredentialLease`, `:1634` `selectSubscriptionCredentialForUse`, `:1742` release, `:2153` `setSubscriptionSessionAccountPin`, `:2266` `recordSubscriptionSessionLastAccount`, `:2324` `updateSubscriptionQuotaMetadata`, `:2370` `wakeSubscriptionCapacityWaiters`, `:2447` workspace predicates (own workspace OR org row). Instantiated `xai-subscription.ts:35`. Org admin: `organization-subscription-repository.ts:14` (`lockPool` advisory key `organization-xai:<org>`, `:108` `wakeOrganizationPool`), instantiated `organization-xai-subscriptions.ts:5`. Waiters: `index.ts:28118` `createScopedSubscriptionCapacityWaiters` (`:28296` arm, `:28918` reconcile), instance `index.ts:29274`. Accepted authority readers: `accepted-subscription-authority.ts:43`, `:68`, `:81`, `:108`.

#### 4.2.3 Claude

##### Tables

- **Pool tables** (`schema.ts:4542`, same factory): `claude_subscription_credentials`, `claude_rotation_settings`, `claude_credential_leases`, `claude_session_account_pins`, `claude_capacity_waiters`, plus `opengeni_private.claude_subscription_runtime_capabilities`. Created by **0598** with `CREATE TABLE … (LIKE xai_…)` and then copying every xAI constraint, index, policy, trigger and function with text replacement `xai_`→`claude_`, `xAI`/`SuperGrok`→`Claude`. Therefore user-scope resource kind is `claude_subscription`, and the 0423/0424/0571 xAI policies and triggers exist on Claude tables as of 0598. Secret: `ClaudeSubscriptionCredential` (`token`, optional `oauth`, `identity`) (`claude-subscription-accounts.ts:17`).
- **`claude_subscription_account_usage`** (`schema.ts:4550`; 0598): PK `credential_id` (FK cascade), `account_id`, `credential_version` (must equal credential `version`), `snapshot` (`ClaudeSubscriptionUsage`, full provider windows), `model_cooldowns` jsonb `{modelId: isoTimestamp}`, `updated_at`. Read by `claude-subscription-accounts.ts:28` `readAccountCapacity` (per-model availability), written by `claude-subscription-account-usage.ts:152` `recordClaudeAccountUsage`.
- **Snapshot columns** (0598): `claude_provider_account_authority_snapshot` on `session_turns` (`schema.ts:7163`), `scheduled_tasks` (`:11625`), `session_system_updates` (`:8618`), `session_system_update_outbox` (`:8725`), **and `scheduled_task_revision_authorities`** (table not in `schema.ts`); `sessions.initial_claude_provider_account_authority_snapshot` (`:4786`). Triggers `<table>_claude_authority_lock_trg` → `prevent_claude_snapshot_mutation()`. Subject sources mirror xAI (`claudeAuthoritySubjectId` in lineage / scheduled snapshot; 0598 conversion sets it null for existing runs).
- **Legacy (pre-0598)**: `connections` rows with `metadata.credentialRole='claude_subscription'` and `organization_model_provider_connections.provider_kind='claude_subscription'` (0544/0545), usage in `connections.claude_usage_snapshot` / `organization_model_provider_connections.claude_usage_snapshot` (0549; `schema.ts:1879`, `:14368`). 0598 converts active rows (`claude-subscription-pool-migration.ts:57`: workspace connection ⇒ workspace scope, org provider connection ⇒ organization scope; one rotation row per pool, rotation off) and installs `reject_legacy_claude_subscription_credentials()` triggers on both legacy tables. Legacy TS readers remain (`claude-subscription-usage.ts`, `claude-subscription-tokens.ts`); `apps/api/src/claude-subscription-usage.ts:63` `refreshClaudeSubscriptionUsage` has no caller found (dead code, **uncertain** whether reachable another way).

##### Functions and differences from xAI

- Cloned routines: `claude_provider_account_authority_snapshot_v1_valid`, `claude_subscription_authority_live`, `claude_subscription_pool_visible`, `create_claude_subscription_credential`, `resolve_claude_authority_pool`, `revalidate_claude_subscription_authority`, `disconnect_claude_subscription_credential`, `prevent_claude_authority_mutation`, `prevent_claude_snapshot_mutation`, `opengeni_private.enforce_claude_credential_pool_reference`, `opengeni_private.enforce_claude_organization_runtime_update` (**changed**: refresh requires `version` unchanged, because Claude OAuth renewal keeps the account generation), `opengeni_private.prevent_organization_claude_live_disconnect` (0598).
- New: `opengeni_private.claim_session_system_update_outbox_v2` (returns both snapshots), `reject_legacy_claude_subscription_credentials()`, `opengeni_private.claude_subscription_pool_protocol_v1_active()` (startup interlock) (0598). 0602 adds a Claude branch to the product-lifecycle fact dispatcher.
- TS: `claude-subscription-accounts.ts:92` factory instance with `refreshIncrementsVersion: false`, `metadataIncrementsVersion: false`, `onAccessTokenRenewed`; `:172` org repository (`withOrganizationClaudeCapacityMutation`); `claude-subscription-account-usage.ts:99` `loadClaudeAccountCredential` (org path runs with no workspace GUC + admin subject + `get_organization_administration_overview`); `claude-subscription-account-tokens.ts:23` `resolveClaudeAccountCredential`. Waiters `index.ts:29292` (`worker:claude-workspace`).

##### RLS

Same set as xAI with `claude_` names (`claude_subscription_scope`, `claude_subscription_pool_scope`, `organization_scope_*`, `organization_lease_lifecycle_read`, `model_connection_workspace_access`, `lifecycle_backfill_read`, `claude_subscription_capability_read/insert` on membership/authority tables), all FORCE (0598). Plus `claude_usage_account_scope` on `claude_subscription_account_usage` (ALL): `account_id` = GUC account AND the credential row is visible to the caller (0598).

#### 4.2.4 Personal (user-scope) accounts across providers

- Generic authority table `organization_user_resource_authorities` (`schema.ts:1233`; kind values `codex_subscription`, `xai_subscription`, `claude_subscription`; tuple indexes 0226/0234).
- User-scope credentials always carry a `workspace_id` (shape checks), and xAI/Claude creation requires a workspace grant: a personal account is owned by a member **and bound to one workspace**, not organization-wide.
- Membership removal/retention (`0263` `organization_membership_lifecycle`, near `0263:2731` and `:2878`) deletes user-scoped Codex and xAI credentials and rejects any other retained kind with `unsupported retained resource kind`. `claude_subscription` is **not** in the allowed list and no later migration redefines it ⇒ likely gap (**uncertain**: not executed).
- Scheduled admission DB functions (0275, 0478 `admit_scheduled_agent_run_execution`, `bind_scheduled_task_run_connection_authorities`, etc.) check `xai_provider_account_authority_snapshot` scope=user against `xaiAuthoritySubjectId`; no Claude equivalent in SQL (Claude checked only in TS, e.g. `index.ts:69796`; **uncertain** whether all scheduled paths cover it).

#### 4.2.5 Shared execution-authority fence

`0608` `opengeni_private.fence_inbox_execution_context()` (trigger `inbox_execution_context_fence` on `session_turns`) requires a receiving system/goal turn to copy the context turn's `initiating_human_subject_id`, MCP bindings, and **xAI and Claude** snapshots; causal system updates must match. Codex accepted policy (turn metadata) is not part of this fence.

---

### 4.3 DB subjects and RLS settings

GUCs set by `packages/db/src/database.ts:423` `setRlsContext`: `opengeni.account_id`, `opengeni.workspace_id` (empty for org admin), plus from the async-local actor (`database.ts:90` `withSessionRlsActorContext`): `opengeni.subject_id`, `opengeni.initiating_human_subject_id`, `opengeni.private_file_owner`. `setSubjectRlsContext` (`database.ts:1068`) overrides `opengeni.subject_id`. DEFINER helpers temporarily set `opengeni.organization_tenancy_lifecycle`. Maintenance migrations (0403, 0422, 0492, 0598, 0608) require `opengeni.migration_application_roles` and drained app sessions.

Private-session visibility (`0345` policy `session_visibility_isolation`, RESTRICTIVE on `sessions`): visible if `opengeni.subject_id` is empty, or `visibility='workspace_shared'`, or `session_private_actor_visible(...)` (`0304`: subject **or** `initiating_human_subject_id` equals the owner).

| Subject | Where | Used for | Private-session effect |
|---|---|---|---|
| *(no subject)* | Codex DB functions: `withWorkspaceRls` / `withSessionActivityRlsContext` with only account+workspace (e.g. `index.ts:26127` `acquireCodexCredentialLease`, `:27649` reconcile) when no actor is in async-local storage | Codex selection, leases, waiters, pins, quota | Empty subject ⇒ all sessions visible. Codex pool rows never depend on subject |
| `service:agent-turn` | `apps/worker/src/activities/agent-turn/run.ts:513` with `initiatingHumanSubjectId = fileAuthoritySubjectId` | Agent-turn runtime; any DB call inside inherits it (Codex lease calls happen inside, `run.ts:525`) | Private session visible via initiating human GUC |
| `worker:xai-workspace` / `worker:claude-workspace` | `index.ts:29278` / `:29296`; chosen by `resolveXaiWaiterSubject` (`index.ts:28162`) when the frozen snapshot scope is workspace or organization | xAI/Claude capacity-waiter read/arm/reconcile | Non-empty, non-owner subject. Unless an async-local actor also sets `initiating_human_subject_id`, private sessions are hidden by `session_visibility_isolation`; reconcile updates `sessions` (`index.ts:29239`, error at `index.ts:29256`). **Uncertain** whether this hides private sessions in practice (depends on the Temporal activity context) |
| Initiating human `user:*` | user-scope xAI/Claude snapshots: waiters (`index.ts:28198`), acceptance (`subscription-account-repository.ts:754` requires subject), materialize/lease (`withWorkspaceSubjectRls`) | Exact-subject pool RLS (`*_authority_live`, `*_pool_visible`) | Owner subject ⇒ own private sessions visible |
| Org admin `user:*` (or local `dev`) | no workspace GUC; `codex_organization_admin_visible`; `organization-subscription-repository.ts:34` `withAdministrator`; Claude org usage via `get_organization_administration_overview` | Org pool CRUD, rotation, org wakes (wakes fan out per workspace using the admin subject, `organization-subscription-repository.ts:114`) | n/a |
| Migration owner (`current_user`) | `capture_legacy_codex_turn_sources` (clears subject), `codex_turn_source_bindings.capture_insert`, `*_capability_*` policies, `organization_lease_lifecycle_read` | Definer-only paths | Clears subject ⇒ sees all |
| Redeeming human `user:*` | `codex_reset_redemption_attempts.subject_id` must equal credential `connected_by_subject_id` | Reset-credit redemption | n/a |

---

### 4.4 Divergences and conflicts

#### 4.4.1 Structural divergences: Codex vs Claude/xAI factory

1. **Two implementations.** Codex is bespoke (`codex_*` tables, functions in `index.ts`). xAI and Claude share `createSubscriptionPoolTables` + `createSubscriptionAccountRepository`. Claude's SQL objects are a one-time **text clone** of xAI at 0598; later xAI-only migrations do not propagate (already visible: 0263 and 0275/0478 cover xAI only).
2. **Pool selection model.** Codex: one effective pool per workspace from `workspace_codex_subscription_preferences.mode` + `resolve_workspace_codex_subscription_source` (workspace credentials win in `automatic`). xAI/Claude: pool chosen at acceptance by `resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptanceInTransaction` (`subscription-account-repository.ts:775`): user pool with active credential ⇒ else any workspace credential ⇒ else org pool with active pointer ⇒ else workspace.
3. **Accepted authority storage.** Codex: JSON in `session_turns.metadata` + `codex_turn_source_bindings`; the dedicated `codex_provider_account_authority_snapshot` columns (0226) are inert and absent from `schema.ts`; no `sessions.initial_codex_…`; not in the 0608 fence. xAI/Claude: typed immutable columns on turns, sessions, scheduled tasks, system updates, outbox.
4. **Pins.** Codex: single pin + last on `sessions`. xAI/Claude: separate pin row per (session, pool), so one session can hold different pins/last accounts per scope/owner.
5. **Waiters.** Codex: one per session, extra columns (`reset_kind`, `policy_hash`, `refresh_attempt`, `resumed_update_id`). xAI/Claude: per (session, pool); subject-dependent RLS; worker subjects.
6. **Rotation/fairness.** Codex: separate workspace and org tables, no fairness cursor (uses `selection_count`/`last_selected_at`), rotation default off. xAI/Claude: one table per pool with `fairness_cursor`, rotation default on (Claude conversion set it off).
7. **Quota.** Codex: two windows + typed cooldown + revision guard + plan exclusions + reset credits. xAI: single percent. Claude: per-model windows/cooldowns in a side table; credential `version` does not change on token refresh.
8. **Personal accounts.** Codex user scope is schema-only; its RLS has no subject check. xAI/Claude user scope is live with exact-subject RLS and DEFINER lifecycle functions.
9. **Org visibility helpers are Codex-named** but shared (`codex_organization_scope_visible`, `codex_organization_admin_visible`, `list_organization_codex_workspace_ids`).
10. **Codex-only features:** Apps designation, reset-credit redemption, `codex_compaction_mode`, provider-artifact invalidation. **xAI-only:** realtime voice model, video funding (frozen credential envelope).

#### 4.4.2 Conflicts with the target model

| Target | Current data model | Evidence |
|---|---|---|
| No workspace-owned connections | All three have `authority_scope='workspace'` rows with `workspace_id` set; Codex also has per-workspace `codex_rotation_settings` | 0024/0028, 0234, 0598 |
| Org connections scoped to org / chosen workspaces / chosen people | Org rows have `allowed_workspace_ids` + `allow_personal_workspaces` (0424); **no per-person scoping column** | 0424 |
| Personal accounts only by choice/opt-in fallback; today personal pool auto-wins | xAI/Claude acceptance prefers an active user pool automatically (`subscription-account-repository.ts:775`). Codex `automatic` prefers any workspace-local credential, including a Personal workspace's own, over the org pool (`resolve_workspace_codex_subscription_source`, 0422) | — |
| Personal accounts | User-scope rows are bound to one workspace (`workspace_id` NOT NULL, workspace grant required) | 0234 `create_xai_subscription_credential`; 0381 shape check |
| Account belongs to the session, sticky | Codex pin/last on `sessions` but cleared for **all** sessions in a workspace on any source-mode change (`workspace_codex_subscription_preference_affinity_reset`, 0381). xAI/Claude pins are per pool, so a scope change at the next acceptance gives a different pin row. No prompt-cache warmth field found | 0381, 0234 |
| Automatic failover across providers with org order; explicit pins wait | No table/column for provider fallback order or failover settings found in `schema.ts`/migrations (searched `failover`, `fallback`) | — |
| Codex remote_v2 must not lock a session to Codex for life | `sessions.codex_compaction_mode` frozen at create; check remote_v2/portable | 0143, `schema.ts:4886` |
| Codex Apps on org-owned scoped connections | `codex_apps_settings` composite FK requires a workspace-owned credential; org credentials cannot be designated | 0173, 0381 comment |
| Org defaults with lockable workspace overrides, effective value + source | Codex: org `rotation_enabled` and workspace `rotation_enabled` are independent rows; workspace `mode` is the only override, no lock. xAI/Claude: per-pool `rotation_enabled`; no org→workspace inheritance or lock columns | 0028, 0381, 0234 |
| Pools never change session visibility; background work re-establishes the initiating human | xAI/Claude waiters run as `worker:*-workspace` for workspace/org snapshots without an explicit initiating-human GUC (possible private-session blind spot, **uncertain**). Codex background paths run with no subject (sees everything). `capture_legacy_codex_turn_sources` clears the subject by design | `index.ts:28162`, 0492 |
| Reset redemption tied to a human | `connected_by_subject_id` must match; org credentials have no workspace and cannot be redeemed | `index.ts:30384` |

#### 4.4.3 Open / uncertain points

- Codex user-scope: no writer found in `packages/db/src` or `apps`; confirmed only by search, not exhaustive call-graph review.
- Whether `worker:xai-workspace` / `worker:claude-workspace` reconcile paths run inside an async-local actor that sets `initiating_human_subject_id` (would avoid the private-session gap).
- Claude membership-retention gap in 0263 and Claude scheduled-admission coverage in SQL: inferred from absence, not executed.
- `scheduled_task_revision_authorities` has a Claude snapshot column (0598); no xAI or Codex column found there.
- Codex Live realtime (`gpt-live-1-boulder-alpha`) account selection was not traced.

## Appendix: uncertain points and open questions

These were not confirmed by reading every caller or by running code. Each should be settled by a test in the `verification-suite` work item before the contract relies on it.

1. The exact statement that raises "Session not found" when Claude/SuperGrok arming fails on a private session (EP-T07, CA answer (a)). The mechanism (subject GUC, restrictive policies) is confirmed by code; the throw site is not.
2. Whether every reported "wrong authority scope" case came through the paths in EP-T11/EP-S20/EP-S22 (not reproduced).
3. Whether `claude_subscription` personal accounts block membership removal because 0263 only knows Codex and xAI kinds, and whether every scheduled path checks the Claude user-scope subject (Part 4 §4.2.4).
4. Whether a `user`-scope Codex credential can exist today; no writer was found (CA-02).
5. What happens to a SuperGrok video operation funded by an organization pool after reconciliation rejects its envelope, and whether xAI revokes the previous refresh token when video recovery refreshes outside the serialized lock (EP-N13, EP-N14).
6. Whether the SuperGrok image path checks the turn lease before dispatch (EP-N09).
7. Whether a workspace reader can trigger refresh of another member's `user`-scope Codex row through `/codex/usage/refresh` (EP-N21).
8. Whether `upsertOrganizationClaudeSubscription` wakes waiters (EP-S11).
9. Whether child-session turns can count as `api` source for receiver execution context (EP-S22).
10. Codex holder-id construction and the false-resumption clearing rule were not re-read (CA-08, CA-28).
11. How the generic failure path presents "This model is disabled for the connected/pinned … subscriptions" errors, which are plain `Error`s for all providers (EP-T03, CA-25).
12. `getCodexCapacityWait` reconstructs only the first waiter it finds (Codex, then SuperGrok, then Claude); the behaviour when a session has waiters for more than one provider is undefined (CA-27). Cross-provider failover will make this reachable.
