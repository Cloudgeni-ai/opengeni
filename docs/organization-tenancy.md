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

## Common owner grant lifecycle

Migration `0253_common_user_resource_authority_lifecycle.sql` activates the
generic lifecycle only for already-existing active user-resource authorities.
Authenticated humans must request the new surfaces with explicit `scope=user`;
legacy omitted scope remains workspace-scoped. The server derives the active
organization membership from the authenticated subject and never accepts an
owner subject or membership identifier from the caller. Lists expose only
opaque authority/grant identifiers and lifecycle fences, never owner identity,
membership, or secret material.

Issuance is idempotent for the exact active once/session/always grant identity.
Session and authority-epoch fences come from the current target session; the
target workspace must belong to the same organization and remain accessible to
the owner. `workspace_shared` requires an explicit durable shared-output
acknowledgement. Revocation is immediate and advances grant generation.

For direct and scheduled personal Variable Set/Rig use, personal-workspace and
origin-workspace columns are provenance/lifecycle facts only. Authorization is
the active server-derived owner organization membership, same organization,
current target-workspace access, and exact live authority/resource/grant,
session visibility, authority epoch, generation, status, and interruption
fences. Direct turns re-run the corrected resolver before any Rig or Variable
Set read; sessions without personal resources take a no-op path.

Migration `0258_three_scope_document_knowledge_authority.sql` applies the same
organization-user lifecycle to newly-created personal Documents. The physical
workspace/base/file still owns ingestion and indexing, while
`origin_workspace_id` is immutable provenance and the common authority's active
organization membership is ownership. Consequently, an owner can discover,
read, reindex, file, and delete the Document from any workspace they currently
access in the same organization, and losing the origin workspace does not
transfer or delete it. Those operations retain the original workspace, base,
file, and chunk storage rather than copying data into the authorizing workspace.
The document-scoped original-file metadata and download routes resolve the
requested-workspace Document authority, its current owner/organization state,
provider ACL, and the one immutable origin file in one database authority
boundary; they do not make the origin workspace's generic file inventory portable.
Configured/local subjects without an eligible active organization membership,
and existing personal Documents, remain on the legacy origin-workspace lane
instead of being guessed into a new organization-user authority.

Agent access is separate from human ownership. At exact attempt admission the
database freezes only ready, agent-enabled personal Documents backed by an
active `document.read` grant for that target workspace and the session's exact
`user_private|workspace_shared` context. Shared-context grant issuance uses the
common durable acknowledgement. Every search, get, browse, compatibility fetch,
and chunk read revalidates membership, target-workspace access, authority and
grant generations, session epoch, attempt liveness, and interruption state;
revocation therefore takes effect before the next read. An agent call without
an exact admitted attempt receives organization and current-workspace knowledge
only—never ambient personal knowledge.
The bounded compatibility exception is a null-authority legacy personal
Document: an agent may read it only in its origin workspace and only for the
exact initiating subject. It never follows the subject to another workspace;
activated common-authority Documents always require the admitted grant
snapshot.

Migration `0262_scoped_connected_machines_and_rigs.sql` activates the same explicit
organization/workspace/user ownership for Rigs and Connected Machines. Human
machine approval defaults to user scope. Physical workspace ids remain provenance
and transport-routing facts, not personal authority boundaries: an owner's user
resources remain visible in every same-organization workspace they can access.
Personal machine attachment is owner-only, and exact machine use is separately
admitted and revalidated against a `connected_machine.use` grant. Workspace access
loss removes workspace resources immediately without deleting the user's resources;
cross-organization visibility remains impossible.

## Slice B: managed-human lifecycle provisioning and first runtime projection

Migration `0219_organization_tenancy_managed_human_provisioning.sql` adds the
first narrow dual-write seam. The existing Better Auth managed-human hook
`ensureManagedAccessForUser` now converges, in one transaction, on:

- exactly one `organization_memberships` row for the existing
  `managed_accounts` organization and the derived `user:<id>` subject;
- exactly one deterministic same-organization personal workspace with a normal
  `workspace_inference_controls` row; and
- an active membership pointer to that workspace.

After that exact lifecycle routine returns the active membership and matching
personal-workspace pointer, the same transaction appends one owner-only runtime
grant to the authenticated managed human's `AccessContext.workspaceGrants`.
The grant is an access projection rather than a `workspace_memberships` row and
does not carry `workspace:admin`, `members:manage`, or `api_keys:manage`, so it
cannot delegate access to another principal. The personal workspace is therefore
included in authenticated workspace lists and ordinary runtime resource paths
only for its owning managed human. Organization/account admins, API keys,
delegated bearers, services, and other members receive no ambient personal-
workspace access. The legacy Better Auth workspace remains
`defaultWorkspaceId`, and persisted legacy grants remain first in the returned
grant order.

This runtime projection does not create user-resource authority or grant rows.
The personal workspace still receives no `workspace_memberships` row, so
membership CRUD and subject-membership fallback cannot discover or widen the
owner-only projection.

