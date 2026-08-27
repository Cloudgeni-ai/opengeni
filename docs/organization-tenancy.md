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

Migration `0305_personal_resource_grant_management.sql` replaces the ambient
owner-management seam with the activated product contract. Only a canonical
managed-cookie context for the exact subject may use it; API keys, delegated or
service principals, agents, and account/organization administrators receive no
ambient personal-resource authority. Lists are deterministic bounded keyset
pages for one exact resource kind, include the opaque resource/origin identity,
and return only grants targeting the route workspace. Resource kind derives the
only accepted action (`connection.use`, `document.read`, `variable_set.use`,
`rig.use`, or `connected_machine.use`) and its exact product permission gate.
For a canonical managed human with that permission, an organization without
the version-1 activation receipt has exactly zero usable personal authorities,
so discovery returns an empty page. Issue, revoke, and runtime use remain
activation-gated; the empty discovery answer does not activate the product or
weaken any mutation fence.
The managed personal-workspace projection includes `rigs:use`, allowing its
owner to discover and propose changes to personal Rigs without granting the
administrative `rigs:manage` capability.

Public issuance supports `session` and `always`. Session grants are authorized
through the ordinary session authorization seam after all target-free
principal, permission, and activation gates, and require the caller's expected
authority epoch; missing and inaccessible targets share the ordinary
non-enumerating session denial. Always grants remain unbound and require
session-create authority. Shared context requires the durable acknowledgement.
The server returns the complete credential-free `UserResourceDelegation`,
including organization, authority generation, grant generation, and session
epoch. Revocation proves the grant's route workspace but intentionally remains
available after a resource permission is removed because it only narrows
authority. Expiry is not authorable on this public surface; historical active
rows already past expiry are normalized to `expired` and no longer block exact
reissuance, and every projected timestamp is RFC3339 UTC. Historical active
grants whose action is arbitrary or belongs to a different resource kind are
deterministically revoked; invalid terminal history remains durable but is
omitted from typed management lists rather than rewritten or misrepresented.
The migration performs those backfills as the non-bypass table owner inside one
transactional `NO FORCE`/`FORCE` window over both the grant table and its
authority join, then restores FORCE RLS. Runtime list/issue/revoke uses a narrow
lifecycle policy marker inside schema-local, PUBLIC-revoked SECURITY DEFINER
functions with `pg_catalog`, the target schema, and `pg_temp` as their exact
search path; the app role retains zero direct table DML. The Connection-specific
REST wrappers converge on this lifecycle, including permission-independent
revocation after baseline route-workspace access is proved.
Standalone `once` and custom expiry remain outside this management surface.
Migration 0306 adds the only direct-session `once` path; maintenance migration
0338 extends it to the selected personal Connected Machine. Create/Send/Steer
acceptance derives the fixed personal Variable Set/Rig/Connected Machine closure and issues it in
the same transaction as the logical turn. New-session create binds the new
session epoch; established-session requests provide the expected epoch. The
receipt and snapshots are immutable, credential-free, and turn-bound, so
same-turn recovery reuses once while goal/machine successors do not inherit it.
The managed web console exposes that exact command for a new session and its
existing-session Send/Steer composer. It discovers only the current managed
human's active Variable Set/Rig/Connected Machine authorities through the bounded owner list,
joins names from the server-issued personal workspace's metadata-only catalogs,
and never lets an established session switch its fixed resource ids. Shared
sessions require the version-1 output warning acknowledgement; authority-epoch,
principal, organization, workspace, session, or source-access changes clear the
local decision and require an authoritative reload plus reconfirmation. The UI
does not project an attachment as accepted before the create/Send/Steer command
commits. Cross-workspace grant/fork UX, standalone management of `once`,
Documents/Connections without an exact runtime adapter, and
MCP/agent administration remain outside this slice.

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

Migration `0339_document_authority_reclassification.sql` turns that deliberate
non-guessing rule into an explicit administrator workflow. The caller supplies
an idempotent operation id plus the exact expected Document authority tuple;
the owner-only lifecycle writes an immutable before/after receipt and updates
the Document and all chunks atomically. Stale tuples, conflicting operation-id
reuse, a non-original subject claiming personal authority, and organization
changes without exact account administration all fail closed. Origin
workspace, base, file, creator, and content provenance never change. The exact
account-admin capability is minted by the canonical access resolver and bound
to its account and actor, rather than inferred from an organization-membership
row or caller-set GUC. That keeps managed, local/configured, and signed delegated
administrators equivalent. Activated personal Documents remain operable from a
currently accessible same-organization sibling workspace after origin access is
lost; targeting workspace authority still requires the immutable origin route.
Receipt reads are bounded scope-bound cursor pages. A separate resumable
run/operation/receipt ledger creates or adopts one internal Default collection
per organization workspace without using collections as authority. A later
cross-domain migration may consume these receipts as evidence but must not
perform a second Document reclassification.

Migration `0343_personal_document_force_rls_lock_repair.sql` restores the
portable mint and exact-attempt admission paths under the real
NOSUPERUSER/NOBYPASSRLS owner. Migration 0258's capability was open, but its
membership `FOR SHARE` also required an UPDATE-applicable policy and therefore
returned no row. The repair drops the redundant lock and makes future
visibility disagreement abort with SQLSTATE `55000`. It does not bulk-convert
already affected Documents: they are byte-identical in authority shape to
deliberately legacy personal Documents. Operators use the explicit 0339
original-owner-fenced lifecycle when the owner elects portability.

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

### Session ownership at the mint (migration 0302)

Because that workspace has no membership row, migration 0225's session write
fence could never attribute a session created there and minted a NULL owner
instead. Migration `0302_personal_workspace_session_ownership.sql` repairs it:
the fence now accepts an active membership's own `personal_workspace_id`
pointer as an alternative to the `workspace_memberships` row, the same
stated-authority shape 0258 already uses for personal Documents. It is
authority read from the authority row, not inference from `created_by`, a
default workspace, or current access; the ordinary shared-workspace path is
unchanged, and the pointer is 1:1 through
`organization_memberships_personal_workspace_idx`. The disjunct is restricted
to `user:%` subjects, matching the lifecycle gate in 0219/0263. A
subject-created session that still resolves to no owner inside an active
membership's personal workspace raises SQLSTATE `55000` instead of silently
writing NULL; service, API-key, unanchored, and suspended-member sessions
remain legitimately ownerless. Rows already durable before 0302 remain the
existing `bun run db:backfill-session-ownership` seam's job.

### `getWorkspaceGrant` is not an authority answer

`getWorkspaceGrant` (`packages/db/src/index.ts`) is a bare
`workspace_memberships` join. Because a managed personal workspace deliberately
has no row there, it returns `null` for the one human who always belongs. Any
seam that re-derives "does this subject still hold workspace authority here"
from that join denies the owner inside their own private workspace.

`subjectHasLiveWorkspaceAuthorityInScope`
(`packages/db/src/workspace-authority.ts`) models both halves - the membership
row whose owning organization membership is active, and the active
organization membership whose `personal_workspace_id` pointer is exactly this
workspace. `namedSubjectHasLiveWorkspaceAuthority` (`packages/db/src/index.ts`)
is the exported scope-setting wrapper over that canonical implementation.
Predicate-style authority probes should use the appropriate variant rather
than re-deriving the rule.

**It is an oracle, not an authorization. Its safety is caller discipline, and
every call site must establish that discipline locally.** The name says
"named subject" because that is exactly what it answers about: whatever subject
the caller hands it.

It is tempting to believe otherwise, and an earlier revision of this document
claimed it. The claim was: the pointer branch reads
`list_self_organization_memberships`, a SECURITY DEFINER seam that raises
`42501` unless the requested subject equals `opengeni.subject_id`, so the
function must be self-limiting. **That is false, and it is worth understanding
why, because the shape recurs.** The seam's guard compares its argument to a GUC
that the caller sets - `namedSubjectHasLiveWorkspaceAuthority` sets it from its
own `subjectId` argument one statement earlier, through an ordinary `set_config`
available to the plain `opengeni_app` role. The predicate therefore only checks
that the caller supplied the same value twice. It constrains the caller to be
self-consistent; it does not constrain the caller to be anyone.

Proven against real Postgres as `opengeni_app` with RLS engaged, from a process
that never authenticated as anyone: naming a victim returned that victim's full
organization-membership row including the private `personalWorkspaceId`, and
`namedSubjectHasLiveWorkspaceAuthority` returned `true` for the victim's personal
workspace. The same self-set-GUC pattern makes
`list_self_organization_memberships` a general read primitive for any
application-role connection;
`ensureManagedAccessForUserWithOrganizationMemberships` uses it the same way.
The SECURITY DEFINER wrapper is not buying the isolation its name implies. Do
not treat any `*_self_*` definer routine here as a caller check without
re-reading its guard.

So a call site is correct only if it has **independently** proven the caller is
entitled to ask about that exact subject. The two entitled shapes in the
codebase today:

- the subject is the authenticated request principal's own subject, taken from
  an already-authorized grant - and **not** a delegated/bearer grant, whose
  `subjectId` and `workspaceId` are unvalidated signed-token payload built by
  `delegatedAccessContext` with no database row behind them; or
- the subject is the frozen `ownerSubjectId` of a delegation already persisted
  for the workspace the caller is already authorized in.

Anything else - a subject that was looked up, inferred, or supplied by a caller

- is a vulnerability. Prefer plumbing the caller's own identity to the call site
  over widening what the oracle is asked.

The in-scope variant refuses to set the subject GUC, making the
arbitrary-subject oracle shape unrepresentable at its session-list, pin, and
composer-draft call sites. It keeps the authority read in the caller's
transaction and checks that the requested subject matches the applied scope.
That check is a consistency tripwire, not an authorization: the application
role can set the scope itself. The actual owner exception at those session
surfaces is the positive `canonicalManagedHumanSession` provenance stamp, set
only by the access branch that verified a Better Auth cookie. An absent stamp
fails closed, so delegated/bearer principals, API keys, service initiators,
same-organization co-members, and account or organization administrators do
not receive personal-workspace access by exclusion-list inference.

For the same reason, "make
`list_self_organization_memberships` read the GUC instead of taking the subject
as a parameter" is **not** the structural fix it appears to be: reading the GUC
rather than a parameter changes nothing about _who may set that GUC_.
`setSubjectRlsContext` is an ordinary `set_config` that accepts any string from
any `opengeni_app` connection, so the caller still names whoever it likes - the
name just arrives by a different route. Reaching for that design because it
"feels" safer is the exact reasoning error this section exists to correct.

The genuine structural fix is to stop letting the application role set
`opengeni.subject_id` freely at all - a definer-only setter, or an attested
subject established once at authentication and immutable thereafter. That is a
much larger conversation than either variant, and nothing short of it converts
this oracle into an authorization.

> **Convergence note.** The session-surface prerequisite introduced the
> scope-derived `subjectHasLiveWorkspaceAuthorityInScope` and repaired
> `listSessionsForSubject`, `setSessionPin`, and the composer draft. The two
> resolver variants live side by side on purpose: several connection callers
> legitimately ask about a frozen delegation owner rather than the caller and
> can only use the named-subject oracle.
>
> The naming is deliberate and worth preserving. The **dangerous** function
> carries the qualifier (`namedSubjectHasLiveWorkspaceAuthority` - it answers
> about a _named_ subject) and the safer one reads as scoped. Do not "simplify"
> by giving the oracle the shorter name: at the point of use the name is the
> most visible warning either function has.
>
> **The subject-GUC restore under the mechanical traps below is load-bearing and
> must survive any refactor of the wrapper.** A wrapper that sets
> `opengeni.subject_id` and returns without restoring it reopens the leak
> silently - no failing test, no conflict marker. Anything that rewrites the
> wrapper must re-prove the restore with the test that pins it.
>
> The session surface's positive owner-exception provenance is a better shape
> than this path's delegated blocklist. Converging connection authority on that
> shape is a tracked follow-up and is deliberately not hidden in this merge
> resolution.

The personal-connection authority path uses the oracle at every hop -
`freezePersonalConnectionDelegations` and the `*ForGrant` connection resolvers
in `packages/core/src/domain/personal-connection-delegations.ts`, the per-turn
`ownerHasWorkspaceMembership` port and
`resolveGoogleDrivePublicationTarget` in `apps/worker/src/activities/` - and the
stream-token mint recheck in `apps/api/src/sandbox/viewer.ts`. Do not
reintroduce a `getWorkspaceGrant` boolean in those positions, and do not widen
`getWorkspaceGrant` itself: it is also the fallback inside
`accessGrantAuthorization`, where a delegated bearer or API-key principal would
inherit any widening. `getWorkspaceGrant` and the oracle answer genuinely
different questions - a _grant with permissions_ for a request principal versus
a _boolean about a named subject_ - and are not interchangeable at an
authorization site.

Two mechanical traps on this path, both now closed and both worth not
reopening:

- The probe sets `opengeni.subject_id`, `withRlsContext` restores only
  `account_id`/`workspace_id`, and `SET LOCAL` survives savepoint release - so
  on a transaction handle the probed subject leaked into the rest of the
  caller's transaction. `namedSubjectHasLiveWorkspaceAuthority` now restores the
  prior subject itself.
- The account and the workspace passed to a probe must come from one object.
  Scoping RLS by a grant's account while reading memberships for a different
  object's workspace silently filters every row out and drops authority.
- `personalConnectionDelegationSourceForGrant` checks the `{sessionId, turnId}`
  turn branch **above** its delegated filter, which is safe only because
  `DelegatedAccessTokenPayload` forbids a `human_session` principal from
  carrying attempt claims. That coupling is load-bearing; it is pinned by
  `packages/contracts/test/delegated-access-token-attempt-claims.test.ts`.
  Relaxing the refinement means moving the filter above the turn branch.

**Delegated grants carry no personal-connection authority anywhere.** The
delegated filter collapses the source before the workspace is consulted, so a
delegated bearer freezes zero personal connections in ordinary **shared**
workspaces as well as personal ones. That is a deliberate widening of the
denial, not a side effect of the personal-workspace fix: a delegated payload's
`subjectId` is signed token content with no row behind it, so letting it borrow
someone's private provider credentials in a shared workspace is the same defect
as letting it reach their personal workspace. Operator-facing consequences are
in [`docs/embedding.md`](embedding.md).

