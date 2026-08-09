# Workspace State

Workspace State is a read-time inventory of existing workspace authorities. It
helps operators understand instruction-policy metadata, structured preference
identities, document authority coverage, knowledge freshness, and deterministic
structural gaps. The projection and export remain read-only. The console hosts
two bounded administration seams over existing canonical authorities: an
instruction-policy onboarding composer that creates only inactive drafts, and
structured preference governance for explicit organization/workspace/personal
proposal and lifecycle operations. It does not create another storage
authority, background synthesizer, or runtime prompt source.

The current slice is additive and dependency-safe. Wider policy authoring,
proposal review workflows, learning-policy history, and source administration
remain later phases.

## Authority boundaries

Workspace State projects existing sources; it owns none of them:

- charter and policy authority remains
  `workspace_instruction_policy_revisions`,
  `workspace_instruction_policy_heads`, and
  `workspace_instruction_policy_activation_events` as documented in
  [`workspace-instruction-policies.md`](workspace-instruction-policies.md);
- onboarding evidence remains in
  `workspace_instruction_policy_onboarding_proposals`, and every proposal links
  to one inactive revision in that same instruction-policy authority;
- indexed knowledge remains in Documents (`document_bases`, `documents`, and
  `document_chunks`);
- durable facts, decisions, procedures, and other retrieval observations remain
  in Memory (`knowledge_memories`); historical rows with
  `knowledge_memories.kind = preference` are legacy, non-authoritative
  observations only;
- the dedicated structured preference registry (`preference_registry_preferences`
  plus its immutable revisions and lifecycle events) is the sole active
  preference authority, as documented in
  [`preference-registry.md`](preference-registry.md);
- skills, tools, agents/sessions, rigs, variable sets, and workspace settings
  remain on their existing API and console surfaces.

The inventory does not add `workspace_charters`, a generic source/fact schema,
or any knowledge-derived policy store. Knowledge-derived charter or preference
changes remain proposals only: if represented as instruction policy, they must
be inactive, provenance-linked drafts until an authorized policy operation
explicitly activates them.

## HTTP and authorization

`GET /v1/workspaces/:workspaceId/workspace-state` requires `workspace:read` and
returns `Cache-Control: private, no-store`. The optional
`?attemptId=<uuid>` query requests immutable governance metadata for one
accepted attempt.

`GET /v1/workspaces/:workspaceId/workspace-state/export` accepts the same query,
requires the same permissions, and runs the same permission-filtered projection
before serialization. It returns canonical JSON as a private, no-store
attachment. The export is not a raw database dump or compliance audit log.

The separate proposal surface lives at
`/v1/workspaces/:workspaceId/instruction-policies/onboarding-proposals`.
`GET` requires `workspace:read`; `POST` requires `workspace:admin`, an exact
active-head baseline, bounded source/version/confidence evidence, and an
idempotent operation ID. The POST creates only immutable proposal evidence plus
one inactive instruction-policy revision. It never activates policy.

Structured preference administration uses the existing
`/v1/workspaces/:workspaceId/preferences` governance routes rather than a
Workspace State write endpoint. List/detail requires `workspace:read` and is
limited to the authenticated subject's visible organization, current-workspace,
and personal rows. Organization mutations require the matching direct-human
`account:admin` grant, workspace mutations require direct-human
`workspace:admin`, and personal mutations always derive the target from the
signed-in human. API keys, services, workers, agent attempts, and incomplete
principal contexts remain read only.

Attempt inspection additionally requires the authenticated subject to equal
the turn's immutable initiating-human subject (including a causal human carried
by an authorized service continuation). The lookup explicitly fences account,
workspace, the attempt's immutable session/turn identity and execution
generation, and initiating subject. It does not require the turn's mutable
current execution generation to remain equal after recovery, so a retained
historical accepted attempt remains inspectable. Missing, foreign-account,
foreign-workspace, and another subject's attempts all collapse to the same
`attempt_not_found_or_not_authorized` result, with no session or turn identifier
disclosed.

Knowledge facts are independently gated by `documents:search`:

- with the permission, the server computes subject-visible document aggregates,
  a bounded base/topic projection, and a deterministic narrow Memory sample;
- without it, `knowledge.availability` is `unavailable` and the response
  discloses no base, document, topic, source-kind, memory, freshness, or gap
  counts.

Document inspection passes the authenticated grant subject to the existing
Documents visibility filter. Private documents therefore remain visible only
to their creator. Workspace RLS remains the outer boundary.