Organization-table writes use one target-schema-local
`ensure_managed_human_personal_workspace(uuid, text, uuid)` SECURITY DEFINER
capability with a fixed schema-plus-`pg_catalog` search path, PUBLIC execution
revoked, and explicit `opengeni_app` EXECUTE. Its transaction-local RLS marker,
exact account/subject binding to the existing managed-human owner membership,
deterministic workspace identity, control-row validation, and row lock make
first, repeated, and concurrent provisioning converge. Suspended or revoked
memberships, foreign accounts, wrong subjects/workspaces, an unexpected
persisted workspace membership on the personal workspace, and malformed
subjects fail closed. The app
role still has zero direct SELECT/INSERT/UPDATE/DELETE privileges on all four
organization-tenancy tables.

`GET /v1/organization-memberships` is the first read-only managed-human
discovery surface. It accepts only a current Better Auth human session and
returns the exact active membership id, organization id, and personal-workspace
id emitted by that same narrow provisioning capability. API keys, delegated
bearers, configured/local access, and missing or terminal memberships fail
closed. The response intentionally omits subjects, retention state, grants,
resource authority, and the runtime grant itself.

## Organization membership lifecycle (0263)

Migration `0263_organization_membership_lifecycle.sql` activates the bounded
managed-human administration plane without making organization membership a
workspace grant. Owners may invite an already-registered human as owner,
administrator, or member; administrators may invite and manage members only.
Acceptance is bound to the exact authenticated `user:<id>` named by the
invitation. Pending invitations can be revoked. Role changes, suspension,
reactivation, offboarding, and retention-policy changes require an exact
revision plus an input-bound operation id. Exact retries return the immutable
receipt; changed reuse and stale revisions fail closed. The last active owner
cannot be demoted, suspended, or offboarded. Suspension is reversible only
through an explicit owner-authorized reactivation. Offboarding is terminal: a
revoked membership cannot be re-invited or accepted again. A future rejoin
contract would need a new generation identity propagated through the immutable
retention ledger; 0263 deliberately does not reset or reuse that evidence.

The managed-human API surface is:

- `GET /v1/organization-invitations` (bounded to 100 with the same deterministic
  keyset cursor) and
  `POST /v1/organization-invitations/:invitationId/accept` for the invited
  human. Acceptance resolves only the exact subject-bound invitation id; it
  never scans invitation history;
- `GET|POST /v1/organizations/:organizationId/invitations` and its explicit
  `/revoke` operation for owners/administrators. Listing is capped at 100 and
  uses a deterministic `(created_at,id)` keyset represented by the last
  returned invitation UUID; ordinary members and cross-organization callers
  cannot enumerate invitation metadata;
- `GET /v1/organizations/:organizationId/members` and
  `PATCH /v1/organizations/:organizationId/members/:membershipId`; and
- `GET|PATCH /v1/organizations/:organizationId/retention-policy`.

These routes require a direct managed-human cookie session; API keys and
delegated bearer requests are rejected. Provider email delivery and invitations
for people who have not registered remain separate integrations.

Suspension immediately removes persisted shared-workspace grants, revokes
personal-resource grants, fences membership-owned sessions, terminally cancels
their nonterminal work, and cancels shared-session work whose frozen initiating
human is the suspended subject. Active realtime modes owned by that subject are
ended with `authority_revoked`; their connections close and the durable workflow
wake makes teardown repairable.
Session, workspace-control, combined live, and interaction SSE connections
re-resolve the current human access projection before every emitted frame and
also on the bounded idle timer. A buffered or replayed event therefore fails
closed after suspension or offboarding instead of retaining the grant captured
when the HTTP request began.
Reactivation restores only active organization and personal-workspace access,
never old grants. Offboarding applies the same canonical
workspace/session/turn/attempt teardown, then terminally revokes membership and
retains resource authority and physical data. Owned-session authority epochs
advance with content-free audit events; unrelated users' shared-session state
is not changed. The lifecycle does not infer membership ownership for retained
processes or other direct provider operations that lack an exact membership
authority field; adding that attribution and stream-token invalidation belongs
to the separate live-access hardening program. `retain` has no deletion deadline;
`delete_after` accepts the initial 30–90 day policy window and stamps a bounded
future deadline. Destructive expiry is an explicit operator lifecycle, not an
API request or background service. The command
`bun run db:sweep-organization-retention --organization-id <uuid> --dry-run`
previews at most 100 due memberships, and
the same command without `--dry-run` processes a bounded batch (`--limit`,
default 10). Each member is claimed independently with `SKIP LOCKED`, exact
operation and lease fences, so one provider failure records immutable
content-free failure evidence without rolling back successful members.
Database finalization first locks the personal workspace and every known
storage-key source, materializes an immutable exact-key cleanup-obligation set,
freezes the configured storage bucket, rejects any mismatched File bucket, and
erases that user's personal workspace and supported personal resources.
Foreign-key checks therefore serialize concurrent retained consumers and abort
before external bytes are touched. The operator then deletes only those
prepared objects and records separate content-free completion receipts; a
provider failure retries only unfinished obligations, and every resume must
present the same frozen bucket before deletion. The closed inventory
covers Files, session recordings, browser-state uploads/artifacts,
transcription and video staging objects, workspace artifact/editable blobs, and
workspace-capture manifest/tree/blob payloads. Provider-native sandbox
checkpoints remain under their surviving global GC authority. Unknown resource
kinds or malformed/unrepresentable storage facts fail closed. Membership,
lifecycle, grant/authority, cleanup-obligation, deletion-receipt, and event
evidence is retained.

