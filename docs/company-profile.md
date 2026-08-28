# Organization identity

Organization identity is the single active always-on authority for two small,
stable facts: who the company is and why it exists. It is organization-scoped
(`managed_accounts.id`) and is known across every workspace in that account.
Products, customers, goals, constraints, strategy, and changing facts are
organization-scoped Documents/RAG evidence, retrieved only when relevant. They
are not standing identity fields.

The persistence and public API retain the historical `company_profile` name and
its list fields so old revisions, hashes, snapshots, and integrations remain
readable without mutation. Current product surfaces and new writes use only
`identity` and `mission`. Nonempty list fields on an already-active historical
revision remain prompt-composed as explicitly labeled compatibility context
until an organization owner replaces that profile; this prevents silent context
loss while the organization moves those facts into Documents.

Canonical implementation:

- contracts: `packages/contracts/src/company-profile.ts`;
- persistence and exact-attempt snapshots:
  `packages/db/src/company-profile.ts`,
  `packages/db/src/company-profile-schema.ts`, and migration
  `0201_company_profile_authority.sql`;
- HTTP/SDK administration: `apps/api/src/routes/company-profile.ts` and
  `packages/sdk/src/company-profile.ts`;
- concrete durable-learning adapter:
  `packages/core/src/domain/company-profile-durable-learning-adapter.ts`;
- explicit owner-confirmed agent administration:
  `packages/db/src/company-profile-agent-admin.ts`,
  `packages/core/src/domain/company-profile-agent-admin.ts`,
  `apps/api/src/mcp/company-profile-agent-admin.ts`, and migration
  `0324_human_confirmed_company_profile_agent_admin.sql`;
- the only prompt composer: `packages/runtime/src/workspace-governance.ts`,
  resolved by `apps/worker/src/activities/agent-turn/governance-model.ts`;
- admin presentation: Organization settings → Knowledge in
  `apps/web/src/routes/org-settings.tsx`.

## Scope and authority

There is at most one active company-profile head per account. A workspace id is
required at API and accepted-attempt boundaries only to authenticate the caller,
apply tenant RLS, and identify the consuming session. Workspace membership,
workspace admin, session creation, provenance, documents, collections, memory,
and preference records never widen organization authority.

Reads require `workspace:read` in a workspace belonging to the account. Human
administration requires a direct authenticated human session with the exact
account's `account:admin` (granted to organization owners); `workspace:admin`,
organization admins and members, services, agent attempt grants, and API-key
identity cannot activate or roll back through the admin route. That admission
contract is unchanged by the agent path below; widening it to organization
admins, or narrowing it to the canonical managed-cookie session only, is a
deliberate product decision rather than a side effect of agent administration.

An exact live agent attempt may administer the profile only through the
separate `company_profile_propose` → structured human input →
`company_profile_confirm` path. Proposal admission resolves the logical turn's
initiating human and requires that human's current active organization
membership to be the `owner` role, i.e. exactly the authority the manual
`account:admin` route requires; an organization admin who cannot use the
manual editor cannot activate through an agent either. The proposal is an
inactive, immutable identity/mission revision with empty compatibility lists. Confirmation requires the
canonical question returned by the proposal to have been answered `activate`
by that same human, then revalidates the current attempt, organization
membership, immutable proposal provenance/hash, and unchanged active-profile
head before activation. Dedicated immutable proposal and confirmation receipts
retain the exact session, turn, attempt generation, membership, human-input
request, revision, and activation event; both receipt tables carry the
restrictive `session_visibility_isolation` policy like every other
session-referencing receipt. The revision uses the distinct `agent_admin`
provenance, not `durable_learning`. MCP authorization supplies only ordinary
exact-session control/read capabilities; organization role is resolved
authoritatively in PostgreSQL, so an agent never receives `account:admin`.

