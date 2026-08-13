# Company Brain write routing

OpenGeni does not use one generic `memory_save` destination for every reusable
observation. Destination selects authority, visibility, lifetime, and review
semantics; content labels do not. This document records the target routing
model and the first implemented slice: root-task-tree coordination notes.

## Destination matrix

| Destination | Purpose | Authority | Model access | Current status |
| --- | --- | --- | --- | --- |
| Knowledge | Sourced company facts and evidence | Documents/scoped-knowledge authority | Permission-first `knowledge_search`/`get`/`browse`; never prompt-injected | Existing workspace-local read surface; governed write routing remains later work |
| Ways of working | Human-authoritative policy and preferences | Existing instruction-policy and preference-registry heads | Bounded descriptors by default; full bodies on demand | Existing authorities; no new writer in this slice |
| Task notes | Short-lived technical coordination inside one root session tree | Exact accepted turn/attempt plus root-session visibility | Explicit `task_notes_list`; never prompt-injected | Implemented by migration 0239 |
| Durable agent learning | Reusable technical knowledge beyond one task tree | Existing Memory/governed-learning authorities | Existing retrieval rules | Routing/promotion remains later work |

The router must preserve the selected destination's provenance and may propose
promotion, but it must not convert an agent observation into active company
policy or a preference. Personal and organization cross-workspace routing stay
inactive until their tenancy authorities are activated; workspace-local task
notes do not widen those scopes.

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

- governed Knowledge proposals/writes with source provenance;
- policy/preference proposal adapters that retain human activation authority;
- durable agent-learning routing and promotion;
- destination-choice receipts and learning-policy integration;
- bounded expiry cleanup and user-facing Advanced/search/export surfaces.

Canonical implementation: `packages/contracts/src/task-notes.ts`,
`packages/db/src/task-notes-schema.ts`, `packages/db/src/task-notes.ts`,
`packages/db/drizzle/0239_task_tree_notes.sql`, and
`apps/api/src/mcp/server.ts`.
