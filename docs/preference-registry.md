# Structured preference registry

The preference registry is an additive backend governance store for stable,
skill-like preferences at organization, workspace, and personal scope. It is
deliberately separate from:

- Documents/RAG and imported source content;
- `knowledge_memories` and its retrieval/ranking lifecycle;
- Skills content, materialization, activation, or editing;
- workspace instruction-policy charters and their separate authority;
- model, tool, connector, or prompt-composition policy.

The registry provides storage, service operations, HTTP and first-party MCP
retrieval, SDK types, and isolation guarantees. Migration
`0156_session_policy_role_snapshots.sql` now invokes its exact-attempt snapshot
at runtime and composes only bounded descriptors with workspace policy. Full
content remains on-demand. This adds no UI, connector, source/fact schema, or
parallel preference authority.

## Scope and identity

Each preference has one stable key unique within its exact target. The same
semantic key may be layered at all three tiers:

- **organization** maps to the existing managed account that owns the current
  workspace;
- **workspace** targets one workspace in that account;
- **user** targets one subject in that account and is self-only at human API
  ingress.

Organization writes require the literal `account:admin` permission on the
unique authenticated account grant matching the workspace grant's account and
subject; workspace permissions never substitute for that account authority.
Workspace writes require `workspace:admin`. Personal writes derive the target
from the authenticated human and accept no caller-selected subject. A scope change
requires authorization for both the old and new scopes and advances a
compare-and-swap scope version. Every lifecycle request carries the expected
scope version. The database locks the visible head first, runs route scope
authorization while that lock is held, and rejects a stale version before
creating a revision or event.

Model-facing reads are stricter than ordinary human list/get reads. Summary and
full-content operations require an exact signed session, turn, attempt, and
execution generation. Direct human turns derive the personal subject from the
immutable accepted initiator. Trusted goal continuations and compactions retain
a service initiator but freeze the causal turn's human in the separate immutable
`session_turns.initiating_human_subject_id` field. A worker, service principal,
delegated-token subject, membership role, session creator, or mutable grant
subject can never substitute its identity. Service-only work with no causal
human fails closed to no preference snapshot.
Authority resolution and snapshot/list/detail/full-content access share one
transaction. Ordered workspace, session, turn, and attempt locks revalidate the
exact account, workspace, session pointer, turn pointer, attempt state,
attempt/turn/request generations, interruption state, and initiating human.
Attempt replacement therefore either waits for an authorized read to finish or
causes the stale read to fail; an existing snapshot never revives stale worker
authority.

## Immutable revisions and lifecycle

Migration `0137_preference_registry.sql` adds four dedicated FORCE-RLS tables:

- `preference_registry_preferences` holds stable identity, target, status,
  active revision/hash, scope version, and activation version;
- `preference_registry_revisions` is immutable content and metadata history;
- `preference_registry_events` is immutable lifecycle audit history;
- `preference_registry_snapshots` freezes the descriptors visible to one exact
  accepted attempt and initiating human.

Every proposal begins inactive with status `proposed`; creating a proposal can
never activate it. Immutable revisions contain the bounded title, bounded plain
descriptor, full content, server-verified SHA-256, typed precedence/conflict
metadata, provenance/trust, optional expiry, correction linkage, and actor/time
evidence. Mutable heads store the exact active revision number, ID, and hash.

The audited lifecycle supports proposal creation, activation, correction,
deactivation, rejection, supersession, scope change, and expiry. Activation,
correction, deactivation, and supersession use both active-head and scope-version
compare-and-swap; activation and rejection also require the expected scope
version, while scope changes lock and compare the existing head. Corrections append a new
revision and retain the corrected revision. Rejected and superseded records are
terminal. Expiry is derived at read time: expired heads remain historical truth
but do not produce descriptors.

All governance mutations require a positively identified `human_session`
principal. Delegated bearer principal kind is a mandatory immutable HMAC-signed
claim; agent-attempt, service, API-key, configured-key, and missing principal
kinds fail closed even when their permission strings would otherwise be
sufficient. Mixed or mismatched authenticated subject/account contexts also
fail closed. Organization authorization uses the matching account grant rather
than copying `account:admin` into workspace permissions. The verified kind is
propagated into the database transaction and rechecked by the lifecycle
function. Each successful transition
records the actor, bounded reason, old/new revision or target, related
preference where applicable, and monotonic event version.

Ordinary runtime SQL cannot update or delete a preference head, insert
lifecycle events, or insert snapshots. Three target-schema-local
security-definer functions own canonical head locking, lifecycle application,
and snapshot creation. They derive authority
from transaction-local RLS context, lock related heads in UUID order, repeat the
scope/revision CAS checks, perform only the operation-specific transition, and
append its complete event atomically. A deferred constraint requires every new
proposal head to have its exact version-1 creation event before commit.
Supersession locks both heads and rejects a replacement whose active immutable
revision is expired at transaction time, leaving the source and event history
unchanged.
Revisions, events, snapshots, heads, and their account/workspace/session/turn/
attempt parents use restrictive deletion semantics; parent deletion cannot
erase registry history.