The session list, pin, and composer-draft seams are repaired by the landed
session-surface prerequisite. Other seams still on the bare join, and therefore
still wrong for a personal workspace, are known and deliberately out of scope
of this connection change. They deny the owner rather than leaking to anyone
else, so each is a broken feature, not an authority hole:

- `listWorkspaceMembers` / `listWorkspacesForSubject`
  (`packages/db/src/index.ts`) - empty roster; the workspace-list fallback is
  latent only because `managedPersonalWorkspacePermissions` carries
  `workspace:read`.
- `withCodexAppsRequestAuthorization`, `designateCodexAppsCredential`,
  `clearCodexAppsCredential` (`packages/db/src/index.ts`) and
  `resolveCodexAppsCredentialIdForRun`
  (`packages/core/src/domain/capabilities.ts`) - Codex Apps designation and
  execution.
- The OAuth-callback grant rechecks over the signed `state.subjectId` in
  `apps/api/src/integrations/{google-drive,atlassian,fiken,social-oauth}.ts`
  and `apps/api/src/routes/connections.ts`. The generic MCP and curated API
  Integration callbacks (`oauth-client` and `provider-oauth`) now resolve the
  exact signed human's live personal-workspace pointer through the narrow
  `resolveNamedManagedPersonalWorkspaceGrant` seam; the remaining provider
  callbacks still deny personal-workspace setup rather than leaking authority.
- SQL seams without the personal-workspace disjunct: the xAI subscription
  authority views/functions in 0234. Migration 0303 repairs
  `transition_session_visibility` and `fork_session_content` with the exact
  active-membership personal-workspace-or-ordinary-membership disjunction. The
  API/core/SDK caller is now active for explicitly activated organizations;
  the web console is its managed-human caller. Visibility transitions and
  private-source forks remain owner-only, while any currently authorized
  workspace member may fork a shared source into fresh authority of their own.
  Worker, MCP, runtime, and React package callers remain future work. 0225's
  `guard_session_authority_write` was the same defect and is repaired by
  migration 0302 (described above); do not add these back to this list. (Many
  other SQL seams - 0253, 0258, 0262, 0264, 0275, 0280 - already carry the
  disjunct.)

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
workspace grant. Owners may invite a human as owner, administrator, or member;
administrators may invite and manage members only.
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
- `POST /v1/organizations` is the compatibility entry point for the one-time
  organization-name-only setup. It creates exactly the owning human's active
  organization membership and canonical Personal workspace/control row—no
  shared workspace and no Personal `workspace_memberships` row;
- `POST /v1/organizations/:organizationId/workspaces` idempotently creates a
  shared workspace without implicitly granting the organization administrator
  operational access;
- `GET /v1/organizations/:organizationId/members` and
  `PATCH /v1/organizations/:organizationId/members/:membershipId`; and
- `PATCH /v1/organizations/:organizationId/workspaces/:workspaceId` plus its
  `/settings` route, `PUT
/v1/organizations/:organizationId/workspaces/:workspaceId/members/:membershipId`
  for an idempotent named or custom grant, and the explicit `/revoke` command
  below that member route for the shared-workspace control plane; and
- `GET|PATCH /v1/organizations/:organizationId/retention-policy`.

These routes require a direct managed-human cookie session; API keys and
delegated bearer requests are rejected.

### Pre-registration invitations and signup convergence (0314)

Migration `0314_unregistered_organization_invitations.sql` lets an owner or
administrator record an invitation before its target has an OpenGeni login.
The durable row keeps the normalized email, optional display name, role, and a
bounded set of initial shared-workspace ids, while `target_subject_id` stays
null. The public response never reveals whether that email is registered, and
the create route deliberately performs no global user lookup. Registered and
unregistered targets therefore receive the same invitation representation.

A pending invitation binds only after the exact Better Auth `user:<uuid>` has
verified the matching normalized email. Binding is performed by a
PUBLIC-revoked SECURITY DEFINER capability under the existing organization
lifecycle policy, serializes first on a normalized-email advisory fence and
then on canonical per-organization advisory locks, and never accepts a
caller-asserted verification fact. Each successful bind appends immutable
evidence naming the exact invitation, verified subject, and resulting revision.
Invitation creation takes the same email fence before its organization lock.
Because managed-access convergence keeps
the transaction-scoped email fence through its pending check and fallback
provisioning decision, it cannot snapshot an absent invitation while a matching
create commits. Until acceptance, the
verified user receives an empty managed access context sufficient for the
managed invitation surface; the fallback `better-auth:user` organization and
workspace are not provisioned. Acceptance then uses the existing exact-subject,
revision-fenced 0263 lifecycle to create the organization membership and
personal workspace, and atomically adds the selected shared-workspace grants.
Consequently a newly provisioned invited user joins the inviting organization
without also creating a redundant personal organization. Self-invitation reads
and acceptance bind through the same database-attested verified-email seam.

0314 is a drained maintenance cutover, not a rolling migration. Old callers can
accept an invitation without applying its initial workspace grants and can run
fallback provisioning before verified-email convergence. Stop every API,
control worker, and turn worker; provide the exact old/new application database
role list to the migrator; apply 0314; and never restart a pre-0314 image.

The Better Auth create hook no longer provisions access before required email
verification. Email verification and later canonical managed-cookie access
both run the verified binding/convergence seam. Managed bootstrap also stops
renaming an existing initial workspace back to `Default workspace`, so a later
administrator rename is durable. Migration 0314 itself sends no provider
message; the later 0348 API delivery path below does.

### Post-sign-in organization setup and one-time invited-user setup (0348)

Migration `0348_named_signup_and_user_setup.sql` makes both onboarding paths
explicit without widening Better Auth or organization authority. Public
self-service email signup remains an ordinary Better Auth account create and
accepts no organization or workspace intent. After the first verified
managed-cookie sign-in, a user with no organization membership or bound
invitation may call `POST /v1/auth/organization-onboarding`
with only a bounded organization name and operation id. One PUBLIC-revoked
SECURITY DEFINER lifecycle serializes the exact auth user, binds any
already-committed verified-email invitation first, and then creates exactly one
active owner membership plus its canonical Personal workspace and control row.
It creates no shared workspace and no `workspace_memberships` row. A FORCE-RLS
completion receipt makes exact retries converge and changed retries fail, while
ordinary managed-access refreshes use the non-provisioning path and cannot
bypass the setup gate. The `/v1/organizations` compatibility entry point
uses the same canonical fingerprint bytes, so an exact operation can move
between either supported route without forking its receipt identity. A user
whose memberships are all suspended or revoked receives the explicit bounded
`unavailable` state; a bound pending invitation still takes precedence and
opens only the invitation chooser. `GET /v1/organization-memberships` reports
that same terminal state as a bounded empty list rather than a 403: the route
projects only the caller's own memberships, so an empty list leaks nothing and
does not make an un-onboarded human look unauthenticated. Its 403 remains for a
session that claims a verified email the durable `auth_users` row contradicts.

Because managed-access convergence no longer provisions a fallback
organization, it also no longer self-heals one. A human left holding a legacy
`better-auth:user` account whose organization membership was never anchored -
migration 0290 anchored only subjects that already held workspace access -
would otherwise be permanently stuck: the state resolver reports `required` and
every completion attempt refuses. The lifecycle therefore **adopts** that exact
account instead of refusing it. It reuses the account id, so the human keeps
their existing account identity and any legacy workspace grants inside it,
takes the canonical organization advisory lock before any workspace state, and
defers the one-shot signup rename until after every workspace row is acquired -
an organization-row write held across workspace acquisition is exactly the
deadlock migration 0299 fences. Adoption requires the account to carry **no**
organization membership at all; one that already has memberships is refused,
because granting owner there would be a privilege event rather than a repair.
No migration-time backfill over a FORCE-RLS table is needed.

Pre-registration invitation creation now claims a matching durable
`organization_user_setup_deliveries` row and append-only attempt before calling
the shared managed-auth email transport. The delivery freezes the invited
name/email, organization name/role, and exact named shared-workspace access. It
stores only SHA-256 token/payload digests, never the bearer or rendered message
body. `organization_user_setup_deliveries` and
`organization_user_setup_delivery_attempts` are FORCE RLS with no application-
role DML; PUBLIC-revoked SECURITY DEFINER claim, prepare, settle, and preview
capabilities are the only application seams.

The prepare capability writes the stable bearer and payload digests and the
`provider_started` marker before provider I/O. A stable provider idempotency key
belongs to the delivery rather than an HTTP attempt, so exact create replays and
explicit retries send byte-identical content under the same key. The digest
includes the effective provider sender as well as recipient, subject, text, and
HTML plus an immutable provider/account/policy idempotency scope, so changing
`OPENGENI_EMAIL_FROM`, provider, provider account, or key-retention policy cannot
silently change a retry under an old key. Clear provider refusals settle as
`failed`; network/server ambiguity settles as `outcome_unknown` and is never
blindly retried by the server. Each transport declares a conservative key-
retention guarantee. The prepare boundary persists the resulting absolute safe-
until fence, and an ambiguous retry cannot extend it. Resend declares its
documented 24-hour retention; another injected transport supplies its own bound
scope and retention. Once the durable fence expires, `retryState` becomes
`reconciliation_required`, the API rejects a new send, and People & invitations
instructs an administrator to reconcile provider state instead of offering a
retry. Every allowed retry appends an attempt and preserves the delivery id,
bearer, frozen snapshot, payload digest, provider scope, safe-until fence, and
provider key. A prior unresolved outcome also survives a later render/prepare
failure or pre-provider lease expiry; only a same-scope idempotent provider
settlement or revocation clears it. Revocation wins over an in-flight provider
result and atomically closes its claim and attempt.

Invitation creation and provider delivery intentionally remain separate
transactions. If the process exits after the invitation commits but before its
delivery journal is created, the invitation list shows `Delivery not started`
and offers `Send invitation`. That authenticated retry resolves the immutable
invite operation receipt server-side, creates the missing ledger while keeping
the original creator binding, and sends through the ordinary prepare/settle
path. An exact expired pre-provider claim becomes `failed`; an expired
provider-started claim becomes `outcome_unknown`. Neither can remain a hidden
permanent `pending` row.

`OPENGENI_RESEND_API_KEY` selects the standalone Resend adapter, while embedded
hosts may inject another provider-neutral `ManagedEmailTransport`. An injected
transport must declare a bounded sender, a stable non-secret idempotency scope
that identifies provider/account/policy, and an integer retention guarantee;
composition rejects malformed metadata before any invitation can commit.
Local/test mode uses a process-local capture transport whose entries are count-
and TTL-bounded and one-time readable; it has no route, database, disk, or log
surface. Production managed-mode configuration validation still requires a
provider key; the injectable seam does not relax that deployment preflight.

Because the bearer is derived from the invitation id, the URL and signing
configuration (`OPENGENI_PUBLIC_BASE_URL` and
`OPENGENI_BETTER_AUTH_SECRET`) is proven as a precondition _before_ the
invitation commits and reported as `503`; a deployment missing either would
otherwise fail after the row exists without even being able to construct the
setup link. Provider availability is deliberately not part of that
configuration precondition; the durable journal records the resulting delivery
outcome.

`POST /v1/auth/organization-setup/preview` accepts the same signed-out bearer
under the setup abuse limiter and returns only its frozen safe invitation
projection. Pending previews include organization, invited name/email, role,
named shared-workspace access, and expiry. Invalid, expired, revoked, and
completed links return explicit bounded states without disclosing another
invitation or account.

`POST /v1/auth/organization-setup` accepts the unguessable bearer without a
session. A bounded fail-closed global/per-client application limiter runs
before request work. The route then performs a cheap, non-consuming,
PUBLIC-revoked SECURITY DEFINER token-authority preflight before invoking
Better Auth's password hasher. Invalid, expired, unavailable, and completed
bearers cannot amplify password hashing; an exact completed retry goes directly
to the final idempotency check. The route fingerprints the request without
storing the password and calls one PUBLIC-revoked SECURITY DEFINER completion
capability. Under the
normalized-email fence and canonical organization lock order, the function
rejects expired or revoked invitations and every pre-existing Better Auth email,
creates one verified credential, binds and accepts the exact invitation through
the revision-fenced 0263 lifecycle, and consumes the bearer in the same
transaction. Exact retries return the committed result; changed replays fail.
After the email fence, every organization referenced by a matching pending
invitation is locked in UUID order before the selected invitation is touched.
No session is created until normal sign-in, no temporary or plaintext password
exists, and the user has only the inviting organization, their canonical
Personal workspace, and the invitation's selected shared-workspace grants.

0348 is a drained maintenance protocol cutover, not a rolling migration. Stop
every old API, control worker, and turn worker; provide the exact old/new
application database role list through
`OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES` (or
`applicationDatabaseRoles` for programmatic/dedicated-schema migration); apply
0348; and never restart a pre-0348 image. The migration checks
`pg_stat_activity` before and after its exclusive writer fence and aborts with
SQLSTATE `55000` if a configured application login remains. The Personal-only
product mutations are also API-contract fenced, and the web sends the exact
release contract revision, so a stale client cannot cross the cutover after
service resumes.

The canonical repository acceptance for this lifecycle is
`test/e2e/organization-onboarding-acceptance.e2e.ts`. It composes the real
Better Auth handler and Hono API, migrates PostgreSQL through a dedicated
`NOSUPERUSER NOBYPASSRLS` owner, provisions and connects through
`opengeni_app`, drives public operations through the SDK, and completes the
human paths in a production-built web bundle under Chromium. Its process-local
mail capture is count- and TTL-bounded, one-time readable, and never persists a
bearer or rendered body. The lane proves ordinary named signup, the exact
Personal-only owner graph, immediate private-session creation, unregistered
setup, registered invitation choice, shared grant/revoke, stale and
cross-organization rejection, password reset, delivery refusal/ambiguity, RLS
posture, accessibility, responsive layout, and browser-error cleanliness.

Run the same fail-closed boundary locally with:

