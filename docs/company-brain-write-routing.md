# Company Brain write routing

OpenGeni does not use one generic `memory_save` destination for every reusable
observation. Destination selects authority, visibility, lifetime, and review
semantics; content labels do not. This document records the target routing
model and the implemented workspace-local slices: root-task-tree coordination
notes plus governed Knowledge and Ways-of-working proposals.

## Destination matrix

| Destination | Purpose | Authority | Model access | Current status |
| --- | --- | --- | --- | --- |
| Knowledge | Sourced company facts and evidence | Documents/scoped-knowledge authority | Permission-first `knowledge_search`/`get`/`browse`; never prompt-injected | Workspace-local claim proposal/correction routing implemented as append-only review/relation evidence |
| Ways of working | Human-authoritative policy and preferences | Existing instruction-policy and preference-registry heads | Bounded descriptors by default; full bodies on demand | Workspace-local Knowledge-backed inactive proposal adapters implemented; activation remains human-only |
| Task notes | Short-lived technical coordination inside one root session tree | Exact accepted turn/attempt plus root-session visibility | Explicit `task_notes_list`; never prompt-injected | Implemented by migration 0239 |
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
  charter/policy draft against an exact active-head baseline; or
- materialize an exact Knowledge change proposal as an inactive workspace
  preference with `knowledge_proposal` provenance and `untrusted_proposal` trust.

The request carries an operation UUID plus the exact account, workspace,
session, turn, attempt, and execution generation. One transaction locks and
revalidates that active attempt, its immutable initiating human, and the absence
of a live interruption. It then requires a workspace-scoped claim and exact
supporting evidence. Organization, personal, generic Memory, and caller-selected
active authority are not valid inputs.

Every route first appends one `proposed` Knowledge review using a deterministic
sub-operation UUID. Its immutable input hash binds the complete request and
exact attempt through a content-free service actor identity. This common guard
makes the top-level operation UUID idempotent across all four destinations: an
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

Receipts expose only operation/input hashes and audit/resource IDs. They report
`human_review_required`; because the write is proposal-only, immediate rollback
is `not_applicable_proposal_only` and no authority rollback token exists.
Rejection/revocation and the existing human-governed destination lifecycle are
the only later rollback/review mechanisms. No selector snapshot,
logical-turn context receipt, Task-note write, MCP/API/UI registration,
or automatic policy/preference activation is part of this slice.

The transport-neutral learning-policy router resolves an exact
`scoped-knowledge-evidence/<evidenceId>` source from the immutable policy
snapshot owned by the accepted attempt. Callers cannot supply another source
key to select a more permissive override. `off` produces no destination write;
`suggest` creates the existing inactive proposal; and `automatic` creates the
same auditable proposal while requesting activation at the destination-owned
lifecycle boundary. Its receipt explicitly reports that activation has not
occurred. Mandatory instruction policy and preferences therefore remain
inactive until their existing authority accepts them, even in automatic mode.
The public receipt exposes only the effective source-specific decision and
snapshot identity/hash, not the snapshot's other source overrides.

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
  expiry from one through 30 days;
- `task_note_archive`: an optimistic version-1 archive with a separate bounded
  reason and operation UUID.

There are at most 500 active, unexpired notes per root tree. Mutation locks the
root session in canonical session order, so concurrent sibling agents cannot
overrun the cap. Expired notes stop counting and stop appearing in ordinary
retrieval; archival retains immutable evidence. A later bounded maintenance
job may physically clean expired rows without changing their runtime semantics.

## Authority and visibility

All three tables use FORCE RLS for exact account/workspace isolation. Notes and
events also use a RESTRICTIVE root-session visibility policy. The lifecycle
functions recheck both the addressed session and root using the immutable human
authority frozen on the accepted logical turn. The worker identity is transport
only. Pure service turns retain explicit service provenance and never acquire a
manufactured human identity.

Create, list, and archive accept the exact account, workspace, session, turn,
attempt UUID, and execution generation from the worker-signed MCP grant. They
lock and verify the active turn and attempt and reject pending interruption.
The application role has function execution only: direct table DML and direct
selects are not part of the runtime contract. One-transaction capabilities
fence the internal row/event mutations.

Create and archive each preserve an immutable operation/input receipt. The
input hash binds tenant, root tree, source session, logical turn, attempt,
generation, and content. An exact retry converges; reuse in another tree, turn,
attempt, generation, or with different input conflicts. This is intentionally
attempt-bound: ordinary side-effecting tool recovery records an ambiguous call
as outcome-unknown and does not invoke it again on a successor attempt. A new
attempt therefore cannot claim a predecessor's note operation as its own.

Archiving is the only ordinary mutation. It advances version 1 to 2 and writes
separate archive actor/attempt/operation fields plus an append-only event; the
original creation receipt is never overwritten. Note text is immutable.

## Deployment and deferred work

Migration `0239_task_tree_notes.sql` is rolling and additive. It does not
activate organization or personal cross-workspace reads, change goal behavior,
inject prompt context, or replace any Knowledge, policy, preference, Memory, or
learning authority.

Still required for the complete write-router architecture:

- durable agent-learning routing and promotion;
- an explicitly reviewed API/tool surface for the governed proposal contract;
- bounded expiry cleanup and user-facing Advanced/search/export surfaces.

Canonical implementation: `packages/contracts/src/task-notes.ts`,
`packages/db/src/task-notes-schema.ts`, `packages/db/src/task-notes.ts`,
`packages/db/drizzle/0239_task_tree_notes.sql`, and
`apps/api/src/mcp/server.ts` for task notes; and
`packages/contracts/src/company-brain-governed-writes.ts`,
`packages/db/src/company-brain-governed-writes.ts`,
`packages/core/src/domain/company-brain-governed-writes.ts`, plus migration
`0255_company_brain_governed_write_proposals.sql` for governed proposals.