## Sanitized projection

The response deliberately excludes:

- instruction-policy bodies, legacy runtime instructions, provenance source
  identifiers, and policy actors;
- document titles, summaries, parser names, errors, URIs, external identifiers,
  authors, versions, ACL tags, curation evidence, and file identifiers;
- Memory text, source references, scopes, confidence, metadata, actors, session
  identifiers, and correction chains;
- policy snapshot bodies and personal preference titles, descriptions, values,
  retrieval handles, subject identifiers, session identifiers, and turn
  identifiers;
- variable values, credentials, integration configuration, prompt text, and
  model/tool schemas.

It returns only bounded metadata and aggregates:

| Projection | Bound | Truncation truth |
| --- | ---: | --- |
| Active instruction-policy heads | 32 | `activeHeadsTruncated` |
| Document bases returned | 24 | Separate exact `baseCount`; `basesTruncated`; `coverage=partial` |
| Subject-visible document status/source totals | All matching rows via SQL aggregates | No document records are returned or sampled |
| Topics returned | 24 | `topicsTruncated` |
| Newest Memory records sampled | 100 | `memorySample.limitReached`; `coverage=partial` |
| Accepted-attempt policy entries | 3 | Immutable snapshot-table constraint; count and hash are explicit |
| Accepted-attempt preference descriptors | 64 / 16 KiB | Only descriptor count/hash is projected; `truncated` is explicit |

The current structured-preference inventory uses the same subject-scoped,
bounded descriptor identity query as accepted-attempt drift comparison. It
returns only the active descriptor count, a deterministic identity hash,
organization/workspace/user counts, and truncation truth. Preference titles,
descriptions, values, stable keys, precedence details, provenance, expiration,
and retrieval handles do not cross the boundary.

Subject-visible document aggregates additionally include fixed-cardinality
counts for the immutable `organization`, `workspace`, and `personal` document
authorities. The personal count includes only the authenticated subject's own
documents; another subject's personal rows and every cross-tenant row remain
outside both the inventory and export.

Base names are normalized and clipped to 160 characters. Topic labels are
normalized and clipped to 96 characters. Aggregate status and source-kind
counts cover all subject-visible documents through fixed-cardinality SQL
aggregates; the endpoint never materializes `Document[]`. The existing response
field `inspectedVisibleDocumentCount` is therefore an exact visible total, while
base and topic rows remain bounded presentation lists. `baseCount` comes from a
separate aggregate query, while `memorySample.recordCount` is a sample count,
not a total.

The Memory sample has its own Workspace-State-only SQL query. It selects exactly
`id`, `status`, `kind`, and `updated_at`, orders by `updated_at DESC` plus stable
`id ASC`, and applies the 100-row limit in SQL. The stable id is used only as a
deterministic tie-breaker and is not exposed by the HTTP response. Memory text,
source references, metadata, and embedding/vector columns are never selected or
materialized for this surface. The adjacent `memorySample.preferenceAuthority`
descriptor explicitly labels `kindCounts.preference` as a count of legacy,
non-authoritative `knowledge_memories` observations and names the structured
preference registry as the sole active preference authority. Workspace State
does not read, duplicate, or create another preference store.

`generatedAt`, `latestDocumentUpdatedAt`, per-base `latestUpdatedAt`, and the
Memory sample's `latestUpdatedAt` make freshness explicit.

## Sanitized export

The export envelope is versioned as
`opengeni.workspace_state.sanitized_export` schema version `1`. It embeds the
already-validated `WorkspaceStateResponse`, includes a SHA-256 over canonical
JSON for that sanitized state, and carries an explicit omission manifest for:

- hidden platform prompts;
- policy bodies;
- preference content;
- document content and private metadata;
- Memory content and provenance;
- secret values and credentials;
- session messages and tool outputs.

Object keys are recursively sorted and arrays preserve their projection order,
so an identical sanitized state produces byte-identical export JSON and the
same digest. `generatedAt` is reused from the projected state rather than
introducing a second export clock. Any future export shape requires a new schema
version; raw content must never be added to version `1`.

## Current state versus accepted-attempt governance

The current inventory remains labeled
`truth.current.source=read_time_projection`. Without `attemptId`,
`truth.attemptGovernance.status=not_requested`.

