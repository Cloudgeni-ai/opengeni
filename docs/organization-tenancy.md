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
- `organization_user_resource_grants`: opaque grants carrying the owning
  membership, canonical action, target workspace, private/shared context, and
  generation; `once` and `session` grants require an exact session plus
  positive authority epoch, while `always` grants carry neither fence; and
- generic session owner, `user_private|workspace_shared` visibility, authority
  epoch, and independent-fork provenance columns.

The new authority tables are deliberately inert: FORCE RLS is enabled with one
explicit `organization_tenancy_system_only` policy per table using
`USING (false) WITH CHECK (false)`, and the standalone application role
receives no direct table DML. Privileged migration/operator connections can
inspect the scaffold. No API, SDK, worker, MCP, UI, or resource DAO uses it in
Slice A.

## Slice B: managed-human lifecycle provisioning

Migration `0219_organization_tenancy_managed_human_provisioning.sql` adds the
first narrow dual-write seam without activating personal-workspace runtime
access. The existing Better Auth managed-human hook
`ensureManagedAccessForUser` now converges, in one transaction, on:

- exactly one `organization_memberships` row for the existing
  `managed_accounts` organization and the derived `user:<id>` subject;
- exactly one deterministic same-organization personal workspace with a normal
  `workspace_inference_controls` row; and
- an active membership pointer to that workspace.

The personal workspace is lifecycle metadata only in this slice. It receives no
`workspace_memberships` row, is absent from `AccessContext.workspaceGrants`,
`defaultWorkspaceId`, subject workspace lists, and existing runtime resource
paths, and does not create user-resource authority or grant rows. The legacy
Better Auth default workspace remains the sole runtime-access workspace.

Organization-table writes use one target-schema-local
`ensure_managed_human_personal_workspace(uuid, text, uuid)` SECURITY DEFINER
capability with a fixed schema-plus-`pg_catalog` search path, PUBLIC execution
revoked, and explicit `opengeni_app` EXECUTE. Its transaction-local RLS marker,
exact account/subject binding to the existing managed-human owner membership,
deterministic workspace identity, control-row validation, and row lock make
first, repeated, and concurrent provisioning converge. Suspended or revoked
memberships, foreign accounts, wrong subjects/workspaces, existing runtime
access on the personal workspace, and malformed subjects fail closed. The app
role still has zero direct SELECT/INSERT/UPDATE/DELETE privileges on all four
organization-tenancy tables.

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
- A grant references an authority and owning membership in the same
  organization, and the authority's owner must equal the grant owner.
- Grant actions are canonical non-wildcard names. `once` and `session` grants
  reference a session in the exact target workspace and carry its positive
  authority epoch; `always` grants have null session and epoch. Partial or
  mixed fences are rejected.
- Session owner, fork actor, and fork source must belong to the same
  organization as the destination session. The source may be in another
  workspace in that organization.

These constraints represent identity, not runtime permission. Later access
paths must still prove the authenticated owner membership and target-workspace
grant. A later activation slice must atomically consume an active `once` grant
before accepting its use; Slice A stores the invariant but does not activate
the access path.

## Later migration phases

### B. Dual-write (0219 current)

Managed-human membership and personal-workspace lifecycle metadata now use the
narrow provisioning seam described above. Resource authority/grant dual-write,
new-session owner/visibility writes, and all read-path changes remain future
work; old writers remain accepted.

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

## Non-goals in Slices A and B

- organization/member API or UI;
- personal-workspace runtime access or a personal `workspace_memberships` row;
- user-resource authority/grant writes, discovery, or sharing;
- resource CRUD or discovery changes;
- session sharing/fork runtime;
- turn/task cancellation or authority-epoch claim checks;
- Connected Machine, rig, variable-set, connection, Codex, or Document
  materialization changes;
- retention deletion workers;
- provider, cloud, or deployment changes.