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

Migration 0157 projects this same authority tuple onto `documents` and
`document_chunks`. Legacy workspace documents deterministically remain
workspace authority. Legacy private documents become personal authority bound
to their original workspace and existing creator; migration 0126 already
rejects an empty private creator, so ambiguous rows never widen. New document
and chunk authority is immutable, chunks copy the exact parent tuple, and the
runtime-role FORCE-RLS policy calls the same
`scoped_knowledge_scope_visible` predicate before any document search ranking.
The older `visibility` field remains only as a compatibility projection
(`personal` → `private`, organization/workspace → `workspace`).

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
change proposal cannot activate a workspace instruction-policy head, create a
preference registry head, or write an active `knowledge_memories` row. A later
authorized human flow may materialize a proposal through the existing policy or
preference lifecycle, retaining the proposal UUID as provenance.

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
