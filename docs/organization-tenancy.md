# Organization tenancy foundation

This document is the current implementation map for the accepted
[organization-tenancy ADR](design/organization-tenancy-slice-a-2026-08-11.md).

## Slice A: shipped foundation

Migration `0218_organization_tenancy_foundation.sql` is rolling and additive.
It adds:

- `organization_memberships`: organization membership, lifecycle state, one
  personal-workspace pointer, authorization revision, revocation time, and
  retained-personal-data deadline;
- `organization_user_retention_policies`: organization-level `retain` or
  bounded `delete_after` policy;
- `organization_user_resource_authorities`: stable
  organization+membership authority ids for future user resources, with a
  non-authoritative origin-workspace provenance field;
- `organization_user_resource_grants`: opaque once/session/always grants bound
  to a target workspace and private/shared context, with optional exact session
  and authority-epoch fencing; and
- generic session owner, `user_private|workspace_shared` visibility, authority
  epoch, and independent-fork provenance columns.

The new authority tables are deliberately inert: FORCE RLS is enabled with no
policies, and the standalone application role receives no direct table DML.
Only migration/operator connections can inspect the scaffold. No API, SDK,
worker, MCP, UI, or resource DAO uses it in Slice A.

## Legacy behavior

Existing resources retain their current workspace foreign keys and RLS. Slice
A does not change variable-set, rig, Connected Machine, connection, Codex, or
Document materialization.

Existing sessions and old writers are safe because the new session columns
have explicit defaults:

- `visibility = 'workspace_shared'`;
- `authority_epoch = 1`;
- owner membership is null; and
- every fork-provenance field is null.

Null owner/authority/grant fields are non-authority. Contract parsing likewise
defaults omitted resource scope to `workspace`; `user` scope requires one
complete opaque delegation.

## Referential integrity

- Organization membership belongs to one `managed_accounts.id` organization.
- An active membership must identify a same-organization personal workspace.
- A personal workspace may identify at most one organization membership.
- User-resource authority references a membership in the same organization.
- Origin workspace is same-organization provenance. Deleting it clears only the
  provenance column; it does not delete or transfer the authority.
- A grant references an authority and workspace in the same organization.
- Session-bound grants reference a session in the exact target workspace.
- Session owner, fork actor, and fork source must belong to the same
  organization as the destination session. The source may be in another
  workspace in that organization.

These constraints represent identity, not runtime permission. Later access
paths must still prove the authenticated membership and target-workspace grant.

## Later migration phases

### B. Dual-write

Introduce lifecycle-only organization membership administration and exact
server-derived user authority creation. New resource writes may record an
authority id while continuing to write the existing workspace-owned row. New
session writes may record owner/visibility, but old writers remain accepted.
No read path changes yet.

### C. Backfill

Classify every existing resource explicitly as workspace-owned unless there is
reviewed, deterministic evidence for user ownership. Never infer user authority
from `created_by`, connection attribution, a default workspace, resource name,
or current access. Provision personal workspaces for active memberships through
an idempotent lifecycle operation. Record backfill receipts and unresolved rows
without widening access.

### D. Validate

Verify organization/membership/workspace consistency, one personal workspace
per active membership, stable authority uniqueness, provider-account collision
rules, session ownership, and zero partial delegations. Add read-only shadow
comparisons between legacy and proposed effective scopes. No mismatch may fall
back to user authority.

### E. Activate

Add exact organization+subject+workspace RLS policies and narrowly scoped
security-definer lifecycle functions. Switch one subsystem at a time to
authority ids and immutable accepted-work delegations. Implement session
visibility, sharing/fork copying, epoch fencing, cancellation, cache/pin
stripping, and owner-only grants before enabling personal attachment to shared
sessions.

### F. Retire

Only after all writers/readers are activated and audited may legacy
workspace-owned assumptions be removed. Resource FKs are never destructively
rewritten in the same release that first activates user authority.

## Non-goals in Slice A

- organization/member API or UI;
- resource CRUD or discovery changes;
- session sharing/fork runtime;
- turn/task cancellation or authority-epoch claim checks;
- Connected Machine, rig, variable-set, connection, Codex, or Document
  materialization changes;
- retention deletion workers;
- provider, cloud, or deployment changes.