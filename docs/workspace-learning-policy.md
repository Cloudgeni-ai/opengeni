# Workspace Learning Policy

The workspace learning-policy domain controls whether evidence from one source may produce a durable **derived change**. It does not decide which durable authority receives a write and it never turns source evidence into prompt authority by itself.

## Modes

Each active revision has one workspace mode:

- `off`: evidence may still be ingested and retrieved, but no durable derived change is authorized.
- `suggest`: downstream evaluation may create an auditable inactive draft for review.
- `automatic`: downstream evaluation may request activation through the destination authority's existing governed lifecycle.

An exact source may override the workspace mode with `off`, `suggest`, or `automatic`. `inherit` exists only at request boundaries: canonical revisions omit inherited entries, so persisted override arrays are sparse, unique, bounded, and byte-ordered by `{kind,id}`.

Source references are provider-neutral `{kind,id}` identities. They may identify a scoped-knowledge source, a connector source, a session-derived evidence lane, or another future source without coupling the policy to one connector table. Current ACL, lifecycle, deletion, revocation, initiating-human, and destination-scope checks remain the responsibility of the evidence and destination authorities.

## Durable lifecycle

Migration `0199_workspace_learning_policy.sql` adds four FORCE-RLS tables:

- `workspace_learning_policy_revisions`: immutable workspace mode plus sparse source overrides and a canonical policy hash.
- `workspace_learning_policy_heads`: one current revision per workspace. The ordinary runtime role has read-only access; a trigger rejects inserts, updates, and deletes outside the lifecycle function.
- `workspace_learning_policy_activation_events`: immutable, idempotent activation/rollback evidence with exact old/new revision identities, actor, reason, activation version, and timestamp.
- `workspace_learning_policy_snapshots`: immutable accepted-attempt policy state, reconstructed from activation events at the logical turn's immutable `created_at`.

Revision creation does not activate a policy. Activation and rollback require an exact authenticated human actor, expected current revision, expected activation version, and operation fingerprint. A rollback target must have been active previously. Direct head/event writes are not a supported or authorized activation path.

Workspaces without an active revision snapshot deterministically as `suggest`, with no revision and no source overrides. The UI names this mode **Require approval**. This default applies only to governed Workspace instruction and Skill changes; it does not disable `memory_search` or gate autonomous Workspace Memory writes.

Migration `0364_workspace_learning_policy_snapshot_lock_order.sql` repairs the accepted-attempt snapshot lock order without changing policy semantics. Snapshot creation locks the workspace, session, turn, and attempt explicitly in the same order as ordinary session lifecycle writers, then revalidates the complete authority and interruption tuple in a fresh statement. The attempt `SHARE` lock remains held through commit and every supported interruption writer takes that attempt `FOR UPDATE` before insertion, so an interruption cannot cross the revalidation-to-insert interval. PostgreSQL query planning therefore cannot invert session and turn locks, while a Pause, Steer, replacement, or settlement that completed during a lock wait still causes the snapshot to fail closed.

## Effective resolution and governed evaluation

`resolveWorkspaceLearningPolicyEffectiveMode(snapshot, source)` is the stable routing seam:

1. It accepts an immutable `WorkspaceLearningPolicySnapshot`, never a mutable current head.
2. It matches one exact `{kind,id}` override.
3. It returns the override mode when present; otherwise it returns the workspace mode with `inherited: true`.
4. Its receipt retains the snapshot id/hash, policy revision identity, activation version, and source reference.
5. `workspaceLearningPolicyRouterContext(effectiveMode)` projects the exact immutable `{mode,snapshotId,revisionId}` object consumed by the canonical router. A snapshot with no active revision uses the explicit stable `workspace-learning-policy:default-suggest:v1` revision sentinel, preserving the deterministic approval-required policy instead of misrepresenting it as a missing snapshot.

Migration `0393_workspace_memory_and_learning_defaults.sql` changes only the no-active-revision default to `suggest`; existing activated revisions and immutable accepted-attempt snapshots remain authoritative and unchanged.

Migration `0268_governed_learning_decision_receipts.sql` adds the deterministic evaluator over this frozen policy state. The Company Brain learning-policy router (`createCompanyBrainLearningPolicyRouter` in `packages/core/src/domain/company-brain-governed-writes.ts`) invokes it after every committed Ways-of-working proposal (instruction policy or preference) with the accepted snapshot and the turn's immutable initiating human; see [`company-brain-write-routing.md`](company-brain-write-routing.md). It accepts only an exact live attempt, its accepted policy snapshot, and one workspace-scoped proposal/claim/supporting-evidence lineage. Before recording a verdict it rechecks current Task-note or scoped-Document authority, the latest review, expiry/staleness, conflicts, and a platform-owned confidence floor. The result is one immutable, content-free receipt with exact IDs, hashes, versions, bounded facts, and canonical reason order.

`automatic` is only an eligibility verdict. The evaluator has no destination-writer call, head privilege, activation grant, or reusable capability. Exact retries converge on the original receipt; a changed operation input, another task tree, another subject, or another proposal for the same accepted snapshot conflicts or denies. The receipt table is FORCE RLS with no direct runtime DML, and the app role can call only the target-schema-local SECURITY DEFINER evaluator.

