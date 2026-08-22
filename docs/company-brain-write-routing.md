# Company Brain write routing

OpenGeni does not use one generic `memory_save` destination for every reusable
observation. Destination selects authority, visibility, lifetime, and review
semantics; content labels do not. This document records the target routing
model and the implemented workspace-local slices: root-task-tree coordination
notes plus governed Knowledge and Ways-of-working proposals.

## Destination matrix

| Destination | Purpose | Authority | Model access | Current status |
| --- | --- | --- | --- | --- |
| Knowledge | Sourced company facts and evidence | Documents/scoped-knowledge authority | Permission-first `knowledge_search`/`get`/`browse`; never prompt-injected | Workspace-local claim proposal/correction plus rooted Task-note promotion implemented as append-only review/relation evidence |
| Ways of working | Human-authoritative policy and preferences | Existing instruction-policy and preference-registry heads | Bounded descriptors by default; full bodies on demand | Workspace-local Knowledge-backed inactive proposal adapters plus atomic rooted Task-note promotion implemented; activation remains human-only |
| Task notes | Short-lived technical coordination inside one root session tree | Exact accepted turn/attempt plus root-session visibility | Explicit `task_notes_list`; never prompt-injected | Create/list/archive implemented by migration 0239; atomic correction/revert lineage by migration 0260 |
| Durable agent learning | Reusable technical knowledge beyond one task tree | Existing Memory/governed-learning authorities | Existing retrieval rules | Routing/promotion remains later work |

The router must preserve the selected destination's provenance and may propose
promotion, but it must not convert an agent observation into active company
policy or a preference. Personal and organization cross-workspace routing stay
inactive until their tenancy authorities are activated; workspace-local task
notes do not widen those scopes.

## Governed workspace proposals

`writeCompanyBrainGovernedProposal` accepts one explicit destination operation:

- propose one existing workspace Knowledge claim with exact supporting evidence;
- propose a correction by linking one replacement claim to a different replaced
  claim with `supersedes`, then appending a proposed review;
- materialize an exact Knowledge change proposal as an inactive instruction
  charter/policy draft against an exact active-head baseline;
- materialize an exact Knowledge change proposal as an inactive workspace
  preference with `knowledge_proposal` provenance and `untrusted_proposal` trust;
- promote an exact rooted Task note into proposed workspace Knowledge;
- atomically promote an exact rooted Task note through proposed Knowledge into
  an inactive instruction-policy draft; or
- atomically promote an exact rooted Task note through proposed Knowledge into
  an inactive workspace preference.

The request carries an operation UUID plus the exact account, workspace,
session, turn, attempt, and execution generation. One transaction locks and
revalidates that active attempt, its immutable initiating human, and the absence
of a live interruption. It then requires a workspace-scoped claim and exact
supporting evidence. Organization, personal, generic Memory, and caller-selected
active authority are not valid inputs.

Instruction-policy proposals acquire their destination's exclusive workspace
lock before any rooted Task-note session locks. The nested policy lifecycle
therefore re-enters an already-held workspace lock instead of upgrading after a
root lock; concurrent independent roots serialize without deadlock. Knowledge
and preference routes retain their less-exclusive workspace lock path.

Every route first appends one `proposed` Knowledge review using a deterministic
sub-operation UUID. Its immutable input hash binds the complete request and
exact attempt through a content-free service actor identity. This common guard
makes the top-level operation UUID idempotent across every explicit operation: an
exact retry reconstructs the same receipt, while changed destination, content,
attempt, generation, evidence, or reason conflicts. Corrections add an immutable
relation; Ways-of-working routes add an immutable Knowledge change proposal and
the destination's normal inactive proposal/revision records.

The preference adapter additionally records an immutable workspace-local
destination receipt keyed by the top operation UUID and full input hash. Replay
returns the original preference/revision IDs even if a human later activates,
rejects, deactivates, supersedes, or changes the scope of the preference. This
is a write-destination receipt only; it does not select context, freeze a
logical-turn snapshot, or overlap the permission-first selector's context
receipt ownership.

Migration `0255_company_brain_governed_write_proposals.sql` broadens the
historically named onboarding-proposal validator without changing its table. A
Knowledge-backed instruction draft is admitted only when its provenance source
ID, workspace scope, target, and content hash match the exact immutable
`knowledge_change_proposals` row. Existing onboarding validation is unchanged.
The same migration adds the immutable FORCE-RLS preference destination receipt
and an exact-attempt security-definer proposal writer.
Migration `0261_preference_knowledge_proposal_actor_binding.sql` is the rolling
repair that makes both existing Knowledge-backed adapters executable against
their canonical constraints: instruction change proposals retain the exact
`global | role` target shape, and the preference security-definer writer uses
an unambiguous local actor binding. It changes no privilege, authority, or
receipt shape.

