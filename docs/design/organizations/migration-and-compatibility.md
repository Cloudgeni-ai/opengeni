<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# Organizations and identity migration and compatibility plan

Status: **corrective revision after the third exact-head blocked review; no DDL may land before approval**

Companions: [`tenancy-identity-adr.md`](tenancy-identity-adr.md),
[`threat-model.md`](threat-model.md)

## 1. Migration principles

1. Forward-only, expand-before-use migrations; no reverse migration.
2. Existing workspace ids and resource tenant pairs never change.
3. `managed_accounts.id` remains the physical organization id.
4. `account_id`/`accountId` remains a compatibility alias for organization id.
5. Existing writers remain valid during schema expansion and shadowing only. They are
   drained and database-fenced before canonical governance becomes authoritative.
6. New writers synchronously preserve the legacy authorization projection until all
   supported old clients age out; keeping the wire/physical alias indefinitely is
   acceptable, but an old binary never remains an authority after cutover.
7. Backfill is idempotent, bounded, resumable, observable, and never guesses identity
   from unverified email.
8. No feature read switches until shadow-read parity, constraints, and real FORCE-RLS
   tests pass.
9. A binary rollback does not require a database rollback and does not grant broader
   access than before the deployment.
10. Destructive cleanup is a later, separately reviewed program—not part of OPE-10's
    initial rollout.
11. Human/login recovery authority is deployment-scoped and stored outside organization
    membership. Organization governance recovery is scoped to exactly one organization
    and has no database capability over human/login state.
12. No legacy row is considered ready for canonical governance merely because a role,
    email, login, or workspace membership exists. Required human custody and recovery
    enrollment are explicit enablement gates.
13. Identity merge uses bounded invisible staging and a short generation cutover.
    Post-apply disputes contain and repair forward from retained per-object provenance;
    there is no data-migration rollback or lossless merge reversal.
14. Deployment identity recovery and exceptional organization-governance custody have
    separate offline-root/policy rows, custodian lifecycle operations, factors,
    revisions, capabilities, quorums, degraded states, and lost-quorum reconstitution.
15. Personal-to-team conversion changes one organization in place under a barrier and
    atomic custody/billing cutover. Organization merge is unsupported and fail-closed.
16. Wrongful-merge identity separation uses new resolver/human/owner generations and
    immutable alias lineage; it never rewinds a migration or invents tenant grants.
17. An external effect is not complete without a capability-fenced delivery state.
    Unknown delivery blocks ordinary merge finalization and is never blindly retried.

## 2. Existing compatibility spine

The following remain authoritative through the initial rollout:

- `managed_accounts.id` — organization id;
- `workspaces.account_id` — workspace's organization id;
- `(workspaces.id, workspaces.account_id)` — composite tenant parent;
- workspace resource `(account_id, workspace_id)` pairs and FORCE-RLS policies;
- `workspace_memberships.subject_id` — legacy principal mapping/fallback;
- `AccessContext.accountGrants`, `defaultAccountId`, and wire `accountId` fields; and
- existing billing/usage rows keyed by account id.

New concepts augment this spine. They do not create a second organization id or copy
resource rows to a new workspace.

## 3. Proposed additive persistence shape

Exact DDL, names, indexes, and migration number are implementation-review outputs. The
approved schema must represent at least the following without unchecked polymorphic
foreign keys.

### 3.1 Human identities

`human_identities` contains opaque id, display metadata, status, security revision, and
timestamps. Email is not unique identity.

For managed deployments, one legacy Better Auth user initially maps to one human
identity. Embedded/configured subjects can map through a typed external-subject binding
instead of requiring Better Auth tables.

### 3.2 Login accounts

`login_accounts` contains human identity id, normalized issuer, provider subject,
adapter/auth-user reference, verified-claim summaries, status, security revision, and
timestamps.

Required uniqueness is the bytewise pair `(canonical_issuer, provider_subject)`. Section
12 defines canonicalization, collation, limits, and index rollout. There is no unique
email constraint used for linking. A login account belongs to exactly one human
identity.

### 3.3 Organization metadata and membership

Organization kind/status/slug/personal-owner metadata may be additive columns on
`managed_accounts` or a one-to-one organization metadata table keyed by the same id.
Either shape preserves `managed_accounts.id` as the only organization identity.

`organization_memberships` contains organization id, human identity or explicitly typed
external principal, base role, status, authorization revision, and timestamps.
Composable billing/recovery capabilities use validated role bindings or permission rows;
they are not arbitrary JSON trusted at authorization time.

Required constraints include:

- one active membership per human/organization;
- at most one active personal organization per human;
- exactly one active personal owner for an active personal organization (enforced by a
  combination of constraint and serialized transaction);
- for every active team organization, at least one active human owner and one active
  human organization recovery steward, including when it has no workspaces or other
  resources; and
- unique composite keys needed by workspace-membership foreign keys.

The organization governance row stores a monotonic governance revision and one of
`governance_pending`, `active`, `governance_locked`, `deletion_pending`, or `deleted`.
An invitation, API key, service principal, agent, external unknown principal,
deployment identity-recovery custodian, or deployment organization-governance
custodian never counts as a human owner or organization recovery steward. An
organization recovery steward is an explicit active-human membership capability; it is
not inferred from a legacy admin role.

Direct app-role membership or organization-status DML is denied after canonical
enablement. Narrow serialized functions lock the governance row and affected
memberships, compute the post-state, write both canonical and legacy projections,
increment revisions, append audit/outbox, and reject an active team post-state without
both required human capabilities. Last-owner/steward transfer is one atomic operation.
Deletion retains custody through `deletion_pending`; the terminal transition to
`deleted` deactivates the last memberships in the same transaction. Emergency
suspension that would orphan governance atomically selects `governance_locked`, not an
active state without accountable human custody.

### 3.4 Workspace membership compatibility

Add nullable human identity and/or organization-membership references to
`workspace_memberships`. Keep `subject_id` populated.

When a workspace membership references an organization membership, a composite foreign
key proves both belong to the same organization. The existing composite workspace pair
continues to prove the workspace relationship.

New managed-human writes populate both canonical identity references and legacy
`subject_id = user:<adapterUserId>` in one transaction. Before canonical enablement, an
old legacy-only write remains readable and is synchronously marked for reconciliation.
After canonical enablement, that mutation is rejected by the database fence; it is
never asynchronously granted later.

### 3.5 Invitations

