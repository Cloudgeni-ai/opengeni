<!-- docs-refs: record -->

> **Point-in-time design record.** Baseline audited against `origin/main` at
> `a906a06881036b7d005ab33940f5ec6c91938482` on 2026-07-18; implementation
> checkpoint updated on the memory-design branch on 2026-07-19. Paths, names, and final
> merge status may move; code and migrations win.

# ADR: Labeled, hierarchical, role-aware memory

Status: implemented and rebased on the memory-design branch; pending exact-head CI, browser evidence, and independent review
Owners: memory-design (semantics/data contract); memory-design (responsive presentation)
Related: memory-design (product concept map), memory-design (capability discovery)

## Context

Workspace Memory V1 is useful and in production, but it is intentionally flat.
Every agent-visible record has `scope = "workspace"`; the standing context is
selected by pin plus update recency; and all non-episodic records compete for one
2,500-token block. This creates two opposing failure modes:

1. broadly useful learning is not targeted enough to the user, role, task, or
   session that needs it; and
2. role-specific operating instructions can be placed in shared context and reach
   agents for which they were never intended.

Memory is a plausible continuity mechanism across sessions and products. That does
**not** imply that OpenGeni needs a canonical durable `Agent` or profile object.
Existing user/workspace principals, sessions, session metadata, instructions,
tools, permissions, and policies are enough to test the product hypothesis first.

This ADR separates shipped primitives from new decisions, defines an additive
storage and wire contract, and constrains autonomous cleanup/learning to explicit,
audited operations.

## Audited baseline: shipped versus open

The baseline was reconciled from current source, merged PRs #16, #313 and #320,
production aggregates, and memory-design/memory-design/memory-design. Historical branches and sessions
were read-only.

| Area | Shipped at the audited SHA | Open before memory-design |
| --- | --- | --- |
| Storage | `knowledge_memories`; five kinds; six lifecycle states; source refs; confidence; session provenance; embeddings; pins; usage; validity window; supersession links; text hash | Typed/composable scope; labels; general relationships; creator subject for runtime user context |
| Isolation | Account/workspace composite ownership; `ENABLE` + `FORCE ROW LEVEL SECURITY`; `workspace_isolation` policy | Subject-level protection for user-scoped records; relationship/audit RLS; principal-persona tests |
| Writes | One sanitizing save gate; length/cap limits; secret-pattern redaction; exact and near dedup; correction/archive | Scope-safe writes; derived summaries; explicit audited maintenance; deterministic export and hard delete |
| Retrieval | Vector/keyword hybrid with fail-soft keyword fallback; scored result; usage counter | Applicability filtering; validity filtering; labels/task hints; scope/freshness/confidence/provenance components; conflict explanation |
| Standing context | Setting-gated; pinned then update recency; max 50 candidates; ~2,500 estimated tokens; episodic excluded | User/role/session targeting; shared-label admission; deterministic explanation; anti-flood policy |
| Product/API | Human list/get/create/edit/pin/archive/search; first-party `memory_search`, `memory_save`, `memory_correct`; timeline events and deep-link | Scope/label/provenance/relationship inspection; export/delete; maintenance preview/apply |
| Evidence | Real PostgreSQL RLS/search/dedup/concurrency/correction/cap/injection tests | Multi-subject scope isolation; conflict/correction/freshness; deletion/export/retention; ranking properties; browser evidence |

### Production snapshot

At the audit window, 115 rows existed across three workspaces in one account:
90 active, 24 superseded, one archived; every row was workspace-scoped; no row
had an embedding; only two returned-search uses had been recorded. Memory was
actively written and corrected, but standing injection—not explicit search—was
the dominant consumption path. The deployed API/web/worker/relay revision matched
the audited SHA. These values are a point-in-time observation, not a live SLO.

### memory-design implementation checkpoint

Implemented on the focused branch after the audited baseline:

- maintenance/drain-only migration `0095_hierarchical_role_aware_memory.sql` adds trusted session
  creator provenance, typed scopes, bounded labels, relationships, reversible
  maintenance operations, and text-free deletion/private-export audit tables;
  all five memory tables are FORCE RLS;
- DB applicability/ranking, bounded standing injection, atomic correction edges,
  deterministic export, hard delete, and hash/row-version-fenced maintenance are
  wired through REST, capability-first MCP tools, contracts, and the SDK;
