# Knowledge and Agent learning

Knowledge is the durable retrieval system from maintenance migration **0459**.
It replaces agent Memory and the separate reviewed Knowledge authoring lane.
Conversation history and temporary task notes keep their existing jobs.

## Sources, records and storage

Agents encounter information through chat attachments, user messages, connected
systems such as Slack or Drive, repository tools, and ordinary scheduled work.
They retain useful source content or findings through the same Knowledge service.
A finding need not duplicate an excerpt as a second source entry: it can cite an
already retained source revision and a page, passage, message, or code location.

- **Original files:** immutable bytes in object storage, with `files` metadata and
  explicit workspace or personal ownership in Postgres. Attaching a file in a
  normal chat uses the same retained original as other upload paths.
- **Retained sources and findings:** `knowledge_entries` and exact immutable
  `knowledge_entry_revisions` in Postgres. Kinds are source, fact, decision,
  requirement, incident, note and group. Source metadata identifies the original
  file, connector, conversation or repository location when available.
- **Evidence and organization:** revision-pinned evidence and typed relationships
  in `knowledge_entry_links`. Groups are ordinary Knowledge entries; one record
  may belong to several groups. A group or relationship never grants access.
- **Publication and review:** immutable decisions and operation receipts. The
  current published revision and newest pending revision may coexist.
  `knowledge_review_batches` identifies changes from the same turn or scheduled
  run; counts include only currently accessible, reviewable revisions.
- **Search:** keyword and embedding projections are rebuildable caches. They own
  neither content nor publication. Apply scope and evidence access checks before
  matching, ranking, counts, excerpts and pagination.

Uploading retains the original. Source preparation extracts searchable content;
it does not invent company facts. In ordinary chats the accepted agent turn
prepares its uploaded sources, then retains useful findings as part of its work.
Off leaves the file available to the chat while refusing new agent Knowledge.
Document parsing and indexing are mechanical infrastructure. Configured Drive
and Atlassian sources are ordinary scheduled agent tasks: their exact source and
connection selection lives in `agentConfig.knowledgeSource` and is frozen in the
accepted run. The attempt-only `knowledge_source_fetch` tool transfers and
prepares source content with provider ACLs and durable checkpoints;
`knowledge_source_read` lists content changed in that run and reads bounded
passages. The agent selects findings and saves them with `knowledge_save`.
No separate ingestion workflow decides what the company should remember.

Review-first source content and findings belong to the same run's review batch.
The source tool may read that run's pending content so the agent can finish its
work; ordinary retrieval still excludes pending revisions. Source-job settlement
updates its checkpoint and summary, while the ordinary agent lifecycle owns task
completion. Each provider request, including retries, rechecks the live attempt,
current source selection and connection version. A source schedule requires its
connection owner's accepted human revision authority.

## Personal and shared Knowledge

Personal and workspace Knowledge use the same schema, tools, versioning and
review lifecycle. A verified initiating human owns a private chat's personal
Knowledge; a shared chat writes to its workspace. Personal retrieval can also
read authorized shared records. Shared agents do not ambient-load a person's
private Knowledge. Neither a subject label nor provenance metadata proves human
ownership. Tools use the exact live attempt; HTTP uses the full authenticated
access boundary. Legacy role, session and ephemeral selectors remain restrictive.

The original file, source entry, evidence and findings all retain their authority.
A shared finding cannot point at private evidence. The human UI offers **Copy text
to workspace** as an explicit, editable new entry. That action does not copy the
private graph, grant access to its original files, or keep the two entries synced.
Personal originals and Knowledge do not disappear just because their original
shared workspace is removed. Migration derives original-file ownership from typed
chat resources, document authority and generated-artifact session references.
If several private owners already used the same original, each keeps access;
unrelated workspace readers do not. An original already referenced by a shared
chat or document keeps its existing shared authority. Unbound historical files
retain their prior workspace ownership instead of guessing an owner.

## Agent learning settings

**Settings → Agent learning** groups three destinations together:

| Destination | New-workspace default | Storage authority |
| --- | --- | --- |
| Knowledge | Automatic | Knowledge entries and revisions |
| Workspace instructions | Review first | Native instruction revisions and active heads |
| Skills | Review first | Native Skill folders, revisions and lifecycle receipts |

Each destination supports **Automatic**, **Review first** and **Off**. These
control agent authoring and publication. Off does not remove existing Knowledge,
disable installed Skills, prevent a human edit, or forbid a human plugin install.
Organization identity keeps its separate organization-owner policy. External
message sending, tool approvals, secrets and other action permissions remain
separate from learning policy.