`organization_invitations` and optional workspace-grant templates contain organization
scope, immutable proposed authority, inviter identity, target claim/identity, secret
hash, status, revision, expiry, acceptance actor, and timestamps.

The raw secret never enters the database. Workspace templates carry and validate the
same organization id as the invitation.

### 3.6 Browser session broker

Provider-neutral browser-session and login-slot storage contains opaque ids,
login-account/auth-session references, selected state or revision, expiry/revocation,
CSRF/session generation, and timestamps. Raw upstream tokens remain in the auth adapter
or encrypted credential store.

Migration must not change the behavior of the existing Better Auth cookie until the
broker feature is enabled. Initial sessions may be lazily adopted as a one-slot session
set after successful revalidation.

### 3.7 Entitlement-owner interface

Introduce a typed owner record or concrete per-owner tables for `organization`,
`workspace`, and `personal`. A checked one-of target and concrete/composite foreign keys
are required; a free `(type, uuid)` pair is not enough.

Existing balance, customer, credit, usage, and entitlement state maps to an organization
owner with owner organization id equal to legacy account id. The billing/quota owner
owns detailed ledger changes and must review the final interface.

### 3.8 Audit and revisions

Introduce the separately owned append-only audit authority from ADR section 18 and
augment events with actor human/login/slot or principal identity, authorization
revision, request/idempotency id, scope, outcome, assurance summary, chain sequence, and
integrity fields. Legacy audit calls are adapted to the append function during the dark
phase; direct mutable app-role access is removed before any governance endpoint enables.

Add monotonic security/authorization revisions to the smallest appropriate governance,
membership, and login rows. A durable outbox carries invalidation after the committing
transaction; publishing before commit is forbidden.

### 3.9 Deployment identity-recovery persistence and privilege

`deployment_authority_planes` has exactly one versioned row for each closed plane kind,
`identity_recovery` and `organization_governance_custody`. Each row stores independent
offline-root public/factor digest and algorithm, policy digest/version, configured
quorums and path availability, eligibility age, notice-channel references, state
(`unconfigured`, `enrollment_pending`, `enabled`, `degraded`, `reconstituting`, or
`disabled_unavailable`), monotonic revision/generation, unavailable reason, and last
verified root ceremony. No root secret is stored. A constraint prevents one root/factor
reference from satisfying both plane kinds.

Plane-local custodian rows store proved human operator id, independent factor-root
digest, lifecycle state (`absent`, `enrollment_pending`, `cooling_off`,
`active_ineligible`, `active`, `factor_rotation_pending`, `revocation_pending`, or
`revoked`), enrolled/eligible timestamps, human/factor/custodian/plane revisions, and
no-content capability reference. Separate immutable operations/approval tables persist
enrollment, activation, planned and compromise revocation, factor rotation, atomic
replacement, and lost-quorum reconstitution. Each includes unique idempotency key,
expected root/policy/plane/custodian/factor/human revisions, incident, distinct operator
and offline-root approvals, notices, cooling/eligibility deadlines, generation,
checkpoint, and outcome. A replacement generation activates an eligible successor
before predecessor revocation; ordinary mutations whose locked post-state loses quorum
are rejected. Compromise revocation commits immediately and may select `degraded`.

Lost-quorum reconstitution rows require the exact precommitted offline-root signature,
independent incident/legal basis, long-cooling deadline, notices, proposed new eligible
set, and old/new plane generations. While nonterminal, the plane's recovery claims are
database-denied. An unavailable/disputed offline root selects
`disabled_unavailable`; no runtime role or remaining custodian function can lower a
quorum or self-enroll. Plane and custodian mutation functions are distinct per plane or
accept only a non-caller-selectable installed capability fixed to one plane kind.

Human recovery factors are owned by a human identity, stored as verifier metadata or
encrypted references, and versioned independently from login accounts and organization
memberships. Factor secrets never enter audit, tenant projections, or organization
tables.

Deployment identity-recovery custodians are separately enrolled human operator
identities with a dedicated no-content capability, factor root, status/revision, and
eligibility timestamps. Enrollment does not create an organization membership and
confers no tenant discovery, workspace access, or ordinary support wildcard. The
custodian role cannot be synthesized from organization owner/admin/recovery standing.

Custodian-backed identity operations reference one `enabled` identity-plane revision
and exact viable path. Database constraints/functions reject an approval from another
plane, an `active_ineligible`/revoked custodian, a stale plane revision, or a path
recorded unavailable. A person enrolled in both planes has two independent rows,
factors, revisions, and capabilities.

`identity_recovery_operations` and immutable approval/evidence rows store the target
human security revision, requested global effects, authority path, factor/custodian
identities, notice set, affected-grant digest, deadlines, idempotency key, generation,
state, revocation outbox references, and sanitized deployment-audit outcome. Only
schema-qualified identity-recovery functions held by the dedicated deployment
capability can mutate these rows or human/login/session state. They accept no
organization-derived authority and deny self-approval, stale/new custodian enrollment,
insufficient distinct factors, expired approval, missing notice, or revision mismatch.

Apply fences the target first, then atomically increments global security revisions and
revokes every affected login slot, auth session, personal credential, offline cache,
user-bound delegated token, and stream before a newly proved path is usable. It never
changes an organization membership, organization role, workspace grant, billing owner,
or personal-workspace owner. Tests compare seeded organization A, organization B, and
personal state before and after both allowed and denied ceremonies.

### 3.10 Organization governance recovery persistence and privilege

Organization recovery operations store exactly one organization id and governance
revision, requested membership/custody effects, eligible active human recovery
stewards, approvals/notices/deadline, incident, idempotency key, generation, state, and
organization-scoped audit/outbox references. The operation cannot name or mutate a
login binding, global human status, human-private owner, another organization, or a
personal workspace outside its named organization.

Ordinary organization recovery is authorized only by the organization's explicit
active human recovery stewards under its closed quorum/delay policy. If immediate human
suspension places an organization in `governance_locked`, separately authorized
deployment governance custody—not a deployment identity-recovery custodian merely by
virtue of that role—may use a delayed, noticed, audited ceremony to appoint a proved
human owner/steward. The new human must independently prove a usable login; the ceremony
cannot recover sign-in. Reactivation and appointment commit atomically only when the
active-team invariant is satisfied.