```bash
OPENGENI_REQUIRE_REAL_DB=1 \
OPENGENI_ONBOARDING_EVIDENCE_DIR=/tmp/opengeni-onboarding-evidence \
bun scripts/run-browser-e2e.ts \
  ./test/e2e/organization-onboarding-acceptance.e2e.ts
```

The curated `onboarding` CI lane retains a machine-readable evidence file plus
1440 px, 390 px, and 320 px screenshots. Missing Docker/PostgreSQL, Chromium,
an evidence file, or any expected capture fails the lane rather than producing
a skipped green result.

The managed web console exposes this lifecycle as a bounded organization
administration surface with separate Overview, People & invitations, Retention,
and Billing sections. Overview projects the canonical organization name plus
every shared workspace and its direct human/service access roster; the database
excludes all Personal workspaces before JSON projection. Owners and
administrators can rename the organization through a revision- and
operation-fenced lifecycle function, and managed-access bootstrap never
overwrites that deliberate name from the user's profile. It lists the
organization roster and invitation state; incoming invitation pages include the
authorized current organization name so a multi-invitation choice never relies
on opaque UUID fragments.
supports the role and lifecycle transitions authorized above, accepts incoming
invitations, and gives owners a version-fenced 30–90 day retention editor while
administrators receive the read-only policy. The browser binds every read and
mutation result to the exact managed principal generation, organization, and
route workspace; reads and mutations use independent operation lanes so a
refresh cannot supersede an accepted mutation. An organization transition or
keyed unmount invalidates both lanes before a delayed result can update state,
navigate, announce success, or revalidate authority. A conflict refreshes
authoritative state and requires a new human action rather than replaying the
mutation.

The roster projects the safe name and email fields needed by an administrator;
standalone reads Better Auth while embedded deployments inject the
`userProfileLookup` identity port. A stable masked subject identifier is only a
last-resort compatibility fallback. It never links or derives identity from
another member's `personalWorkspaceId`, and organization
administration does not grant access to that member's Personal workspace,
private sessions, credentials, Connections, or personal resources. Workspace
access is administered from the organization console: invite the person to the
organization first, then assign an active organization member to each shared
workspace. Workspace settings links back to that control plane instead of
creating an independent invitation path. People & invitations shows the invited
name/email, organization role, exact named shared-workspace access, invitation
and delivery state, attempt count, and explicit retry controls for failed or
outcome-unknown delivery. A sole active owner's role/suspend/remove controls
remain visible but disabled with the instruction to assign another active owner
first. The setup screen renders the frozen invitation preview and states that
no Personal workspace is shared.

Migration `0331_managed_organization_creation.sql` introduced the
managed-cookie-only `POST /v1/organizations` factory with a provisional initial
shared-workspace graph. Migration 0348 replaces the same database function in
place and forwards compatibility callers through the final setup lifecycle described
above. Exact operation ids still serialize before replay lookup, but successful
creation now yields only the owner membership and canonical Personal
workspace/control row; it does not create an owner grant or forced shared
workspace. The SECURITY DEFINER function dynamically pins its runtime search
path to `pg_catalog`, the selected data schema, then `pg_temp`.

Migration `0332_organization_shared_workspace_control_plane.sql` makes the
organization control plane authoritative rather than depending on an
administrator also holding an operational workspace grant. The managed-cookie-
only organization routes can create or update shared-workspace metadata/settings
and add, update, or remove an active organization member's direct workspace access. Each
mutation runs under an exact active owner/administrator organization membership
and an organization-scoped transaction advisory fence. Missing,
cross-organization, and Personal workspace ids are rejected through one
non-enumerating result before mutation. The capability never creates an
operational workspace grant for the organization administrator. The exception
to the durable last-workspace-admin removal guard requires a transaction-local
capability opened by the direct organization route; merely holding an
organization role through an ordinary or delegated workspace route does not
activate it. Organization
Overview presents Member and Workspace administrator as the primary access
presets while preserving existing custom permission sets until an administrator
deliberately replaces one.

Migration `0350_organization_shared_workspace_administration.sql` completes
that product contract as a rolling, additive compatibility slice. Every public
`Workspace` now carries a required machine-readable `kind` of `personal` or
`shared`. The database derives it only from the canonical
`organization_memberships.personal_workspace_id` pointer under exact
account/workspace RLS context; names, slugs, and client guesses never determine
authority. Signup and invitation acceptance still create only the joining
human's Personal workspace. A shared workspace exists only after an owner or
administrator explicitly creates it.

The server owns three exact shared-workspace role definitions: `viewer`,
`member`, and `admin`. The administration overview returns their labels,
descriptions, and permission arrays, and every named grant materializes that
server-owned array rather than accepting caller permissions. Existing or newly
authored advanced permission sets remain an explicit `custom` escape hatch;
the server validates them against workspace-scoped permission vocabulary and
never lets custom workspace access smuggle account or billing authority.
Organization owners and administrators may create and rename shared
workspaces, grant or replace access, and revoke access. Ordinary organization
members, cross-organization membership ids, and every Personal workspace fail
closed. Organization membership role changes keep the 0263 sole-owner
invariant; workspace roles do not alter organization roles.

Create, rename, grant, and revoke are operation-id idempotent. Renames and
access replacement/removal are exact-timestamp CAS fenced. Immutable FORCE-RLS
receipt and event tables record the actor membership, shared workspace, target
membership/access row, action, and named/custom role without accepting direct
application DML. Revocation enters the organization advisory fence before the
canonical session-tenancy and per-subject personal-state locks, then delegates
destructive cleanup to the existing 0278 settlement/removal protocol before
writing its receipt. This preserves queued/live turn cancellation and personal
row teardown without reintroducing the organization/workspace lock inversion.

Rolling compatibility is explicit: the legacy `list_organization_members`
function and its Personal retention fields remain unchanged for older binaries.
New organization-administration routes use the separate
`list_organization_administration_members` projection, which exposes safe
name/email plus shared-workspace access and omits Personal workspace and
retention metadata. Organization settings remains the cross-workspace editor
for the human roster and shared-workspace grants. A shared workspace's Members
page is the scoped editor for that workspace: a holder of `members:manage` may
choose from a bounded list of active same-organization humans who do not already
have access, add the selected organization membership, change that member's
workspace role or fine-grained permissions, and revoke that exact workspace
grant. It cannot invite people into the organization, change organization
roles, enumerate unrelated workspace access, or administer Personal
workspaces. The separate Slack access-request queue keeps its existing
workspace-admin lifecycle.

### Recovery custody and permanent workspace ownership

The complete security, notification, rollout, self-hosting, and unsupported
operation contract is in
[`organization-recovery.md`](organization-recovery.md).

Migration `0363_organization_recovery_custody.sql` adds the organization-owner
recovery boundary. A policy names exactly three distinct active non-owner
canonical-human memberships. Each person must accept against the exact policy,
membership, subject, identity, and authentication revisions before the policy
becomes active. A later membership suspension, role change, identity merge, or
authentication revision makes that evidence ineligible instead of silently
retargeting it.

Any eligible custodian may start one recovery operation for an existing active
non-owner canonical-human member. Two distinct accepted custodians must approve;
the target cannot approve their own promotion even when they are also a
custodian. The second valid approval starts one fixed seven-day cooldown. The
operation expires after 30 days, and an existing owner can cancel it before
execution. Execution revalidates the complete policy, target, approvals,
cooldown, expiry, canonical identity, and managed actor fence in one
transaction. Its only authority change is promoting the target membership to
an additional organization owner. It never removes or demotes an existing
owner, moves or shares Personal content, transfers a workspace, changes billing
ownership, or rewrites workspace access.

Configuration, acceptance, starting, approval, cancellation, and execution
require a current canonical managed-browser human plus a selected-slot
`complete_reauth` receipt from the selected account slot within ten minutes. Every mutation takes
the managed actor fence before the canonical `organization-membership:<account>`
advisory lock, then locks the account, recovery state, membership, canonical
identity, and append-only evidence in deterministic order. Operation ids are
body-bound replay keys. FORCE-RLS policy/head/custodian/acceptance/operation/
approval/receipt/event/outbox tables grant the application role no direct DML;
schema-local, PUBLIC-revoked SECURITY DEFINER functions own the lifecycle.
Notification intent is committed with the recovery event through an outbox,
and each provider attempt is journaled as started then sent, failed, or
outcome-unknown under a stable idempotency key. The repository fake provider is
the conformance transport; a production provider remains an operator-selected
adapter rather than part of the custody authority decision.

The public surface is rooted at
`/v1/organizations/:organizationId/recovery`: read overview, replace/disable a
policy, accept custody, start an operation, and approve/cancel/execute one exact
operation. Contracts and SDK types expose server-owned capabilities so the web
Recovery section never reconstructs authorization in the browser. Conflict
responses require a fresh read and a new user action rather than replay with a
new body. The section shows the three acceptances, two-person quorum, exact
cooldown/expiry, target, notification evidence, and promotion-only consequence.

Workspace organization ownership is permanent. Migration 0363 installs a
`BEFORE UPDATE OF account_id` trigger that rejects every distinct organization
change even for migration-owner direct SQL. Authorized
`PATCH /v1/workspaces/:workspaceId` requests containing `accountId` receive the
stable `workspace_transfer_unsupported` conflict before any database update.
Same-organization handoff uses workspace grants. Cross-organization workspace
transfer, billing transfer, Personal-workspace transfer, and ownership
replacement remain unsupported operations.

Migration `0351_organization_user_setup_delivery.sql` adds the rolling durable
invitation-email delivery boundary described above. Its lock prefix is
normalized email advisory fence, canonical organization advisory fence,
account row, actor membership, invitation, delivery, then attempt. Claim holder
ids are server-generated and capability-bound; caller operation ids identify
replay receipts but never authorize settlement. A released `provider_started`
claim projects `outcome_unknown`, preserving ambiguity for explicit human
reconciliation rather than permitting a second untracked send.

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
never old grants.
Removing one workspace membership (migration 0278) is the same canonical
teardown scoped to exactly that workspace and subject: the
`workspace_membership_removal_command` SECURITY DEFINER seam cancels the
removed member's queued/live turns there, interrupts live attempts, ends their
active realtime modes, pauses their created scheduled tasks and owned-session
goals, revokes their workspace-scoped resource grants, advances their private
sessions' authority epochs with `session.authority.revoked` events, registers
workflow wakes, deletes their per-workspace personal rows, and deletes the
membership - in one transaction, behind the same prepare/settle protocol for
pending tool calls. Self-removal, removing the last administering member, and
a non-administering actor fail closed in the seam itself. Other workspaces,
organization membership status, and retention are untouched. Offboarding applies the same canonical
workspace/session/turn/attempt teardown, then terminally revokes membership and
retains resource authority and physical data. Owned-session authority epochs
advance with content-free audit events; unrelated users' shared-session state
is not changed. Since migration 0277, every persistable `/workspace` writer
admission and retained process carries its own authority tuple: causal
initiator, initiating human, the exact organization-membership grant identity
with its observed authorization revision, and the session tenancy
epoch/visibility/owner frozen at admission. `turn` actors copy the accepted
turn's frozen snapshot; `direct` (API request) actors resolve the request
principal's grant through the tenant-fenced
`resolve_workspace_writer_grant_identity` SECURITY DEFINER seam; retained
processes inherit their parent admission's tuple verbatim. A revoked or
suspended grant fences a NEW direct mutation immediately
(`authority_revoked`), and a pre-0277 row with no tenancy half fences a
retained process's next mutation (`authority_unattributed`) - in both cases the
running provider process is never terminated or re-owned, and the fence
consumes no workspace generation. The lifecycle still never infers ownership
for a historical row whose authority was never recorded. Since migration
0281 the live-stream surface is bound to the same authority: a scoped stream
token (`ogs_`, 120 s TTL unchanged) minted for a viewer carries the
authenticated viewer subject and the session's live authority epoch, the
viewer lease holder records the same pair (per-subject monotone - a stale
lower claim never lowers a subject's recorded epoch, while a different
subject reusing the holder id starts a fresh pair), the API re-verifies a
human subject's live workspace authority at every mint through the same
model the route uses - a membership row whose owning organization membership
is active, or an active organization membership's personal-workspace pointer
(managed personal workspaces deliberately have no membership row) - and
degrades to `transport:null` when that authority is gone. Delegated
token-borne grants are authorized by their signed token, not rows, and keep
their route authorization. The selfhosted relay rejects an attach whose
authority claim is below the live channel's authority floor; the floor is
defense-in-depth that dies with the channel, while mint refusal plus the
120 s TTL remain the revocation authority. A pre-0281 token without the
claims still attaches during the rolling window and enforces nothing new.
Connection-use audit facts and variable-set audit events carry the same
attribution since migration 0280: every `connection_use_audit_facts` row
records the frozen causal initiator and the session authority
epoch/visibility/owner observed by the exact locked rows of that use (NULL
attribution on a fence that never loaded them is itself the honest fact), and
variable-set materialization/secret-read audits carry the causal human,
attempt authority triple, and owner authority identity. Variable-set denials
raise and roll their transaction back by design; the application records the
metadata-only denial fact in a fresh transaction instead of weakening the
fail-closed seam. Since migration 0282 the API-direct session-attach
materialization lane records the same fact: the seam reads the request
subject and causal human from the standard context GUCs, writes a
`variable_set.materialized` audit event with actor kind `session_attach` and
the live session authority tuple from the exact locked session row, and an
old image that sets no subject records the explicit `service:session`
sentinel rather than nothing.

Signed object-storage URLs are the remaining deliberately-bounded bearer
surface: provider-native signing has no revocation, so revocation prevents
NEW mints immediately (every mint is route-time authorized against live
grants), every principal-facing issuance - file download/upload mints, video
playback sources, document originals, the files-MCP download tool, and the
workspace-capture manifest/file serves - records a metadata-only
`file.signed_url.issued`/`file.signed_upload.issued` audit fact (subject,
target, expiry; never the URL or object key) awaited before the URL leaves
the platform, and an already-issued URL stays valid only for its short
default TTL (download 300 s, upload 900 s - pinned in the storage tests).
Worker- and provider-internal signed URLs (sandbox materialization,
server-side capture-manifest loads, browser-session provider plumbing) stay
on their attempt/session-scoped authority and are not double-recorded.
Retention policy: `retain`
has no deletion deadline;
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

