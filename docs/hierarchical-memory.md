# Hierarchical memory foundation

This document is the canonical current contract for the database/domain
foundation beneath composable workspace knowledge memory. The first slice is
storage and governance only: it adds typed scopes, namespaces, labels,
relationships, lifecycle evidence, deterministic apply/revert operations, and
FORCE-RLS enforcement. It does **not** add or change HTTP, SDK, MCP, worker
retrieval/injection, prompt composition, automatic learning, or UI behavior.

## Data model

`knowledge_memories` remains the canonical memory row. Migration
`0152_hierarchical_memory_foundation.sql` adds:

- one typed scope selector: `workspace`, `user`, `role`, `session`,
  `ephemeral`, or fail-closed `legacy`;
- a normalized hierarchical `namespace_key` such as
  `engineering/backend`;
- sorted, unique normalized labels, which are relevance hints and never an
  authorization boundary;
- a positive `memory_version` used as the lifecycle compare-and-swap fence;
- immutable creator kind, subject/service identifier, and bounded structural
  context.

The old `scope` column remains a compatibility projection. Existing rows whose
scope is exactly `workspace` retain workspace visibility. Any other historical
scope becomes `legacy`; the migration never guesses a user, role, session, or
human creator from session ownership, source metadata, or free-form text.

Exact visible-text deduplication is local to the full typed target plus
namespace. Identical text may therefore exist independently for different
users, roles, sessions, or namespaces without colliding.

## Scope authorization

Every row remains fenced first by exact `account_id` and `workspace_id`.
Additional selectors are composable relevance/visibility boundaries:

| Scope | Required runtime context |
| --- | --- |
| `workspace` | Exact account and workspace only. |
| `user` | Exact authenticated subject id. |
| `role` | Exact normalized role key derived from persisted session metadata. |
| `session` | Exact session id. |
| `ephemeral` | Exact session id and an unexpired validity window. |
| `legacy` | Never visible to the ordinary runtime role; database-owner audit only. |

Missing or malformed subject, role, session, or expiry context evaluates to
false, not unknown/allow. The ordinary runtime role cannot self-assert an admin
override. `knowledge_memories`, `knowledge_memory_relationships`, and
`knowledge_memory_lifecycle_events` all use ENABLE + FORCE RLS.

Relationships are visible only when both endpoint memories are visible to the
current context. Lifecycle events are visible only to their exact immutable
actor within the exact account/workspace; database owners retain their normal
operator audit access outside the runtime role.

## Authority and provenance

Governance operations accept one of three transaction-pinned authority forms:

1. a direct authenticated subject;
2. a direct named service, with no human subject context;
3. the exact current session/turn/attempt/execution generation.

Exact-attempt authority is revalidated under row locks against the session's
active turn, the turn's active attempt and immutable initiator, the attempt
state/generation, and any unsettled interruption. The optional role key is read
from canonical persisted `sessions.metadata.memoryRoleKey`; a caller cannot
supply it independently. A stale attempt or non-canonical persisted role fails
closed.

Creator authority on memory rows is derived at insert time and is immutable.
Legacy writers that do not establish actor authority are recorded explicitly
as service/unattributed legacy writers. Creator context is structural and
allowlisted; arbitrary metadata and secrets are discarded rather than copied
into provenance. The pre-existing nullable `created_by_session_id` is only an
auxiliary legacy correlation: its foreign key may clear it when that session is
deleted, without changing the immutable creator kind, identifier, or context.

## Relationships

`knowledge_memory_relationships` stores typed, workspace-qualified edges:

- `derived_from`
- `supersedes`
- `corrects`
- `conflicts_with`
- `related_to`
- `depends_on`
- `applies_to`

`conflicts_with` and `related_to` are symmetric and use canonical UUID endpoint
ordering. The other types are directed. Supersession/correction edges point
from the replacement memory to the retired memory. Edges are never deleted;
removal and revert set or clear immutable-event references and increment the
edge version.

## Deterministic lifecycle

The domain layer normalizes each operation plan and computes a stable SHA-256
plan hash. PostgreSQL independently renders the structural JSON with the same
canonical key/array ordering and rejects a caller-supplied hash that does not
match before any mutation. The database exposes two target-schema-local
SECURITY DEFINER functions:

- `knowledge_memory_apply_operation`
- `knowledge_memory_revert_operation`

Supported apply operations are `reclassify`, `archive`, `relationship_add`,
`relationship_remove`, `supersede`, and `correct`. Memory-changing operations
use expected `memory_version` values and row locks. Symmetric relationship
normalization also swaps the matching expected endpoint versions so the CAS
fence follows the canonical endpoint identity.

An operation id is idempotent only for the same plan hash and immutable actor.
Attempt-bound retries must also match the exact session, turn, attempt, and
execution generation. A revert has its own operation id, references one apply
event, requires the same actor, and succeeds only while the post-apply
memory/edge versions and edge state still match. Revert appends new evidence
and restores state; it never edits the apply event.

Lifecycle events contain structural state only: statuses, typed selectors,
namespace, labels, versions, validity timestamps, supersession ids, and edge
state. Memory text, source references, metadata, and embeddings are excluded.
Lifecycle events are append-only, while relationship identity and creation
evidence are immutable.

## Deployment boundary

Migration 0152 is a maintenance cutover. All `opengeni_app` API/control/turn
sessions must be stopped before activation, and no pre-0152 writer may restart
afterward. The cutover replaces the old workspace-global visible-text unique
index with the typed-scope-local index; old writers neither understand the new
selectors nor recognize the replacement constraint name.

## Explicitly later slices

This foundation intentionally leaves these surfaces unchanged:

- HTTP, SDK, MCP, and UI contracts;
- worker retrieval, ranking, injection, and prompt composition;
- automatic learning/activation;
- release and deployment execution.

Workspace Memory V1 continues to own existing agent retrieval/write surfaces
until a later contract/runtime slice adopts typed selectors. The structured
preference registry remains the only active preference authority, and workspace
instruction policies remain the only charter/policy authority. A
`knowledge_memories.kind = preference` row is legacy knowledge observation, not
a preference-registry record or instruction-policy activation.

Canonical source anchors:

- `packages/db/drizzle/0152_hierarchical_memory_foundation.sql`
- `packages/db/src/memory-domain.ts`
- `packages/db/src/memory-governance.ts`
- `packages/db/src/memory-governance-schema.ts`
- `packages/db/src/runtime-posture.ts`