- REST/MCP adapters bind user/role/session/actor selectors from signed grants and
  persisted session context, never caller-controlled identity fields; a worker
  bearer is only the transport principal, while the persisted session creator
  supplies private-memory subject and creator/actor attribution;
- workspace-qualified creator provenance replaces the old global session FK;
  reviewed `approved`/`rejected` states are created only by a row-locked
  `proposed` transition; and workspace-readable session events redact private
  memory call arguments/results and omit memory text/reason/source metadata;
- a fresh PostgreSQL 17 + pgvector 0.8.5 migration and non-owner role probe proved
  multi-subject RLS, role/session/ephemeral retrieval, symmetric edge identity,
  private export audit, deletion tombstone, maintenance apply/revert, creator
  inheritance, and exactly one concurrent correction winner; committed domain,
  API, DB integration, and SDK parity tests retain that coverage for CI.

Still open at this checkpoint:

- rebase onto current `origin/main`, exact-head CI, and independent Sol/xhigh
  privacy/product review;
- memory-design-owned `/memory` presentation and real desktop/mobile browser evidence
  against the additive SDK contract;
- policy-configured scheduling or autonomous consolidation beyond the explicit,
  audited primitives. No opaque background rewriting has been introduced;
- merge/release/production acceptance, owned by the root delivery lane and memory-design,
  not memory-design.

## Decisions

### 1. Keep `knowledge_memories`; do not create an Agent or graph database

memory-design evolves the existing PostgreSQL record. It does not add an `agents` table,
a durable profile identity, or an external graph store. Hierarchy is represented
with typed relationships between records. A summary is an ordinary memory with
`derived_from` edges to its sources, so provenance and rollback remain visible.

This decision is intentionally reversible. If concrete workflows later require a
first-class profile, the profile can select existing scopes; the memory model does
not need to be rewritten around it.

### 2. One typed scope per record; retrieval composes applicable scopes

Each record has exactly one scope. A retrieval context composes the union of
applicable records, rather than encoding arbitrary policy in a free-form string.

| `scope_type` | Required selector | Applicability | Standing-context behavior |
| --- | --- | --- | --- |
| `workspace` | none | Every session in the workspace | Unlabeled records are broadly shared. Labeled records require a matching task label. |
| `user` | `scope_subject_id` | Exact trusted creator/authenticated subject | Included only for that subject; absent subject context fails closed. |
| `role` | `scope_role_key` | Exact normalized session `metadata.role` | Included only for that role; role is relevance, never authorization. |
| `session` | `scope_session_id` | Exact session | Included only in that session. |
| `ephemeral` | `scope_session_id` and `valid_until` | Exact session before expiry | Included only in that session, excluded from default export, and eligible for explicit expiry cleanup. |
| `legacy` | existing free-form `scope` | Human audit only | Never injected or returned to agent search until explicitly reclassified. |

The legacy wire field `scope` remains. Existing `scope = "workspace"` rows backfill
to typed workspace scope. Any non-workspace legacy value backfills to `legacy`,
preventing an unknown historical convention from becoming broadly visible by
accident. New clients use additive `scopeSpec`; responses contain both fields.

Typed selectors are columns, not an opaque JSON policy:

- `scope_type text not null`
- `scope_subject_id text null`
- `scope_role_key text null`
- `scope_session_id uuid null`

A database check enforces the selector matrix. Session selectors use a composite
workspace/session foreign key. `valid_from < valid_until` is enforced when an end
exists.

#### Trusted user context

The first-party MCP principal is `worker:first-party-mcp`, not the human that
created the session. Session rows at the audited SHA do not persist their creator.
Therefore memory-design adds nullable, immutable `sessions.created_by_subject_id`:

- direct creation records `grant.subjectId`;
- child creation inherits the parent session's creator subject;
- system/scheduled and historical sessions remain null unless a trusted creator
  already exists;
- user-scope agent search, save, and injection fail closed when it is null.

For REST and the deprecated documents-MCP route, a signed session id is resolved
against the requested workspace before any memory operation. Missing or foreign
sessions fail with 403. The worker bearer subject never substitutes for the
persisted creator; a signed session without a creator fails closed for user writes,
while workspace writes remain valid. Sessionless human/API grants retain their
authenticated subject. Only the validated session id may become creator/actor
provenance, and the composite `(workspace_id, created_by_session_id)` foreign key
prevents a valid session from another tenant being attached to a memory.