Invitation, binding-event, operation-receipt, and lifecycle-event tables are FORCE RLS with
zero direct application-role DML. Target-schema-local SECURITY DEFINER routines
are PUBLIC-revoked, explicitly granted, and pinned to
`pg_catalog,<target-schema>,pg_temp`. Managed access refresh re-reads all active
memberships for the subject and derives role-bounded account plus owner-only
personal-workspace grants; inactive organizations disappear on the next
request.

### Lock order: organization fence before the canonical workspace prefix (0299)

The membership lifecycle spans an entire organization, so it must agree with
every ordinary workspace writer about lock order. Migration
`0299_organization_membership_lock_order.sql` fixes the one place
where it did not.

**What was wrong.** `prepare_organization_membership_protocol_settlements`, the
wrapped `organization_membership_command_0263`, and the 0275
`organization_membership_command` wrapper each opened with `managed_accounts
... FOR UPDATE` and took the canonical per-workspace prefix
(`workspace_inference_controls FOR SHARE` -> `workspaces FOR KEY SHARE`) only
afterwards. An ordinary workspace writer is forced into the opposite order and
cannot avoid it: it locks its own `workspaces` row first - AGENTS.md's canonical
event-write prefix - and only then reaches `managed_accounts` _implicitly_, through
the account foreign-key check of a row it inserts. `sessions`,
`session_events`, `session_turns`, `session_goals`, and
`session_system_updates` all reference `managed_accounts`, and an FK check takes
`FOR KEY SHARE` on the referenced row, which conflicts with `FOR UPDATE`:

```
transition_session_visibility    holds workspaces       waits managed_accounts
prepare_organization_membership  holds managed_accounts waits workspaces
```

An administrator suspending or offboarding a member concurrently with any
ordinary workspace write in the same organization therefore deadlocked (40P01).

**What replaced it.** The organization row lock was doing two unrelated jobs.
Mutual exclusion between concurrent membership commands for one organization is
now a transaction-scoped advisory lock,
`pg_advisory_xact_lock(hashtextextended('organization-membership:<organization
id>', 0))`, taken by all three entry points. It is re-grantable within one
transaction, so the wrapper, the preparation seam, and the wrapped 0263 body all
take it reentrantly inside the single `updateOrganizationMember` transaction,
and it lives in a lock space no ordinary workspace writer touches, so it can
never appear in a cycle with a `workspaces`/`managed_accounts` row lock. Proving
the organization exists and cannot be deleted underneath the command stays a row
lock, downgraded to `managed_accounts FOR KEY SHARE`, which still blocks DELETE
and primary-key UPDATE while being compatible with every ordinary writer's FK
check. This is the same shape migration 0278 already used for the workspace
membership removal seam.

The lifecycle's first _row_ lock is therefore the canonical prefix, and the full
order is:

```
advisory 'organization-membership:<organization id>'
  -> shared advisory 'session-tenancy:<workspace id>' for every organization
     workspace in UUID order (after the 0345 protocol cutover)
  -> managed_accounts FOR KEY SHARE
  -> per workspace, in UUID order:
       workspace_inference_controls FOR SHARE
       workspaces FOR KEY SHARE
  -> organization_memberships FOR UPDATE (UUID ordered)
  -> sessions FOR NO KEY UPDATE -> session_turns FOR UPDATE
  -> session_turn_attempts FOR UPDATE
```

The 0345 session-tenancy cutover extends the same prefix to every privileged
membership lifecycle entry point, including the preparation seam and the
wrapped 0263 body. The shared workspace fences do not stall ordinary session
writers, but they exclude a concurrent visibility transition or fork before
the lifecycle takes any session row lock or performs any session mutation.
Retention database finalization uses the same sorted organization-wide shared
fence set because it can pause scheduled tasks in any organization workspace
before deleting the revoked member's personal workspace and its cascades.

**Do not reintroduce a conflicting organization row lock.** Any new
organization-wide seam that both locks `managed_accounts` more strongly than
`FOR KEY SHARE` and afterwards touches `workspaces` (directly or through an FK)
recreates this deadlock. Serialize on the advisory key instead. CAS on
`organization_memberships.authorization_revision`, the operation-receipt
idempotency, and every fail-closed authorization check are unchanged by 0299 -
only lock strength and lock class moved.

`packages/db/test/migration-0299-organization-membership-lock-order.test.ts`
holds the regression evidence: a deterministic cycle probe, a parallel-load
probe that asserts PostgreSQL's own `pg_stat_database.deadlocks` counter does
not move (so an application-level `40P01` replay cannot mask a regression), and
an exclusion probe that proves a held advisory key genuinely blocks a
concurrent membership command.

**Defence in depth, not the fix.** `updateOrganizationMember()` and
`acceptOrganizationInvitation()` additionally replay their exact transaction a
bounded number of times on `40P01`. Replay is exact rather than approximate:
the whole lifecycle command runs in one transaction keyed by its
caller-supplied operation id (`organization_membership_operation_receipts`)
plus its CAS revisions, and a deadlock abort rolls back every durable effect,
so re-running the identical command either applies it once or observes the
newer authoritative state. `40001` remains the authoritative stale-revision /
stale-epoch conflict and is never replayed. That wrapper is a caller-side
safety net for a `40P01` raised by some _other_ cycle; it is not the lock-order
fix and must never be treated as a licence to reintroduce a conflicting
organization row lock. The 0299 parallel-load probe reads
`pg_stat_database.deadlocks` directly precisely so this replay cannot hide a
lock-order regression.

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

## Context-bootstrap tables outside RLS

`workspaces`, `workspace_memberships`, and `auth_identities` carry an
`account_id`, grant the runtime role full DML, and deliberately have no
row-level security. They are the tables the authentication and access layer
reads to _establish_ the organization context that every RLS predicate then
depends on, so an `account_id = current_account_id()` predicate over them is
circular for the first two and type-incoherent for the third — `auth_identities`
holds Better Auth's provider subject string in `account_id`, not a tenant id,
and Better Auth queries it over its own connection pool that never carries an
OpenGeni GUC. Consequently a query that reached the database layer without going
through the access layer can read another organization's workspace and
membership _metadata_, though never its content: every content table remains
FORCE RLS and genuinely isolated.

This is a reasoned exemption rather than an oversight, and it is attested by
`packages/db/test/non-rls-authority-tables.test.ts` — which also pins the three
dormant capability policies already stored on `workspace_memberships`, because
enabling RLS on that table would make them the entire admission set and fail
every membership read closed. Adding a table to `NON_RLS_RUNTIME_TABLES` is a
tenancy decision; update that test and the analysis in
[`design/organization-tenancy-non-rls-authority-tables-2026-08-18.md`](design/organization-tenancy-non-rls-authority-tables-2026-08-18.md)
in the same change.

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
activity writes fail closed when that snapshot is stale. 0222 itself activates
no visibility mutation, read authorization, or fork path; its successor
`0225_session_visibility_fork_activation.sql` does, and the next section states
exactly which parts of that successor are live and which remain inert.

Note that owner membership is null only as a _column default_. Since 0225 the
`guard_session_authority_write` trigger derives
`owner_organization_membership_id` and `owner_subject_id` on every subject-created
session insert - from the parent session for children, otherwise from the
creator's active organization membership when that subject also holds a
`workspace_memberships` row for the target workspace. Ordinary session creation
for a managed human therefore produces an owned, `workspace_shared`,
epoch-1 session; only pre-0225 rows and sessions created without a resolvable
membership stay ownerless.

Null owner/authority/grant fields are non-authority. Contract parsing likewise
defaults omitted resource scope to `workspace`; `user` scope requires one
complete opaque delegation.

## Session-visibility and fork public activation

`0225_session_visibility_fork_activation.sql` shipped the first database
surface; `0303_session_tenancy_product_activation.sql` replaces its unsafe
mutation contract. The database prerequisite and first public caller are now
both present, but the caller remains inert for every organization without its
exact version-1 activation receipt.

**Active today.** These parts of 0225 run in production on every deployment:

- `guard_session_authority_write`, a `BEFORE INSERT OR UPDATE` trigger on
  `sessions`. It derives the owner pair described above, rejects incomplete
  owner provenance, rejects `user_private` without an owner, and rejects any
  direct write of visibility, owner, authority epoch, or fork provenance that
  does not hold a transaction-local row in the FORCE-RLS
  `session_visibility_write_capabilities` table. Ordinary application code can
  therefore never set those columns itself.
- `session_private_actor_visible` (SECURITY DEFINER) and
  `session_reference_visible` (SECURITY INVOKER), the two read predicates.
- The RESTRICTIVE `session_visibility_isolation` policy, installed on
  `sessions` and on every FORCE-RLS table that carries `account_id`,
  `workspace_id`, and a foreign key to `sessions.id`, plus a seven-table manual
  list. Later migrations add it to their own new tables. **Visibility-aware
  reads are live, not future work**; 70 tables carry the policy.
- The `authority_change` interruption kind and the runtime `EXECUTE` grants on
  both lifecycle functions.

Migration 0304 aligns `session_private_actor_visible` with the same exact
personal-workspace-or-ordinary-membership disjunction. Without that repair, a
valid personal-workspace transition to private committed successfully and then
hid the session and its event from its owner because personal workspaces never
carry a `workspace_memberships` row.

Migration 0311 adds atomic private visibility at session creation. The public
create request defaults to workspace visibility; an explicit Only-me choice is
accepted only for the exact canonical managed human in an activated
organization and is inserted with owner provenance, visibility, and the first
event/turn in the existing create transaction. The web checks the capability
before presenting Only me, omits the locked choice when Workspace is the only
valid value, and never sends a restored private draft while that preflight is
pending or denied.

Migration 0323 separates operator readiness from product enablement for shared
organization workspaces. The version-1 `session_tenancy_activations` row
remains the drained, evidence-backed operator prerequisite for every private
create. A distinct FORCE-RLS `organization_private_session_settings` row is the
owner/admin product decision for shared organization workspaces on top of that
receipt. Its managed-session `GET`/`PATCH
/v1/organizations/:organizationId/private-session-settings` API is backed by
subject-bound SECURITY DEFINER functions with active-membership owner/admin
role checks, optimistic versioning, and idempotent operation receipts; it never
consults the organization members endpoint. Existing organizations that were
already operator-activated are backfilled enabled so the rolling migration does
not remove a shipped capability. For later activations, an owner or
administrator must enable Only-me chats before use; the setting cannot be
enabled before the receipt exists. Enablement does not grant access: any active
member may use it only in a workspace where their ordinary grant carries
`sessions:create`, and the private-create transaction rechecks their exact
organization membership plus workspace membership. The setting is enforced by
`open_private_session_create_capability` under the organization advisory fence
and after keyed replay resolution, so a committed keyed create still replays
after the setting is disabled while a fresh create fails closed
(`SESSION_TENANCY_NOT_ACTIVATED`). A managed human's own Personal workspace
keeps the exact 0311 rule: the receipt alone admits an explicit Only-me create
there, and the setting is not consulted. Personal-workspace creates are not
forced private by the server; the web still sends the ordinary workspace-default
wire path for a Personal workspace.

**Mutation-active only after an explicit per-organization cutover.**
`transition_session_visibility` and `fork_session_content` exist, are SECURITY
DEFINER, are granted to the runtime role, are listed in
`RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES`, and have a first-class adapter at
`@opengeni/db/session-tenancy`. `@opengeni/core` now owns the sole product
adapter call, reached by `PUT .../sessions/:id/visibility` and
`POST .../sessions/:id/forks`; `@opengeni/sdk` exposes matching methods. Both
routes require the canonical managed-cookie owner, the exact workspace/session
permissions, and the corresponding host authorization operation. The web
console calls only these SDK methods after the activation-gated `tenancy`
projection proves current ownership; worker, MCP, runtime, and the React
package remain non-callers. The SQL function remains the sole
writer of `session.visibility.changed`; core fetches the returned durable event
id and sequence and performs best-effort live publication without appending a
second event or waking a workflow.

Migration 0303 itself is rolling and supplies platform readiness, not the
owner/admin product preference. The drained
`bun run db:activate-session-tenancy -- --organization-id <uuid> --activated-by <operator>`
command verifies the canonical opt-in, required migrations, zero-valued tenancy
parity gates plus exact drainable/bounded lanes, while retaining the inventory
as contextual evidence, before inserting one immutable
`session_tenancy_activations` receipt. A mutation without that exact version-1
organization receipt fails closed.

0303 was also an intentional signature cutover: it removes the historical
eight-argument transition and fork routines and installs only the corresponding
nine-argument routines with a mandatory activation-version argument and no SQL
default. There is no compatibility wrapper because no legacy product caller
existed at the signature cutover, and an omitted version must fail with
undefined-function rather than infer or bypass activation. The 0225/0289
migration bodies remain historical checkpoints;
anything running against the fully migrated schema, including later migration
tests, must supply version `1` and operate under the exact durable receipt.
Migration 0336 is a rolling expansion on top of that cutover. It retains the
nine-argument private-only overload for an in-flight old caller's exact retry
and adds the ten-argument product overload with an explicit acknowledgement
boolean. New callers use only the ten-argument overload. No defaulted or
activation-free signature is reintroduced.

The activated database contract is intentionally narrow:

- Access is the exact disjunction of an active membership whose own
  `personal_workspace_id` names the workspace, or an ordinary
  `workspace_memberships` row. Names, creators, defaults, roles, and permission
  strings are never authority.
- A transition rejects with a typed conflict unless turns/attempts,
  interruptions, updates, human/tool/RunState receipts, goals/capacity waits,
  realtime, schedules, workspace writers/processes, and sandbox viewer or
  interaction holders are all quiescent. The stale 0225 auto-cancellation
  behavior is not ported. The nested quiescence helper is owner-internal and
  ungranted; only the fully authorized lifecycle functions may invoke it.
- Transition-to-private additionally requires a singleton sandbox group. A
  fresh transition to private in a shared workspace also requires the 0323
  organization setting. Migration 0344 fences the actual visibility update,
  after the lifecycle function's applied-receipt replay return, so a committed
  transition still replays after disable. Personal workspaces are exempt and
  transition-to-shared never consults the setting.
  A
  proven transition advances the epoch, revokes old-epoch personal grants,
  clears staged personal delegations, preserves 0301 cache/pin behavior, and
  appends one event without a workflow wake.