Deployment organization-governance custodians have their own enrollment, status/
revision, separately held factor roots, no-content database capability, and deployment/
organization audit trail. They are not organization memberships. Their three-human
exceptional quorum cannot attach a login or alter global human status, and enrollment
as a deployment identity-recovery custodian never implies eligibility here or vice
versa.

This role uses only the `organization_governance_custody` plane instance and its own
custodian/lifecycle/reconstitution rows from section 3.9. Exceptional unlock is exposed
only when the plane is `enabled` at one current revision and has at least three distinct
`active` eligible custodians/factors. Fewer than three, or `unconfigured`,
`enrollment_pending`, `degraded`, `reconstituting`, or `disabled_unavailable`, is a
durable unavailable result; no organization row or support role fills the gap.

Organization-recovery functions run under an organization-scoped capability whose SQL
surface cannot address human/login/recovery-factor tables. Deployment identity-recovery
functions cannot call organization-recovery functions as an implicit side effect.
Cross-scope equality checks prove that either operation leaves all prohibited rows and
revisions unchanged.

### 3.11 Identity-merge barrier, staging, provenance, and repair

Identity merge persistence separates:

- one merge operation and fencing generation with source security revisions, proofs,
  decisions, notices, deadlines, and irreversible-prerequisite acknowledgments;
- a mutation barrier covering source-human owner, organization-governance, billing, and
  human-private-owner changes;
- bounded staged rows, checkpoints, a revision-bound manifest digest, and categorized
  apply effects that remain authorization-invisible until cutover;
- source-contribution rows and canonical derived rows so authorization never computes a
  dynamic union from two humans;
- observation-window write provenance keyed by object owner plane/id and merge
  generation/sequence; and
- dispute containment, forward-repair plans/approvals/checkpoints/outcomes, and explicit
  irreversible-effect records.

Staging orders stable keys and commits at most 500 rows or 250 ms per transaction. The
short cutover locks only the two human security rows, barrier/generation, affected
governance summary revisions, and session generations; it validates the complete
staged digest, activates canonical custody before source contributions become inactive,
flips canonical resolution, revokes source sessions/credentials, and appends outbox and
audit atomically. A crash before commit returns to staged validation with no visible
partial merge.

During the 30-day applied-observation period, every affected write must transactionally
append merge generation/sequence, owner plane and before/after owner, tenant pair,
actor/login/source lineage or service actor, before/after revision, idempotency/outbox/
external-intent references, digest or tombstone, and conflict/reversibility class. A
later external receipt appends to that exact intent/sequence. A write path that cannot
persist its required provenance is denied. Billing postings,
entitlement changes, credential revocations/creation, deletes, audit facts, external
effects, and personal-organization prerequisites retain their own subsystem authority
and an explicit irreversible or compensatable classification.

A timely dispute first commits containment and revocation, then builds a paginated
provenance manifest. Scoped authorities approve only their own plane's deterministic
forward-repair outcomes. Approvals expire after 14 days or any referenced revision
change without releasing containment. Repair commits bounded idempotent batches and a
final per-category report of retained, transferred, revoked, quarantined, compensated,
and irreversible effects. There is no inverse ledger or state named `reversed`.

### 3.12 Wrongful-merge identity separation persistence

`identity_separation_operations` stores the originating merge/generation, unique
idempotency key, retained source/canonical and optional replacement human ids, starting
human/login/security/alias/private-owner/tenant/billing/authority-plane revisions,
claimant proofs, deployment approvals, notices/disputes/deadlines, state, barrier and
staging generation/digest/checkpoints, revocation/outbox references, and signed terminal
outcome. Only a contained merge may create it, and one exclusion constraint/serialized
function prevents another nonterminal identity operation from naming either claimant.

Alias persistence distinguishes immutable history from current authorization. Alias
lineage rows retain the absorbed→canonical merge edge forever under policy, but current
resolver-generation rows select only one active self/replacement target per proved
person; historical/tombstoned edges cannot authorize. Reusing the retained source human
id is required when structurally valid. A replacement human id requires an immutable
`replacement_of` edge and reason. Human and login rows carry status plus security/
resolver generation so a stale login, alias, or cache fails after cutover.

Separate disposition rows bind each login to one proved claimant and expected binding
revision, or quarantine it. Source/canonical sessions, token families, personal
credentials, delegated tokens, caches, push registrations, and streams are enumerated
in a revocation manifest that commits with the resolver cutover before either claimant
may reauthenticate. Personal-organization outcomes preserve uniqueness and record
converted/deleted tombstones that cannot be recreated by separation.

Per-plane decision rows enforce authority ownership: deployment identity authority can
approve only resolver/human/login mappings; each organization approves only its exact
membership/role/custody outcome; billing authority approves only compensation; and
private-owner rows transfer only with unique lineage and proof. Ambiguous/joint rows
carry a quarantine owner/status rather than a guessed human. Inactive separation rows
stage in stable-key batches of at most 500 rows or 250 ms, and one short digest-checked
generation transaction activates two independent resolvers, revocations, owner
decisions, outbox, and audit. Crash before commit leaves the merged identity contained;
there is no partial resolver activation.

Terminal states are `separated`, `separated_with_quarantine`,
`separated_with_irreversible_exceptions`, and `contained_unresolved`. The last leaves
both claimant paths denied and requires a new fully proved generation. Persistence must
not offer an “unmerge” flag, mutable alias rewrite, automatic tenant-grant copy, or
personal-organization recreation.

### 3.13 Personal-to-team conversion persistence

`personal_team_conversion_operations` stores exactly one organization id, unique
idempotency key, expected personal kind/governance revision, owner human/security proof,
proposed active human owner/recovery-steward rows and factor revisions, billing/
entitlement revision and one explicit terminate/transfer/new-team decision, collaborator
and notice manifest, cooling deadline, state, barrier generation, and audit/outbox ids.
States are `review`, `cooling_off`, `ready`, `applying`, `converted`, `blocked`, and
`aborted`; retries with different inputs under one key fail.

One serialized organization barrier excludes kind, custody, billing, delete, transfer,
and identity-merge-prerequisite races while allowing ordinary workspace data writes
under the unchanged tenant pair. The `applying` transaction changes only the existing
organization kind, activates team custody first, applies the reviewed billing decision,
bumps governance/billing/barrier revisions, and appends outbox/audit. Existing
organization/workspace/resource ids and collaborator workspace grants do not change.
A transaction abort returns to `ready`; no partial kind/custody/billing state is visible.
Identity merge can satisfy this prerequisite only with terminal `converted`.

