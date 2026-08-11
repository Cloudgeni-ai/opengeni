<!-- docs-refs: record -->

> **Point-in-time design record.** Frozen on August 11, 2026 for Slice A. Code
> and [`../organization-tenancy.md`](../organization-tenancy.md) are the current
> implementation map.

# ADR: organization tenancy and user-owned authority

Status: **accepted foundation boundary**

Supersedes the tenancy assumptions in the still-open predecessor design PR
#501 without closing, merging, or otherwise changing that PR.

## Context

OpenGeni already has strong workspace containment, but its managed-mode
provisioning and most operational resource foreign keys assume that a human's
personal authority belongs to one workspace. That is insufficient when a user
belongs to an organization, has grants to several workspaces, and must use the
same personal rig, Connected Machine, variable set, or Codex subscription from
those authorized workspaces without duplicating ownership.

The current physical `managed_accounts.id` remains the organization id. This
ADR does not mass-rename `account_id`; it fixes the authority model around that
stable identifier.

## Decision

### Immutable tenancy hierarchy

The hierarchy is **Organization → Workspace → User**:

- An organization is a hard non-sharing tenant. No resource, grant, session,
  provider account, or fallback crosses an organization boundary.
- A workspace belongs to exactly one organization and remains the containment
  boundary for sessions and ordinary workspace resources.
- A user participates through an organization membership. Organization
  membership is distinct from workspace membership: it does not automatically
  grant workspace-content access.
- Each active organization membership has one personal workspace. That
  workspace is the user's private organization-contained surface, but it is
  lifecycle metadata and provenance—not the ownership anchor for user
  resources.

Organization administrators may manage membership state, personal-workspace
lifecycle, policy, retention, and workspace grants. Administration does not
silently grant access to personal workspace content, user-resource metadata,
credentials, private sessions, or historical personal authority.

### Resource scopes and identity

The canonical resource scopes are `organization`, `workspace`, and `user`.
Existing features that use the word `personal` retain compatibility naming
until their own migration; semantically, `personal` maps to `user` authority.

- Organization resources are owned by the organization and may be used only
  through an authorized organization/workspace boundary.
- Workspace resources are owned by one workspace.
- User resources are owned by one organization membership. Their stable
  authority identity is `(organization, membership, authority id)`, not a
  personal workspace id.
- `originWorkspaceId` is optional contextual provenance. It grants nothing,
  does not constrain use to that workspace, and may be cleared when the origin
  workspace is deleted.

User-resource materialization remains in existing subsystem tables until a
later slice. Slice A adds only stable authority and grant identities; it does
not move variable sets, rigs, machines, Codex subscriptions, or connections.

### Membership revocation and retention

Revocation immediately ends new authority use once runtime activation ships.
The organization owns a configurable personal retention policy:

- `retain` keeps personal data until an explicit lifecycle action; or
- `delete_after` records a bounded retention interval.

The membership records the effective retention deadline at revocation. A
retention policy is not content access and does not let an administrator inspect
retained personal data. Deletion/materialization workers are later slices.

### Sessions, visibility, and forks

Every session remains contained by one workspace and organization. Generic
session visibility is:

- `user_private`: visible only to its immutable owner under organization and
  workspace access checks; or
- `workspace_shared`: visible to authorized members of the containing
  workspace.

Legacy sessions are explicitly `workspace_shared`, authority epoch `1`, with no
owner membership. Absence of owner or authority metadata never creates user
authority.

Forks are independent copies in both directions: private→shared,
shared→private, private→private, and shared→shared. The destination receives
existing selected content according to the eventual product operation, but it
never inherits a live process, worker lease, sandbox route, Connected Machine,
credential, provider account, variable set, rig attachment, pin/cache,
scheduled task, grant, delegation, continuation, recovery, or queued turn.
Fork provenance records source session, source visibility, source authority
epoch, actor, and time. Provenance is audit context, not authority.

### Authority epoch and sharing

Each session has a positive authority epoch. Any accepted turn/task delegation
must eventually bind to the current epoch. A visibility transition or
authority-stripping fork advances or establishes a fresh epoch; work accepted
under an older epoch is historical and non-runnable.

Private→shared sharing copies content but transfers **zero live personal
authority**. The shared destination starts without personal delegations,
credentials, grants, connections, pins/caches, queued/running turns, scheduled
task authority, system-update/outbox delivery, recovery, continuation, stream,
terminal, or sandbox authority.

Slice A stores the epoch and provenance only. Cancellation, fencing, copying,
redaction, and runtime sharing are explicitly not implemented.

### Personal attachment grants

Only the owning user may attach a user resource to a workspace-shared session.
No other workspace member may discover, select, or consume that resource or its
provider metadata.

Grant modes are:

- `once`: one accepted use;
- `session`: bounded to one session and authority epoch; and
- `always`: a standing owner grant for the matching workspace and visibility
  context, still subject to revocation and policy.

Every grant is keyed to organization, user-resource authority, target
workspace, `user_private` or `workspace_shared` context, generation, and—when
session-bound—the exact session and authority epoch. A grant never transfers to
another user. Sharing, forking, epoch change, membership revocation, workspace
removal, or authority generation change prevents ambient reuse. Later use after
private→shared requires a freshly accepted matching grant.

### User-document contextual provenance

User-owned Documents may eventually retain contextual provenance describing
where they were created or used. That provenance is architecture only in this
slice. Existing Document authority, retrieval, RLS, and API behavior do not
change.

## Security consequences

- Organization identity is present in every authority and grant relation.
- Membership ids and authority ids are opaque. Public projections never expose
  raw owner subject ids, provider identifiers, or credential material.
- A caller-provided owner id is never authorization. Runtime activation must
  derive the authenticated membership and workspace grant server-side.
- New Slice A authority tables are FORCE-RLS with no policies and no direct
  application-role privileges. They are intentionally unusable until a later
  reviewed activation slice.
- Existing workspace resource foreign keys and RLS policies remain unchanged.

## Explicitly deferred

Slice A does not implement organization/member CRUD, resource DAO/API/UI
switches, session create/list/share/fork behavior, execution cancellation or
epoch fencing, personal resource materialization/selection, RLS visibility
policies, retention deletion workers, provider/cloud work, or deployment.

## Migration rule

Migration is additive and staged: **expand → dual-write → backfill → validate →
activate → retire legacy assumptions**. No later stage may reinterpret an
absent Slice A field as user authority. See
[`../organization-tenancy.md`](../organization-tenancy.md).