- The fork contract is same-workspace with an explicit `user_private` or
  `workspace_shared` destination. A private source may fork to workspace scope
  only when the request durably acknowledges that its complete conversation
  will be exposed there. The acknowledgement and destination visibility are
  bound into the idempotency hash. One atomic function serializes a quiescent
  source, inserts the destination directly at its selected visibility, creates
  a fresh owner/epoch/provenance/root/singleton group, copies the exact durable
  content allowlist (including typed reasoning/latency), and copies no live
  grant, credential, Connection/delegation, goal/turn, MCP, Variable Set, Rig,
  sandbox identity/process, personal-resource authority, or pin. It never
  creates a private fork and then transitions it. A separate read-only replay
  capability resolves only an exact applied actor/workspace/source/key/request-
  hash receipt before mutable source authorization, so a lost successful
  response remains recoverable after a shared source becomes private. Changed
  intent conflicts, and an absent or fresh key returns no result and must pass
  current source plus embedding-host authorization.
- Both adapters return the exact durable event id and sequence required by a
  later core publisher.

The practical product consequence is deliberately bounded. Only an activated
organization's canonical managed-human owner may change an otherwise quiescent
same-workspace session between `workspace_shared` and `user_private`, or fork a
private source. Any canonical managed human with current access to a
workspace-shared source may make an independent same-workspace private or
workspace-shared fork, which is owned by that actor and retains no source
authority. API keys, delegated/service callers, workers, MCP, runtime, React,
and external non-cookie clients have no product control. The SDK requires an
explicit idempotency key.
Fork requests additionally require an explicit destination visibility and
acknowledgement boolean; visibility changes require the current public authority epoch.
Applied fork replay still requires the exact actor's live workspace authority
and cannot be used to discover another destination or source.
Subject-authorized session reads expose the secret-safe `tenancy` projection
only after activation. The console renders state only when that projection is
present. Its app-lifetime controller retains one exact operation key across
same-target component reload and outcome-unknown/replay recovery, while exact
principal, workspace-transition, and session changes retire old keys. A replay
refetches current tenancy before presentation, so a superseding epoch or missing
projection cannot be mistaken for the historical receipt. Same-workspace fork
navigation additionally requires a fresh owned destination at the receipt's
selected visibility. Route and
principal transitions make delayed browser outcomes inert.
`test/session-visibility-contract-surface.test.ts` pins the server caller
boundary; the web component and Chromium acceptance tests pin the browser
boundary.

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

These constraints represent identity, not runtime permission. Activated access
paths must still prove the authenticated owner membership and target-workspace
grant. Migration 0264 activates the first bounded Connection surfaces: its
accepted-turn transaction atomically changes an active `once` grant to consumed
and binds the exact logical turn in the durable receipt. Recovery and each
physical provider request only revalidate that receipt; no later turn can reuse
it. The accepted snapshot keeps the Connection's same-organization physical
origin distinct from its target workspace, including the owning human's
membershipless canonical personal workspace; this does not create ambient
authority for administrators or other subjects. The maintenance migration
checks for live app-role writers around its exclusive locks and rejects every
executable pre-activation common-user source rather than deriving historical
acceptance from mutable authority. Surfaces outside the explicit 0264 boundary
remain future activation work.

## Later migration phases

### B. Dual-write and first access projection (0219)

Managed-human membership and personal-workspace lifecycle metadata now use the
narrow provisioning seam described above. The first disjoint activation adds
only the authenticated owner's personal workspace to the managed-human access
projection after lifecycle convergence; it does not add a durable workspace
membership or change the legacy default. Resource authority/grant dual-write
remains future work at this phase; old writers remain accepted. Migration 0222
separately delivers the accepted-attempt authority snapshot and stale
activity-write fence described in the Legacy behavior section, and migration
0225 subsequently activates new-session owner derivation and visibility-aware
reads. The later bounded API/core/SDK activation described above does not widen
the personal-workspace exception or add another durable membership row.

### C. Membership lifecycle (0263 + 0314 + 0330 + 0331 + 0348 + 0351 current)

The invitation, role, suspension, reactivation, offboarding, retention,
operator-driven destructive expiry, and multi-organization access projection
described above are active. The bounded managed web administration surface
described above is also active. Verified-email invitation binding,
self-service managed organization creation, organization-scoped shared
workspace administration, the invited-user setup email, and durable email
delivery outcome/retry reconciliation are active. Automatic scheduling of the
operator command remains deferred.

### D. Backfill

Classify every existing resource explicitly as workspace-owned unless there is
reviewed, deterministic evidence for user ownership. Never infer user authority
from `created_by`, connection attribution, a default workspace, resource name,
or current access. Provision personal workspaces for active memberships through
an idempotent lifecycle operation. Record backfill receipts and unresolved rows
without widening access.

The receipt/unresolved ledger is migration 0300: `tenancy_backfill_receipts`
(one idempotent row per organization, resource family, and run key, carrying
classified/skipped/unresolved counts) and `tenancy_backfill_unresolved_rows`
(one append-only row per resource that could not be classified deterministically,
carrying only the resource id and a fixed reason code). Both are FORCE RLS with
no direct `opengeni_app` DML; the only write path is the `tenancy_backfill_ledger`
lifecycle seam - `open_tenancy_backfill_receipt`,
`record_tenancy_backfill_unresolved`, and `complete_tenancy_backfill_receipt`.

Three properties of that seam are load-bearing. The append function takes exactly
receipt, resource, and reason: an unresolved row records a _refusal_ to infer
authority, so the ledger has no column and no argument able to express the
inference it declined to make. The unresolved count is owned by the append
path rather than supplied at completion, so a sweep cannot settle its own
receipt while understating its outstanding obligations. Settled receipts are
evidence: they accept no further rows, cannot be re-opened, and cannot be
settled twice. And every seam is tenant-fenced on the caller's exact
`opengeni.account_id` (the 0285 precedent): `open_tenancy_backfill_receipt`
fences on its organization argument, the other two on the resolved receipt's
owning organization, each raising `42501` on a mismatch. One organization
therefore cannot open, append to, or settle another organization's receipt -
which would both pollute phase-D evidence and make the victim's in-flight
backfill fail `already settled`.

Receipt opening is idempotent concurrently, not merely serially: it yields to
the unique `(organization, resource family, run key)` index and adopts the
winner's row, so parallel sweeps in later slices converge on one receipt rather
than surfacing a duplicate-key error.

The phase's data source is the read-only inventory seam (migration 0285,
corrected by 0292): `bun run db:inventory-tenancy --organization-id <uuid>`
reports content-free counts of every legacy-attribution population - ownerless
sessions, Variable Sets / Rigs / Connected Machines **per authority lane**,
connections per authority lane, humans with workspace access but no
organization-membership anchor, active memberships per lifecycle status,
unattributed workspace writers, and the two linked-input gates (documents
without common authority; Codex credentials without a recorded connecting
human, both owned by their own issues and only counted here). Integers only;
the seam never returns identities, names, keys, or values, and it rejects a
cross-organization request.

The membership and personal-workspace half of the phase is the operator command
`bun run db:backfill-organization-memberships --organization-id <uuid>
--run-key <unique-key>`
(`--dry-run`, `--limit`, default 25, max 100, `--max-passes`, default 1000,
`--after-subject-id`). It drains exactly two of those
counts - `workspaceMemberSubjectsWithoutMembershipAnchor` (humans who held
workspace access before 0219 and never re-authenticated afterwards, so the
managed-access hook never provisioned them) and
`organizationMemberships.activeWithoutPersonalWorkspace`.

Provisioning goes through the existing lifecycle authority, never a second one:
the driver calls the same shared `ensureManagedHumanPersonalWorkspace` helper
the Better Auth managed-access hook calls, over 0219's
`ensure_managed_human_personal_workspace` SECURITY DEFINER capability. The
driver holds no authority logic and writes no organization-tenancy table
directly. Migration 0290 adds only the read-only enumeration it was missing -
`list_organization_membership_backfill_anchors(uuid, text[])` and
`list_organization_memberships_without_personal_workspace(uuid, integer, text)` -
because `organization_memberships` is FORCE RLS with zero direct application
privileges. Both are strictly read-only definer seams over an exact
organization scope; the new `organization_membership_backfill` lifecycle marker
is added to that table's policy `USING` clause only, so it is structurally
incapable of authorizing a write. Every other table the driver reads
(`workspaces`, `workspace_memberships`, `managed_accounts`, `auth_users`) is an
ordinary account-scoped application-role read.

A candidate is provisioned only on complete deterministic evidence: a live
Better Auth login identity for the exact subject, an organization whose own
external identity _is_ that human, and a persisted owner-role workspace
membership. Anything else is recorded unresolved with a bounded reason code and
left completely untouched - `missing_login_identity`,
`organization_identity_mismatch` (the human is a member of someone else's
organization, where the only provisioning path is 0263 invitation acceptance
bound to their own authenticated session - a human act, not a backfill),
`missing_owner_workspace_membership` (workspace access is not ownership), and
`membership_terminal_status` (reactivating a suspended or revoked anchor is an
explicit owner-authorized 0263 action). Consequently at most one subject per
organization is ever backfill-provisionable, which is the honest consequence of
never inferring authority rather than a limitation to work around.

Each candidate is claimed independently with `FOR UPDATE SKIP LOCKED` on its
exact owner workspace membership and provisioned in its own transaction, so the
command is idempotent, resumable, and safe to run repeatedly and concurrently: a
held claim is reported `contended` and picked up by a later run, never blocked
on and never double-provisioned. `--dry-run` classifies and writes nothing at
all.

`--limit` bounds **one pass**, and a pass is a **keyset window**, not a fixed
one. Both populations are ordered by `subject_id`, each is read `limit`-deep
from the same exclusive cursor, and the merged window is therefore a true
prefix of the merged ordered stream - so neither population can starve the
other, and the pass hands back the `nextCursor` that resumes it. One command
invocation chains those passes until the stream is exhausted (`drained: true`,
`lastCursor: null`), bounded by `--max-passes`; a run stopped by that bound
reports `drained: false` and the `lastCursor` that `--after-subject-id`
resumes. This is what makes repeated runs _converge_: a subject the driver
cannot resolve stays in its population permanently, so a fixed `LIMIT n` window
over an organization with more than `n` `user:`-kind subjects would return the
same first `n` rows on every pass and never reach subject `n + 1` at all.
Migration 0340 connects the driver to the durable ledger. A non-dry walk with
`--run-key` opens one `organization_memberships` receipt, records every refusal
with the exact organization-membership id or source workspace-membership id
that made it an obligation, and settles only a complete-from-the-start,
drained, uncontended walk as `completed`. A partial/resumed, contended, or
failed walk settles `failed`; use a fresh run key for the final evidence walk.
Dry runs still write nothing. The four membership-specific reason codes are
part of the fixed, content-free vocabulary; no subject or proposed owner is
stored in the ledger.

Migration 0340 also repairs the two seams that walk feeds on. Migration 0290
gave `list_organization_membership_backfill_anchors` and
`list_organization_memberships_without_personal_workspace` the
`organization_membership_backfill` marker on the shared
`organization_tenancy_lifecycle` policy; migration 0305 restated that policy's
marker list to add `personal_resource_grant_management` and dropped 0290's
entry. Both seams have returned `[]` ever since for a NON-superuser migration
owner - measured on `acquireOwnerMigratedTestDatabase`, not inferred. Because
they are SECURITY DEFINER owned by that role, even a superuser _caller_ gets the
owner's RLS, so only a superuser-migrated database (every prior test harness)
hid it. The consequence was that an already-anchored subject read as
provisionable and the memberships carrying no personal workspace - the actual
target population - were invisible, so the walk could not converge them and its
receipt counts were wrong. 0340 restores that visibility as its own narrow
read-only policy, `organization_membership_backfill_read`, so the next migration
to restate the shared list cannot delete it again.

#### Variable Sets, Rigs, and Connected Machines need no data rewrite

These three families are already terminally classified, and the phase D
deliverable for them is an assertion plus a receipt rather than an `UPDATE`.
`authority_scope` is `text NOT NULL DEFAULT 'workspace'` on all three tables
(0230 for `workspace_variable_sets` and `rigs`, 0262 for `enrollments`), so
every pre-existing row already carries an explicit workspace classification.
Each `*_authority_shape_check` requires `authority_id IS NULL` and
`owner_organization_membership_id IS NULL` for organization/workspace scope and
was `VALIDATE`d at creation, so PostgreSQL has already proven the shape of every
row. A legacy unmigrated row and a deliberately workspace-scoped row are
therefore byte-identical, and 0262 records the reviewed decision in its own
header: "Existing rows remain workspace-owned."

`origin_workspace_id` is provenance, not classification, and does not supply a
missing discriminator: no shape check constrains it for these three families
(unlike `connections`, whose 0256 workspace branch requires
`origin_workspace_id = workspace_id`), and every read of it is gated behind
`authority_scope = 'user'`, which the lifecycle functions always populate. Its
NULL polarity is also inconsistent across the families, so it means different
things in each. Do not backfill it as if it were a classification, and never
resurrect a NULL origin on a user-scoped row - the `ON DELETE SET NULL` foreign
key erased that origin deliberately.

Migration 0256 remains the one sibling family with a genuine discriminator:
`connections.subject_id` plus an active `organization_memberships` row. None of
these three tables has a `subject_id`, so the same shape does not transfer.

#### Connection authority convergence (migration 0340)

Connections use that genuine discriminator through a separate bounded command:

```bash
bun run db:backfill-connection-authority --organization-id <uuid>
bun run db:backfill-connection-authority --organization-id <uuid> --apply \
  --limit 500 --max-batches 200 --run-key <fresh-key>

# Repair only independently proven membership prerequisites first, then
# perform the ordinary connection convergence:
bun run db:backfill-connection-authority --organization-id <uuid> --apply \
  --remediate-memberships --membership-run-key <fresh-membership-key> \
  --run-key <fresh-connection-key>
```

