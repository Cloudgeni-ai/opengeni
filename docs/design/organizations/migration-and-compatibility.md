<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# Organizations and identity migration and compatibility plan

Status: **revised proposal after blocked review; no DDL may land before approval**

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
  combination of constraint and serialized transaction); and
- unique composite keys needed by workspace-membership foreign keys.

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
8. Enable canonical reads for an allow-listed cohort. Canonical/legacy disagreement is
   denial plus quarantine, never a fallback grant.
9. Enable multi-account/invitation UI after auth and revocation tests pass.

No `NOT NULL`, column drop, table rename, legacy-write removal, or policy relaxation is
part of the initial feature rollout.

## 6. API and SDK evolution

### Phase A: additive aliases

- Add `organizationId` beside `accountId` in responses; values are exactly equal.
- Requests accept either; if both are supplied they must be equal.
- Add organization membership/invitation/login-slot endpoints as new routes.
- Existing workspace routes and SDK methods remain valid.
- Feature discovery tells a new client whether organization v2/session slots are
  available; absence is not treated as an authentication failure.

### Phase B: preferred naming

- New SDK APIs and docs prefer `organizationId` while retaining deprecated aliases.
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
- Abort if any old binary health/read/write check changes.

### Gate 2: dual-write and backfill

- Deploy dual-write code with canonical reads off.
- Run bounded backfill and shadow projection.
- Abort/disable v2 for any tenant with unresolved duplicate, missing subject, membership
  mismatch, balance mismatch, or RLS-policy failure.
- Keep canonical governance impossible to enable while any incompatible binary lease
  exists; exercise old/new mutation races continuously.

### Gate 3: read enablement

- Drain incompatible binaries, rotate/provision the v2 database capability, and prove
  the legacy app role cannot read or mutate a canonical tenant.
- Atomically switch an internal tenant governance row from `reconciled` to `canonical`
  only after parity and zero-quarantine checks under the same lock.
- Verify revocation deadlines, old-client behavior, and no cross-tenant query/metric.
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
- Prove one safe outcome and durable audit/idempotency evidence.

### FORCE-RLS

- Run as the non-owner app role in real PostgreSQL.
- Cross-tenant read/write every new organization/workspace table.
- Test wrong composite pairs, absent GUCs, stale pooled connections, and dedicated
  schemas.
- Assert existing protected-table coverage does not decrease.

## 11. Evidence required for candidate handoff

The implementation candidate must freeze and report:

- exact base/head/tree and ordered file list;
- exact migration checksum and schema before/after inventory;
- backfill/reconciliation counts with quarantines explicitly zero or blocked;
- unit, contract, API, SDK, migration, real-Postgres FORCE-RLS, concurrency,
  auth/revocation, and browser commands/results;
- old/new binary compatibility matrix results;
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
key and effect ledger make replay after crash idempotent.

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
  identity merge effect, audit append, and tenant authority flip converges forward;
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