Workspace or personal defaults can be overridden per chat or scheduled task.
Overrides are sparse: selecting Inherit removes that category's override.
Settings list the active overrides in one place; chat options and a schedule's
collapsed advanced settings provide context shortcuts. New-chat choices are retained
in the composer draft and committed with the session before its first accepted
turn; a keyed creation retry cannot change the original choices or reset later
settings. A control must target the
same owner layer the task actually uses, otherwise the write is rejected.

`agent_learning_revisions` stores immutable policy history.
`agent_learning_snapshots` freezes the effective categories, owner and producer
context for an accepted logical turn. Scheduled work resolves against its accepted
run time. Child work and recovery preserve their accepted producer policy; changing
settings affects subsequent accepted work, not an already running turn.

Only-me chats in a shared workspace can be scheduled as existing-session targets.
A selected personal connector source creates an owner-only session for each run,
using its frozen owning-human revision authority and the existing private-create
capability. The normal organization setting for private chats still applies in
shared workspaces. The generated session is atomically bound to that exact run;
its audit creator remains the scheduler. Other private scheduled work uses the
existing private chat or a Personal workspace. Private file attachments require
verified owner access and a personal destination.

## Review and corrections

Automatic publishes an authorized write immediately. Review first stores an
inactive revision and returns a receipt; the agent continues without a chat
approval interruption. Pending revisions never enter normal agent retrieval.
A correction awaiting review leaves the previous published revision available.

The Knowledge browser groups pending changes by chat turn or scheduled run. A
human can inspect source evidence, approve, edit and approve, reject, or review a
selection of up to 100 exact revisions atomically. A complete loaded group of up
to 100 entries has an Approve all action; larger groups use selections. Approval
orders pending evidence before dependent findings. Stale versions conflict rather
than silently overwriting another correction. Undo creates a new revision and
keeps the original decision history. Instructions and Skills use their native
publication lifecycles in the adjacent review UI.

## Cutover and historical compatibility

0459 requires a stopped old runtime. Its owner-run conversion preserves exact
legacy Memory content and IDs, restrictive scopes, source versions, provenance,
relationships and lifecycle evidence. Resolved legacy sources and claims become
canonical source/finding/group records. Unresolved authority does not become a
shared record. Old Memory authoring and competing retrieval endpoints are retired;
old tables remain immutable historical evidence and compatibility references.

Legacy workspace learning mode maps to instruction/Skill defaults. Explicit
Memory opt-outs map to Knowledge Off. Historical per-record learning source
exceptions remain in the frozen old policy history: they are not new task/chat
policies. The old evidence-to-behavior proposal writers are retired. Configure any
future workflow exception on its chat or scheduled task in Agent learning.
Already accepted legacy confirmations still use their original immutable proof.

Pending native instruction proposals remain attached to their original inactive
revisions. Already answered exact instruction confirmations can recover once
through their original lifecycle. Old pending workspace preference proposals
become inactive Skill folder revisions linked to the unchanged original revision;
the converted folder needs normal Skill review, not the old text-only confirmation.

Workspace State and guidance OKF export use bounded canonical published metadata,
not old Memory counts. They are not full-content Knowledge exports. Original file
downloads and entry/history reads retain their ordinary permission checks.

## Code ownership

- Contracts: `packages/contracts/src/knowledge-entries.ts`, `agent-learning.ts`,
  `agent-instruction-changes.ts`.
- Persistence and lifecycle: `packages/db/drizzle/0459_unified_knowledge.sql`,
  `packages/db/src/knowledge-entries.ts`, `knowledge-migration.ts`,
  `knowledge-document-preparation.ts`, `knowledge-indexing.ts`.
- Host authority, source preparation and search: `packages/core/src/domain/knowledge*.ts`
  and `file-owner.ts`.
- API: `apps/api/src/routes/knowledge.ts`; first-party Knowledge tools and document
  adapters share the same service, not another write path.
- UI: `apps/web/src/components/knowledge/`; agent receipts:
  `packages/react/src/timeline/knowledge-receipt.tsx`.

The ongoing implementation/acceptance checklist is in
[`design/unified-knowledge.md`](design/unified-knowledge.md).

Generated originals retain the same private/workspace scope as chat uploads.
Video operations and screenshot cleanup preserve the accepted file owner so
background settlement and cleanup remain possible after a source session is
removed. These internal receipts grant no user or agent additional file access;
private video status and original downloads still require the verified owner.