Dry-run is the default. Apply batches claim `legacy_user` rows with
`FOR UPDATE SKIP LOCKED` and upgrade only a connection whose exact
`subject_id` has one active membership in the same organization. The command
never treats origin workspace, current workspace access, creator metadata, or
provider identity as ownership. Rows without that proof stay byte-identical and
the final full-population classifier records them unresolved. A fresh run key
on a complete converged walk produces the sixth activation receipt,
`connections`; a partial walk must resume without a run key and classify under
a fresh key only after convergence.

Migration 0347 adds the bounded operator evidence needed when 0340 reports a
non-zero residual. Every invocation returns `evidenceBefore` and
`evidenceAfter`; `--evidence-limit` controls the page (maximum 100), and
`--after-connection-id` resumes display after a connection UUID. Completion is
always decided by `evidenceAfter.remaining.total`, which is a full-organization
count independent of that cursor. An empty late page therefore cannot report
success while an earlier residual still exists. Evidence contains connection
UUID, persisted subject id, a fixed classification, and a fixed action only. It
does not expose provider configuration or credentials and never writes
authority.

The two automated actions are intentionally narrow:

- `run_connection_backfill` means the exact active same-organization
  membership already exists, so the normal 0340 upgrader is sufficient.
- `run_membership_backfill_then_connection_backfill` means the independent
  membership lifecycle has the exact Better Auth login, self-owned Better Auth
  organization identity, and owner workspace-membership proof. Use
  `--remediate-memberships` with fresh membership and connection receipt keys.
  A connection row is never evidence for creating a membership.

Every other action remains fail-closed and the command exits non-zero:

- `review_membership_lifecycle_do_not_reactivate_automatically`: a suspended,
  revoked, or otherwise terminal membership must go through an explicitly
  authorized membership lifecycle. The backfill never reactivates it.
- `restore_login_identity_then_recheck`: restore the exact supported login
  identity through the authentication lifecycle, then rerun the dry run.
- `correct_organization_identity_through_supported_account_lifecycle_then_recheck`:
  correct the organization's managed identity through the supported account
  lifecycle. Never rewrite identity columns as a backfill shortcut.
- `establish_owner_workspace_membership_through_supported_membership_lifecycle_then_recheck`:
  establish the required owner access through an authorized membership
  lifecycle. Never promote access from connection provenance.
- `classify_external_subject_then_migrate_via_authorized_connection_lifecycle`:
  classify the external subject, then use its authorized connection lifecycle;
  do not coerce it into a human subject.
- `repair_conflicting_connection_authority_rows_under_incident_procedure` and
  `repair_unrecognized_connection_authority_shape_under_incident_procedure`:
  preserve the row and escalate under the database incident procedure with an
  independently reviewed repair. These shapes have no general-purpose
  automated rewrite.

After any supported corrective action, rerun the dry run and use fresh receipt
keys for an apply. Earlier unresolved receipts remain immutable evidence; a
later recheck records current truth rather than rewriting history. The 0347
inspector uses its own target-schema-local, invocation-exact, SELECT-only
FORCE-RLS capability. It cannot inherit 0340's connection update capability or
collide with a second OpenGeni schema in the same database.

Migration 0340 also closes both ways this compatibility population could reopen.
After an organization activates, `bind_connection_authority` refuses to mint a
new personal connection without a live membership, surviving `legacy_user`
rows are invisible to runtime reads, and the worker refuses a pre-snapshot
workspace reference without an exact connection id before resolving any
credential. Pre-activation behavior remains unchanged, so rollback is still
permitted until the activation receipt is written.

Both of those paths depend on one seam,
`opengeni_private.bind_connection_owner_authority`, and it exists because
`organization_memberships` and `organization_user_resource_authorities` are
`FORCE ROW LEVEL SECURITY` and OpenGeni runs its SECURITY DEFINER routines as a
NON-superuser owner without `BYPASSRLS`. Migration 0256's inline
`SELECT ... FOR SHARE` plus authority `INSERT` therefore matched nothing on
every real deployment: a personal connection whose subject _did_ hold a live
membership silently degraded to `legacy_user`, and 0340's convergence would
have raised `42501 connection backfill membership authority is unavailable` on
every deterministic candidate. The seam opens one read-only
`connection_authority_binding` marker window - owner-only policies on two
tables that carry zero runtime privileges - takes the row lock, mints the
authority row, and restores the previous marker on every exit. The marker gates
narrow dedicated policies rather than new entries in the shared
`organization_tenancy_lifecycle` list, so a later migration restating that list
cannot silently drop connection binding. Note the PostgreSQL rule that made
this invisible: `SELECT ... FOR SHARE` is gated on the UPDATE/ALL policy
`USING` clause as well as the SELECT one, so a capability policy declared only
`FOR SELECT` leaves a row-locking lookup blind. See
[`force-rls-migration-backfills.md`](force-rls-migration-backfills.md) and the
production-posture regression harness
`packages/db/test/migration-0340-owner-migrated-tenancy-cutover.test.ts`.

Migration 0291 is the resulting assertion seam:
`bun run db:verify-resource-classification --organization-id <uuid>
[--run-key <key>]` proves per row that each Variable Set, Rig, and Connected
Machine already carries an explicit terminal authority classification, and
records what it cannot prove. It covers the only genuinely unenforced parts of
the classification, which no constraint catches: that a row claiming user
ownership points at an authority row of the matching `resource_kind` and
`resource_id`, that the authority and its owning organization membership are
both live, and that the delegation still has an origin workspace. Every failure
becomes an unresolved obligation with a fixed reason code - never a guess, and
never a rewrite. Supplying `--run-key` records the verdicts durably through the
backfill ledger as one receipt per family; the report's `ledgerAvailable` field
states plainly whether that happened.

The seam is `SECURITY DEFINER` and claims a transaction-scoped capability
rather than running as plain migration SQL, and this is structural rather than
stylistic. All three tables are FORCE ROW LEVEL SECURITY behind
`workspace_rls_visible(account_id, workspace_id)`, which is false while the
`opengeni.workspace_id` GUC is unset - as it is during migration. FORCE RLS
applies to the table owner, and the documented deployment posture
([`deployment.md`](deployment.md)) is a non-superuser migration principal
without `BYPASSRLS`. A bare `UPDATE ... WHERE ...` in a migration body therefore
matches zero rows and reports success on such a deployment, and only appears to
work in the test harness, which migrates as a superuser for whom FORCE RLS never
engages. Any future classification work on these tables must run behind the same
kind of capability-claiming seam.

**There is no "unclassified" count for Variable Sets, Rigs, or Connected
Machines, and one must not be reintroduced without new schema.** 0285 reported
one, defined as `authority_id IS NULL`; 0292 removed it. The authority shape
constraints (`workspace_variable_sets_authority_shape_check`,
`rigs_authority_shape_check`, `enrollments_authority_shape_check`) _require_ a
NULL `authority_id` for every organization- and workspace-scoped row, so that
predicate was structurally `total - userScoped`: every correctly classified row
was reported as unmigrated and the number could never drain to zero. No
corrected predicate exists either, because `authority_scope` **defaults to
`'workspace'`** (0230 for Variable Sets and Rigs, 0262 for Connected Machines),
making an unmigrated legacy row indistinguishable from a deliberately
workspace-scoped one, and nothing else separates them:

- **Variable Sets** - `origin_workspace_id` (added 0230, never backfilled) is
  NULL for every pre-0254 row and non-NULL for every row `create_scoped_variable_set`
  writes. That is a real fact, but it means "predates the scoped lifecycle", not
  "lacks an explicit authority classification": this phase classifies a reviewed
  legacy row explicitly _as_ workspace-owned, which writes nothing, so a fully
  reviewed row still reads NULL.
- **Rigs** - `origin_workspace_id` is not even a legacy marker. `createRig`
  retains a live non-scoped branch that inserts through Drizzle without it, so
  new rows keep arriving with a NULL origin today.
- **Connected Machines** - 0262 added `origin_workspace_id` and backfilled it
  from `workspace_id` in the same statement, while the ordinary
  `createEnrollment` upsert still leaves it NULL. The polarity is inverted: NULL
  marks a _post_-0262 ordinary row.

`byScope` reports every authority distinction the schema can truthfully make,
and any non-user-scoped total is derivable from it. Restoring a classification
counter requires first adding a durable classification-decision fact to these
tables - contrast the documents gate, whose
`authority_kind = 'personal' AND authority_id IS NULL` names a genuine
post-migration invariant violation (`documents_authority_chk`, 0258) and is
therefore truthful and drainable.

#### Session ownership (migration 0297)

Sessions are **not** an undifferentiated ownerless backlog. Migration 0225's
`guard_session_authority_write` trigger already derives session ownership on
every INSERT, and `session_visibility_isolation` is live. `0285`'s
`sessions.ownerless` count is therefore the residue of two INSERT-only
derivation branches - inherit the same-workspace parent's owner pair, otherwise
resolve the `subject`-kind creator's active organization membership **and** a
`workspace_memberships` row in that workspace - and not a migration backlog.

`bun run db:backfill-session-ownership --organization-id <uuid> --classify`
gives one verdict per session. Exactly two populations are deterministically
repairable, and `--apply` repairs only those:

- **Personal-workspace convergence.** The session's workspace is exactly the
  `personal_workspace_id` of one active membership (0218's unique
  `organization_memberships_personal_workspace_idx` makes that a 1:1 anchor)
  and the session's `created_by_subject_id` is that same membership's subject.
  Slice B provisions a personal workspace _without_ a `workspace_memberships`
  row. Migration 0302 extended live derivation to the membership's exact
  `personal_workspace_id`, so this is now a finite historical population;
  migration 0340 makes parity count that pointer form as well as ordinary
  workspace membership.
- **Parent-inheritance closure.** An ownerless session whose same-workspace
  parent now has an owner pair: branch 1 of the live trigger replayed against
  durable parent data, which is also what makes the driver resumable.

Everything else is recorded unresolved with a fixed reason code and never
guessed: `service`-created sessions (`legacy_shape_unrecognized`), non-`user:`
subjects such as `api_key:` and `configured:` that 0219/0263 can never provision
an organization anchor for (`external_lane_owns_row`, permanently unrepairable
and still being minted), creators without a live membership
(`missing_organization_membership`), a personal-workspace anchor that names a
different subject than the creator (`ambiguous_candidate_authority`), and - the
largest refusal - an active managed human's session in an ordinary shared
workspace (`no_deterministic_evidence`), because replaying 0225's second branch
retroactively would evaluate **today's** workspace grants against a historical
session, which is exactly the current-access inference this phase forbids.

The backfill is dry-run by default, bounded by `--limit`, resumable through
`FOR UPDATE ... SKIP LOCKED`, and idempotent. It writes only the owner pair: it
never touches `visibility`, `authority_epoch`, or `updated_at`, appends no
session event, and widens no read - every candidate is necessarily
`workspace_shared`, which `session_visibility_isolation` short-circuits on.

Its candidate predicate carries the classifier's `created_by_subject_id LIKE
'user:%'` fence in its own SQL, on both the dry-run count and the `--apply`
claim. The write path must never be more permissive than the classification
that authorizes it: `external_lane_owns_row` is called permanently unrepairable
here, so the seam refuses it by construction rather than relying on 0219/0263
never having minted a non-`user:` anchor.

Session rows are safe to re-run over - an attributed row stops matching either
candidate predicate. A `--run-key` ledger is deliberately _not_: each batch
opens its own `<run-key>:batch-N` receipt and the ledger refuses to re-open a
settled one, so a repeat under the same key fails on the first settled batch
instead of overwriting immutable evidence. Resume or repeat with a new
`--run-key`, or omit it and record nothing.

### E. Validate

Verify organization/membership/workspace consistency, one personal workspace
per active membership, stable authority uniqueness, provider-account collision
rules, session ownership, and zero partial delegations. Add read-only shadow
comparisons between legacy and proposed effective scopes. No mismatch may fall
back to user authority.

The phase's executable gate is the read-only parity seam (migration 0298):

```bash
bun run db:check-tenancy-parity --organization-id <uuid>
  [--evidence-limit <0-50>] [--observation-window-days <1-365>]