The two SECURITY DEFINER functions follow the canonical lock order: `workspaces
FOR KEY SHARE`, the initiating human's `organization_memberships` row `FOR KEY
SHARE` (the migration 0299 membership seam orders workspaces, then
memberships, then sessions), then the exact session/turn/attempt rows `FOR
SHARE`. Only after that prefix does `propose` touch `managed_accounts` (`FOR
KEY SHARE`) and does `confirm` reach the organization row `FOR UPDATE` through
the nested `company_profile_apply_activation` call. Nothing stronger than
`managed_accounts FOR KEY SHARE` ever precedes the session prefix, so the
functions cannot form an ABBA cycle with the canonical event writer, which
holds the session row and then reaches `managed_accounts` through the
`session_events` account foreign key. One residual remains: the nested
`company_profile_apply_activation` (migration 0201) still takes
`managed_accounts FOR UPDATE` after the session/turn/attempt `FOR SHARE` rows,
while the post-0299 membership seam (0263 suspend/offboard) opens
`managed_accounts FOR KEY SHARE` and then locks the target human's sessions
`FOR NO KEY UPDATE`, so an owner confirming while being suspended or offboarded
can be deadlock-detected (`40P01`, both sides retry-safe); the fix is
downgrading `company_profile_apply_activation` to `KEY SHARE` plus the
organization advisory key in the 0299 style (follow-up).

Both functions are idempotent across replacement attempts of the same logical
turn: their input hashes bind account, workspace, session, turn, operation id,
content/proposal identity, and the initiating membership, never the attempt id
or execution generation (those are persisted on the receipt rows). After a
worker death re-claims the turn at generation G+1, the same operation id
replays, and a `confirm` retry under a fresh operation id after a successful
activation replays the existing confirmation for that proposal (same bound
human-input request) instead of reporting a profile conflict. The first
confirmation still requires the exact content hash and the `P <= R < L`
generation rule.

This explicit administration path is not governed learning and never consults
workspace learning mode. In particular, `learning_policy_off` cannot block the
owner's explicit request to manage the organization profile. The browser HTTP
administration route remains direct-human-only.

The historical durable-learning adapter remains readable for compatibility.
New products, customers, goals, constraints, strategy, and other changing facts
must go to organization-scoped Documents/knowledge rather than this authority.
Automatic derivation of explorable organization knowledge from sessions and
integrations is a separate retrieval pipeline, not a reason to widen the
always-on prompt.

## Bounded structured content

Each immutable revision retains the compatibility shape:

- nullable `identity` and `mission` strings, each at most 2,048 characters;
- up to 16 keyed entries in each of `products`, `customers`, `goals`, and
  `constraints`;
- normalized stable keys up to 96 characters and entry content up to 1,024
  characters;
- a total canonical JSON ceiling of 28,672 UTF-8 bytes.

At least one field is required. List keys are unique within their section. The
server stores one canonical JSON representation and hashes those exact UTF-8
bytes. The four lists are legacy storage only: current UI and agent proposals
write them empty. Existing revisions are not rewritten, and nonempty historical
lists remain composed with a legacy compatibility label until the next explicit
profile replacement. Richer material belongs in organization-authority
Documents/RAG and is retrieved as evidence.

Those numbers are compatibility ceilings, not targets. Only identity and
mission are always-on prompt context. An **agent** author is bounded more tightly
through `AgentAuthoredCompanyProfileContent`, and the first-party proposal tool
accepts only the two scalar fields:

| Field                                 | Agent bound                      | Human bound           |
| ------------------------------------- | -------------------------------- | --------------------- |
| `identity`, `mission`                 | 400 characters each              | 2,048 characters each |
| legacy list entry                     | not accepted by the current tool | 1,024 characters      |
| whole canonical compatibility profile | 4,096 UTF-8 bytes                | 28,672 UTF-8 bytes    |

Entry counts and total byte bounds remain unchanged so historical payloads keep
validating under the same hash contract. The human `account:admin` API keeps
`CompanyProfileContent` and the wider bounds for compatibility; the current UI
edits only identity and mission and clears the retired lists on the next write.
Existing revisions are never rewritten.

Identity and mission should each be one plain descriptive statement: no
numbered procedure, no marketing copy, no rationale essay, no restating of
platform defaults. The equivalent rule for workspace rules and preferences is in
[`workspace-instruction-policies.md`](workspace-instruction-policies.md).

## Revisions, activation, audit, and rollback

`company_profile_revisions` is append-only immutable history. Every revision
records a monotonic account-local revision number, intent (`active` or
`proposal`), exact content hash, creator, provenance, optional source identity,
and superseded account revision. Operation UUID plus a complete canonical
request fingerprint provides natural-convergence replay; changed input under a
used operation UUID is rejected.

`company_profile_heads` is the one mutable active projection.
`company_profile_activation_events` is immutable audit history. Activation and
rollback serialize on the account row and run only through
`company_profile_apply_activation`, a tenant-, actor-, principal-, and
compare-and-swap-validated `SECURITY DEFINER` lifecycle function. The ordinary
runtime role has read-only access to the head and event tables; trigger fencing
also rejects direct owner mutation outside that function. Each successful call
atomically changes the head and appends exactly one activation event. A stale
writer receives `COMPANY_PROFILE_CONFLICT`; it never silently overwrites newer
truth.

Agent-admin proposals and confirmations add no second mutation mechanism.
Migration `0324_human_confirmed_company_profile_agent_admin.sql` routes the
confirmed operation through the same `company_profile_apply_activation`
lifecycle function, attributes the event to the confirming human, and retains
compare-and-swap behavior. Its receipt tables are FORCE-RLS, immutable, and
have no direct runtime table privileges; the runtime role can execute only the
two bounded exact-attempt functions.

Rollback creates another immutable event and moves the head to a previously
active revision. Router rollback tokens restore the exact prior head, including
absence for a first activation. The rollback operation fingerprint depends only
on immutable router input, and the lifecycle function checks an existing event
before inspecting the mutable head, so retry after an authority/receipt crash
gap returns the original result even after the head was deleted or advanced by
that operation. No history row is edited or deleted.

The API below `/v1/workspaces/:workspaceId/company-profile` exposes current and
historical revisions, one revision, deterministic JSON diff, direct-admin
update-and-activate, proposal activation, and rollback. Purpose-built governance
clients may use this API directly; the simplified organization settings entry
uses the owner-confirmed agent administration path below. List responses contain a separate bounded `activeRevision`
lookup in addition to the bounded newest-revision page, so more than 50 newer
proposals cannot hide the effective profile or initialize the editor from an
empty value.

## Durable-learning adapter compatibility contract

The authority-native adapter retains the original organization-scope subjects
so historical receipts, rollbacks, and rolling clients remain valid:

| Router subject       | Authority operation                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `company_identity`   | replace `identity`                                                                                                                                   |
| `company_mission`    | replace `mission`                                                                                                                                    |
| `company_product`    | legacy stable-key upsert in `products`; a nonempty active historical value remains labeled compatibility prompt context until profile replacement    |
| `company_customer`   | legacy stable-key upsert in `customers`; a nonempty active historical value remains labeled compatibility prompt context until profile replacement   |
| `company_goal`       | legacy stable-key upsert in `goals`; a nonempty active historical value remains labeled compatibility prompt context until profile replacement       |
| `company_constraint` | legacy stable-key upsert in `constraints`; a nonempty active historical value remains labeled compatibility prompt context until profile replacement |

Repeatable list subjects require a valid stable key and fail closed without one.
New learning decisions must route those facts to organization-scoped knowledge;
this adapter compatibility is not permission to create new standing fields.
`createCompanyProfileDurableLearningAdapter` is the concrete structural adapter
installed under canonical durable-learning router's `authorities.company_profile` port. It accepts the
router's attempt/request/decision envelope, requires the resolved organization
scope and company-profile destination, maps the router attempt id to the
authority operation id, and delegates only to `writeCompanyProfileLearning` or
`rollbackCompanyProfileLearning`. It neither imports nor implements the router,
attempt ledger, or workspace learning-policy resolver.

`authority=proposal` appends an inactive proposal revision and never changes the
head. `authority=active` appends and activates one compatibility-profile revision, returns
`effectiveBoundary=next_accepted_attempt`, and returns an opaque rollback token.
The operation identity is the router attempt id, so exact router retry converges
without duplicate profile state. The router remains responsible for attempt-ledger
receipts and public `AUTHORITY_WRITE_FAILED` translation.

## Agent proposals and confirmation

The first-party `company_profile_propose` and `company_profile_confirm` tools
(`apps/api/src/mcp/company-profile-agent-admin.ts`) are the agent-facing path the
Organization settings → Knowledge "Create with OpenGeni" prompt directs a session to. They register
only for exact worker-signed agent attempts with `workspace:read` plus
`sessions:control`. Proposal input contains only identity and mission; the
canonical compatibility lists are written empty before the exact profile is
hashed. The proposal appends one inactive revision with `agent_admin`
provenance and returns the exact structured-human-input payload. It never changes
the head or activation events.

Proposal input is validated against `AgentAuthoredCompanyProfileContent` rather
than `CompanyProfileContent`, so the agent bounds in "Bounded structured content"
above apply here and not on the manual `account:admin` route. The tool
description states those scalar bounds and the authoring style, because a model
left to itself writes an essay into a field that is then prepended to every root
prompt in the organization: one concise descriptive statement per field, no
numbered procedure and no marketing copy. The style clause used for workspace
rules is deliberately not reused here; a profile is descriptive, not an
instruction, so "write one imperative rule" would be the wrong shape.

The returned question's `helpText` binds the revision number and content
SHA-256 and renders a readable summary of the proposed identity and mission
(bounded to the human-input contract), never raw JSON. Migration `0360` narrows
new confirmation copy while preserving immutable prompts on older proposals;
during a rolling deploy it still discloses any nonempty legacy lists submitted
by an older API instance before the human can activate them.

Only `company_profile_confirm`, after the initiating owner answered the bound
question with `activate`, can move the head. It revalidates the live attempt,
current organization role, proposal receipt/hash, human-input request, and
active-head compare-and-swap baseline. The simplified organization Knowledge
section intentionally does not expose revision lists or proposal lifecycle
controls; those remain available through the canonical API for authorized
governance clients. The earlier proposal-only `company_profile_propose` tool
(`durable_learning` provenance, `agent-attempt:<attemptId>` source id) and its
`proposeCompanyProfile` helper are retired; this propose/confirm path fully
supersedes them.

## Exact-attempt prompt delivery and precedence

Every accepted execution attempt creates or replays one immutable
`company_profile_snapshots` row. PostgreSQL validates the exact active
session/turn/attempt/generation and resolves the last activation event at or
before the logical turn's immutable `created_at`. A later activation cannot move
an already accepted turn; same-turn recovery resolves the same snapshot.

The existing workspace-governance composer is the sole prompt authority. When a
profile is active, the bounded deterministic order after non-bypassable platform
CORE is:

1. organization identity and mission, plus explicitly labeled nonempty legacy
   details retained by an older active revision until replacement;
2. organization preference descriptors;
3. workspace charter;
4. workspace global policy;
5. workspace preference descriptors;
6. immutable initiating-user preference descriptors;
7. matching session role policy;
8. durable session instructions;
9. selected tool/repository substrate;
10. bounded Memory/knowledge retrieval.

Per-message `modelContext` is outside this authority block. It enters only as ordinary chronological user-role content attached to its accepted message and cannot modify company-profile authority or the persistent instruction prefix.

The rendered company-profile slice fails closed above 32,768 UTF-8 bytes, and
the existing complete governance block retains its 131,072-byte fail-closed
ceiling. Snapshot/revision hashes and activation evidence are prompt-visible;
raw operation ids, actor identities, source ids, Documents, Memory, and
preference full content are not.

When an active revision contains only historical list fields, its compatibility
section remains present until replacement. When all six fields are empty, the
section is absent. Migration `0201` performs no backfill and creates no default
profile.

## Deliberate non-goals

This authority does not implement natural-language remember commands,
learning-policy resolution, Documents ingestion/search, automatic derivation of
organization knowledge, Memory, Skills, workspace-instruction activation, or a
generic company knowledge explorer. Organization Documents own that larger
retrieval surface.
