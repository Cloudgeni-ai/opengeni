# Scoped knowledge provenance foundation

This internal, provider-neutral persistence foundation records durable
source/version provenance and normalized claims. It is **not** a connector,
document API, second memory system, policy engine, or prompt-composition path.

Canonical implementation:

- contracts: `packages/contracts/src/scoped-knowledge.ts`
- Drizzle declarations: `packages/db/src/scoped-knowledge-schema.ts`
- repository/domain API: `packages/db/src/scoped-knowledge.ts`
- migration and PostgreSQL invariants:
  `packages/db/drizzle/0154_scoped_knowledge_foundation.sql`

## Authority boundaries

Three scope tuples are supported:

- `organization`: exact account; workspace and subject owners are null;
- `workspace`: exact account and current workspace; subject owner is null;
- `personal`: exact account and authenticated initiating subject, optionally
  anchored to the current workspace.

These are the only authority boundaries. Document bases and user-created
collections are optional organization only, never security scopes. Every
future upload or connector ingestion must choose exactly one of the three
authorities; the shared parsing/chunking/embedding pipeline does not create a
fourth authority.

Every new tenant table uses the existing transaction-local
`opengeni.account_id`, `opengeni.workspace_id`, and `opengeni.subject_id` GUCs.
All are `FORCE ROW LEVEL SECURITY`. Missing or wrong GUCs fail closed. A worker,
connector, MCP server, or service identity never substitutes for the initiating
human on personal reads or writes. Insert policies bind human provenance to the
current subject and allow service-only organization/workspace writes only when
no initiating subject is present. Composite account/workspace foreign keys
prevent cross-organization workspace anchors even for malformed direct SQL.

`documents.acl_tags` remain caller-supplied retrieval filters. They are not read
or stored by this foundation and confer no authorization.

Migration 0165 projects this same authority tuple onto `documents` and
`document_chunks`. Legacy workspace documents deterministically remain
workspace authority. Legacy private documents become personal authority bound
to their original workspace and existing creator; migration 0126 already
rejects an empty private creator, so ambiguous rows never widen. New document
and chunk authority is immutable, chunks copy the exact parent tuple, and the
runtime-role FORCE-RLS policy calls the same
`scoped_knowledge_scope_visible` predicate before any document search ranking.
The older `visibility` field remains only as a compatibility projection
(`personal` → `private`, organization/workspace → `workspace`).

Migration 0165 is a drained maintenance cutover. Stop every API and worker,
close all `document-index-*` Temporal workflows, and settle every queued/indexing
document before applying it; the migration rejects both live `opengeni_app`
sessions and an undrained document queue. After commit, only the new image may
run, and every newly created direct or Temporal indexing input must carry the
exact six-field document and authority identity. Rolling migration 0167 adds a
bounded compatibility path only for already-recorded three-field Temporal
history: before any document write, the worker resolves the stored immutable
authority tuple through an exact account/workspace RLS capability. Any supplied
authority tuple must be complete and exactly match that stored tuple; partial or
mismatched tuples reject before parsing, embedding, or chunk writes. Publishing
an organization-authority document requires an exact `account:admin` account
grant; workspace-admin permission expansion is not account-wide publication
authority.

## Source and lifecycle ledgers

The source side records:

- `knowledge_providers`: immutable provider/external-tenant identity;
- `knowledge_sources`: immutable external source identity plus current ACL,
  sync, and lifecycle generations;
- `knowledge_source_acl_versions`: append-only evidence-time ACL snapshots;
- `knowledge_sync_runs`: idempotent started/succeeded/failed sync receipts;
- `knowledge_source_objects`: stable external object identity and tombstone;
- `knowledge_document_versions`: immutable content/version observations;
- `knowledge_lifecycle_events`: append-only delete, revoke, restore, ACL, sync,
  and version-pointer evidence.

Mutable heads are not directly updateable by `opengeni_app`. Target-schema
security-definer functions lock the exact row, recheck live GUC authority,
apply expected-generation compare-and-swap, and append the lifecycle evidence in
the same transaction. Head triggers also require the active writer to be the
exact security-definer function owner, so a caller cannot forge the local
mutation GUCs even if table privileges are accidentally broadened. Runtime
privileges remain `SELECT, INSERT` for ordinary
foundation tables and `SELECT` only for lifecycle events; no new table grants
runtime `UPDATE` or `DELETE`.