No organization-merge table, second-organization target, consolidation job, or generic
resource-reparent primitive is introduced. Database functions and API schemas reject a
second organization id as `organization_merge_unsupported`.

### 3.14 External delivery capability and receipt persistence

Every governed external effect, including a compensating effect, has its own delivery
row linked to its operation/provenance record with stable effect/idempotency key,
canonical request digest, destination and typed owner scope, provider adapter id,
capability snapshot/version, idempotent-publish/status-query/compensation flags, attempt
limit, owner/authority revisions, state, claim generation, timestamps, and sanitized
receipt/failure/query evidence digests. The delivery-state constraint admits only
`prepared`, `publish_claimed`, `receipt_confirmed`, `failed_confirmed`,
`delivery_unknown`, `reconciling`, and `irreversible_exception_approved`. An append-only
original→compensation relation separately admits `compensation_pending` or
`compensated`; it cannot replace either delivery row or its evidence.

A unique claim/attempt constraint plus narrow function commits `publish_claimed` before
network I/O. Provider idempotent retry reuses the exact key/digest and is allowed only
after status query when supported; provider capability-version mismatch blocks it. A
non-queryable/non-idempotent provider has one at-most-once claim, so missing receipt
remains `delivery_unknown`. Status-query attempts, bounded-backoff checkpoints,
compensation child records with their own keys/digests/capability snapshots, and signed
scoped exception approvals are append-linked rather than overwriting the original
attempt. The child uses the same claim-before-network and reconciliation machine. Its
verified receipt atomically marks the relation `compensated`; an unknown or definitively
failed child leaves the relation `compensation_pending` and does not resolve the
original.

Merge finalization queries a locked aggregate constraint/function and succeeds only
when every original effect is `receipt_confirmed`, `failed_confirmed`, or
`irreversible_exception_approved`, or has a linked `compensated` relation backed by a
receipt-confirmed child. Any prepared/in-flight/unknown/reconciling delivery row or
compensation-pending relation selects `finalization_blocked`; a failed compensation
child is terminal for its own publish but does not make an unknown original acceptable.
An approved unresolved exception forces `repaired_with_exceptions` and cannot be
represented as a successful receipt.

## 4. Backfill classification

Backfill reads stable ids and explicit external sources only. It never merges by email.

### 4.1 Better Auth personal accounts

For each `managed_accounts` row whose external source identifies one Better Auth user:

1. Resolve the exact referenced `auth_users.id`.
2. Create one human identity using a deterministic migration key/idempotency record.
3. Create the corresponding login account using the local deployment issuer plus user
   id as provider subject/adapter reference.
4. Mark the managed account as a personal organization owned by that identity.
5. Create an active owner organization membership.
6. Link every `user:<id>` workspace membership to that identity, including memberships
   in other organizations.

This deterministic personal-owner mapping does not enroll an organization recovery
steward, human offline recovery factor, or deployment identity-recovery custodian. The
personal organization remains in the legacy/dark governance phase until its required
human recovery path is explicitly enrolled and verified.

Missing referenced users, duplicate external mappings, or one user mapped to multiple
personal organizations are quarantined for operator resolution. They are not guessed or
silently merged.

### 4.2 Shared workspace memberships

For each distinct `(organizationId, legacy subjectId)` with workspace access:

- if subject maps unambiguously to a human identity, ensure an organization membership
  with at least `member` discovery standing and link workspace memberships;
- if it is an API key or known service principal, retain the self-carried credential
  path and do not manufacture a human membership; and
- if it is configured/local/unknown, create or retain a typed external-principal binding
  with no human governance authority.

Existing role strings do not automatically become owner/admin organization roles. Only
the personal account's exact legacy owner mapping backfills owner. All other elevation
requires an explicit reviewed rule or human operation.

An existing row that will become a team organization remains `governance_pending` until
an authenticated ceremony appoints at least one active human owner and one active human
organization recovery steward and records required steward factors. A single proved
human may hold both capabilities only if deployment policy allows it, but both
capabilities remain explicit. Legacy role text, verified email, invitation, agent/API
key, billing contact, support operator, deployment identity-recovery custodian, or
deployment organization-governance custodian never supplies either team-governance
capability automatically.

### 4.3 Legacy billing

For each legacy billing customer, ledger, usage, and entitlement scope:

- create/resolve one organization entitlement owner for the same organization UUID;
- preserve source workspace and existing idempotency/provider ids;
- shadow-compare balances and entitlement results before switching reads; and
- never infer billing owner from login account or Codex/provider credential labels.

### 4.4 Backfill mechanics

- Use bounded primary-key ranges or `SKIP LOCKED` batches with committed checkpoints.
- Each row writes deterministic idempotency keys and is safe to retry after interruption.
- Store counts for scanned, created, already-current, quarantined, and failed rows.
- Do not hold a table-wide lock or run one unbounded transaction.
- Backfill runs with explicitly reviewed cross-workspace migration authority; product
  app code remains under FORCE RLS.
- A second complete pass must produce zero new rows before feature enablement.

### 4.5 Recovery and governance enrollment gate

Backfill creates no approval, quorum, proof, or recovery factor. Before an organization
can become canonical `active`, the enablement transaction must prove:

- its kind and governance status are resolved and its governance revision is current;
- a personal organization has its exact proved personal owner and required human
  recovery path;
- a team organization has at least one active proved human owner and one active proved
  human organization recovery steward, even if it has no resources;
- all steward/factor enrollments were completed through noticed, step-up ceremonies,
  not data inference;
- each deployment authority plane has an operator-selected mode, independent committed
  offline-root/policy digest when configured, and current state/revision; no root or
  custodian is inferred from tenant or legacy operator data;
- every advertised identity-recovery path has enough current eligible factors/
  custodians to satisfy its configured quorum, or that exact path is durably marked
  unavailable; a degraded/reconstituting plane cannot pass;
- exceptional organization-governance custody has an `enabled` current plane and at
  least three distinct eligible custodians/factors, or is durably marked unavailable
  and absent from recovery promises;
- no incompatible binary lease, quarantine, role ambiguity, or canonical/legacy grant
  mismatch remains; and
- identity-recovery custodians, if deployment policy enables them, were separately
  enrolled under deployment authority and are not counted in tenant custody.