Invitation, operation-receipt, and lifecycle-event tables are FORCE RLS with
zero direct application-role DML. Target-schema-local SECURITY DEFINER routines
are PUBLIC-revoked, explicitly granted, and pinned to
`pg_catalog,<target-schema>,pg_temp`. Managed access refresh re-reads all active
memberships for the subject and derives role-bounded account plus owner-only
personal-workspace grants; inactive organizations disappear on the next
request.

## Canonical human identity and login bindings

Migration `0235_canonical_human_login_bindings.sql` adds a separate,
organization-independent identity authority. One Better Auth user converges on
one canonical human identity, and that identity may have multiple verified
provider/account login bindings. A canonical identity or login binding never
implies an organization membership, workspace grant, personal-workspace
pointer, user-resource authority, or sharing grant.

Binding link, unlink, and recovery operations require identity-revision CAS and
write immutable idempotency/audit receipts. Accepted authority changes advance
a monotonic authentication revision and delete existing Better Auth sessions
in the same transaction. Provider-account collisions place both identities in
a deterministic disputed state; removing or losing the last active factor
enters recovery-required state. Ordinary access denies recovery-required,
disputed, disabled, stale-revision, and missing sessions. Identity recovery
routes may accept only an exactly revision-stamped recovery-required session.

The canonical identity projection exposes only identity and login-binding
metadata. It intentionally omits organization, workspace, membership, and
resource identifiers, so identity discovery cannot become a cross-organization
discovery path. Organization membership remains independently authoritative:
the same human may have separate memberships in multiple organizations, and
each membership and its resources retain their existing organization-local
foreign-key and access constraints.

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

Migration `0222_session_visibility_authority_epochs.sql` extends this
compatibility boundary to accepted attempts. It backfills an immutable
authority snapshot on existing attempts and fills omitted legacy-writer
inserts from the exact workspace and session rows under lock. Accepted
attempts now retain epoch, visibility, and owner-membership provenance, and
activity writes fail closed when that snapshot is stale. Create-time
visibility mutation, visibility-aware read authorization, and independent fork
copying remain future activation work; this migration does not activate those
runtime paths.

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

### B. Dual-write and first access projection (0219)

Managed-human membership and personal-workspace lifecycle metadata now use the
narrow provisioning seam described above. The first disjoint activation adds
only the authenticated owner's personal workspace to the managed-human access
projection after lifecycle convergence; it does not add a durable workspace
membership or change the legacy default. Resource authority/grant dual-write,
new-session owner/visibility writes, and other read-path changes remain future
work; old writers remain accepted. Migration 0222 separately delivers the
accepted-attempt authority snapshot and stale activity-write fence described in
the Legacy behavior section.

### C. Membership lifecycle (0263 current)

The invitation, role, suspension, reactivation, offboarding, retention,
operator-driven destructive expiry, and multi-organization access projection
described above are active. Provider email delivery, unregistered-recipient
invitations, automatic scheduling of the operator command, and member-management
UI remain deferred.

### D. Backfill

Classify every existing resource explicitly as workspace-owned unless there is
reviewed, deterministic evidence for user ownership. Never infer user authority
from `created_by`, connection attribution, a default workspace, resource name,
or current access. Provision personal workspaces for active memberships through
an idempotent lifecycle operation. Record backfill receipts and unresolved rows
without widening access.

### E. Validate

Verify organization/membership/workspace consistency, one personal workspace
per active membership, stable authority uniqueness, provider-account collision
rules, session ownership, and zero partial delegations. Add read-only shadow
comparisons between legacy and proposed effective scopes. No mismatch may fall
back to user authority.

### F. Activate

Add exact organization+subject+workspace RLS policies and narrowly scoped
security-definer lifecycle functions. Switch one subsystem at a time to
authority ids and immutable accepted-work delegations. Accepted-attempt epoch
fencing is delivered by migration 0222; remaining activation work includes
session visibility mutation, visibility-aware reads, sharing/fork copying,
cancellation, cache/pin stripping, and owner-only grants before enabling
personal attachment to shared sessions.

### G. Retire

Only after all writers/readers are activated and audited may legacy
workspace-owned assumptions be removed. Resource FKs are never destructively
rewritten in the same release that first activates user authority.

## Remaining non-goals

- member-management UI and provider invitation email;
- invitations for unregistered humans;
- a personal `workspace_memberships` row or delegated personal-workspace access;
- user-resource authority/grant writes, discovery, or sharing;
- resource CRUD or discovery changes;
- session sharing/fork runtime;
- session visibility mutation, visibility-aware reads, or independent fork
  runtime;
- Connected Machine, rig, variable-set, connection, Codex, or Document
  materialization changes;
- an always-on retention deletion worker (0263 exposes a supported bounded
  operator command instead);
- provider, cloud, or deployment changes.
