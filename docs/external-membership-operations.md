# External membership operation recovery

An organization service key can reconcile customer-workspace onboarding without
replaying a grant. These APIs do not allow service keys to read private sessions,
administer native users, or reactivate suspended identities.

## Retain identity before granting

Derive the external identity on the server. `service.asUser(externalId, { source })`
followed by `getAccessContext()` may provision the identity anchor, but never grants
shared-workspace membership. Retain its subject before starting onboarding.

`service.lookupExternalIdentity(organizationId, { source, externalId })` requires
the organization's service key with `members:manage` (or `workspace:admin`). It is
a non-provisioning POST lookup, returning `{ found: false }` or content-free
identity and organization-membership identifiers, statuses and separate revision
numbers. It also returns suspended/offboarded identities. It never restores them
and returns no Personal-workspace identifiers or private content.

## One operation per explicit onboarding

Persist a UUID operation ID before calling:

```ts
await service.addExternalWorkspaceMember(workspaceId, {
  identity: { source, externalId },
  permissions: ["workspace:read", "sessions:read"],
  operationId: grantOperationId,
});
```

The key's live permission ceiling applies. Existing different permissions conflict
rather than being overwritten; change them with a keyed update instead. An exact operation replay returns its historical
identity receipt without adding or updating membership. That historical response
is not proof of current access. A cancelled operation returns a conflict instead.

## Change an existing member's permissions

Do not revoke and re-grant to change access: revocation tears down the member's
work. Persist a new UUID operation ID and replace the complete permission set:

```ts
await service.updateExternalWorkspaceMember(
  organizationId, workspaceId, organizationMembershipId,
  { operationId: updateOperationId, permissions: ["workspace:read"] },
);
```

`PATCH /v1/organizations/:organizationId/workspaces/:workspaceId/external-members/:membershipId`
requires the organization's service key with `members:manage` (or
`workspace:admin`) and the same live permission ceiling as a grant. It updates an
existing membership only: an absent member or workspace membership is `404`, and a
suspended or offboarded identity conflicts (`409`). The response is
`{ subjectId, organizationMembershipId, permissions, narrowed, replay }`.

Widening only rewrites the set. When any previously held permission is removed
(`narrowed: true`), the same transaction also advances the member's organization
authorization revision - the lifecycle signal an organization role change uses.
Direct requests already re-read workspace permissions on every call; the revision
advance makes frozen authority that recorded the old revision re-check on its next
use: personal connections frozen on an accepted turn are omitted with a visible
warning until the next turn re-freezes them, and an active identity link for that
member must be confirmed again. Nothing is cancelled, interrupted, or torn down:
sessions, turns, attempts, schedules, and processes keep running.

The receipt ledger, organization lock, and replay contract are those of a grant
(migration 0540 adds the `update` action). Retain the exact body and retry it
unchanged after response loss; a replay returns the original receipt even after a
later change, which is not proof of current access. Reusing an operation ID with a
different body conflicts.

## Withdraw access, including a grant still in flight

After withdrawal, use the retained/recovered organization membership ID:

```ts
await service.cancelExternalWorkspaceMemberGrant(
  organizationId, workspaceId, organizationMembershipId,
  { operationId: revokeOperationId, cancelGrantOperationId: grantOperationId },
);
```

The existing organization-workspace member `/revoke` route accepts this separate
service request variant. Its existing managed-human timestamp-CAS variant is
unchanged. The cancellation variant withdraws this external subject's current
access to this shared workspace, not just the permissions initially granted by
the named operation. Do not use it to clean up an individual session while the
person should retain workspace access.

Native removal owns protocol settlement, affected turn cancellation, attempt
interruption, schedule authority invalidation and workflow wakes. The same
transaction records a causal fence for the pending grant even if membership is
absent. A later arrival of that grant cannot create membership. Both operations
serialize under the canonical organization lifecycle lock and reuse immutable
organization-workspace operation receipts; no host-side timeout proves absence.

Retain the exact cancellation body and retry it unchanged after response loss.
`removed` reports whether that transaction removed a membership; a successful
receipt's `fencedGrantOperationId` also proves the pending grant is fenced when
`removed` is false. This is logical revocation, not physical quiescence or history
deletion. Do not treat a private-session 404 as successful cleanup.

Operation identities are organization-scoped. Changed payload or target reuse
conflicts. A currently authorized replacement organization key may reconcile the
same operation; original writes retain their original service audit attribution.

## Non-bypass migration ownership

Migration [0558](../packages/db/drizzle/0558_external_membership_removal_owner_rls.sql)
repairs the native removal passes under a `NOSUPERUSER NOBYPASSRLS` schema owner.
`SECURITY DEFINER` alone does not escape FORCE RLS: 0440's service-actor assertion
could not see its external target's organization membership and raised `42501`
(`workspace member administration required`). Both preparation and command now
open the existing owner-only `organization_membership_lifecycle` policy before
their reads and restore the caller's marker on every return and exception. The
whole-pass window also covers target-membership lookup and organization-user
grant revocation; an assertion-only window would leave teardown incomplete.
Both passes also open 0345's existing owner-only fenced-access capability to see
private work during settlement and teardown. It remains schema/backend/transaction
bound and requires the workspace's held advisory fence; every exit closes only
the current invocation's token.
No table RLS posture, ownership, policy or application-role grant changes.

The complete [API regression suite](../apps/api/test/external-membership-operations.test.ts)
uses `acquireOwnerMigratedTestDatabase`, including response-loss recovery,
revoke-before-grant, concurrency, permission updates and scoped teardown. Direct
native-pass tests also pin non-bypass ownership, marker restoration, denied
direct table access, revoked-key rejection and Personal-workspace exclusion.

Sibling review found that 0439 provisioning, 0441 identity lifecycle and 0540
permission updates already open matching lifecycle policies before membership
reads; the locking reads have an ALL-command policy. Two separate legacy seams
remain outside this repair:

- 0332's `assert_organization_shared_workspace_administrator` and
  `upsert_organization_shared_workspace_member` assume ambient membership
  visibility before their actor check. The current 0350 administration caller
  opens the lifecycle window, but standalone calls under a non-bypass owner can
  fail closed.
- 0278's snapshot, pin and draft deletion uses the actor's subject GUC while
  deleting another subject's rows. Their subject-scoped policies can hide those
  rows from the definer. This repair does not claim physical personal-state
  cleanup; that needs a separately scoped subject window and regression tests.

See [FORCE-RLS runtime seams](force-rls-migration-backfills.md#the-same-trap-at-runtime-security-definer-routines).

## Cutover boundary

The optional `operationId` preserves the legacy unkeyed onboarding lane. An
unkeyed request already in flight has no operation identity and cannot be fenced
by inventing one afterward. Use matched API/SDK rollout and drain old unkeyed
writers before claiming late-grant protection. Do not replay an uncertain unkeyed
grant. A new operation ID is a new explicit grant, not a retry or automatic
restoration of removed membership.

For actual account-wide offboarding, the separate
`updateExternalIdentityMembership` API requires `account:admin` and uses native
organization lifecycle/retention. Do not offboard an entire external identity to
remove it from one customer workspace.