The creator subject stays an internal runtime field; it need not be exposed in the
public `Session` response. Subject labels and arbitrary session metadata are never
used as identity.

#### Role and task context

`metadata.role` supplies an exact normalized role key. `metadata.memoryLabels`
supplies explicit task-label hints. Both are existing session composition inputs,
not new identity or authorization primitives. A missing/invalid value means no
role/task context. Role matching cannot grant permissions or cross an RLS boundary.

### 3. Labels are bounded normalized tags, not an implicit broadcast channel

Records gain `labels text[] not null default '{}'`, with a GIN index. Application
validation lowercases and trims labels, permits a conservative slug alphabet, and
caps label length/count. Labels select and explain relevance; they do not grant
access.

An unlabeled workspace memory means “broad shared default.” A labeled workspace
memory is search-visible but enters standing context only when one of the session's
explicit `memoryLabels` matches. This preserves broad shared learning without
injecting every specialized bucket into every agent.

### 4. Relationships provide hierarchy, provenance, and conflict without opaque rewriting

`knowledge_memory_relationships` stores workspace-local directed edges:

- `derived_from`: a source-to-summary provenance chain;
- `supersedes`: the replacement corrects/replaces the target;
- `contradicts`: unresolved disagreement that must be exposed;
- `related_to`: navigational association;
- `applies_to` and `depends_on`: explicit applicability/dependency evidence.

Composite foreign keys prevent cross-workspace edges. Duplicate directed edges are
unique. The table carries standard account/workspace FORCE-RLS columns and actor
provenance. Existing `supersedes_id`/`superseded_by_id` remain the compatibility
projection for V1 clients; correction writes the edge and projection in the same
outer transaction.

The system does not silently choose a winner for an unresolved `contradicts` edge.
Both live records remain retrievable with a conflict penalty and an explicit reason.
Correction/supersession is the deliberate operation that retires one side.

### 5. Retrieval is applicability-first, then explainable ranking

Retrieval first rejects records that are:

- outside account/workspace RLS;
- outside the trusted subject/role/session context;
- `legacy`, terminal, not yet valid, or expired; or
- label-inapplicable for the requested mode.

The text relevance component preserves V1 behavior:

```text
vector = 1 / (1 + cosine_distance)
keyword = ts_rank / (ts_rank + 1)
text = vector | keyword | min(1, .65*vector + .35*keyword + .10*both)
```

Applicable candidates then receive deterministic components in `[0, 1]`:

```text
scope:      ephemeral/session 1.00, user .95, role .90, workspace .75
labels:     1.00 exact task/query-label match, .50 no requested labels
freshness:  monotonic bounded decay from updated_at; pinned records stay at 1
confidence: stored confidence
provenance: bounded evidence signal from source refs / creator session
conflict:   .85 when a live contradiction remains unresolved, else 1

final = conflict * clamp(
  .55*text + .15*scope + .10*labels +
  .08*freshness + .08*confidence + .04*provenance
)
```

Exact weights are versioned constants and property-tested. Search results retain
V1 `score`, `matchType`, `vectorScore`, and `keywordScore`, and add component
scores plus short machine-stable reason codes. No memory text, label, subject,
query, or source title enters metrics/log labels.

Corrections rank correctly by construction: terminal predecessors never enter the
candidate set. Validity is evaluated against one caller-supplied/reference `now`
per operation so a result cannot straddle time during ranking.

### 6. Standing context remains small and deterministic

The existing hard limits remain: 50 candidates, whole-record selection, episodic
excluded, and an estimated 2,500-token block. Candidate admission changes to:

1. applicable session/ephemeral records;
2. applicable user records;
3. applicable role records;
4. workspace records that are unlabeled or match task labels.

Within that union, pin, scope affinity, label affinity, confidence, freshness,
provenance, update time, and UUID provide a total deterministic order. Rendering
groups records by existing kind sections and shows a compact scope/label hint only
where needed. A lower scope never overrides a higher scope; conflicting records are
marked, not blended. Oversized entries are skipped rather than truncating or
starving the remaining budget.

Memory remains system-level context before per-session instructions. Role targeting
prevents an orchestrator-only role record from entering a worker session; prompt
precedence remains defense-in-depth, not the isolation mechanism.