For an authorized accepted attempt, Workspace State reads the existing
immutable instruction-policy and preference-registry snapshot rows. It projects
only stable IDs, revisions, content hashes, activation versions, timestamps,
normalized policy role/source, coarse counts, and truncation facts. Policy and
preference bodies never cross the boundary.

Drift is deterministic and independently labeled for policy and preferences:

- `identical`: the frozen and current stable identities are exact;
- `superseded`: the same policy targets or preference IDs remain, but active
  revisions changed;
- `changed`: the current target/descriptor identity set added or removed an
  entry;
- `missing`: the accepted attempt exists but one immutable snapshot row does
  not;
- `truncated`: either the frozen or current preference descriptor set reached
  its count/byte bound, so exact equality is not claimed;
- `unavailable`: the attempt lookup did not pass the uniform authorization
  fence.

Active heads remain authoritative current stored state, while the snapshot is
the evidence of what the accepted attempt froze. The legacy workspace override
or deployment-default metadata remains separately labeled and never exposes its
content.

## Knowledge map and gap signals

The knowledge map is computed on demand from bounded SQL aggregates plus a pure
in-memory sanitizer during the GET request. It is the safe adaptation of PR
#722's useful “sweep” concept; it is not a scheduled or Temporal workflow and
writes no state.

Gap signals are deterministic codes over exact visible-document aggregates and
the explicitly bounded base/topic/Memory projections:

- no document bases;
- no subject-visible documents;
- failed documents;
- queued or indexing documents;
- ready documents without topic metadata;
- an empty Memory sample;
- proposed memories in the sample;
- partial inventory caused by a safety bound.

No model generates gap prose, purpose, goals, charter text, or preference
changes. Gaps are not persisted and cannot activate policy.

## Console surface

`/workspaces/:workspaceId/state` renders Workspace State with loading, empty,
permission-unavailable, error/retry, partial-coverage, freshness, and accepted-
attempt governance states. It separately shows current structured-preference
identity counts and company/workspace/personal document authority counts. The
inspector accepts an attempt UUID and displays
only drift status, counts, hashes, role metadata, and timestamps. Loader
generation fences include both workspace and attempt IDs, so a late response
cannot populate a newer selection. A second generation-fenced loader lists
recent onboarding proposal evidence. Workspace admins may submit one explicit
draft-only proposal with the exact displayed active-head baseline; readers see
the immutable source/version/confidence, linked draft, baseline, and timestamp.

A separate generation-fenced registry loader lists at most 100 authorized
structured preferences and loads one selected detail. The administration panel
shows the scope, status, scope/activation versions, compact descriptor,
precedence/conflicts, provenance/trust, immutable revision hashes/correction
links, and lifecycle actor/reason/time evidence. Direct humans may create an
inactive proposal, activate or roll back to an older immutable revision,
correct through a complete replacement body, move scope when authorized for
both old and new scopes, deactivate, or reject. Explicit audit reasons and a
new-attempt confirmation accompany lifecycle changes. Server authorization,
stale-CAS, conflict, and validation errors remain visible rather than being
reinterpreted by the browser.

The browser does not receive registry full content or attempt retrieval handles
on list/detail. It explains that descriptors are automatically composed while
agents retrieve the full body only through `preference_registry_summary` and
`preference_registry_get` under exact accepted-attempt authority. This is not a
Memory editor: `knowledge_memories.kind = preference` remains legacy,
non-authoritative observation metadata. Documents, Memory, connectors, and
imported sources remain evidence or inactive proposals and never directly
activate registry state. The separately authorized governed-learning controller
is the sole future automatic-activation seam.

There is no instruction-policy activation/rollback UI, Memory promotion,
Documents promotion, or general policy editor. Deep links lead to the existing
Documents, Memory, Capabilities/Skills, Sessions/Agents, Rigs, Variable Sets,
and Workspace Settings surfaces.

## Explicit non-goals

This slice does not implement:

- instruction-policy activation, rollback, or general policy editing;
- preference storage;
- browser-readable preference bodies or browser-issued attempt retrieval
  handles;
- source/fact schema work;
- Slack, transcript, email, repository, or other connectors;
- onboarding proposal review/approval states or automatic proposal generation;
- the governed-learning controller or direct automatic activation;
- background sweeps, auto-synthesis, direct prompt injection, or a new charter
  authority.

The point-in-time reconciliation of PR #722 is recorded in
[`design/pr-722-workspace-state-reconciliation.md`](design/pr-722-workspace-state-reconciliation.md).