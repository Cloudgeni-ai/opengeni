# Knowledge and Agent learning

Knowledge is the durable retrieval system from maintenance migration **0461**.
It replaces agent Memory and the separate reviewed Knowledge authoring lane.
Conversation history and temporary task notes keep their existing jobs.

Knowledge is retrieval-only information, not the destination for persistent
behavior. Requests such as "keep replies concise in future sessions" belong in
workspace instructions or an applicable Skill, within the intended scope, rather
than a Knowledge fact about a preference. The always-present CORE teaches this
choice independently of existing governance. See
[durable context write routing](company-brain-write-routing.md#behavior-is-not-a-knowledge-fact)
for scope, mixed requests, and truthful save confirmations.

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
  neither content nor publication. Every chunk indexes its entry title; hybrid
  search includes graded lexical relevance before embeddings are available. Apply scope and evidence access checks before
  matching, ranking, counts, excerpts and pagination.

Uploading retains the original. Source preparation extracts searchable content;
it does not invent company facts. Ordinary chat attachments remain conversation resources; accepting a turn does
not parse or publish them into Knowledge. The agent first identifies useful
lasting information, then explicitly retains supporting evidence or a reusable
reference when warranted.
Off leaves the file available to the chat while refusing new agent Knowledge.
Document parsing and indexing are mechanical infrastructure. Configured Drive
and Atlassian sources are ordinary scheduled agent tasks: their exact source and
connection selection lives in `agentConfig.knowledgeSource` and is frozen in the
accepted run. The attempt-only `knowledge_source_fetch` tool transfers and
prepares source content with provider ACLs and durable checkpoints;
`knowledge_source_read` lists content changed in that run and reads bounded
passages. The agent selects findings and saves them with `knowledge_save`.
No separate ingestion workflow decides what the company should remember.

A failed vector-index batch keeps its last completed projection and the durable
queue retries it with backoff. The stored job reason stays the SQL lifecycle's
fixed `embedding_unavailable` code; the worker warning carries only the
content-free cause: `knowledge_index_embedding_failed` with the provider HTTP
status, `knowledge_index_persistence_failed` with the SQLSTATE when a
PostgreSQL error caused it, `knowledge_index_usage_limit_reached`, or
`knowledge_index_failed` for any other worker-side failure.

Review-first source content and findings belong to the same run's review batch.
The source tool may read that run's pending content so the agent can finish its
work; ordinary retrieval still excludes pending revisions. Source-job settlement
updates its checkpoint and summary, while the ordinary agent lifecycle owns task
completion. Each provider request, including retries, rechecks the live attempt,
current source selection and connection version. A source schedule requires its
connection owner's accepted human revision authority.


## Selective retention and discovery

A saved entry should help answer a plausible future question. Routine approvals,
acknowledgments, temporary task instructions and status chatter stay in the
conversation. Agents inspect screenshots visually and retain a supported
observation, requirement or incident when useful; an upload or successful OCR
extraction alone is not a reason to create Knowledge.

Source metadata distinguishes `purpose: "evidence"` from `purpose: "reference"`.
Supporting evidence preserves original messages, files and exact revisions but
is omitted from ordinary published listing/search before ranking and pagination.
Findings and deliberately retained reference documents remain discoverable.
Exact get, evidence traversal, Files-related inspection, history and review keep
their existing authority checks. Explicit `includeEvidence: true` searches or
the browser's **Include supporting evidence** control expose supporting sources.
Collection membership does not change source purpose or access.

Historical agent-prepared file sources and non-migrated conversation sources are
classified by typed preparation/provenance identity; migrated reference records
are preserved. No source body, original file, decision or evidence link is
rewritten or deleted. An explicit purpose on a new revision wins. Promoting an
existing source to a reference uses the ordinary versioned edit/review lifecycle;
retrying file preparation reuses the existing receipt and does not promote it.

`knowledge_retain_message` creates supporting evidence. `knowledge_retain_file`
defaults to supporting evidence and accepts `purpose: "reference"` for a
selected reusable source. Images retained as evidence preserve the original
without requiring OCR; their empty source text carries `retention: "reference"`.
Reference files still require nonempty extracted text. Opening a file source
shows its original preview first with extracted text collapsed below it.

### Preparing a save

`knowledge_prepare_save` and
`POST /v1/workspaces/:workspaceId/knowledge/entries/prepare-save` take a concise
`query` about the proposed information. The SDK exposes `prepareKnowledgeSave`
from `@opengeni/sdk/knowledge`. The operation requires a live agent with the selected tool, or a human Knowledge
reviewer, because it reads unapproved proposals. It writes nothing. It returns:

- a collection catalog with stable entry/revision IDs, current versions, scopes,
  names, descriptions, parent IDs and separate published/pending status;
- hybrid search matches across all authorized collections, separated into
  `published` and `needs_review`, with previews/excerpts and versioned IDs.

The normal catalog includes all authorized collections in one call, paging
internally rather than stopping at the first 20 results. Large catalogs explicitly
report `complete: false` and per-view continuation cursors; descriptions longer
than 2,000 characters report truncation and can be fetched through `knowledge_get`.
The bounded catalog is fetched when needed, never composed into every prompt.
Collection descriptions are reauthorized against their current published/pending
revision after listing. Every
continuation uses the existing context-bound database cursor.

The agent skips unchanged duplicates, reads and improves an existing entry when
appropriate, or creates a distinct useful entry and chooses existing collections.
Conflicting information stays qualified and evidence-linked; search similarity
alone is not permission to overwrite it. Pending matches are unapproved and
cannot become accepted answers. An unavailable prepare tool falls back to
ordinary search in both views and collection browsing, without widening the
task's selected tools or permissions.

### Model-visible discovery results

`knowledge_search` (first-party and Docs MCP) and `knowledge_prepare_save`
return the complete contract to every caller: HTTP, the SDK, Codemode scripts
and other programmatic callers receive the exact bytes. Only a model tool call
receives a compact copy, projected in the worker at the per-caller seam
(`projectAttemptToolResultForCaller` with
`packages/runtime/src/knowledge-model-projection.ts`), never in the API tool.
It is the same JSON without bookkeeping or repeated text:

- kept: entry and collection IDs, `version` (the `expectedVersion` for an
  update), `revision.id` (for evidence pins), scope, `revision.outcome` and
  collection `view`, titles, kinds, group and parent IDs, descriptions, excerpts
  with their offsets, index status, `complete`, and every pagination cursor;
- removed: timestamps, rank score, revision number and lineage, creating
  session and review batch, and a collection descriptor's `revisionId`;
- removed only when equal to the default or to another shown field:
  `archived: false`, `change: "upsert"`, `sourceKind: null`,
  `descriptionTruncated: false`, `revision.entryId` equal to `id`, and
  `publishedRevisionId`/`latestRevisionId` equal to `revision.id` (so a pending
  revision above the published one, or a missing published revision, stays
  visible);
- `revision.preview`, the first 512 characters of the content, is omitted only
  when it is empty or a content excerpt starting at offset 0 already begins with
  it. The title never counts, because a short content such as a decision's
  answer can appear inside its title and still be the only place it is stated.
  A preview with unique text, such as when the best excerpt is a later chunk or
  there is no excerpt, is kept in full. Every excerpt, including title
  excerpts, is kept. Nothing is truncated.

An error, structured content, or a result that does not strictly match the
contract passes through unchanged. The model call's history item and timeline
event record the compact copy the model received; past tool outputs are never
re-rendered. MCP transport bounds the exact result to 1 MiB before this
projection, so compaction only shrinks results that already fit; a result that
is still over 1 MiB for the model spills its exact bytes like any tool. On contract-valid fixtures sized to staging medians
(`packages/runtime/test/knowledge-model-projection.test.ts`), an eight-entry
search result shrinks from 17.9 KB to 10.0 KB (44%) and a save preparation
from 21.7 KB to 14.1 KB (35%).

## Personal and shared Knowledge

Personal and workspace Knowledge use the same schema, tools, versioning and
review lifecycle. A verified initiating human owns a private chat's personal
Knowledge; a shared chat writes to its workspace. Personal retrieval can also
read authorized shared records. Shared agents do not ambient-load a person's
private Knowledge. Neither a subject label nor provenance metadata proves human
ownership. Tools use the exact live attempt; HTTP uses the full authenticated
access boundary. Legacy role, session and ephemeral selectors remain restrictive.

The original file, source entry, evidence and findings all retain their authority.
A shared finding cannot point at private evidence. The human UI offers **Share with workspace** as an explicit, editable new entry. That action does not copy the
private graph, grant access to its original files, or keep the two entries synced.
Personal originals and Knowledge do not disappear just because their original
shared workspace is removed. Migration derives original-file ownership from typed
chat resources, document authority and generated-artifact session references.
If several private owners already used the same original, each keeps access;
unrelated workspace readers do not. An original already referenced by a shared
chat or document keeps its existing shared authority. Unbound historical files
retain their prior workspace ownership instead of guessing an owner.

## Browsing Knowledge

Agent Knowledge is one page with persistent **Knowledge**, **Files**,
**Instructions** and **Skills** tabs. Each tab has a URL under `/state`; historical
Memory and Documents links keep the same navigation. Files is a library of
original copies with one Upload action. Opening a file shows its preview, extracted
text and a link to related Knowledge. Readable source text stays attached to its
original and in canonical Knowledge; there is no competing Add text form.

The workspace navigation marks Agent Knowledge with an amber indicator while
accessible Knowledge proposals await review. That link opens Needs review directly.
The indicator refreshes after local decisions, on window focus, and every 30 seconds
while visible; a transient refresh failure preserves the last known pending state.

The Knowledge page uses a compact expandable tree. Collections appear as folders
with one-line descriptions; entries open their content and evidence on click.
Collections can nest and an entry can appear in several collections without
copying it. Collection menus provide details and creation within that collection.
Arrow keys navigate, expand and collapse folders. Search and review use compact
flat results so matching entries remain discoverable regardless of their parents.

The root list uses `rootOnly` before server pagination; each expanded collection
pages its direct members using `groupId`. A parent outside the selected scope,
archived parent, or inaccessible parent does not hide an accessible child from
the root. Published and outstanding pending membership edges are checked for
cycles under the publication lock, including at approval and restoration.
Detailed entry types remain in the optional filter and entry details. Manual
authoring starts with title and text. The UI calls groups **collections** and the
general `note` kind **General knowledge**. Collections organize entries without
granting access or becoming a separate storage authority.

Agents choose the closest type based on content: fact for a specific claim,
decision for an adopted choice, requirement for a need, incident for a problem
and its known cause/fix/outcome, or note for other useful context. A fact label is
not proof of verification. Agents are instructed to find and reuse existing
collections and entries across sources without asking users to classify content.
All finding types share retrieval, review, permissions and revision history.

## Agent learning settings

**Settings → Agent learning** groups three destinations together:

| Destination | New-workspace default | Storage authority |
| --- | --- | --- |
| Knowledge | Automatic | Knowledge entries and revisions |
| Workspace instructions | Automatic | Native instruction revisions and active heads |
| Skills | Automatic | Native Skill folders, revisions and lifecycle receipts |

These defaults apply when no saved workspace or personal policy exists. Saved
choices (including Review first and Off), context overrides, and accepted-turn
snapshots are unchanged; no existing policy is migrated.

Each destination supports **Automatic**, **Review first** and **Off**. These
control agent authoring and publication. Off does not remove existing Knowledge,
disable installed Skills, prevent a human edit, or forbid a human plugin install.
Organization identity keeps its separate organization-owner policy. External
message sending, tool approvals, secrets and other action permissions remain
separate from learning policy.

Workspace or personal defaults can be overridden per chat or scheduled task.
Overrides are sparse: selecting Inherit removes that category's override.
Settings list the active overrides in one place; chat options and a schedule's
collapsed advanced settings provide context shortcuts. Existing schedule
overrides are drafts until Save; Cancel discards them. Schedule and learning
changes commit together and restore together if scheduler synchronization fails. New-chat choices are retained
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
approval interruption. Pending revisions never enter normal agent retrieval. Agents can explicitly use
`view: "needs_review"` on search, browse and get to inspect accessible proposals
as unapproved context. They should search both views before creating entries or
collections, reuse IDs for corrections, and never treat pending content as an
accepted answer or instruction. Exact live-attempt and evidence access checks
still apply.
A correction awaiting review leaves the previous published revision available.

The Knowledge browser groups pending changes by chat turn or scheduled run. A
human opens the first proposal directly in the page, with All reviews returning
to the queue. A compact pending-item list stays beside the selected proposal,
so reviewers can scan the batch and switch items without leaving the review.
Review and its supporting entries stay in the page rather than a
modal. The reviewer sees changed text against the exact
published version, and approves or rejects it to move to the next change. Pending
prerequisites are shown first, even outside the loaded page. Sources and
collection placement are separated under Details, collapsed until requested;
following an evidence link keeps a Back path to
the proposal. History expands separately alongside Details, above entry
actions. Details is omitted when there is no supporting metadata. New entries show their proposed text, with long text expandable.
Workspace instruction review loads the current active instruction beside the
complete proposed revision before enabling approval. If that comparison cannot
be loaded, approval remains disabled. The activation ledger independently
rejects legacy or explicit agent replacements that would discard the active
instruction; reject those proposals and recreate them as an append or localized
edit. Editing Knowledge before approval and optional bulk selection remain available. A
selection of up to 100 exact revisions can be reviewed atomically. A complete
loaded group of up to 100 entries has an Approve all action; larger groups use
selections. Approval orders pending evidence before dependent findings. Rejected
initial entries remain discoverable in the Rejected view and can be restored as a
new revision. The Personal review filter includes only personal
Skills; workspace instruction proposals remain in workspace review.
Stale versions conflict rather
than silently overwriting another correction. Undo creates a new revision and
keeps the original decision history. Exact save retries within the same logical
turn recover the original operation receipt after worker replacement; changed
input or another logical turn conflicts. Instructions and Skills use their native
publication lifecycles in the adjacent review UI.

## Cutover and historical compatibility

0461 requires a stopped old runtime. Its owner-run conversion preserves exact
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
- Persistence and lifecycle: `packages/db/drizzle/0461_unified_knowledge.sql`,
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

Hybrid search treats plain multiword queries as alternatives for lexical recall while embedding the original query. This keeps relevant records discoverable when embeddings or vector indexing are unavailable. Explicit keyword queries and quoted/operator syntax keep their existing semantics. Agents should start with a concise entity name, search authorized scopes by default, and retry a key name or browse before claiming knowledge is absent.

### User confirmations as evidence

`knowledge_retain_message` retains the exact accepted user-message text from the calling conversation, using the same scope and frozen learning policy as other agent saves. Its source identity records the session and message event ID (`source.externalId`), plus the original timestamp. It defaults to the calling turn's user trigger; machine-triggered turns must select a real earlier user message. Foreign-session messages are refused. Repeated retention reuses the source without reviving rejected or archived content.

A finding cites that source's entry and revision in `evidence`, with the message ID in `location.messageIds`. Corrections preserve earlier evidence, including conflicting originals, so a user confirmation explains why a newer value wins. The retained source can be inspected from the finding, and links back to its conversation. Retention is evidence capture, not approval or a claim that every statement is true.