If these checks are incomplete, legacy authorization may continue only in the
pre-canonical phase; v2 governance and recovery endpoints remain unavailable. The
system does not silently mark an unresolved team active or strand it without custody.
Canonical enablement records a signed capability digest proving each recovery path
viable or explicitly unavailable; “support can fix it” is not a third state.

## 5. Constraint rollout

1. Create tables/nullable columns/indexes and RLS policies.
2. Deploy code that dual-writes while continuing legacy reads.
3. Backfill and reconcile.
4. Add composite/relationship constraints as `NOT VALID` where PostgreSQL supports it.
5. Validate constraints online and prove no mismatch/quarantine remains in enabled
   tenants.
6. Enable shadow reads and compare canonical versus legacy access contexts.
7. Drain incompatible binaries, install the versioned database capability/fences, and
   prove there is no old writer or reader lease before any tenant changes authority.
8. Install and test distinct database capabilities for ordinary canonical governance,
   exact-organization recovery, deployment organization-governance custody, deployment
   identity recovery, each authority-plane root/custodian lifecycle, append-only audit,
   merge staging, identity-separation staging/cutover, personal-to-team conversion,
   external delivery claim/reconciliation, observation provenance, and contained
   forward repair. No role may inherit a broader plane merely for convenience.
9. Complete the section 4.5 enrollment gate and enable canonical reads for an
   allow-listed cohort. Canonical/legacy disagreement is
   denial plus quarantine, never a fallback grant.
10. Enable multi-account/invitation UI after auth and revocation tests pass.

No constraint/capability rollout introduces organization merge. A schema/function that
accepts two organization ids for kind conversion, consolidation, or reparenting fails
review and remains database-denied.

No `NOT NULL`, column drop, table rename, legacy-write removal, or policy relaxation is
part of the initial feature rollout.

## 6. API and SDK evolution

### Phase A: additive aliases

- Add `organizationId` beside `accountId` in responses; values are exactly equal.
- Requests accept either; if both are supplied they must be equal.
- Add organization membership/invitation/login-slot endpoints as new routes.
- Add one-organization personal-to-team conversion, deployment-plane lifecycle/status,
  identity-separation, and external-delivery status resources behind reviewed
  capabilities; clients surface durable states rather than manufacturing transitions.
- Reject any organization-merge/consolidation target as
  `organization_merge_unsupported`; absence of a server endpoint is not permission for
  an SDK to copy/reparent resources.
- Existing workspace routes and SDK methods remain valid.
- Feature discovery tells a new client whether organization v2/session slots are
  available; absence is not treated as an authentication failure.

### Phase B: preferred naming

- New SDK APIs and docs prefer `organizationId` while retaining deprecated aliases.
- SDK conversion accepts exactly one organization and exposes
  `organization_merge_unsupported` as terminal. Separation/reconciliation SDK surfaces
  are read/act wrappers over server generations and scoped authority, never local
  alias rewrites or blind provider retries.
- Access context v2 contains selected human/login summary plus organizations and
  explicit workspace grants.
- Old clients continue to receive legacy grants derived from canonical memberships.
- New clients against old servers hide unsupported multi-account/invite operations and
  retain existing single-account behavior.

### Future major cleanup

A future major may remove deprecated wire aliases only after telemetry and support
policy show no supported clients depend on them. Physical `account_id` columns may stay
forever; a database rename is not required for public correctness.

## 7. Mixed-version writer and reader authority

Authority is explicit per rollout phase:

| Phase | Legacy-only reader/writer | V2 reader/writer | Access decision and rollback |
| --- | --- | --- | --- |
| `legacy` | Authoritative under existing workspace rules | May shadow and dual-write but cannot grant through canonical state | Roll back freely; v2 governance absent |
| `expanded_dark` | Still authoritative; legacy-only mutations are recorded for synchronous reconciliation | Writes canonical + legacy projection in one transaction; reads legacy and compares shadow | Roll back freely while no tenant leaves this phase |
| `reconciled` | Reads/writes allowed only while the deployment has no canonical-enabled tenant; all discrepancies block enablement | Same as dark; complete backfill and shadow parity required | Drain begins; no new feature exposure |
| `canonical` | Denied by versioned database capability/RLS and mutation fences for that tenant | Sole authority; human access requires active canonical org/workspace grants and an equal legacy projection | Roll back only to a v2-compatible binary; otherwise affected traffic remains fail-closed/unavailable |
| `canonical_degraded` | Denied | Reads/mutations with any canonical/legacy/revision disagreement deny and quarantine; security revocation still removes both projections atomically | Repair forward with compatible binary; never re-enable legacy authority |

The database capability is unforgeable by request input or a settable GUC. The final
implementation uses a versioned non-login database role/capability, provisioned only to
v2-compatible API/worker deployments and consumed by RLS/policy functions. Its exact
role and provisioning require the runtime DB-role owner's review. An ordinary legacy
app role cannot `SET ROLE` into it. A deployment registry also records live binary
protocol leases; tenant cutover locks the registry and refuses while an incompatible
API, worker, migration worker, or background claimant is live.

For a canonical tenant, direct legacy workspace-membership DML is rejected. Compatible
code calls one locked domain/database operation that writes canonical membership,
legacy `subject_id` projection, authorization revision, invalidation outbox, and audit
append in one transaction. Revocation marks canonical standing inactive and removes or
invalidates the legacy projection before commit. The tenant governance row is locked
before membership rows, so an old/new writer race has one serial order: a legacy write
before cutover is reconciled before enablement; after cutover it fails and cannot
reauthorize a revoked human.

The same direct-DML denial applies to canonical organization membership, owner/steward
capabilities, governance status, recovery operation, authority-plane/custodian
lifecycle, merge/separation barrier/staging/provenance, conversion, external delivery,
and repair rows. Each narrow function has one declared authority plane and deterministic
lock order. No generic administrator function may accept a caller-selected scope and
then mutate deployment-human, organization-governance, billing, resolver, or provider-
delivery state together.

New web against old API remains in legacy single-account mode. Old web/SDK against new
API continues to receive additive legacy fields, but its server is still v2 authority.
New API with an incompatible old worker cannot enable identity-dependent jobs; workers
must hold the same protocol capability before claiming those rows. Once any tenant is
canonical, rollback to a pre-v2 API/worker is not a supported availability rollback:
the versioned database fence keeps it from serving that tenant. Recovery is forward to
the last v2-compatible binary.

## 8. Rollout sequence and abort gates

