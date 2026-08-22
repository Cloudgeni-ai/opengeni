# Organization company profile

The organization company profile is the single active authority for concise
company identity, mission, products, customers, goals, and critical constraints.
It is organization-scoped (`managed_accounts.id`) and is known across every
workspace in that account. It is not a generic knowledge store, policy engine,
preference store, Memory record, or document corpus.

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
- explicit owner/admin-confirmed agent administration:
  `packages/core/src/domain/company-profile-agent-admin.ts`,
  `apps/api/src/mcp/company-profile-agent-admin.ts`, and migration
  `0318_human_confirmed_company_profile_agent_admin.sql`;
- the only prompt composer: `packages/runtime/src/workspace-governance.ts`,
  resolved by `apps/worker/src/activities/agent-turn/governance-model.ts`;
- admin presentation: the existing Company Brain / Workspace State route at
  `apps/web/src/routes/workspace-state.tsx`.

## Scope and authority

There is at most one active company-profile head per account. A workspace id is
required at API and accepted-attempt boundaries only to authenticate the caller,
apply tenant RLS, and identify the consuming session. Workspace membership,
workspace admin, session creation, provenance, documents, collections, memory,
and preference records never widen organization authority.

Reads require `workspace:read` in a workspace belonging to the account. Human
administration requires the canonical managed-cookie human session plus the
exact account's current active organization membership role `owner` or `admin`.
The route deliberately does not require or grant the broader `account:admin`
permission. Ordinary members, `workspace:admin` alone, delegated sessions,
services, agent-attempt grants, API keys, revoked roles, subject/account drift,
and cross-organization requests cannot create, edit, activate, or roll back
through the direct-human route.

An exact live agent attempt may administer the profile only through the
separate `company_profile_propose` → structured human input →
`company_profile_confirm` path. Proposal admission resolves the logical turn's
initiating human and requires that human's current active organization
membership be `owner` or `admin`. The proposal is a complete, inactive,
immutable profile revision. Confirmation requires the canonical question
returned by the proposal to have been answered `activate` by that same human,
then revalidates the current attempt, organization membership, immutable
proposal provenance/hash, and unchanged active-profile head before activation.
Dedicated immutable proposal and confirmation receipts retain the exact
session, turn, attempt generation, membership, human-input request, revision,
and activation event. The revision uses the distinct `agent_admin` provenance,
not `durable_learning`. MCP authorization supplies only ordinary exact-session
control/read capabilities; organization role is resolved authoritatively in
PostgreSQL, so an agent never receives `account:admin`.

This explicit administration path is not governed learning and never consults
workspace learning mode. In particular, `learning_policy_off` cannot block an
owner/admin's explicit request to manage the organization profile. The browser
HTTP administration route remains direct-human-only.

Autonomous company-level learning remains separate. The canonical
durable-learning router is the sole caller of the authority-native
`writeCompanyProfileLearning` / `rollbackCompanyProfileLearning` seam. This
authority does not implement the router, its ledger, natural-language commands,
or learning-policy resolution.

## Bounded structured content

Each immutable revision contains exactly:

- nullable `identity` and `mission` strings, each at most 2,048 characters;
- up to 16 keyed entries in each of `products`, `customers`, `goals`, and
  `constraints`;
- normalized stable keys up to 96 characters and entry content up to 1,024
  characters;
- a total canonical JSON ceiling of 28,672 UTF-8 bytes.

At least one field is required. List keys are unique within their section. The
server stores one canonical JSON representation and hashes those exact UTF-8
bytes. Longer source material belongs in organization-authority Documents/RAG
and is retrieved as evidence; it is never copied wholesale into this profile or
the mandatory prompt.

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
Migration `0318` routes the confirmed operation through the same
`company_profile_apply_activation` lifecycle function, attributes the event to
the confirming human, and retains compare-and-swap behavior. Its receipt tables
are FORCE-RLS, immutable, and have no direct runtime table privileges; the
runtime role can execute only the two bounded exact-attempt functions.

