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
  `0197_company_profile_authority.sql`;
- HTTP/SDK administration: `apps/api/src/routes/company-profile.ts` and
  `packages/sdk/src/company-profile.ts`;
- the only prompt composer: `packages/runtime/src/workspace-governance.ts`,
  resolved by `apps/worker/src/activities/agent-turn.ts`;
- admin presentation: the existing Agent Brain / Workspace State route at
  `apps/web/src/routes/workspace-state.tsx`.

## Scope and authority

There is at most one active company-profile head per account. A workspace id is
required at API and accepted-attempt boundaries only to authenticate the caller,
apply tenant RLS, and identify the consuming session. Workspace membership,
workspace admin, session creation, provenance, documents, collections, memory,
and preference records never widen organization authority.

Reads require `workspace:read` in a workspace belonging to the account. Human
administration requires a direct authenticated human session with the exact
account's `account:admin`; `workspace:admin`, delegated services, agent attempt
grants, and API-key identity cannot activate or roll back through the admin
route.

Explicit agent-directed and autonomous company-level learning does not use the
admin route. The canonical durable-learning router is the sole caller of the
authority-native `writeCompanyProfileLearning` / `rollbackCompanyProfileLearning`
seam. This authority does not implement the router, its ledger, natural-language
commands, or learning-policy resolution.

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
rollback serialize on the account row, require the caller's exact expected head
and activation version, and atomically advance the activation version. A stale
writer receives `COMPANY_PROFILE_CONFLICT`; it never silently overwrites newer
truth.

Rollback creates another immutable event and moves the head to a previously
active revision. Router rollback tokens restore the exact prior head, including
absence for a first activation. No history row is edited or deleted.

The API below `/v1/workspaces/:workspaceId/company-profile` exposes current and
historical revisions, one revision, deterministic JSON diff, direct-admin
update-and-activate, proposal activation, and rollback. The Agent Brain UI uses
only this API.

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
`authority=proposal` appends an inactive proposal revision and never changes the
head. `authority=active` appends and activates one full-profile revision, returns
`effectiveBoundary=next_accepted_attempt`, and returns an opaque rollback token.
The operation identity is the router attempt id, so exact router retry converges
without duplicate profile state. The router remains responsible for attempt-ledger
receipts and public `AUTHORITY_WRITE_FAILED` translation.

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
8. session and exact-turn instructions;
9. selected tool/repository substrate;
10. bounded Memory/knowledge retrieval.

The rendered company-profile slice fails closed above 32,768 UTF-8 bytes, and
the existing complete governance block retains its 131,072-byte fail-closed
ceiling. Snapshot/revision hashes and activation evidence are prompt-visible;
raw operation ids, actor identities, source ids, Documents, Memory, and
preference full content are not.

When no company profile exists, its section is absent. Existing legacy
workspace persona and structured policy/preference composition remain
byte-for-byte unchanged; migration `0197` performs no backfill and creates no
default profile.

## Deliberate non-goals

This authority does not implement natural-language remember commands, learning-policy
resolution, durable-learning routing/ledger storage, Documents ingestion or search,
Memory, Preference Registry, workspace charter/policy activation, or generic
company knowledge retrieval.