### Gate 0: design

- Independent exact-head ADR/threat-model approval.
- Adjacent owners re-reconciled and implementation paths reserved.
- Final DDL/API contract reviewed by RLS, billing, auth, SDK, and UI owners.

### Gate 1: schema expand, dark

- Apply additive migration before dependent binaries.
- Enumerate every new table, FK, index, policy, app-role grant, and schema-qualified
  function in clean and upgraded databases.
- Assert both authority-plane rows/lifecycle functions are disjoint, no organization-
  merge primitive exists, and all resolver/delivery state constraints are installed.
- Abort if any old binary health/read/write check changes.

### Gate 2: dual-write and backfill

- Deploy dual-write code with canonical reads off.
- Run bounded backfill and shadow projection.
- Abort/disable v2 for any tenant with unresolved duplicate, missing subject, membership
  mismatch, balance mismatch, or RLS-policy failure.
- Keep canonical governance impossible to enable while any incompatible binary lease
  exists; exercise old/new mutation races continuously.
- Keep v2 governance unavailable for rows that lack explicit owner/steward/factor
  enrollment; never “fix” the gate by deriving authority from legacy role/email data.
- Keep every custodian-backed path unavailable until its plane/root/current eligible
  quorum proves viable; exercise immediate compromise revocation and lost-root failure.

### Gate 3: read enablement

- Drain incompatible binaries, rotate/provision the v2 database capability, and prove
  the legacy app role cannot read or mutate a canonical tenant.
- Atomically switch an internal tenant governance row from `reconciled` to `canonical`
  and organization governance from `governance_pending` to `active` only after parity,
  zero-quarantine, and section 4.5 human-custody checks under the same lock.
- Verify revocation deadlines, old-client behavior, and no cross-tenant query/metric.
- Verify organization-A governance recovery leaves global human, organization-B, and
  personal state byte-for-byte/revision-for-revision unchanged, and deployment identity
  recovery leaves all organization governance rows unchanged.
- Verify personal-to-team conversion preserves every tenant/resource id and collaborator
  grant while atomically changing custody/billing; organization-merge inputs deny.
- Verify contained wrongful merge cannot authenticate until a two-resolver separation
  cutover, and provider delivery unknown selects `finalization_blocked` without retry.
- Gradually widen; feature flag rollback changes reads/UI only, never schema.

### Gate 4: multi-account/invitations

- Enable browser broker and invitation flows only after cookie/CSRF/callback/replay tests
  and real-browser evidence.
- Keep single-account adoption path and per-slot rollback fence.

### Gate 5: cleanup (separate project)

- Remove legacy fallback or deprecated fields only in a later reviewed major.
- Never combine cleanup with first production enablement.

## 9. Binary rollback and operational recovery

- Rolling back API/web/worker leaves expanded schema and canonical rows intact.
- Before any canonical tenant exists, legacy workspace authorization continues exactly
  as before and a binary rollback is available.
- After canonical enablement, only a v2-protocol-compatible rollback may serve that
  tenant. A pre-v2 binary remains fenced for reads and writes even if accidentally
  deployed; availability is sacrificed rather than reopening access.
- Disable new mutation endpoints and drain claims before a compatible rollback so one
  authority remains active.
- Do not reverse migrations, delete backfilled rows, or rename columns during incident
  response.
- Re-run reconciliation after returning to a compatible binary.
- If invalidation delivery is impaired, fail closed for new requests by reading current
  revision from Postgres and terminate persistent channels rather than trusting cache.
- A merge dispute rolls no schema or data migration backward. It enters durable
  containment and executes only an approved, provenance-backed forward-repair plan;
  missing lineage or expired approval keeps the operation contained.
- A different-person merge dispute keeps both claimant resolver paths contained until
  section 3.12 atomically activates two independently proved generations. Failed proof,
  missing tenant decisions, or unavailable identity authority never reopens the merged
  resolver.
- A conversion incident before atomic cutover removes/discards only its barrier/
  inactive generation and leaves personal kind unchanged. After `converted`, recovery
  is forward; it never changes kind back or invokes organization merge.
- An ambiguous external publish remains `delivery_unknown`; incident response queries
  or uses exact-key idempotent retry only when the persisted capability permits, and
  never clears `finalization_blocked` manually.
- A custodian compromise revokes immediately and may leave its plane `degraded`.
  Recovery operations remain unavailable until atomic replacement or offline-root
  reconstitution completes; a lost root selects `disabled_unavailable`.
- A `governance_locked` team remains unavailable for governance-sensitive mutations
  until the delayed deployment organization-governance-custody ceremony appoints
  proved human custody. Incident response must not reactivate it with an invitation,
  agent, or login recovery alone.

This is “rollback-free forward compatibility”: recovery rolls binaries/features back,
not data definitions.

## 10. Required migration verification

### Clean database

- Apply full migration list from zero in a non-default schema and default schema.
- Verify all identity/org tables, constraints, policies, grants, and functions.
- Start old and new binaries independently against the expanded database.

### Legacy production-shaped database

- Seed personal accounts, shared memberships, API keys, billing rows, invitations absent,
  deleted/expired auth sessions, configured/local subjects, duplicate display emails,
  and malformed/quarantine candidates.
- Apply migration twice; run backfill to fixpoint twice.
- Compare workspace access, billing balance, usage, and row counts before/after.
- Prove no email equality merged identities.

### Concurrency and crash recovery

- Crash between every backfill checkpoint/write and prove retry convergence.
- Race old writer/new writer/backfill on the same user and membership.
- Race invitation acceptance/cancel/resend and owner leave/demote/transfer.
- Race last-owner and last-steward leave/remove/demote in an empty active team, identity
  suspension, terminal deletion, identity-merge cutover, and organization recovery.
- Crash before/after every merge staging batch, digest validation, generation flip,
  observation write/provenance append, containment, repair approval, and repair batch.
- Race conversion cooling/apply against kind/custody/billing/delete/transfer/merge-
  prerequisite changes; crash before/after barrier, custody activation, billing
  decision, kind flip, outbox, and audit.
- Crash/race every authority-plane bootstrap/enrollment/eligibility/rotation/planned or
  compromise revocation/atomic replacement/lost-quorum reconstitution boundary,
  including root loss and same human independently enrolled in both planes.
- Crash before/after every separation proof/notice/barrier/staging batch/digest/resolver-
  alias-login-generation flip/revocation/private-owner or tenant decision/audit append;
  race stale login and alias resolution during cutover.