## Imported material is proposal-only

Knowledge, imported documents, Slack messages, meeting transcripts, and call
transcripts are evidence sources, not preference authority. They may create
only inactive proposals with a required provenance source ID and
`untrusted_proposal` trust. Neither ingestion nor a connector/service identity
can activate a preference or change its scope. A separately authorized human
must review and activate the exact immutable revision, producing audit evidence.

This registry does not ingest source content and does not define connector or
source/fact schemas. Those systems can call proposal creation later, but cannot
bypass proposal status or human activation.

## Deterministic descriptors and authorized full content

An applicable active revision exposes only a sanitized descriptor containing
stable identity, bounded title and description, scope, active version, exact
revision/hash, typed precedence/conflict and provenance metadata, expiry, and a
retrieval handle. Descriptor text strips controls, invisible formatting, line
breaks, and prompt-like delimiter characters into one deterministic plain line.
Full preference content is never embedded in a descriptor.

Descriptor snapshots are deterministic and bounded to 64 entries and 16 KiB of
canonical UTF-8 JSON. Ordering is organization, workspace, user; precedence
rank descending within a tier; then stable key and preference ID by code-point
order. If either bound is reached, the snapshot records `truncated=true`.
The narrow snapshot function locks exact attempt authority, derives the
initiating human, complete descriptor array, hash, truncation flag, and
transaction timestamp, and validates an existing immutable race winner. The
caller cannot supply any of those canonical fields.

The retrieval handle binds the exact preference, immutable revision, and
content hash. Full-content retrieval succeeds only when the exact handle exists
in the exact attempt snapshot and the revision still matches all three values.
A later correction, deactivation, expiry, or scope change cannot rewrite that
snapshot or redirect its handle. Runtime reconstructs active state from the
immutable lifecycle ledger at the logical turn's acceptance timestamp, so a
turn queued before a later activation/deactivation retains its accepted
descriptor set. Recovery attempts replay that same boundary. A new human turn,
continuation, or compaction gets a new boundary and the then-current state.

## Runtime composition

The worker creates or replays the preference snapshot immediately after the
exact attempt claim, before credit admission, provider allocation, compaction,
or model work. The runtime renders descriptors only, ordered organization then
workspace then immutable initiating user, and interleaves them with charter and
policy in the precedence documented in
[`workspace-instruction-policies.md`](workspace-instruction-policies.md).
Descriptor count and canonical JSON remain bounded to 64 entries and 16 KiB;
the combined governance prompt has its own 131,072-byte fail-closed limit.

The same descriptor snapshot and retrieval handles are used by normal turns,
goal continuations, and compaction. The exact handle remains authorized only
for its session/turn/attempt/generation and initiating human. Automatic prompt
composition never retrieves or embeds the full preference body.

## API, MCP, and SDK boundaries

Human governance routes are below
`/v1/workspaces/:workspaceId/preferences`. List/get operations require
`workspace:read` and expose only organization, current-workspace, and current
personal rows. Proposal and lifecycle operations apply the scope authorization
rules above.
Derived active/expired predicates execute in the joined SQL query before
deterministic ordering and `LIMIT`, so bounded status pages cannot be emptied by
expired rows that sort earlier.

The summary and full-content routes require exact attempt authority. The same
restriction applies to the first-party MCP tools
`preference_registry_summary` and `preference_registry_get`. They are registered
only when complete signed attempt metadata exists and are not registered on the
Toolspace surface. `@opengeni/sdk` exposes the corresponding governance and
retrieval contracts without introducing a second editor or content system.

## Isolation and canonical implementation

All four tables carry account/workspace visibility keys, use ENABLE + FORCE RLS,
and are accessed through account/workspace/subject context wrappers. Ordinary
runtime DML is SELECT + INSERT for proposal heads and revisions and SELECT-only
for events and snapshots. Snapshot INSERT and head UPDATE/DELETE are available
only through their narrow security-definer functions. Database constraints, restrictive
foreign keys, and immutable-history triggers defend revision/hash, target,
active-head, snapshot, and audit integrity beneath the service layer.

Canonical implementation:

- `packages/contracts/src/preference-registry.ts`;
- `packages/db/src/preference-registry-schema.ts`;
- `packages/db/src/preference-registry.ts`;
- `packages/db/drizzle/0137_preference_registry.sql`;
- `packages/db/drizzle/0156_session_policy_role_snapshots.sql`;
- `apps/api/src/routes/preference-registry.ts`;
- `apps/api/src/mcp/server.ts`;
- `packages/sdk/src/preference-registry.ts`;
- `packages/runtime/src/workspace-governance.ts`;
- `apps/worker/src/activities/agent-turn.ts`.