# Unified Knowledge and agent learning

Status: implemented in the unified Knowledge change, tracked by OPE-478.
Product decisions were agreed on 10 September 2026. The current runtime map and
cutover contract are in [Knowledge](../knowledge.md) and
[deployment](../deployment.md).

Delivery is one comprehensive PR. Implementation is staged within that PR, but
the cutover, migration, connected agent workflows, retrieval, review and settings
must be complete together before merge. A new unused storage or policy subsystem
is not an acceptable stopping point.

## Product contract

Knowledge replaces autonomous Memory and the separate reviewed Knowledge lane.
Agents retain source content and save facts, decisions, requirements, incidents,
and other useful information through one service. Source text and selected
knowledge have the same entry/revision structure. A source preserves the
original wording; a fact is information selected for reuse and can itself be
quoted or summarized. Findings are additional entries, not a mandatory second
extraction stage or a copy of every source paragraph.

Original file bytes remain in object storage, with file metadata in Postgres.
The canonical Knowledge entries, immutable revisions, evidence, group links,
relationships, review decisions, and write receipts live in Postgres. Search
chunks and embeddings are rebuildable projections of published revisions.

An ordinary chat upload is sufficient. It retains the original file; the accepted
agent turn prepares searchable source text without blocking message admission. Source
preparation and scheduled ingestion use ordinary agent work; they do not create
a second ingestion product. An agent may save useful facts while answering a
normal question, without requiring the user to say "remember this". Not every
document has facts worth retaining. Source preparation failure is visible and
retryable, and never relabels an unprocessed document as ready.

Groups such as Acme and Billing API collect references to entries. One incident
may belong to both groups without copying its content. Corrections preserve
revision history and refer to the exact prior revision. Organization or
reclassification changes use the same service and policy, including when a
scheduled agent proposes better grouping.

## Ownership and access

Personal and workspace Knowledge share all content and lifecycle capabilities.
Existing organization Knowledge remains supported during migration; an
organization authority is never inferred from workspace administration.

- A private chat writes to the authenticated initiating human's personal scope.
- A shared chat writes to its workspace scope.
- Personal retrieval can compose personal entries with authorized shared entries.
- A group is organizational structure, never an access grant.
- Evidence is an access dependency. A shared entry or group must not expose a
  private source, quotation, source title, or restricted relationship endpoint.
- Sharing is an explicit operation with authority and evidence checks. It is
  never inferred from a group's name or an autonomous learning setting.

Legacy role, session, ephemeral, or ambiguous scopes must retain their existing
restrictions during migration. They must not be silently mapped to workspace or
personal visibility. Exact content, IDs, creators, available provenance and
review history are preserved; missing historical evidence remains missing.

## One configuration surface

Settings > Agent learning owns a row for each category:

| Category | New-work default |
| --- | --- |
| Knowledge | Automatic |
| Workspace instructions | Review first |
| Skills | Review first |

Each row supports Automatic, Review first, and Off. Off prevents agent authoring
in that category, not retrieval/use of existing material or authorized human
management. Explicit existing opt-outs and configured behavioral defaults must
survive migration. These settings grant no external action or tenant authority.

Workspace and personal defaults are clearly scoped. Sparse overrides belong to
an ordinary chat or scheduled task. An explicit context override wins; removing
it selects Use default. A scheduled run inherits its task's accepted policy,
and recovery must not silently re-resolve it from a mutable setting. A child
inherits the effective producer policy unless an authorized user explicitly
changes its context setting. The model cannot approve its own proposals or
self-authorize a policy override from arbitrary source text.

The settings page lists editable defaults and context overrides. Contextual
shortcuts edit those same records:

- Scheduled task: collapsed Advanced > Agent learning.
- Chat: + > Chat settings > Agent learning, with no persistent composer toggle.

Knowledge, Instructions and Skills appear together in the browsing area while
their content and activation authorities remain distinct. The existing unified
Skill folder/revision lifecycle is reused.

## Review is publication, not a pause

Automatic publishes a valid authorized write immediately. Review first retains
an inactive entry or revision and returns a pending receipt to the agent. The
task continues. Its current chat can still read its own uploaded source and
answer the user. Future-task retrieval excludes pending content; if a previous
published revision exists, it remains current until approval.