Receipts expose only operation/input hashes and audit/resource IDs. They report
`human_review_required`; because the write is proposal-only, immediate rollback
is `not_applicable_proposal_only` and no authority rollback token exists.
Rejection/revocation and the existing human-governed destination lifecycle are
the only later rollback/review mechanisms. No selector snapshot,
logical-turn context receipt, generic Task-note write surface, external REST/UI,
or automatic instruction-policy activation is part of this slice; automatic
preference activation is routed through the governed-learning evaluator and
controller as described below.

The transport-neutral learning-policy router resolves an exact
`scoped-knowledge-evidence/<evidenceId>` source from the immutable policy
snapshot owned by the accepted attempt. Callers cannot supply another source
key to select a more permissive override. `off` produces no destination write;
`suggest` and `automatic` both create the same auditable proposal. After the
proposal commits, a Ways-of-working proposal (one that materialized a
`knowledge_change_proposals` row: instruction policy or preference) is passed to
the migration 0268 evaluator with the same frozen snapshot, the exact accepted
attempt, and the turn's immutable initiating human; the evaluator records a
content-free decision receipt that the receipt's `learning` summary reports
(`outcome`, `automaticEligible`, ordered `reasons`). Under `automatic`, a final
eligible decision for a **preference** is handed to the migration 0269
activation controller, which revalidates current authority and applies the
change only through the preference lifecycle; the receipt then reports
`decision: "activated"` with the activation receipt id, destination revision,
and effective boundary, and the change is undoable through the `/learning`
API/SDK undo operation (the Learning & autonomy web view exposes only the
learning mode).
Mandatory instruction policy keeps a human activation boundary even under
`automatic` (`activation.boundary = "human_activation_required"`): its decision
receipt is recorded and its inactive draft waits for a human. Knowledge
destinations create no change proposal and are never evaluated; the human
Knowledge review lifecycle owns them. Evaluator or controller failures never
roll back the durable proposal; they surface as a bounded content-free
`learningFailure` and the proposal remains for review. Evaluation and
activation operation ids are derived deterministically from the proposal
operation id, so exact retries converge on the same receipts. The public
receipt exposes only the effective source-specific decision and snapshot
identity/hash, not the snapshot's other source overrides.

The first-party proposal surface is intentionally explicit:
`knowledge_propose`, `knowledge_correct`, `task_note_promote_knowledge`,
`task_note_promote_instruction_policy`, `task_note_promote_preference`,
`instruction_policy_propose`, and `preference_propose`. The signed host supplies
the exact attempt tuple. Tool input cannot select authority scope, active
authority, a different learning-policy source, or replacement evidence bytes.

## Explicit user-directed remember

`remember` (`apps/api/src/mcp/remember.ts`, router
`packages/core/src/domain/remember.ts`) is the one tool for "remember this for
the workspace". Its lane is the Company Brain area (`preference`,
`instruction_policy`, or `knowledge`); v1 supports the workspace scope only. The
content becomes one exact task note (the evidence, expiring after 90 days), the
note is promoted through the learning-policy router above with full user
confidence, and the receipt is one of:

- `blocked` - the frozen learning policy is `off` for this source; nothing durable
  was written;
- (Knowledge facts also return `confirmation_required`, bound to the claim id
  rather than a change proposal; the same one-click answer approves the claim
  through the Knowledge review lifecycle, see below);
- `activated` - a preference under `automatic` was activated by the governed
  controller and is undoable through the `/learning` API/SDK undo operation;
- `confirmation_required` - the proposal is durable but the policy will not
  activate it (Suggest mode, an ineligible decision, or a mandatory rule, which
  always keeps a human boundary). The receipt carries the exact
  `request_human_input` payload: one `single_select` question whose id is
  `remember:<proposalId>` with options `save` / `skip`. The agent asks the human
  through the built-in tool, then calls `remember_confirm` with the proposal id,
  the decision receipt id, and the returned `requestId`.

