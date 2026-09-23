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
rather than being overwritten. An exact operation replay returns its historical
identity receipt without adding or updating membership. That historical response
is not proof of current access. A cancelled operation returns a conflict instead.

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