- Crash at external intent commit, publish claim, network send, provider success,
  receipt append, status query/result, compensation claim, and compensation receipt;
  prove non-idempotent/non-queryable publish occurs at most once.
- Prove one safe outcome and durable audit/idempotency evidence: active custody,
  `governance_locked`, terminal `deleted`, unchanged staging, contained forward repair,
  two separated resolvers, contained-unresolved identity, unchanged personal kind,
  atomic converted kind, or truthful delivery state—never active missing-human custody,
  a visible partial merge/separation/conversion, one active resolver shared by two
  people, or assumed external success.

### FORCE-RLS

- Run as the non-owner app role in real PostgreSQL.
- Cross-tenant read/write every new organization/workspace table.
- Test wrong composite pairs, absent GUCs, stale pooled connections, and dedicated
  schemas.
- Assert existing protected-table coverage does not decrease.
- Deny organization-A recovery against human/login and organization-B/personal rows;
  deny deployment identity recovery against organization-governance rows.
- Deny cross-plane custodian approval/lifecycle use, tenant/support root mutation,
  recovery under degraded/reconstituting/unavailable plane, and self-expanding quorum.
- Deny identity-separation authority from tenant roles; deny deployment authority from
  mutating tenant grants/billing/private quarantine; deny stale alias/resolver generation.
- Deny conversion with second organization id, stale owner/custody/billing/barrier
  revision, implicit collaborator organization role, or organization-merge target.
- Deny delivery claim/retry with wrong owner scope, key/digest, provider capability
  version, generation, or compensation/exception authority.
- Deny an affected observation-window write when its provenance append is absent,
  stale, wrongly scoped, or fails in the same transaction.

## 11. Evidence required for candidate handoff

The implementation candidate must freeze and report:

- exact base/head/tree and ordered file list;
- exact migration checksum and schema before/after inventory;
- backfill/reconciliation counts with quarantines explicitly zero or blocked;
- unit, contract, API, SDK, migration, real-Postgres FORCE-RLS, concurrency,
  auth/revocation, and browser commands/results;
- old/new binary compatibility matrix results;
- authority-plane root/policy/mode and viable-or-unavailable path proof with no secret
  root/factor material;
- merge/separation/conversion/external-delivery state-machine crash/race results and
  signed exception/quarantine summaries;
- scrubbed UI evidence across required states; and
- remaining provider/host limitations and residual risks.

No successful migration, staging check, merge, or release makes the issue Done. The
identical accepted revision must be deployed and verified live in production under the
release owner's control.

## 12. Exact normalization, uniqueness, and tombstones

Normalization has a version stored beside every normalized value. Changing a rule is a
new migration and shadow comparison, never an in-place reinterpretation.

### 12.1 Issuer and provider subject

For URL issuers, require an absolute URI with no userinfo, query, or fragment.
Canonicalization lowercases the ASCII scheme and IDNA A-label host, removes only the
scheme's default port, and preserves path, percent encoding, and trailing slash exactly. OIDC
issuer equality remains exact after those authority-component rules; paths are
case-sensitive and no percent decode or Unicode normalization occurs. Non-URL issuers
must use a registered ASCII `urn:opengeni:issuer:<adapter>:<opaque>` namespace; unknown
formats are rejected.

Provider subject is an opaque, case-sensitive bytewise UTF-8 string from the configured
issuer, 1–1024 bytes, with no trimming, case folding, email parsing, or Unicode
normalization. The database uses deterministic `C`/bytewise collation for canonical
issuer and subject. The unique key is `(canonical_issuer, provider_subject)`; a digest
may accelerate lookup but cannot replace collision-checked original bytes. Raw issuer
is retained for display/diagnostics, never equality.

### 12.2 Verified invitation email

Email is only a target claim. Trim surrounding ASCII whitespace, split at the final
`@`, reject empty/control/invalid UTF-8 components, convert the domain to lowercase
IDNA A-label form, and preserve the local part byte-for-byte and case-sensitive by
default. Do not remove dots, strip plus tags, map aliases, or apply consumer-provider
rules. A deployment may register an issuer-specific local-part canonicalizer only with
an immutable version and exact verified issuer; invitation creation and acceptance must
use the same version. Store claim type, canonical value, canonicalizer version, and
verifying issuer. Equality alone never links humans.

At most one active invitation with identical organization, target claim/version, and
proposed authority is allowed. A resend rotates its secret on that row. Different
authority remains a visible inviter conflict, not last-write-wins.

### 12.3 Organization and workspace slugs

Route slugs are restricted to lowercase ASCII: start/end alphanumeric, internal
alphanumeric or single hyphen, 1–63 bytes. Input is trimmed and ASCII-lowercased; any
other Unicode, consecutive hyphen, or lossy transliteration is rejected. Organization
slug is unique deployment-wide. Workspace slug is unique within organization. Unique
indexes use bytewise collation and partial predicates over live/reserved states.

Soft deletion creates a tombstone retaining normalized slug, former owner scope,
deletion/finalization times, and deep-link/invitation invalidation generation. Slugs are
never automatically reused. An authorized operator may reclaim only after the
deployment's declared retention (never less than 90 days), zero live links/invites/
callbacks, explicit takeover warning, step-up, and audit. Reclaim increments generation
so stale signed state cannot resolve to the new tenant.

## 13. Migration identity and online DDL transaction rules

This design intentionally names no migration number. Immediately before implementation,
the sole schema owner must fetch current `main` and every accepted adjacent candidate,
reserve the next identity through the repository's migration ownership process, and
record the exact prefix/checksum in Linear and the PR. A placeholder or locally guessed
number may not be committed.

Online expansion is split by PostgreSQL transaction semantics:

1. One short rolling migration creates nullable columns/tables, functions, triggers,
   RLS policies, and unvalidated FKs with `lock_timeout = '1s'`, ordinary DDL
   `statement_timeout = '5s'`, and no table rewrite/default requiring a heap scan.
2. A nontransactional reviewed migration creates each large unique/supporting index via
   `CREATE INDEX CONCURRENTLY`, one at a time, with `lock_timeout = '1s'` and
   `statement_timeout = '30min'`. An invalid index after crash is detected, dropped
   concurrently, and retried; it is never treated as complete.
3. A short migration attaches constraints to proven indexes or adds them `NOT VALID`.
   Constraint validation runs separately with a 30-minute statement timeout and aborts
   on operational gates below.