Insert-time triggers also lock the referenced source/object and require the
next exact ACL, sync, or document-version generation. A direct insert cannot
reserve a future generation, start from a tombstone, or create a stale orphan
that blocks the canonical writer.

Deletion and revocation are tombstones. Ordinary upsert and stale generation
writers cannot reactivate them. Restore is an explicit lifecycle transition
that advances the generation; old versions and evidence remain immutable.

## Normalized knowledge

The normalized side records:

- typed entities and collision-safe aliases;
- canonical facts (subject, predicate, object hash);
- immutable explicit/inferred claims with confidence and effective time;
- append-only supersession/conflict links;
- append-only supporting/contradicting document-version evidence;
- append-only proposed/approved/rejected/revoked human review events;
- immutable policy/preference **proposals**.

Facts are identity, not authority. Claims are not directly model-visible. A
change proposal cannot activate a workspace instruction-policy head, create an
active preference registry head, or write an active `knowledge_memories` row.
The governed workspace write adapter may materialize it as an **inactive**
instruction-policy or preference proposal, retaining the proposal UUID as
provenance. A later separately authorized human flow must review and activate
the exact immutable destination revision through its existing lifecycle.

Documents, claims, and proposals remain RAG/governance evidence. None is
automatically composed into a system prompt.

## Eligibility is an ACL intersection

`listEligibleKnowledgeClaims` and `getEligibleKnowledgeClaim` use the same SQL
predicate. A claim is returned only when it is effective, unexpired, and its
latest review is approved; it has at least one supporting evidence row; and
**every** supporting path remains valid.

Each support path must retain an active provider, source, and object; an exact
immutable document version; a visible evidence-time ACL; and a visible current
source ACL. When bridged to existing Documents, the current document must still
be ready and visible to the initiating subject, and any chunk locator must still
match. Agent reads additionally require every ACL snapshot and current Document
to allow agent access.

The predicate is an intersection, never a union. Workspace evidence plus
private-A evidence is eligible only for A. Private-A plus private-B evidence is
eligible for nobody. Revocation, deletion, current ACL tightening, expiry, or
one agent-disabled support removes eligibility immediately while immutable
provenance remains stored.

No permissive eligibility cache is introduced. Semantic ranking, if added
later, must run only after this hard SQL filter.

## Internal API only

The package exports provider/source/ACL/sync/object/version lifecycle methods;
entity/fact/claim/evidence/review/proposal methods; and exact/list eligibility
reads. Every write carries an operation identity and deterministic input hash.
Every read carries account, workspace, exact initiating subject, and human vs
agent surface.

Natural-identity convergence is also durable. When distinct operation IDs race
to create the same provider, source, object, document version, entity, alias,
fact, or claim relation, `knowledge_operation_receipts` records every accepted
identity and its exact result. Replaying any accepted identity with different
input fails even when that identity did not win the underlying row insert.

Migration 0154 is maintenance-only because it expands the exact runtime-role
table and grant contract; old application sessions must be stopped for the
cutover.

This slice intentionally adds no HTTP route, public SDK method, MCP tool, UI,
connector, scheduled sweep, prompt injection, or automatic policy/preference
activation.

## Effective Document retrieval composition

The later Documents retrieval slice does not expose normalized claims or create
a second prompt/memory path. `searchEffectiveDocuments` composes only current
Document/chunk evidence authorized for the exact organization, requesting
workspace, and immutable initiating human. The public `/knowledge/search` route, SDK
`searchKnowledge`, and docs-MCP `knowledge_search` all use that same boundary;
the subject is derived from the authenticated grant rather than request/tool
input, authorization predicates run before vector/keyword ranking and limits,
and results retain source plus immutable authority provenance. Agent calls also
require `agent_access=true`. Migration 0258 activates common organization-user
authority for new personal Documents: their physical workspace remains the
immutable ingestion/indexing origin, but human discovery and management follow
the owner across that owner's currently accessible same-organization
workspaces. `GET /v1/workspaces/:workspaceId/documents` is the effective human
inventory; exact reads, reindex, filing, and deletion use the same authority
predicate while operating on the immutable origin rows. Document-scoped
original-file metadata and signed-download routes atomically resolve that
predicate, current owner authority, provider ACL, and the one immutable origin
file, without widening generic file access.
Configured/local
subjects without an eligible active organization membership and legacy private
rows keep the workspace binding established by migration 0165.

