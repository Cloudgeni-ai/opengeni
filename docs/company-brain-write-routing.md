# Durable context write routing

After maintenance migration 0461, [Knowledge and Agent learning](knowledge.md)
is the canonical durable retrieval and review contract. The former Memory,
reviewed-claim and evidence-to-behavior authoring routes are retired.

| Information | Destination | How agents use it |
| --- | --- | --- |
| Source text, facts, decisions, requirements, incidents and outcomes | Knowledge entries and immutable revisions | Search published entries; explicitly inspect pending proposals before updating the same entry with `knowledge_save` |
| Related information about a customer, product or system | Knowledge collections and relationships | Reuse collections across sources; membership does not copy content or grant access |
| Short unconditional rules | Workspace instruction revisions and active heads | Compose only the active rules; author through `instruction_policy_save` |
| Reusable conditional procedures | Native Skill folders and revisions | Load relevant published Skills; author through the Skill lifecycle |
| Organization identity and mission | Company profile | Separate organization-owner policy and lifecycle |
| Temporary coordination in a session tree | Task notes | Explicit read/save/replace; no automatic prompt composition |

Knowledge, instructions and Skills each use their accepted Agent learning policy:
Automatic publishes, Review first stages an inactive revision without pausing the
agent, and Off refuses agent authoring. A pending Knowledge entry is readable
with `view: "needs_review"` but is not accepted fact or instruction authority.
Evidence does not grant permission to change behavior. Human review publishes
through the destination's own lifecycle.

Preserve exact source references and uncertainty. Reuse the entry ID and current
version when correcting a finding. A reviewed source revision must be reconciled
explicitly when a pending finding still cites an older revision. Knowledge save
receipts survive a replacement attempt in the same logical turn, but the new
attempt must independently pass the live authority checks.

## Historical proof

Pre-0459 claim, proposal, learning-policy and confirmation rows remain immutable
migration and audit evidence. Already accepted legacy confirmations recover only
against their original exact proof. They are not alternative authoring routes.
See [the cutover](knowledge.md#cutover-and-historical-compatibility). Old migration
files and their fixtures preserve the historical contract; runtime guidance must
never direct agents to those retired writers.

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