```

It prints one machine-readable report and exits `0` when every gate passed,
`1` when at least one gate failed, and `2` when the command could not run. Like
the inventory seam it is strictly read-only - its only writes are the claim and
release of its own transaction-local private capability row, it holds its own
capability separate from 0285's so the inventory seam gains no new visibility,
and it rejects a cross-organization request. **It never repairs, widens, or
resolves an ambiguity; a reported mismatch is never resolved toward user
authority.**

The report has three deliberately distinct parts.

**Gates** are invariants that must be zero. Each carries an evidentiary
`basis`: `constraint`/`trigger` gates shadow an enforcement the physical schema
already provides, while `runtime` gates are the ones nothing in the schema
prevents and therefore carry the real evidence about a cutover. Failures come
with bounded row UUIDs as evidence - never subjects, names, keys, or values -
and an explicit `truncated` flag.

- organization/membership/workspace consistency: an active membership
  identifies a personal workspace, that workspace belongs to the same
  organization, and it is claimed by at most one membership;
- a managed personal workspace carries **no** `workspace_memberships` row - the
  owner-only grant is a derived access projection, and a persisted row there is
  exactly how membership CRUD and the subject-membership fallback would widen it
  into delegable access;
- stable authority uniqueness: the physical unique index is per
  (account, membership, kind, resource), so two _different_ memberships can
  still claim one resource. That ambiguity is reported, never resolved;
- zero partial delegations, plus a live owning membership, a non-revoked
  authority, and a session fence that is never ahead of the session it fences;
- session owner provenance is complete, paired, in-organization, and still
  names its owning membership's subject;
- provider-account collision rules: the `(provider, provider_account)` unique
  index makes a duplicate binding impossible, so a collision is recorded by
  disputing the existing binding **and both identities**. A disputed binding
  whose identity is still usable is a collision that never fenced its identity;
  an identity's `active_login_binding_id` must also be its own binding (the FK
  proves existence, never ownership);
- the shadow scope comparison: legacy effective scope is workspace for every
  resource, so every connection, Variable Set, Rig, Connected Machine, or
  Document whose _proposed_ effective scope is `user` must have an active
  authority owned by an active membership. Without one there is no reachable
  user resolution - it must fall back to workspace or deny.

**Lanes** are legacy populations, not corruption: a non-zero lane blocks a
cutover (`cutoverReady`) without failing the invariants. Every lane must
therefore have a _reachable_ zero, or the cutover gate is structurally
unreachable rather than merely unmet. A lane is `drainable` only when a backfill
can actually take it to zero; a lane over immutable history is `observation`
and is reported over a bounded recent window, where the honest signal is "the
lane stopped being exercised".

They are the 0285 inventory populations plus these refinements.
`sessionsAttributableButUnattributed` is the _drainable_ subset of ownerless
sessions - those whose creating subject today's `guard_session_authority_write`
fence would attribute. Three lanes are `observation` because their tables are
immutable history whose all-time count can never drain:

- `connectionUseLegacyResolutionsInWindow` - `connection_use_audit_facts` are
  append-only audit rows.
- `workspaceWriterAdmissionsLegacyUnattributedInWindow` and
  `workspaceWriterProcessesLegacyUnattributedInWindow` -
  `sandbox_workspace_mutation_admissions` and `sandbox_retained_processes` are
  settled by `UPDATE` and never deleted, and 0277's one-shot attribution
  backfill only reached rows whose actor was a turn (`actor_kind` /
  `owner_actor_kind` = `'turn'`). Every pre-0277 `direct:` or `process:`
  admission therefore keeps the `legacy_unattributed` sentinel permanently, so
  a single such row would otherwise pin `cutoverReady` to false forever.

`connectionsLegacyUser` is the opposite case and is deliberately _not_ bounded
today: 0256's `guard_connection_authority_write` still actively mints
`legacy_user` for any **new** connection whose subject holds no active
organization membership, and no migration upgrades an existing `legacy_user`
row to `user`. It is drainable only _after_ the organization-membership
backfill lands and stops the mint, which is why it names that owner.

Documents and Codex credentials are consumed as gate inputs only; their repair
is owned elsewhere and this program never writes a second reclassification for
either.

The checker **cannot run against a read replica.** Its capability row is
claimed and released with `INSERT`/`DELETE` inside the calling transaction, so
a read-only standby (or an explicit `SET TRANSACTION READ ONLY`) fails with
`25006: cannot execute DELETE in a read-only transaction`. Point it at a
writable primary; it is still read-only with respect to every table it
inspects.

**Unverifiable** properties are named explicitly rather than emitted as a
counter that could never reach zero:

- Variable Sets, Rigs, and Connected Machines have no legacy discriminator.
  `authority_scope` defaults to `workspace` and the `*_authority_shape_check`
  constraints _require_ `authority_id IS NULL` for organization/workspace scope,
  so a never-classified legacy row and a deliberately workspace-owned row are
  byte-identical. Any "unclassified" counter for them is structurally
  `total − userScoped`. (Documents are the exception that _does_ have a
  discriminator: `authority_kind = 'personal' AND authority_id IS NULL`.)
- `workspace_shared` is the permanent correct visibility for a shared session,
  not a legacy marker.
- A null session owner is legitimate forever for API-key, delegated, and
  service-created sessions and for creators with no active membership; only the
  attributable subset above is drainable.

`packages/db/test/organization-isolation-evidence.test.ts` is the executed
cross-organization evidence suite for this phase. Against a real PostgreSQL
database, driven as the genuine non-superuser `NOBYPASSRLS` `opengeni_app`
login, it proves - each denial paired with a positive control under the owning
organization - that no seeded resource family (session, session event, Variable
Set, Rig, Connected Machine, enrollment, connection, file, Document base,
Document, knowledge memory, scheduled task, API key) crosses an organization
boundary by read, forged workspace id, sibling workspace, insert, update, or
delete; that a missing account or workspace context denies rather than widens;
that forging `opengeni.organization_tenancy_lifecycle` opens no authority table
because the runtime role holds no privilege on any table gated only by a
caller-settable GUC; that every account-carrying table the runtime role can
touch enforces FORCE RLS apart from the reviewed `workspaces` /
`workspace_memberships` / `auth_identities` directory exceptions whose boundary
is enforced in `@opengeni/core`; that an active membership in another
organization is not authority in this one and revoking one membership stops
access on the very next transaction while leaving the other organization and
the retained rows intact; and that FORCE RLS still binds a non-superuser
`SECURITY DEFINER` owner, which is the property every capability seam here
depends on.

#### Compatibility-lane telemetry

The inventory seam answers "how many legacy-shaped rows exist right now". It
does not answer the question the cutover gate actually asks - **is a
compatibility lane still being exercised by live traffic?** - and it cannot,
because a point-in-time row count cannot separate a dormant historical
population from one that live writers are still adding to.

`opengeni_tenancy_compatibility_lane_uses_total{lane}` is that second signal: a
content-free Prometheus counter, one increment per live use, emitted through
the ordinary `@opengeni/observability` registry by both the API and the worker.
The closed lane set is `TENANCY_COMPATIBILITY_LANES` in
`packages/observability/src/index.ts`; an unreviewed name is ignored rather
than minting a series. Every lane is published at zero on process start, so an
operator can tell "this lane is dead" from "this lane was never wired up". The
lane name is the only label OpenGeni adds - never an organization, workspace,
session, subject, connection, resource, provider, or server identity - and a
registry failure is swallowed at the telemetry boundary, so counting can never
change an authorization or credential outcome.

| Lane                            | Increments when                                                                                                                                                                           | Emitted from                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `connection_legacy_user`        | An accepted connection use resolves to `authority_scope = 'legacy_user'` - a personal row with no common authority or grant, admitted through `legacy_user_compatibility` provenance.     | `apps/worker/src/activities/mcp-credentials.ts` |
| `connection_pre_snapshot_ref`   | A workspace-scope connection ref carries no connection id, so accepted-use authority (0279) cannot identify the exact row and the request takes the unprivileged pre-snapshot resolution. | `apps/worker/src/activities/mcp-credentials.ts` |
| `workspace_writer_unattributed` | An API-direct persistable `/workspace` mutation is refused `authority_unattributed` because its writer has no recorded authority.                                                         | `apps/api/src/sandbox/channel-a.ts`             |

The workspace-writer lane is scoped to the API-direct surface on purpose: that
is where the fence is a deliberate, observable refusal of a caller's request.
The worker's turn-admission lane does not raise it at all (it accepts a
recorded-but-legacy initiator by design), and the retained-process promotion
path in `apps/worker/src/sandbox-routing.ts` collapses every promotion fence
into one durable-output rejection without discriminating the code, so counting
there would need a separate change to that fence's contract.

**These counters are use rates, never burndown gauges, and must not be
relabelled as one.** Restating the finding plainly: _none_ of the tenancy
compatibility populations is bounded on the current write paths. Each is still
open, so no row-count predicate over it can reach zero, and a backlog gauge
would read as a permanent unmigrated backlog - the same defect class that
already had to be removed from the inventory seam's resource counters.

- **`legacy_user` connections are not backfill residue.** Migration 0256's
  `bind_connection_authority` trigger is still the live classifier and is never
  superseded by 0264/0275/0279/0280, which only _read_ the lane. It assigns
  `legacy_user` to any NEW personal connection whose inserting subject has no
  active organization membership, and `configured:`, `api_key:`, and bare `dev` subjects
  can never have one (below). The offboarding sweep in 0263 deletes only
  `authority_scope = 'user'` rows, so the population never shrinks either.
- **`legacy_unattributed` workspace writers are monotonically non-decreasing.**
  `'legacy_unattributed'` remains the column DEFAULT on both
  `sandbox_workspace_mutation_admissions` and `sandbox_retained_processes`
  (0277), the turn lane still freezes it whenever the parent turn carries the
  pre-0096 legacy initiator, and a retained process copies its parent verbatim.
  Only the direct lane fences it; `assertRetainedProcessAuthority` deliberately
  accepts a recorded-but-legacy initiator rather than fencing ordinary work.
  There is no targeted prune, retention job, or recurring backfill on either table,
  so nothing ages out. The counter above therefore reports _refused mutations_,
  which is a real bounded event, and says nothing about the row population.
- **Null-authority personal Documents are a permanent lane, not only a legacy
  one.** `create_personal_document_authority` (0258) returns zero rows when the
  caller has no deterministic active organization membership, and the document
  store then inserts `authority_id = NULL` by design. The inventory predicate
  `authority_kind = 'personal' AND authority_id IS NULL` is truthful - it names
  exactly the shape 0258 permits - but it is not drainable while that lane
  stays open, so its `legacyPersonal…` naming overstates what the number means.
- **Default-visibility sessions are not a compatibility lane at all and must
  never be instrumented as one.** `workspace_shared` is the permanent,
  legitimate column default for every new session (0218); only `user_private`
  requires an owner. Counting it would be the `total - userScoped` defect in
  another costume. The genuinely legacy-shaped session population is
  `owner_organization_membership_id IS NULL`, which the inventory already
  reports as `ownerless` - but that too is still growing (service, API-key, and
  configured creators take the `created_by_kind <> 'subject'` path in
  `guard_session_authority_write`, which leaves the owner NULL) and cannot be
  repaired in place: `transition_session_visibility` explicitly refuses an
  ownerless session and has no non-test caller.
- **Subjects with no organization-membership anchor are partly unreachable by
  construction.** Only two statements ever insert an `organization_memberships`
  row: managed-human provisioning (0219), gated to `user:%` subjects in their
  own `better-auth:user` self-account, and invitation acceptance (0263), whose
  invitations are CHECK-constrained to `user:%`. So `configured:`, `api_key:`, and
  bare `dev` subjects can _never_ acquire an anchor - the inventory's
  `user:%` filter correctly excludes them. Cross-account human grants
  (`grantWorkspaceAccess`, `bootstrapWorkspace`, the Slack link approval) still
  add anchorless `user:` subjects, and re-authentication cannot fix those;
  only an explicit invitation accept can.

Deliberately uninstrumented, with the reason recorded rather than a misleading
number shipped: the Document lane (its runtime branch is dominated by
permanently-ineligible subject kinds, so a use counter could not be read as a
migration signal without a discriminator the schema does not have); ownerless
session creation (no runtime lane switch exists - the trigger simply leaves the
column NULL); and the missing-anchor lane (same mixed-population problem, and
its permanently-ineligible subjects would dominate the count). Instrumenting
any of these truthfully requires a durable classification-decision fact first.

### F. Activate

Add exact organization+subject+workspace RLS policies and narrowly scoped
security-definer lifecycle functions. Switch one subsystem at a time to
authority ids and immutable accepted-work delegations. Accepted-attempt epoch
fencing is delivered by migration 0222.

Migration 0225 delivered the first database half. Migration 0303 replaces its
auto-cancelling mutation functions with the activated, proven-quiescent
contract described in "Session-visibility and fork public activation".
The bounded API/core/SDK managed-human caller is now active behind the
per-organization receipt. The managed web UI keeps visibility changes and
private-source forks owner-only, and exposes shared-source forks to current
workspace members.
Worker, MCP, runtime, and `packages/react` remain non-callers; cross-workspace
forks, attachments, and personal-resource grant UX remain out of scope.

Cache and pin stripping is delivered by migration
`0301_session_snapshot_and_pin_visibility.sql`. Migration 0225 installed
`session_visibility_isolation` by enumerating relations that carry a foreign key
to `sessions.id`, so it reached 70 relations but could not reach
`session_list_snapshots.ordinary_session_ids` — a bare `uuid[]` with no foreign
key. 0301 closes both halves of that gap:

The current session rail no longer creates these arrays: its opaque cursor
freezes the committed workspace activity revision and traverses the existing
`updated_at,id` index with a bounded `limit + 1` keyset. The table and trigger
remain active only for old cursors and replicas during rolling deployment, so
the original migration guarantee below continues to describe that compatibility
window. The v2 cursor's legacy envelope deliberately resolves to the existing
typed 410/rebase path on an old replica; it never points at a materialized row.

- A cached list page is stripped at the transition, not filtered on the read
  path. An `AFTER UPDATE OF visibility` trigger on `sessions` replaces the
  transitioned identity with the reserved all-zero UUID in every _other_
  subject's live snapshot for that workspace; the owner's own page is left
  intact because the session is still visible to them. Replacing rather than
  removing the slot keeps snapshot cardinality and every in-flight cursor offset
  byte-stable, so a stale continuation still returns the same page it would have
  returned when the hidden row was merely filtered out by RLS. A RESTRICTIVE
  predicate over the array was rejected: a snapshot holds up to 5,000 ids and a
  subject up to 32 live snapshots, so it would cost up to 160,000 per-element
  visibility calls on the hot first-page read while also making the row
  undeletable. The trigger writes other subjects' rows under 0225's existing
  transaction-local `session_visibility_write_capabilities` capability — a row
  only the schema owner can mint and which the runtime role can neither read nor
  forge — so the strip does not depend on the migration owner being a
  superuser.
- A stale personal pin stays removable by the member who created it.
  PostgreSQL applies SELECT policies to a `DELETE` that reads any column, so a
  command-scoped `FOR DELETE` exemption is impossible; the RESTRICTIVE policy's
  USING side instead carries an explicit `subject_id =