### 7. Lifecycle is explicit: validity, archive, retention, export, deletion

- `valid_from`/`valid_until` control agent visibility; human audit can include
  expired records explicitly.
- `archive` is reversible and preferred for correction/cleanup.
- `supersede` is an atomic correction with bidirectional compatibility links and
  a relationship edge.
- curated creation accepts only `proposed`; `approved` and `rejected` are
  update-only review outcomes, and the update locks the current row and rejects
  every source status other than `proposed`.
- `ephemeral` requires a bounded TTL and is excluded from default export.
- workspace settings may define terminal/expired retention windows. Retention is
  evaluated by an explicit preview; it never runs as an invisible LLM rewrite.
- deterministic JSON export sorts memories and relationships by stable keys and
  includes typed scope, labels, source refs, validity, lifecycle, and provenance.
  It excludes ephemeral rows unless explicitly requested.
- hard delete is a distinct, authorized, irreversible action. Relationships are
  severed by FK behavior; the audit tombstone retains ids/action/time but never
  deleted text or secret-bearing metadata.

User-scoped records are visible/exportable only to their exact subject by default.
An explicit workspace-admin private export is a separate audited mode. API-key and
delegated principals work without a membership row, matching the principal contract
in `docs/design/contract-decisions.md`.

### 8. Reconciliation, cleanup, and learning are audited capabilities

There is no ambient “dreaming” job that rewrites memory. Generic workflows use:

1. **preview**: return candidate ids, reasons, proposed edges/status changes, and a
   plan hash without mutation;
2. **apply**: require the exact plan hash/id set and record actor/session provenance;
3. **revert**: reverse archive/label/relationship changes when their optimistic
   preconditions still match.

Consolidation creates a normal memory plus `derived_from` edges. It does not delete
sources. Purge/hard delete is intentionally outside the reversible operation class.
Audit rows contain ids, enums, counts, hashes, and timestamps—not memory/query text.

Current memory tools remain capability-first. memory-design owns how capabilities are
discovered; memory-design owns their scope-safe semantics. Applying maintenance requires an
explicit management capability/permission and is not silently granted with search.

### 9. Additive API/UI contract

V1 fields and endpoints remain valid. Additive contract shapes include:

- `MemoryScopeSpec` and `MemoryScopeType`;
- `labels` on memory create/update/response;
- label/scope filters on list/search;
- `MemoryRelationship` list/create/delete;
- score `components`, `reasonCodes`, freshness/conflict/provenance hints;
- deterministic export;
- explicit delete and maintenance preview/apply/revert responses.

The workspace-readable `session_events` contract is intentionally lossy. New
private memory tool call/output events carry ids, names/actions, and an explicit
redaction marker only; `memory.saved`/`memory.corrected` omit text previews,
queries, replacement text, reasons, sources, and metadata. Unredacted calls and
results remain only in authorized `session_history_items` for model continuity.
React readers continue accepting historical preview-bearing replay events.

memory-design owns layout and interaction. memory-design supplies data semantics and only minimal
compatibility rendering if necessary. Browser acceptance covers desktop/mobile,
keyboard/touch, dark/light, long text, many labels, loading/empty/error, provenance,
conflicts, and visible retrieval reasons while preserving `?memory=<id>` deep links.

## Tenant and subject isolation