Related pending writes are collected into one review batch per task/run. A
nonblocking chat card and Knowledge > Needs review show the same proposals.
Approve all, edit and approve, and reject operate on exact revisions. A stale
review cannot overwrite a newer correction. There is no second approval after
the review decision and no `requires_action` interruption for Knowledge saves.
Instruction and Skill proposals use their destination-native activation while
sharing the configuration and review presentation.

Automatic saves have compact saved-entry receipts with inspect, correct and
undo. Undo is a new revision or compensating lifecycle event, never deletion of
history. A rejected pending edit leaves published knowledge unchanged.

## Existing authorities to retain

- Conversation history remains protocol-preserving conversation truth.
- Task notes remain temporary agent coordination inside a task tree.
- Instructions remain bounded mandatory prompt authority.
- Skills remain reusable folders loaded when relevant.
- Organization identity retains its separate organization-owner authority.
- Files and provider credentials retain their existing access controls.

Task-note promotion enters the Knowledge service and uses the same scope,
policy, evidence, and revision rules as any other write.

## Delivery checklist

- [x] Shared entry, evidence, relationship, revision and policy contracts.
- [x] Canonical persistence, publication/review lifecycle, RLS and migration.
- [x] Accepted-context policy resolution across chats, schedules and recovery.
- [x] Agent save/correct/read/search tools and task-note promotion.
- [x] Source preparation from ordinary chat uploads and agent ingestion.
- [x] Unified retrieval and retirement of competing Memory writers.
- [x] Central settings, secondary context overrides and destination adapters.
- [x] Knowledge collections, source/file inspection and nonblocking review UI.
- [x] Migration/access/replay/concurrency and end-to-end acceptance tests.
- [x] Canonical architecture/docs updated to delivered behavior.

Acceptance includes the PDF plus Slack example: retain an original PDF and its
source text, save renewal terms and a product requirement, retain a Slack
incident update, and show linked entries under Acme and Billing API. Repeat in
private and shared chats, and with an automatic workspace default plus a
review-first scheduled task. Verify corrections, mixed-scope evidence denial,
pending replacement visibility, batch review, replay and undo.

## Implementation boundaries

Migration 0459 converts Memory, retained document content and scoped knowledge
into the canonical graph, preserves restrictive legacy scopes, and disables the
old authoring/retrieval paths. Historical inspection and exact pre-cutover
confirmation recovery remain; conversation history and task notes are separate.
This is a maintenance cutover: stop old API and workers, migrate and provision
roles, and start only the matching runtime. Do not restart an old binary.

Built-in Drive/Atlassian sources use ordinary scheduled agent turns. Their fetch
adapter retains originals/source text under the frozen policy; the agent selects
useful findings. Task lifecycle owns completion; source adapters own checkpoints.
Legacy source schedules keep their IDs and configuration. Those with no active
owning-human authority are preserved paused, and require a current authorized
edit. The change does not extend the managed scheduled-authority lifecycle to
unmanaged or local identities; ordinary MCP-based agent schedules remain ordinary
agent work.

Original files, generated images/video, screenshots and upload cleanup retain
personal ownership across retries and delayed completion. Immutable operation
ownership survives deletion of its original session. New-chat settings persist
in drafts and commit before the first accepted turn, with a separate immutable
creation identity so retries cannot reset later settings.

## Verification

Real PostgreSQL checks exercise maintenance conversion, FORCE RLS, exact-attempt
policy snapshots, source adapter convergence, private originals, publication and
review, replay, corrections, migration-era confirmations and cleanup. API/SDK
contracts and browser flows cover files/PDF preview, related records across
sources, review batches, edit-and-approve, rejection, restore, central defaults,
chat settings and schedule overrides. Provider responses in automated source
tests are controlled fixtures; no live paid model/provider run is claimed.

The full Mac suite exercised 15,252 tests: 15,128 passed, 69 skipped and 55 failed.
Failures were investigated individually: changed migration/retirement fixtures
were corrected; shared-process mock/DOM interference and timeouts pass in fresh
processes; Linux-only archive checks pass in the local Linux container. The
latest focused Knowledge suite passes all 52 tests. Workspace isolation,
TypeScript checks, lint and production build/bundle measurements are separate
acceptance checks. CI still needs to validate the immutable PR candidate.