4. `NOT NULL`, legacy column removal, table rename, heap-rewriting default, and broad
   policy replacement are excluded from the initial rollout.

Each DDL unit records start/end catalog inventory and exact checksum. Failure leaves
expanded compatible schema; recovery repairs forward. No transaction contains both
concurrent index creation and ordinary DDL.

## 14. Bounded backfill and large-tenant operating envelope

Backfill orders by immutable primary key and processes at most 500 rows per transaction.
Each transaction targets 250 ms, has `lock_timeout = '1s'`, `statement_timeout = '5s'`,
and `idle_in_transaction_session_timeout = '5s'`. It locks only selected rows with
`FOR UPDATE SKIP LOCKED`, writes canonical row + legacy projection + checkpoint in the
same transaction, and commits before fetching the next batch. A deterministic source
key and categorized effect record make replay after crash idempotent. Identity-merge
staging uses the separately fenced manifest/provenance contract in section 3.11 rather
than treating generic backfill records as merge-repair evidence.

The controller pauses new batches when any default gate persists:

- primary or replica database CPU is above 80% for five minutes;
- replay/replication lag exceeds 10 seconds;
- migration-attributable WAL exceeds 1 GiB in five minutes or free WAL/disk capacity
  falls below 20%;
- application p95 database latency rises more than 20% over the recorded 30-minute
  baseline for five minutes;
- a batch waits on a lock for one second, exceeds five seconds, or reports a deadlock;
  or
- error/quarantine rate exceeds 0.1% or any authorization mismatch appears.

Resume requires ten healthy minutes and an operator/controller checkpoint. Any
cross-tenant result, duplicate canonical key, unexplained count/balance mismatch,
governance-invariant violation, audit-chain failure, or legacy grant without canonical
source is an abort for that tenant, not a skipped row. Provider-specific monitors may
use stricter values; weakening these defaults requires a new recorded migration review.

Backfill never runs one transaction per tenant when the tenant is unbounded. For a hot
tenant it interleaves small ranges, preserves stable ordering, and exposes progress by
source table/range without raw tenant labels in shared telemetry. A second full scan and
a separately started reconciliation pass must both reach a zero-change, zero-quarantine
fixpoint before the tenant can become `reconciled`.

## 15. Required clean, upgrade, crash, race, and scale proofs

In addition to section 10, the implementation must prove:

- canonicalization fixtures for URL authority case/default ports, significant issuer
  path/trailing slash, opaque subject case/Unicode bytes, IDNA domains, case-sensitive
  email local parts, provider-specific versioning, and ASCII slug rejection;
- clean install and production-shaped upgrade produce the same constraints/indexes/
  policies/grants despite different row histories;
- crash before/after every DDL unit, concurrent-index phase, batch write, checkpoint,
  identity merge stage/cutover/provenance/containment/repair effect, audit append, and
  tenant authority flip converges forward;
- organization-A recovery cannot reactivate login/global-human state or mutate
  organization-B/personal state, while deployment identity recovery cannot mutate any
  organization governance; include failed quorum, stale factor, notice failure, and
  revision-race cases;
- deployment organization-governance custody cannot attach a login, change global
  human status, read content, or satisfy active-team custody itself; its distinct
  three-human/delay ceremony may only appoint a freshly proved human under the locked
  organization revision;
- each deployment authority plane independently exercises unconfigured/enrollment-
  pending/enabled/degraded/reconstituting/disabled-unavailable states and every
  custodian lifecycle transition; ordinary quorum-losing removal denies, atomic
  replacement activates successor first, compromise revokes immediately, and lost
  offline root never lowers quorum or self-expands authority;
- an empty active team cannot lose its last active human owner or recovery steward under
  leave/remove/demote/suspend/delete/merge/recovery races; invitations, agents, API
  keys, service principals, and either kind of deployment custodian never count;
- large identity merge staging remains authorization-invisible, bounded to 500 rows or
  250 ms per transaction, and finishes with a short digest-validated generation cutover
  that activates canonical custody before source deactivation;
- concurrent post-apply writes from both source identities, affected organizations, and
  service actors append complete ordered provenance or fail; test memberships,
  invitations, private objects, billing/entitlements, credential creation/revocation,
  audit, deletes/tombstones, and external receipts;
- dispute containment revokes and fences before review, missing provenance denies,
  repair approval expires after 14 days without releasing containment, and reports
  distinguish retained/transferred/revoked/quarantined/compensated/irreversible effects
  including personal-organization conversion/deletion and external facts;
- wrongful-merge separation prefers the retained source id, tombstones historical alias
  authorization, proves or quarantines every login, revokes every source/canonical
  credential before reauthentication, preserves deleted/converted personal-org facts,
  moves only uniquely attributable private state, and ends exactly separated,
  separated-with-quarantine, separated-with-irreversible-exceptions, or contained-
  unresolved without inventing tenant grants;
- personal-to-team conversion traverses review/cooling/ready/applying/converted and
  blocked/aborted paths, preserves ids/resources/workspace-only collaborators, activates
  human owner/steward and explicit billing outcome atomically, and rejects every
  organization-merge request;
- external delivery crash points prove exact-key/digest idempotent retry only,
  query-before-retry where supported, at-most-once non-idempotent publish,
  `delivery_unknown` reconciliation/compensation/exception authority, and merge
  `finalization_blocked` until every effect is terminal-acceptable;
- a legacy writer racing canonical grant/revoke before cutover is reconciled, while the
  same write after cutover is database-denied and cannot restore access;
- old reader, old worker, or stale job claimant lacks the v2 database capability and
  receives no canonical-tenant data;
- canonical-only row, legacy-only row, mismatched revisions, and mismatched owner pair
  all fail closed and quarantine;
- generated large tenants exercise at least the greater of production p99 or 1,000,000
  owner/resource rows, and at least the greater of twice the largest production
  membership fan-out or 100,000 memberships in one organization, while a
  throttle-injection test trips each CPU, lag, WAL, disk, latency, lock, and error gate;
  and
- rollback before cutover preserves legacy availability, whereas attempted pre-v2
  rollback after cutover is visibly unavailable rather than permissive.

Results include batch duration, locks, WAL, lag, CPU, latency, rows/sec, retries,
quarantines, and fixpoint counts. Synthetic scale below either stated floor is not
acceptance evidence.
