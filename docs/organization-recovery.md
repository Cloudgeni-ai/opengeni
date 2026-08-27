# Organization recovery custody

This document is the security, rollout, self-hosting, and unsupported-operation
contract for organization recovery. The broader tenancy model and immutable
workspace ownership boundary live in
[`organization-tenancy.md`](organization-tenancy.md).

## Product contract

Recovery custody is a quorum ceremony for the narrow case where ordinary
canonical-human login recovery cannot restore permanently unavailable owner
authority. It is not an operator or support override.

- One active owner configures exactly three distinct active non-owner human
  organization memberships.
- Each selected canonical human accepts independently. Linked login bindings
  never create another acceptance or vote.
- An accepted custodian starts an operation targeting one existing active human
  non-owner membership. The target cannot approve their own promotion.
- Two distinct accepted canonical humans approve. The second valid approval
  starts a fixed seven-day cooldown. Operations expire after 30 days.
- Any current active owner may cancel before execution.
- Execution only changes the target organization membership role to `owner`.
  Existing owners, Personal content, workspace ownership and grants, billing,
  organization identity, and data placement do not move.

The public states are
`pending_acceptance|active|degraded|superseded|disabled` for policies and
`collecting|cooling|executed|cancelled|expired|superseded` for operations.
Lost quorum or an absent, disabled, or degraded policy projects
`recovery_unavailable` instead of inventing a bypass.

## Security authority

Only a ready canonical-human managed browser session may read or mutate this
surface. API keys, Authorization bearer credentials, agents, machines, service
principals, recovery-only identities, deployment administrators, database
operators, suspended members, and cross-organization identifiers do not become
recovery principals. Denied identifiers return a non-enumerating result.

Every mutation binds these server-owned facts in one transaction:

1. the selected provider-neutral browser slot, actor epoch, authority hash, and
   request-owned mutation lease;
2. the Better Auth session and user resolved by the server for that slot;
3. the newest exact successful `complete_reauth` operation for that same slot,
   session, canonical human, generation, and epoch within ten minutes;
4. the active organization membership and its authorization revision;
5. canonical identity, authentication, subject, login-binding, policy,
   operation, custodian, target, acceptance, and approval revisions.

Clients submit none of the session, canonical identity, or re-authentication
proof fields. A command operation id is a body-bound replay key and is distinct
from a recovery-operation resource id. Exact replay returns the stored receipt;
changed-body reuse conflicts. Deterministic advisory and row locking makes
cancel versus execute, approval versus rotation, and execute versus offboarding
choose exactly one valid result.

Migration `0363_organization_recovery_custody.sql` owns policy, acceptance,
operation, approval, receipt, event, and notification evidence behind FORCE RLS.
The runtime role has no table DML. PUBLIC-revoked, target-schema-local
`SECURITY DEFINER` functions perform lifecycle changes, restore their local
markers on every exit, and cannot be redirected through `search_path` or TEMP
objects. Receipt and event history is append-only.

## Notifications and fake-provider acceptance

The quorum transaction journals the complete notification batch before an
operation can cool. Provider I/O never happens inside that transaction. The
dispatcher claim journals `provider_started` before returning a bounded payload
and stable idempotency key; terminal settlement appends `sent`, `failed`, or
`outcome_unknown` evidence. Failed work may be retried only through the bounded
claim protocol with the same idempotency key. Ambiguous delivery is not blindly
sent twice and requires explicit reconciliation.

Repository acceptance uses the in-memory fake transport. It records the exact
idempotency key and payload digest, makes zero external calls, settles the
durable attempt, and proves a duplicate claim cannot produce another logical
delivery. Adding a real email or notification adapter is a separately reviewed
operator integration. Provider success never authorizes recovery and provider
failure never bypasses the notification-journal execution fence.

## Workspace ownership and unsupported operations

A workspace is permanently owned by exactly one organization. The database
rejects every distinct `workspaces.account_id` update, including migration-owner
direct SQL. Workspace PATCH rejects the presence of `accountId`, including null
or the current organization, before any database update and returns
`workspace_transfer_unsupported`.

Supported human handoff inside one organization uses the existing explicit
workspace-admin grant and revoke lifecycle. These operations are unsupported:

- cross-organization workspace reparenting or transfer;
- Personal-workspace transfer, conversion, or sharing;
- replacement, impersonation, demotion, or removal of an existing owner by the
  recovery ceremony;
- billing custody or historic/future charge transfer;
- organization merge or deletion;
- a full backup, compliance archive, organization-wide export, or migration
  export. The existing sanitized workspace-state export remains only its
  documented bounded export surface;
- support, API, database, deployment, or provider bypasses.

## Rollout and self-hosting

Migration 0363 is additive, but the recovery mutation surface requires the
provider-neutral browser slot authority. A managed self-hosted
deployment must complete the browser-slot rollout described in
[`browser-login-session-sets.md`](browser-login-session-sets.md) and run in
`dual` or `broker` mode before enabling recovery custody. Legacy mode has no
request-owned actor lease and therefore leaves recovery mutations unavailable.
Local/configured access modes do not emulate a managed canonical-human ceremony.

Safe rollout order:

1. take the ordinary database backup required by the deployment runbook;
2. migrate through 0363 as the migration owner and verify the runtime-posture
   function/table/grant contract;
3. deploy compatible API, SDK, and web artifacts together;
4. keep external notification adapters disabled and run the fake-provider
   conformance ceremony against a non-production organization;
5. verify direct runtime DML denial, owner direct workspace-transfer denial,
   linked-login dedupe, revision invalidation, exact cooldown boundaries,
   notification settlement, and the three required races;
6. enable any real notification adapter only through its separately accepted
   rollout. Repository delivery alone does not activate one.

An application rollback is safe only to an image that knows migration 0363 and
continues to reject workspace ownership changes. Never disable or drop the
workspace ownership trigger to accommodate an older writer. Recovery policy
disable and owner cancellation are product operations, not schema rollback.

Operationally, `recovery_unavailable` is a product safety state. Do not repair it
with direct table writes. Restore the affected human identity or membership,
rotate the policy through a current owner, or let the current operation expire.
There is no supported production mutation in this repository delivery.

## Acceptance evidence

The release gate combines strict contract/API/SDK tests, real PostgreSQL under
the non-superuser migration owner and restricted `opengeni_app`, two-connection
race tests, and same-origin Chromium at 1440, 390, and 320 CSS pixels with
keyboard and Axe checks. Existing organization administration, offboarding,
workspace deletion, sanitized export, billing, Personal isolation, and tenant
revocation suites must remain green. Exact-head independent code, security, and
browser review plus wholly green CI and current-main compatibility are required
before merge.