Migration 0338 adds the only supported authority-reclassification lifecycle for
those retained rows. It never guesses from a collection, creator other than the
original personal owner, origin workspace, or present-day access. A caller must
supply a UUID operation id and the exact current four-field authority tuple;
PostgreSQL locks that operation, rejects stale expected state, and writes one
immutable before/after receipt in the same transaction that changes the
Document and every chunk. Moving to or from organization authority requires an
opaque capability minted from the canonical exact `account:admin` grant; it is
bound to the command's account and actor but does not require the principal to
also have a managed `organization_memberships` row, so managed,
local/configured, and signed delegated account administrators retain the same
authority contract. A personal target is allowed only for the Document's
immutable creating subject. The route workspace authorizes the command but
never changes physical origin: an activated personal Document may be managed
from another currently accessible same-organization workspace even after origin
access is lost, while a workspace target must use (and therefore re-authorize)
the immutable origin-workspace route. Cross-organization routes fail closed.
Retries with the same logical input return the same receipt, conflicting reuse
fails, and a failed transaction leaves the old authority and provenance intact.
Receipt history is a scope-bound opaque-cursor page (default 50, maximum 100),
never an unbounded array. The collection remains non-authoritative.

The same migration supplies an account-admin-only, bounded Default-collection
backfill. A stable run id advances a workspace UUID cursor in batches, one
operation id makes each call replay-safe, and immutable per-workspace receipts
record whether an existing Default was adopted or a missing one was created.
This changes grouping only. It does not reclassify a Document or widen
retrieval, ranking, citation, or file access.

One run writes a receipt for **every** workspace in the account, so those
receipts - and the reclassification receipts - are workspace-owned evidence that
cascades with its workspace rather than pinning it. `deleteWorkspaceIfQuiescent`
relies on cascades and has no quiescence branch for these tables, so an
`ON DELETE RESTRICT` here would turn one administrator action into an untyped
Postgres error on `DELETE /v1/workspaces/:workspaceId` for every workspace in
the account. The row-level immutability trigger still refuses every direct
`UPDATE`/`DELETE`; only the referential cascade of an owning parent may remove a
receipt, and the run's aggregate counters are retained as the run-level history.

Both lifecycle routines run `SECURITY DEFINER`, so inside them `current_user` is
the schema owner - and `FORCE ROW LEVEL SECURITY` binds the owner too. Two rules
follow, and both fail **silently** when broken. First, the
`personal_document_authority_capabilities` window must be opened *before* the
`organization_memberships` read, or that read matches zero rows and the portable
personal-authority activation is skipped without an error. Second, that read must
carry **no** locking clause: PostgreSQL applies a relation's `UPDATE` policies to
any `SELECT ... FOR SHARE`/`FOR KEY SHARE`/`FOR UPDATE`, and every read policy on
`organization_memberships` is `FOR SELECT` only, so a locking read also returns
zero rows. The referential pin is taken by the
`organization_user_resource_authorities` foreign-key check instead, which bypasses
row security. See [`force-rls-migration-backfills.md`](force-rls-migration-backfills.md).

Personal Document ownership never becomes ambient agent authority. The exact
attempt-admission transaction freezes only Documents covered by a live
`document.read` once/session/always grant for the target workspace and exact
private/shared session context. Every subsequent retrieval revalidates that
snapshot and all membership, authority, grant, session-epoch, attempt, and
interruption fences. Missing attempt identity omits personal evidence, and
revocation fails closed before content is returned. The common grant lifecycle
requires explicit durable acknowledgement before personal content can be used
in a workspace-shared session. A legacy null-authority private Document remains
available to an agent only for the exact initiating subject in its origin
workspace; this compatibility lane cannot cross workspaces, while every
common-authority personal Document still requires the exact attempt snapshot.

The workspace-local agent projection builds on that boundary without another
store. Docs-MCP `knowledge_search` returns strict Knowledge envelopes over
authorized chunks, then re-fetches every selected chunk before response
projection. `knowledge_get` rechecks one stable Document/chunk id, while
`knowledge_browse` rechecks an authorized Document parent before returning its
chunks and binds its opaque cursor to the exact account, requesting workspace,
initiating subject, parent, and filters. Personal subject ids and inaccessible
linked-record metadata are absent from this projection; origin workspace, base,
and file ids also remain outside the Knowledge envelope. This changes neither
`knowledge_memories` nor the preference registry, company profile, instruction
policy, prompt composition, or governed learning/write routing. See
[`knowledge-retrieval.md`](knowledge-retrieval.md).