`remember_confirm` invokes migration 0272's
`activate_human_confirmed_learning_decision`. That SECURITY DEFINER capability
requires the exact initiating human's `session_human_input_requests` row: same
session and logical turn (at the decision receipt's execution generation or a
later one of that turn), status `answered`, `responded_by` equal to the turn's initiating human, and the bound
question answered with exactly `save`. The question the human saw is not
trusted from the agent: the capability reconstructs the canonical prompt from
the proposal lane, the help text from the exact Task-note text, and the fixed
`Save` / `Don't save` options, and refuses any human-input row whose question
differs, so a misleading agent-authored prompt cannot obtain confirmation (only
Task-note-backed proposals, i.e. those created by `remember`, are confirmable).
It accepts `suggest`, `automatic`, and
`confidence` decision receipts (never `off`, `revoked`, `stale`, or `conflict`),
revalidates the current learning policy (not `off`), evidence, review, and
destination CAS, and writes only through the destination-native lifecycle. The
activation receipt records `authorityKind = human_confirmed` and the human-input
request id, so the `/learning` history API shows who authorized it and exact
undo remains available through the API/SDK (not the web view). Because the
receipt is minted before the human-input pause and the turn resumes on a new
attempt at a later execution generation (and a recovery re-claim before the
pause or another interruption answered first likewise advances the pending
request row's generation), the capability requires the turn's current live
attempt of the same logical turn at the minting generation or later rather than
the minting attempt (migration 0315); neither the answered row nor the live
attempt may belong to another turn or an earlier generation. Agents cannot
fabricate that answer: the human-input row is written only by the authenticated
human's response route.

For the Knowledge lane, `remember_confirm` invokes migration 0274's
`confirm_remember_knowledge_claim`. It performs the same live-turn,
responder, canonical-prompt (`Save this as workspace knowledge for everyone in
this workspace?`), exact-note-text, fixed-options, and `save` checks bound to
`remember:<claimId>`, requires the claim's latest review to still be
`proposed` and its Task-note evidence to be active and uncontradicted, then
appends an `approved` service review through the guarded
`governed_learning_apply_knowledge_review` path (service actor, causal human
retained; since migration 0284 the reason-carrying overload records a truthful
human-confirmed reason instead of the automatic wording) and records an
immutable content-free `remember_knowledge_confirmation_receipts` row. Undo is the Knowledge review
lifecycle itself (`knowledge_correct` or a human revocation), not Learning &
autonomy history. Knowledge is never approved automatically, even under the
`automatic` learning mode.

`task_note_promote_knowledge` accepts an active, unexpired version-one note from
the exact caller's root tree plus normalized entity/predicate metadata. The note
text becomes the proposed workspace Knowledge fact value. Migration
`0260_task_note_knowledge_promotion.sql` extends claim evidence with exactly one
Document-version or Task-note source shape. Task-note evidence stores only the
note/root/version/content-hash facts; it never copies note
text into evidence metadata. The security-definer resolver revalidates the
current attempt, immutable initiating human, and exact source-specific
learning-policy snapshot, locks the note, and rejects policy-off, another root,
workspace, tenant, archived note, expired note, or stale version. A value-free,
one-transaction capability binds the exact evidence/claim operations and is
consumed by the insert trigger; the runtime role has no direct capability-table
DML and cannot forge Task-note evidence onto another claim. Migration 0260 pins
`pg_catalog`, the deployment target schema, then `pg_temp` for every new
definer and the complete invoked Task-note closure: the legacy attempt resolver,
create/archive/list lifecycle, mutation/event guards, session-reference RLS
helper, and private-actor visibility helper. A runtime caller with database
`TEMP` privilege therefore cannot shadow session, turn, attempt, interruption,
membership, Task-note, event, or capability authority relations.
The migration 0261 preference-adapter repair preserves that same explicit
`pg_catalog`, deployment target schema, `pg_temp` definer boundary.
The resulting claim is `proposed`, never approved or prompt-active. Exact retry
reconstructs the same receipt even after the short-lived note is archived;
changed input conflicts, and source cleanup cannot silently widen authority.

The two direct Task-note-to-Ways tools use the same rooted source admission and
first materialize that exact note text as proposed workspace Knowledge. In the
same outer transaction they pass those unchanged bytes to the selected inactive
destination adapter. Callers supply bounded descriptor/target metadata but no
replacement content. Exact concurrent retries converge, archival replay reads
the immutable fact/evidence lineage rather than the expired note row, and a
different root or changed input fails closed. Neither path activates a head or
injects the result into a prompt.

## Root-task-tree notes

`task_notes` is a bounded coordination ledger, not conversation compaction,
prompt memory, Knowledge, or policy. A note is attached to the canonical
`sessions.root_session_id`, so a coordinator and descendants in that same tree
can explicitly retrieve discoveries, ownership, blockers, decisions, artifacts,
and handoffs. Agents do not crawl a folder hierarchy and the runtime never
automatically composes notes into a prompt.

The remote first-party MCP surface is:

- `task_notes_list`: at most 20 unexpired notes, with a 96 KiB aggregate
  projection bound;
- `task_note_save`: one 4,096-UTF-8-byte note, a caller operation UUID, and an
  expiry from one through 90 days;
- `task_note_archive`: an optimistic version-1 archive with a separate bounded
  reason and operation UUID; and
- `task_note_replace`: atomically archive one exact active version-1 note and
  create a fresh linked version-1 replacement, with one top-level operation UUID.

There are at most 500 active, unexpired notes per root tree. Mutation locks the
root session in canonical session order, so concurrent sibling agents cannot
overrun the cap. Expired notes stop counting and stop appearing in ordinary
retrieval; archival retains immutable evidence. A later bounded maintenance
job may physically clean expired rows without changing their runtime semantics.

## Authority and visibility

The note, event, write-capability, and replacement-receipt tables use FORCE RLS
for exact account/workspace isolation. Notes and events also use a RESTRICTIVE
root-session visibility policy. The lifecycle functions recheck both the
addressed session and root using the immutable human authority frozen on the
accepted logical turn. The worker identity is transport only. Pure service turns
retain explicit service provenance and never acquire a manufactured human identity.

Create, list, archive, and replace accept the exact account, workspace, session,
turn, attempt UUID, and execution generation from the worker-signed MCP grant.
They lock and verify the active turn and attempt and reject pending interruption.
The application role has function execution only: direct table DML and direct
selects are not part of the runtime contract. One-transaction capabilities fence
the internal row/event mutations.

Create and archive each preserve an immutable operation/input receipt. The
input hash binds tenant, root tree, source session, logical turn, attempt,
generation, and content. An exact retry converges; reuse in another tree, turn,
attempt, generation, or with different input conflicts. This is intentionally
attempt-bound: ordinary side-effecting tool recovery records an ambiguous call
as outcome-unknown and does not invoke it again on a successor attempt. A new
attempt therefore cannot claim a predecessor's note operation as its own.

Archiving is the only in-place note mutation. It advances version 1 to 2 and
writes separate archive actor/attempt/operation fields plus an append-only event;
the original creation receipt is never overwritten. Note text is immutable.
Correction therefore uses `task_note_replace`: one transaction archives the old
note and creates a new immutable note, then records a content-free receipt linking
both IDs and derived lifecycle operations. Exact retry returns that same lineage;
changed input, another tree/attempt, or a stale old version fails closed. Undo is
the same explicit operation in reverse: replace the correction with a fresh note
whose body is copied from the retained archived original. History is never edited
or reactivated, and failure of either half rolls back the entire replacement.

## Deployment and deferred work

Migrations `0239_task_tree_notes.sql`,
`0260_task_note_knowledge_promotion.sql`, and
`0261_preference_knowledge_proposal_actor_binding.sql` are rolling and additive. Migration 0260
also adds immutable replacement receipts and the exact replacement lifecycle
function. Neither activates organization or personal cross-workspace reads,
changes goal behavior, injects prompt context, or replaces any Knowledge,
policy, preference, Memory, or learning authority.

Still required outside this workspace-local slice:

- Personal/Organization promotion and explicit scope commands after their
  canonical cross-workspace authorities are active;
- automatic activation destinations beyond the workspace-scoped Preference
  lifecycle (instruction policy stays human-activated; Knowledge is
  review-owned) owned by migration 0269; and
- bounded expiry cleanup and user-facing Advanced/search/export surfaces.

Canonical implementation: `packages/contracts/src/task-notes.ts`,
`packages/db/src/task-notes-schema.ts`, `packages/db/src/task-notes.ts`,
`packages/db/drizzle/0239_task_tree_notes.sql`, and
`apps/api/src/mcp/server.ts` for task notes; and
`packages/contracts/src/company-brain-governed-writes.ts`,
`packages/db/src/company-brain-governed-writes.ts`,
`packages/core/src/domain/company-brain-governed-writes.ts`, plus migration
`0255_company_brain_governed_write_proposals.sql` for governed proposals and
`0260_task_note_knowledge_promotion.sql` for exact Task-note evidence, with
`0261_preference_knowledge_proposal_actor_binding.sql` repairing the two
Knowledge-backed Ways adapter predicates.