Migration `0269_governed_learning_activation_controller.sql` adds the separate
controller that consumes one final `automatic` receipt. The learning-policy
router invokes it for eligible **preference and instruction-policy** decisions,
revalidating and activating only through the destination-owned lifecycle.
Migration 0272 adds
the sibling `activate_human_confirmed_learning_decision`, used by the explicit
`remember_confirm` tool: it activates a `suggest`/`automatic`/`confidence`
receipt only after the exact initiating human answered the bound
`remember:<proposalId>` structured human-input question with `save` on the same
logical turn, and stamps `authority_kind = human_confirmed` plus the
human-input request id on the activation receipt. The generation rule
(migration 0316, and likewise for `confirm_remember_knowledge_claim`): the
answer is bound to the same logical turn and exact proposal, not to one
execution generation. Resuming the `requires_action` human-input pause always
increments the turn's execution generation, and a recovery re-claim before the
pause or another interruption answered first advances the pending request row's
own generation, so both the answered request row and the live claimed/running
attempt may carry a later generation than the decision receipt; they must still
belong to the same session active turn and turn id, never an earlier generation
or another turn. See
[`company-brain-write-routing.md`](company-brain-write-routing.md). It revalidates
the accepted attempt and initiating human, current policy head and source
override, current evidence ACL/lifecycle/hash, latest Knowledge review, inactive
proposal, conflict facts, and destination CAS before invoking the destination's
native lifecycle. A service actor performs the mutation while the causal human
remains explicit; neither identity substitutes for the other. Immutable
content-free activation and undo receipts bind every source/destination hash,
version, event, and effective boundary.

Undo is compensation, not history deletion. It succeeds only while both the
automatic Knowledge review and destination head remain current. Knowledge adds
an append-only revocation review, Preference uses its native deactivation
lifecycle, and instruction policy restores the exact prior head. A first policy
activation can therefore return to no active head through the service-only
`automatic_deactivate` event while retaining a durable monotonic inactive
boundary for later CAS. Accepted-turn event reconstruction observes no policy
after that boundary. Human activation and rollback event shapes remain
unchanged.

## Administration and inspection

Migration `0270_governed_learning_history_inspection.sql` keeps all three
governed-learning receipt tables inaccessible to direct runtime reads and adds
three bounded, read-only SECURITY DEFINER projections. Each projection requires
the exact current account, workspace, subject, and `human_session` principal;
decision history additionally retains session-visibility and immutable
initiating-human checks. The projections return only the existing content-free
receipts.

`GET /v1/workspaces/:workspaceId/learning` is the canonical permission-filtered
history surface. It combines the active workspace policy and immutable policy
events with the current human's decision, automatic-activation, and undo
receipts. The response cites stable source IDs, hashes, versions, confidence,
reason codes, actors, and the `next_accepted_attempt` effective boundary. It
never returns source text, proposal content, preference values, instruction
content, credentials, or another human's receipts.

Policy revision creation, activation, and rollback plus exact governed-change
undo require `workspace:admin` and an authenticated human session. The
Workspace settings **Workspace instruction & Skill autonomy** section exposes
only the workspace learning mode, mapped directly to the canonical backend
modes (`Off`, `Require approval` = `suggest`, and `Autonomous` = `automatic`); a
mode change creates and activates a new revision under activation-version CAS
and carries the active revision's existing source overrides forward unchanged.
Exact-source overrides, rollback, and governed-change undo remain API/SDK
operations on the `/learning` routes with no web UI. Rollback and undo remain
destination-native compensating lifecycle operations rather than history
mutation.

Workspace Memory is deliberately outside this policy. When the separate
`memoryEnabled` workspace setting is not explicitly false, exact live agent
attempts may use `memory_save` and `memory_correct` autonomously in every
Learning mode. Learning mode continues to govern derived Skills and instruction
proposals, not the shared agent Memory mechanism. Autonomous may activate an
eligible Skill or instruction through the destination-owned lifecycle; Require
approval leaves the proposal inactive until a person approves it; Off creates
no durable derived change. Organization identity is separate again: its own
organization-owner policy uses Off, Require approval, and Autonomous modes for
`company_profile_propose`, and cannot be changed or widened by a workspace
administrator.

Destination ownership remains:

- Documents/RAG: evidence and retrieval only.
- Memory: facts, decisions, observations, and history.
- Preference Registry: procedures, preferences, working methods, and skill-like guidance; descriptors are bounded and full content is retrieved only on demand.
- Charter/instruction policy: bounded always-composed mandatory context.

## Explicit non-goals

The controller deliberately does not implement:

- Memory mutation through the learning controller (agent Memory writes use the
  separate `memoryEnabled` gate) or company-profile mutation (agent profile
  changes use the separate organization-owner policy);
- Personal or Organization scope expansion;
- explicit session command/tool integration;
- runtime prompt composition or automatic snapshot installation;
- Slack notification delivery.

Canonical policy code: `packages/contracts/src/workspace-learning-policy.ts`, `packages/db/src/workspace-learning-policy.ts`, `packages/db/src/workspace-learning-policy-schema.ts`, and migrations `0199_workspace_learning_policy.sql`, `0364_workspace_learning_policy_snapshot_lock_order.sql`, and `0393_workspace_memory_and_learning_defaults.sql`. Canonical evaluator code: `packages/contracts/src/governed-learning-evaluator.ts`, `packages/core/src/domain/governed-learning-evaluator.ts`, `packages/db/src/governed-learning-evaluator.ts`, and migration `0268_governed_learning_decision_receipts.sql`. Canonical activation code: `packages/contracts/src/governed-learning-activation.ts`, `packages/core/src/domain/governed-learning-activation.ts`, `packages/db/src/governed-learning-activation.ts`, and migration `0269_governed_learning_activation_controller.sql`. Canonical administration code: `packages/contracts/src/workspace-learning-administration.ts`, `apps/api/src/routes/workspace-learning.ts`, `packages/sdk/src/workspace-learning.ts`, `apps/web/src/routes/workspace-learning-admin.tsx`, and migration `0270_governed_learning_history_inspection.sql`.