Rollback creates another immutable event and moves the head to a previously
active revision. Router rollback tokens restore the exact prior head, including
absence for a first activation. The rollback operation fingerprint depends only
on immutable router input, and the lifecycle function checks an existing event
before inspecting the mutable head, so retry after an authority/receipt crash
gap returns the original result even after the head was deleted or advanced by
that operation. No history row is edited or deleted.

The API below `/v1/workspaces/:workspaceId/company-profile` exposes current and
historical revisions, one revision, deterministic JSON diff, direct-admin
update-and-activate, proposal activation, and rollback. The Company Brain UI uses
only this API. List responses contain a separate bounded `activeRevision`
lookup in addition to the bounded newest-revision page, so more than 50 newer
proposals cannot hide the effective profile or initialize the editor from an
empty value.

## Durable-learning adapter contract

The canonical router sends only organization-scope `company_profile` subjects here:

| Router subject | Authority operation |
| --- | --- |
| `company_identity` | replace `identity` |
| `company_mission` | replace `mission` |
| `company_product` | stable-key upsert in `products` |
| `company_customer` | stable-key upsert in `customers` |
| `company_goal` | stable-key upsert in `goals` |
| `company_constraint` | stable-key upsert in `constraints` |

Repeatable list subjects require a valid stable key and fail closed without one.
`createCompanyProfileDurableLearningAdapter` is the concrete structural adapter
installed under canonical durable-learning router's `authorities.company_profile` port. It accepts the
router's attempt/request/decision envelope, requires the resolved organization
scope and company-profile destination, maps the router attempt id to the
authority operation id, and delegates only to `writeCompanyProfileLearning` or
`rollbackCompanyProfileLearning`. It neither imports nor implements the router,
attempt ledger, or workspace learning-policy resolver.

`authority=proposal` appends an inactive proposal revision and never changes the
head. `authority=active` appends and activates one full-profile revision, returns
`effectiveBoundary=next_accepted_attempt`, and returns an opaque rollback token.
The operation identity is the router attempt id, so exact router retry converges
without duplicate profile state. The router remains responsible for attempt-ledger
receipts and public `AUTHORITY_WRITE_FAILED` translation.

## Agent proposals and confirmation

The first-party `company_profile_propose` and `company_profile_confirm` tools
(`apps/api/src/mcp/company-profile-agent-admin.ts`) are the agent-facing path the
Company Brain "Create with OpenGeni" prompt directs a session to. They register
only for exact worker-signed agent attempts with `workspace:read` plus
`sessions:control`. Proposal input is the complete profile; omitted list keys are
derived from entry content and de-duplicated before the exact canonical profile
is hashed. The proposal appends one inactive revision with `agent_admin`
provenance and returns the exact structured-human-input payload. It never changes
the head or activation events.

Only `company_profile_confirm`, after the initiating owner/admin answered the
bound question with `activate`, can move the head. It revalidates the live
attempt, current organization role, proposal receipt/hash, human-input request,
and active-head compare-and-swap baseline. The Company Brain → Company profile &
goals view also lists inactive revisions under "Pending proposals" so a current
direct owner/admin can review and activate them manually through the same
lifecycle. The older `proposeCompanyProfile` persistence helper remains a
proposal-only internal seam and is not the registered first-party MCP path.

## Exact-attempt prompt delivery and precedence

Every accepted execution attempt creates or replays one immutable
`company_profile_snapshots` row. PostgreSQL validates the exact active
session/turn/attempt/generation and resolves the last activation event at or
before the logical turn's immutable `created_at`. A later activation cannot move
an already accepted turn; same-turn recovery resolves the same snapshot.

The existing workspace-governance composer is the sole prompt authority. When a
profile is active, the bounded deterministic order after non-bypassable platform
CORE is:

1. organization company profile;
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

When no company profile exists, its section is absent. Existing legacy
workspace persona and structured policy/preference composition remain
byte-for-byte unchanged; migration `0201` performs no backfill and creates no
default profile.

## Deliberate non-goals

This authority does not implement natural-language remember commands, learning-policy
resolution, durable-learning routing/ledger storage, Documents ingestion or search,
Memory, Preference Registry, workspace charter/policy activation, or generic
company knowledge retrieval.
