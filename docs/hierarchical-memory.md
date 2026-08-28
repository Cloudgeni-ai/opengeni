# Hierarchical memory foundation

This document is the canonical current contract for the database/domain
foundation beneath composable workspace knowledge memory. The storage slice
adds typed scopes, namespaces, labels, relationships, lifecycle evidence,
deterministic apply/revert operations, and FORCE-RLS enforcement. A later
reversible containment slice changes only how the legacy V1 surface contributes
to model context; it does not adopt the final scoped selector or write router.

## Agent Knowledge routing contract

Agent Knowledge is not one generic storage destination. Agents and user-facing
creation flows apply these boundaries:

- a specific fact, decision, incident, bug fix, or confirmed outcome uses
  `memory_save` whenever workspace Memory is enabled. The exact live agent
  attempt writes it immediately as an active `knowledge_memories` record,
  independently of workspace Learning mode, and future agents can find it
  through `memory_search` and the Memory UI;
- reusable conditional how-to guidance belongs in a Skill backed by the
  structured preference authority;
- an unconditional rule that every agent must follow belongs in Workspace
  instructions and should use the minimum wording that fully states the rule.

The same material should not be copied across these authorities. A Workspace
instruction may tell agents to search for related incidents, while the incident
itself remains Memory and the reusable investigation method remains a Skill.
`memory_save` and `memory_correct` are agent-only autonomous tools exposed only
when workspace Memory is enabled. They do not activate a Skill, instruction,
company profile, or reviewed Knowledge claim. `remember lane=knowledge` remains
the narrower reviewed fallback when autonomous Memory is unavailable and a user
explicitly requests reviewed workspace knowledge; its confirmation-to-Memory
receipt preserves exact approved text and provenance.

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

| Scope       | Required runtime context                                               |
| ----------- | ---------------------------------------------------------------------- |
| `workspace` | Exact account and workspace only.                                      |
| `user`      | Exact authenticated subject id.                                        |
| `role`      | Exact normalized role key derived from persisted session metadata.     |
| `session`   | Exact session id.                                                      |
| `ephemeral` | Exact session id and an unexpired validity window.                     |
| `legacy`    | Never visible to the ordinary runtime role; database-owner audit only. |

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

## V1 compatibility and reversible containment

The typed foundation still leaves these surfaces for later slices:

- typed-selector adoption in HTTP, SDK, MCP, and UI contracts;
- typed-selector-aware worker retrieval and ranking;
- automatic learning/activation;
- release and deployment execution.

Workspace Memory V1 continues to own the existing data, correction, export, and
write surfaces until a later contract/runtime slice adopts typed selectors. The
workspace setting `memoryPromptMode` controls how that store reaches the
model:

- composition is always `retrieval_only`: no standing pinned/recency block is
  injected into any agent prompt. An agent reads the store through
  `memory_search` when it needs it, rather than receiving it unbidden;
- durable agent Memory writes go directly through `memory_save` and
  `memory_correct` whenever `memoryEnabled` is true. These exact-attempt writes
  are always autonomous and do not consult the workspace Learning mode;
  `memory_search` remains the retrieval path.
  Agent-authored durable text is bounded by the destination it lands in, on every
  surface that reaches it including task-note promotion: 600 characters for a
  mandatory workspace rule (composed verbatim into the prompt of every session it
  applies to), 1,200 for a preference (only its short descriptor is composed, so
  that length is retrieval cost), and 4,000 for a Knowledge fact (retrieval
  evidence only). Write one imperative statement in 1-3 sentences with no numbered
  procedure, and keep procedure in a Document or Skill the entry references. See
  [`company-brain-write-routing.md`](company-brain-write-routing.md) and
  [`workspace-instruction-policies.md`](workspace-instruction-policies.md);
- first-party agent `memory_search` excludes legacy `kind = preference` rows,
  while authorized human search, audit, correction, export, and the canonical
  rows remain unchanged;
- child sessions omit the company profile from governance composition, but
  roots retain it and all children retain mandatory instruction policy plus
  always-visible structured preference and Skill descriptors.

The setting remains in the workspace settings JSON with the single value
`retrieval_only`. The former `legacy_standing` opt-out is retired: a workspace
that stored it keeps the stored value in its passthrough settings bag, where it
no longer means anything, and already accepted turns keep the mode they
recorded because those snapshots are immutable facts about what was composed.
Agent prompts no longer read `knowledge_memories` unbidden; the rows are
unchanged and still reachable through search. It does not
create session notes, select typed scopes, change memory writes, or activate
observations as policy. The structured preference registry remains the only
active preference authority, and workspace instruction policies remain the only
charter/policy authority. A `knowledge_memories.kind = preference` row is legacy
knowledge observation, not a preference-registry record or instruction-policy
activation.

Migration 0259 freezes `memoryEnabled`, `memoryPromptMode`, and legacy workspace
instructions when a logical turn is accepted. Instructions live only in a
bounded immutable turn-context snapshot, with original UTF-8 byte count and an
explicit truncation marker when a legacy value exceeds the bound. A pre-migration
turn receives an explicit `legacy_first_claim` snapshot because acceptance-time
truth is no longer reconstructable.

The first exact attempt then creates one content-free Company Brain selection
receipt that binds the snapshot, root/child role, company-profile inclusion,
existing governance hashes, and at most 50 legacy workspace-Memory candidate
references in pinned/recency order. It separately freezes the whole-entry subset
that fit the original prompt budget. References contain identity, version, and
hashes, never memory or instruction text. A replacement attempt cannot admit a
newer or originally budget-omitted row, and rechecks current scope, lifecycle,
validity, version, pinned state, and exact content hashes before loading each
rendered candidate. Revocation or drift can therefore only shrink recovery
context. Normalized Knowledge and Task notes stay explicit tool reads and are not
automatic prompt candidates.

Human inspection is a separate read-only surface. Migration 0266 projects a
bounded page of content-free receipt facts, or the receipt for a supplied
attempt's already-accepted logical turn, only when the authenticated subject is
that turn's frozen initiating human and both the session and root remain
visible. It cannot call the 0259 get-or-create path, return memory identities or
bodies, or grant direct table access. A recovery attempt therefore resolves the
original logical-turn receipt without becoming authority to create or widen it.

At ordinary and provider-backed compaction model-request boundaries, the worker
also emits content-free, exact-attempt contribution telemetry for mandatory
rules, guide/Skill descriptors, company profile, and the legacy standing block
when present. The structured log carries the selection receipt id, exact attempt,
already-durable policy, preference, and company-profile snapshot ids, root/child
role, inclusion reason, authority class, UTF-8 bytes, and an estimated token
count. Prometheus receives only bounded category/source/reason/scope/role/mode
labels and token estimates. No memory or preference content enters either
receipt or telemetry.

Canonical source anchors:

- `packages/db/drizzle/0152_hierarchical_memory_foundation.sql`
- `packages/db/src/memory-domain.ts`
- `packages/db/src/memory-governance.ts`
- `packages/db/src/memory-governance-schema.ts`
- `packages/db/src/company-brain-context-selection.ts`
- `packages/db/drizzle/0259_company_brain_context_selection_receipts.sql`
- `packages/db/drizzle/0266_company_brain_context_receipt_inspection.sql`
- `packages/db/src/runtime-posture.ts`