current_subject_id()` escape. That discloses nothing new — the pre-existing
  permissive `workspace_isolation` policy already limits every visible pin to
  its own subject, and a pin row's only session-derived field is an id that
  subject supplied. The WITH CHECK side keeps the strict predicate, so a member
  still cannot pin, or flip `pinned` on, a session they cannot see, and INSERT
  cannot become a session-existence oracle through the foreign key. The pin row
  is deliberately retained rather than deleted: it is durable personal intent,
  it is inert in every product projection while the session is private, and it
  becomes meaningful again if the owner re-shares.

Severity was bounded when the repair landed because
`transition_session_visibility` had no product caller then. The later
API/core/SDK activation now depends on this prerequisite; the bounded managed
web owner surface is active, while worker, MCP, runtime, and React package
surfaces remain out of scope.

### G. Retire

Only after all writers/readers are activated and audited may legacy
workspace-owned assumptions be removed. Resource FKs are never destructively
rewritten in the same release that first activates user authority.

## Rollback boundary and canonical activation

This section is the canonical home for what is reversible before canonical
tenancy authority activation and what becomes forward-recovery-only after it.
The operator procedure that executes an activation lives in
[`deployment.md`](deployment.md) with the other maintenance cutovers.

**Canonical tenancy authority activation** is a phase-F event for one subsystem:
the point at which that subsystem's access decision is made by
organization/membership authority ids under exact organization+subject+workspace
RLS instead of the legacy workspace-owned lane. Activation is per subsystem, and
each activation is one way.

### Where the boundary sits today

The program is deliberately not one global switch, so "rollback is explicit
before canonical activation" is a per-subsystem statement:

- **Rolling, application-reversible.** `0218_organization_tenancy_foundation`,
  `0219_organization_tenancy_managed_human_provisioning`,
  `0222_session_visibility_authority_epochs`,
  `0235_canonical_human_login_bindings`,
  `0253_common_user_resource_authority_lifecycle`,
  `0258_three_scope_document_knowledge_authority`,
  `0262_scoped_connected_machines_and_rigs`,
  `0263_organization_membership_lifecycle`, `0277`–`0282`, and
  `0285_organization_tenancy_inventory` all declare
  `-- deployment-mode: rolling`. Their tenancy columns keep non-authority
  defaults (`visibility = 'workspace_shared'`, `authority_epoch = 1`, null owner
  membership, null fork provenance, `authority_scope = 'workspace'`), so a
  compatible earlier application image can still read and write them and an
  image rollback remains an ordinary deployment decision.
- **Already one way.** Two tenancy migrations declare
  `-- deployment-mode: maintenance` and have globally crossed their boundary;
  session tenancy additionally crosses per organization through a durable
  activation receipt.
  - `0264_connection_authority_runtime_activation.sql` proves there are no other
    `opengeni_app` sessions both before and after taking `ACCESS EXCLUSIVE` locks
    on `sessions`, `session_turns`, `session_system_updates`,
    `session_system_update_outbox`, `scheduled_tasks`, and `connections`, rejects
    a live application with SQLSTATE `55000`, and additionally rejects every
    executable pre-activation common-user Connection source as a durable data
    fence. Old workers neither materialize accepted connection authority nor
    carry the exact attempt/use fences, so after 0264 commits the Connection
    surface has no rollback boundary left - only forward recovery.
  - `0275_scheduled_connection_authority.sql` repeats that shape for scheduled
    work: the same `pg_stat_activity` drain guard and SQLSTATE `55000`, then
    `ACCESS EXCLUSIVE` locks on `sessions`, `session_turns`,
    `session_system_updates`, `scheduled_tasks`, `scheduled_task_runs`,
    `connections`, and `organization_user_resource_grants`. It freezes
    common-user Connection authority on scheduled-task revisions, admits one
    immutable copy per stable occurrence, and rejects every remaining
    queued/dispatched agent run, every active task carrying activated Connection
    delegation, and every active personal-resource task whose creator is not an
    active organization member. An old writer must never be restarted after it
    either; see [`architecture.md`](architecture.md) and
    [`deployment.md`](deployment.md).
  - `0303_session_tenancy_product_activation.sql` is rolling and inert at
    migration time, but each per-organization activation receipt is a one-way
    boundary. The operator command requires the exact application-role
    inventory, canonical env opt-in, required migrations, and clean
    inventory/parity evidence, then inserts the receipt only under a
    double-checked drain and write-blocking locks. Earlier images fail the
    current runtime-posture contract because they do not declare the receipt
    table or hardened routine signatures.

The remaining phase-F work named in [F. Activate](#f-activate) has therefore not
crossed its boundary yet.

### Reversible before activation

While a subsystem is pre-activation:

- an application/image rollback to a compatible earlier digest is permitted, and
  the legacy workspace-owned path stays byte-identical;
- tenancy columns and authority/grant rows are additive facts, not the access
  decision, so an earlier writer that ignores them is not producing wrong
  authority;
- the four foundation authority/grant tables stay FORCE-RLS with zero direct
  application-role DML, so no legacy writer can widen access through them;
- backfill classifications and inventory reads are content-free and idempotent;
  re-running them changes no authorization outcome.

### Forward-recovery-only after activation

Once an activation migration commits for a subsystem:

- there is no down-migration and no mixed-version rolling rollback;
- an earlier image must never be started again - it strips or ignores the
  authority the activated subsystem now depends on;
- recovery is forward only: fix the new runtime and roll forward, remaining in
  maintenance while doing so.

### Preconditions for permitting an activation

All of the following must hold, per organization, before an activation migration
is run:

1. **Complete backfill and quiet observation window.** Run both
   `bun run db:inventory-tenancy --organization-id <uuid>` and the canonical
   migration-0298 parity report. The inventory is retained and hashed as the
   content-free population snapshot; it is not a universal drain-to-zero gate.
   The parity report must have zero violations in every invariant gate and zero
   in each current activation lane: `connectionsLegacyUser`,
   `workspaceWriterAdmissionsLegacyUnattributedInWindow`,
   `workspaceWriterProcessesLegacyUnattributedInWindow`,
   `documentsLegacyPersonalNullAuthority`,
   `codexCredentialsUnattributedConnector`,
   `workspaceMemberSubjectsWithoutMembershipAnchor`,
   `sessionsAttributableButUnattributed`, and
   `connectionUseLegacyResolutionsInWindow`. The bounded writer/use lanes prove
   the legacy path is no longer exercised; the attributable-session lane is the
   actually repairable subset of ownerless sessions. Total `sessions.ownerless`
   and the all-time `workspaceWriters.*.legacyUnattributed` inventory counts are
   deliberately not blockers: service/API-key sessions can remain ownerless,
   and pre-0277 direct/process writer rows are immutable historical evidence.
   A single non-zero required parity lane or invariant violation is a blocker.
   Variable Sets, Rigs, and Connected Machines contribute no drain-to-zero
   counter here, and one must not be invented: nothing in their schema separates
   an unmigrated legacy row from a deliberately organization- or
   workspace-scoped one, so no truthful unmigrated-population count exists for
   them (see [D. Backfill](#d-backfill)). Reconcile those three families through
   their `byScope` breakdown against the reviewed classification instead -
   `byScope` reports every authority distinction the schema can truthfully make,
   and any non-user-scoped total is derivable from it.
   Migration 0340 additionally requires the newest receipt in each executable
   phase-D family to be settled: `organization_memberships`, `sessions`,
   `variable_sets`, `rigs`, `machines`, and `connections`. Produce them with one
   complete membership walk, one resource-classification run, a converged
   connection-authority run, and a final full session `--classify`, each with a
   fresh `--run-key`. The four resource/connection receipts must have zero
   unresolved rows and every resource/session/connection receipt must cover its
   current full-family total. Membership and session unresolved rows are not
   blindly treated as corruption: the inventory/parity gates above decide
   whether their current residual populations are legitimate. The newest
   receipt wins, so a later open/failed or partial run cannot hide behind an
   older successful one.
2. **Parity evidence.** The phase-E read-only shadow comparison shows the
   proposed effective scope equals the legacy effective scope for every compared
   read. No mismatch may be resolved by falling back to user authority.
3. **Cross-organization and RLS evidence.** Exact organization+subject+workspace
   policies deny every cross-organization read and write, and missing or
   mismatched transaction-local identity fails closed rather than widening.
4. **Immediate-revocation tests.** Suspension, offboarding, and single-workspace
   membership removal take effect before the next read on the activated surface,
   including buffered/replayed SSE frames, and revoked or suspended grants fence
   new mutations before any generation is consumed.
5. **Zero incompatible writers.** `pg_stat_activity` shows no `opengeni_app`
   session other than the migration connection. The in-migration guard is the
   durable fence, not a courtesy check.

### The pre-activation opt-out switch

`OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED`
(`organizationTenancyCanonicalActivationEnabled` in `@opengeni/config`) is the
named deployment-level switch for declining or deferring canonical activation.
It defaults to `false` - the reversible pre-activation posture - and is parsed
with the config library's `EnvBoolean`, so an operator writing `false` out
explicitly stays declined rather than being coerced into activation.

- `false` (default): this deployment declines/defers activation. No phase-F
  slice may switch a subsystem's access decision to authority ids.
- `true`: the operator states that the preconditions above were proven for this
  deployment and that the one-way boundary is accepted.

What the switch is not:

- **not a kill switch and not a rollback.** After an activation migration has
  committed, setting it back to `false` does not restore legacy authority. The
  switch only governs whether the boundary may be crossed, never whether it can
  be uncrossed;
- **not an authorization decision.** It grants and revokes nothing by itself;
  every membership, grant, epoch, and RLS fence keeps its own authority;
- **not a data migration toggle.** Rolling tenancy migrations are applied
  independently of it.

Migration 0303 is the first slice to enforce this switch. Its ordinary rolling
migration remains inert with the default `false`; the drained activation
command refuses to write a per-organization receipt unless the switch is true.
Once any receipt exists, API/worker startup and readiness also require true.
That startup interlock is forward-only posture, not a rollback mechanism.
Migration 0340 preserves the activation command and database function
signatures while adding the settled-backfill proof above. New activation rows
bind the six exact receipt ids. Older activation rows retain their existing
zero-receipt evidence and remain replayable only for their identical stored
inventory/parity digests; the migration never invents historical evidence. The
database recomputes inventory, parity, and receipt evidence while holding the
complete source-table fence and rejects a stale or fabricated supplied digest
with SQLSTATE `40001`.

Migration 0340 additionally makes that receipt writable. Migration 0303 created
`session_tenancy_activations` with FORCE ROW LEVEL SECURITY and a
`FOR SELECT`-only policy and no INSERT policy at all, so under the documented
non-superuser-owner posture the activation was denied `42501` on its own append
after every gate had already passed - the cutover could not commit at all. The
new `session_tenancy_activation_receipt_insert` policy re-opens exactly that one
command for exactly the migration owner, gated on a
`session_tenancy_activation` marker the function sets only around the append and
restores on every exit, and fenced to the transaction's own organization. INSERT
is the complete write set: the table is append-only, no `UPDATE` or `DELETE`
writer exists anywhere in the tree, and activation is one-way. The runtime role
keeps `SELECT` and nothing else.

Migration 0340 also freezes the deployment-wide advisory boundary
`session-tenancy-canonical-boundary:v1` behind the owner-only
`lock_session_tenancy_activation_boundary()` seam. Operator activation keeps
the organization advisory prefix, acquires every source-table
`ACCESS EXCLUSIVE` lock, and only then takes this boundary immediately before
its final evidence recompute and receipt write. A future greenfield provisioning
transaction must do the inverse work order: write its complete organization
graph first, take this same boundary last, and then inspect the already-committed
version-1 witness. This ordering means a setup transaction either commits
unactivated before the first boundary or waits and observes it afterward; taking
the global boundary before the operator's source locks would introduce a
RowExclusive/global-lock deadlock and is forbidden. Migration 0340 does not
itself auto-activate new organizations.

Migration 0349 consumes that frozen boundary only inside
`complete_self_service_organization_setup`. The setup transaction first writes
and validates exactly one newly inserted `better-auth:user` organization, one
active owner membership, its canonical Personal workspace and control row, no
`workspace_memberships`, and its immutable setup receipt. The explicit 0348
orphan-account adoption branch is excluded even when the adopted account was
otherwise empty. Only after that proof does the owner-only helper take the
canonical boundary and inspect a committed activation witness. With no witness,
the setup commits unactivated and remains on the operator procedure above; with
a witness, the same transaction appends the existing version-1 activation
receipt shape, an enabled version-1 private-session setting and immutable
setting event, plus `session_tenancy_greenfield_activation_evidence` binding the
exact setup operation, Personal-only graph digest, witness, parity digest, and
setting event. A failure rolls back the account graph, setup receipt, activation,
setting/event, and evidence together, so retry is deterministic and no
unreceipted private authority can escape. Setup replay returns its existing
receipt and never re-runs activation; a changed operation remains a conflict.

The greenfield helper and evidence table have no runtime-role or PUBLIC access,
use FORCE RLS under the real non-superuser/non-BYPASSRLS owner posture, and are
not an alternate activation API for existing organizations. Migration 0349 also
opens and restores a subject-and-organization-fenced owner policy window around
the two Personal private-create membership readers; without that repair those
readers were blind under FORCE RLS and an otherwise activated fresh owner could
not create the immediate private session promised by the signup contract.

### What an operator must not do

- Do not restart a pre-activation image after an activation migration has
  committed, and do not attempt a mixed-version rolling rollback across one.
  This already applies to `0264`, `0275`, and an organization activated through
  `0303`.
- Do not run an activation migration with a live application. The
  `opengeni_app` session guard aborts with SQLSTATE `55000` and rolls its
  transaction back cleanly; treat that as the contract, not as a race to retry.
- Do not hand-edit `organization_memberships`,
  `organization_user_resource_authorities`,
  `organization_user_resource_grants`, or session tenancy columns to "undo" an
  activation. Those tables have zero direct application-role DML by design, and
  lifecycle evidence is immutable.
- Do not treat flipping
  `OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED` back to `false`
  as a rollback, or as a way to re-open a crossed boundary.
- Do not infer user authority for an unresolved backfill row in order to clear a
  precondition counter. Ownership is never guessed from `created_by`, connection
  attribution, a default workspace, resource name, or current access.

## Remaining non-goals

- a personal `workspace_memberships` row or delegated personal-workspace access;
- user-resource authority/grant writes, discovery, or sharing;
- resource CRUD or discovery changes;
- worker, MCP, runtime, or `packages/react` callers for the activated
  `transition_session_visibility` and `fork_session_content` lifecycle
  functions; cross-workspace fork, attachment APIs, and
  personal-grant UI also remain out of scope. The bounded API/core/SDK
  managed-human caller, managed web owner controls plus shared-member Fork
  action, and activation-gated subject read projection are active (see
  "Session-visibility and fork
  public activation");
- Connected Machine, rig, variable-set, connection, Codex, or Document
  materialization changes;
- an always-on retention deletion worker (0263 exposes a supported bounded
  operator command instead);
- provider, cloud, or deployment changes.
