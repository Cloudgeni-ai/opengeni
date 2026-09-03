# Agent Knowledge overview (Workspace State projection)

The user-facing **Agent Knowledge** page is a small map of what agents can follow
or find in the current workspace. The Workspace State projection supplies its
status counts, but the page does not expose the projection's diagnostic model.
It contains exactly two groups:

- **How agents work**: concise Workspace instructions and conditional Skills;
- **What agents can find**: Documents/RAG evidence and Memory records.

Workspace instructions and Skills are prompt-first. The user describes the
desired behavior, then continues in a real OpenGeni session that asks only
essential questions and proposes the destination-specific result before saving.
The workspace-instruction prompt targets the shortest useful universal rule—
normally 1–5 sentences and at most 120 words. A conditional procedure is routed
to a Skill, while a fact, decision, incident, fix, or outcome is routed to
remembered Knowledge. The same material is never copied across destinations.

The compact manual editors remain available in the focused subviews. Manual
workspace saves create and activate an immutable global policy revision through
the existing instruction-policy API. Manual Skill saves derive the stable key
and default conflict metadata, then activate the explicit human-authored
preference-registry revision. Only active Skills render as simple summary cards;
proposal hashes, revision history, lifecycle controls, accepted-attempt lookup,
raw inventories, structural gaps, proposal queues, portable export, and the
historical Knowledge inspector are not presented on the default product page.

The small always-on organization identity and mission are administered from
**Organization settings → Knowledge**. Products, customers, goals, constraints,
and other company facts live in company-scoped Documents on that same surface
and are retrieved when relevant. Learning mode is administered from **Workspace
settings → General → Workspace instruction & Skill autonomy**. Neither is a workspace instruction
or Skill.

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

The account-scoped company profile remains a separate organization authority.
Its agent-assisted product entry point is Organization settings → Knowledge;
Workspace State does not own or duplicate it. See
[`company-profile.md`](company-profile.md).

## HTTP and authorization

`GET /v1/workspaces/:workspaceId/workspace-state` requires `workspace:read` and
returns `Cache-Control: private, no-store`. The optional
`?attemptId=<uuid>` query requests immutable governance metadata for one
accepted attempt.

`GET /v1/workspaces/:workspaceId/workspace-state/export` accepts the same query,
requires the same permissions, and runs the same permission-filtered projection
before serialization. It returns canonical JSON as a private, no-store
attachment. The export is not a raw database dump or compliance audit log.

`GET /v1/workspaces/:workspaceId/company-brain` is the portable Company Brain
read projection. It requires `workspace:read` and returns the full authorized
company-profile, instruction-policy, and structured-preference revision bodies
that the requesting subject may read through the existing FORCE-RLS authority.
Personal preference bodies for another subject never enter the candidate set.
Knowledge remains an independently permission-filtered Workspace State
projection: without `documents:search` it is explicitly `unavailable`, which is
distinct from an authorized but empty knowledge inventory.

`GET /v1/workspaces/:workspaceId/company-brain/export` runs that same projection
and returns a private, no-store Markdown attachment. The single fenced `yaml`
payload is canonical JSON, which is a YAML 1.2 subset. Guidance newlines and
Markdown delimiters therefore remain escaped data and cannot terminate or alter
the package structure. Entries and object keys have deterministic ordering.
The package carries explicit source-history, 512-item, and 4 MiB aggregate
UTF-8 truncation facts and an omission manifest; active guidance is retained
first within the aggregate bound, and links to omitted or inaccessible targets
are themselves omitted rather than emitted as metadata. It intentionally
excludes Document bodies, Memory bodies and provenance, secrets, credentials,
session messages, task notes, and policy or preference actor identifiers.
PostgreSQL remains canonical after export or round-trip parsing.

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

`/workspaces/:workspaceId/state` is labeled **Agent Knowledge** in the console.
The default route renders only the four destinations above. Documents summarize
indexing health, Memory summarizes the newest authorized sample, and both link
to their dedicated pages. Workspace instructions and Skills link to focused
creation views; no `company`, `learning`, or generic preference-administration
view is accepted by route search validation.

The Workspace State API and generation-fenced loaders still provide the bounded
projection used by tests, administrative integrations, and future purpose-built
governance clients. The detailed policy inventory, structured-preference
lifecycle panel, Knowledge inspector, proposal queues, accepted-attempt drift,
and OKF export remain separate technical capabilities, not elements of the
default Agent Knowledge experience. Simplifying the product page does not
weaken their tenancy, compare-and-swap, immutable-history, or permission
boundaries.

The browser does not receive registry full content or attempt retrieval handles
on list/detail. It explains that descriptors are automatically composed while
agents retrieve the full body only through `preference_registry_summary` and
`preference_registry_get` under exact accepted-attempt authority. This is not a
Memory editor: `knowledge_memories.kind = preference` remains legacy,
non-authoritative observation metadata. Documents, Memory, connectors, and
imported sources remain evidence or inactive proposals and never directly
activate registry state. The separately authorized governed-learning controller
is the sole automatic-activation seam; it consumes only a final eligible
decision receipt and revalidates the current destination head before calling
the destination-native lifecycle.

There is no instruction-policy rollback UI, Memory promotion, Documents
promotion, or general policy editor. The product surface intentionally omits
the prior attention feed, recent-change list, inspector, export control, and
collapsed technical administration panel.

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