The account/workspace pair remains the primary tenant boundary. New tables use
composite workspace/account foreign keys, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW
LEVEL SECURITY`, and the existing `opengeni_private.workspace_rls_visible(...)`
predicate.

User memory adds a subject-aware clause to `knowledge_memories` RLS. Application
helpers set transaction-local account, workspace, subject, and explicit private-admin
GUCs on the same pinned transaction. Missing subject does not mean “all users”; it
means no user-scoped rows. Private-admin bypass is set only after an authoritative
permission check. Relationship reads require both endpoint memories to be visible.

Required database evidence uses a non-owner app role and at least:

- two accounts, two workspaces, and two subjects in one workspace;
- cross-account/workspace create/read/search/update/delete/edge rejection;
- subject A unable to list/get/search/export B's user record;
- API-key and delegated principals without membership rows;
- session/ephemeral composite-FK and expiry behavior;
- all new tables reporting both RLS enabled and forced.

## Migration and rollout

The implementation uses maintenance/drain-only migration `0095` after the retained migrations.
Although its storage changes are additive, it is not safe for mixed worker
versions: an old worker ignores typed applicability and can over-read role-,
session-, or ephemeral-scoped rows written by a new worker during overlap.

The cutover sequence is therefore:

1. stop new session/turn admission;
2. drain and terminate every old worker and in-flight session execution;
3. apply `0095` with no old application process reading memory;
4. start only compatible API and worker versions;
5. verify health and reopen admission.

Within that fenced cutover, `0095`:

1. add nullable session creator provenance and typed memory columns with safe
   defaults;
2. backfill `workspace` versus `legacy` scope in bounded SQL;
3. replace every legacy one-column memory creator FK with the idempotent
   workspace/session composite FK, then add the remaining checks/indexes/composite
   FKs;
4. create relationship and audit/operation tables with FORCE RLS;
5. replace the memory policy with workspace + subject semantics;
6. start compatible readers/writers and enable typed writes;
7. keep the workspace `memoryEnabled` gate and V1 fallbacks.

The first migration line is `-- deployment-mode: maintenance`. No released/applied
migration is rewritten. Rollback keeps admission closed, drains the incompatible
runtime, disables typed writes/injection, and returns to V1 workspace-only selection;
additive columns/tables can remain until a later maintenance migration removes them.
Unknown fields remain safe for older clients under the same-major additive contract
policy, but that wire compatibility does not make mixed memory readers safe.

## Verification contract

Reviewed readiness requires all of the following at the exact PR head:

- domain and property tests for normalization, scope applicability, total ordering,
  bounded rendering, monotonic freshness, conflict penalty, and correction winner;
- real PostgreSQL migration, FORCE-RLS, multi-account/workspace/subject, relation,
  retention, delete, and export tests;
- API/MCP tests for all principal personas and scope-safe tool behavior;
- deterministic export snapshots and secret-safe audit assertions;
- SDK contract parity, typecheck, lint, format, architecture/docs checks;
- real-backend browser evidence through the memory-design-compatible surface;
- independent Sol/xhigh privacy/product review after exact-head CI.

No memory-design owner or leaf merges, dispatches, deploys, or releases. Root serializes
delivery lanes; memory-design alone owns release/production acceptance.

## Alternatives rejected

1. **Canonical durable Agent/profile now.** No concrete workflow requires it; it
   would bind memory continuity to an unresolved product identity.
2. **One flat workspace feed with better recency.** Does not prevent role leakage
   or user-specific flooding.
3. **Arbitrary scope expressions in JSON.** Hard to index, test, explain, or
   constrain with RLS.
4. **A graph database rewrite.** PostgreSQL rows and a typed edge table satisfy the
   current hierarchy/provenance requirements with transactional/RLS continuity.
5. **Automatic contradiction winner.** Confidence/recency heuristics cannot prove
   truth; unresolved disagreement must remain visible until corrected.
6. **Opaque background summarization/cleanup.** It destroys auditability and makes
   rollback or human explanation impossible.

## Primary-source lessons (bounded, not copied wholesale)

- Generative Agents demonstrates a useful separation between a raw memory stream,
  retrieval by recency/relevance/importance, and explicit reflection into higher-level
  observations. memory-design adopts explainable components and source-traceable summaries,
  but not autonomous hidden rewriting.
- MemGPT/Letta demonstrates tiered working versus archival context and explicit memory
  operations. memory-design keeps bounded standing context plus search, but does not adopt a
  monolithic persistent agent identity.
- LangGraph's store namespaces demonstrate that hierarchical namespace selection can
  compose across threads/users without making the thread itself the durable identity.
  memory-design uses typed indexed columns instead of arbitrary tuple namespaces because RLS,
  lifecycle constraints, and UI explanation are first-class requirements.
- W3C PROV's entity/activity/agent separation supports source references and audited
  operations rather than overwriting provenance. “Agent” there is a provenance role,
  not a reason to create an OpenGeni Agent product primitive.
- Bitemporal/valid-time database practice supports retaining correction history with
  explicit validity intervals instead of mutating past truth in place. memory-design uses the
  already-shipped validity/supersession fields and keeps system-time in audit records.

The research informs the small composable model above; it is not a mandate to import
another framework's identity, graph, or background-reflection architecture.

