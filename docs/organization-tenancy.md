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
rather than a parameter changes nothing about *who may set that GUC*.
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
> about a *named* subject) and the safer one reads as scoped. Do not "simplify"
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
different questions - a *grant with permissions* for a request principal versus
a *boolean about a named subject* - and are not interchangeable at an
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
  `apps/api/src/integrations/{oauth-client,provider-oauth,google-drive,atlassian,fiken,social-oauth}.ts`
  and `apps/api/src/routes/connections.ts` - connecting a provider *from* a
  personal workspace fails at callback even though `connections:write` is in
  the personal permission set.
- SQL seams without the personal-workspace disjunct: the xAI subscription
  authority views/functions in 0234. Migration 0303 repairs
  `transition_session_visibility` and `fork_session_content` with the exact
  active-membership personal-workspace-or-ordinary-membership disjunction;
  they still have no production caller today. 0225's
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

The managed web console exposes this lifecycle as a bounded organization
administration surface with separate Overview, People & invitations, Retention,
and Billing sections. It lists the organization roster and invitation state,
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

The roster intentionally uses a stable masked subject identifier because the
lifecycle API does not expose a safe profile name or email. It never links or
derives identity from another member's `personalWorkspaceId`, and organization
administration does not grant access to that member's Personal workspace,
private sessions, credentials, Connections, or personal resources. Workspace
access remains a separately labelled administration surface. Provider email
delivery and invitations for unregistered recipients remain non-goals; the web
surface accurately requires an already-registered user.

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

Invitation, operation-receipt, and lifecycle-event tables are FORCE RLS with
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
event-write prefix - and only then reaches `managed_accounts` *implicitly*, through
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

The lifecycle's first *row* lock is therefore the canonical prefix, and the full
order is:

```
advisory 'organization-membership:<organization id>'
  -> managed_accounts FOR KEY SHARE
  -> per workspace, in UUID order:
       workspace_inference_controls FOR SHARE
       workspaces FOR KEY SHARE
  -> organization_memberships FOR UPDATE (UUID ordered)
  -> sessions FOR NO KEY UPDATE -> session_turns FOR UPDATE
  -> session_turn_attempts FOR UPDATE
```

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
safety net for a `40P01` raised by some *other* cycle; it is not the lock-order
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
reads to *establish* the organization context that every RLS predicate then
depends on, so an `account_id = current_account_id()` predicate over them is
circular for the first two and type-incoherent for the third — `auth_identities`
holds Better Auth's provider subject string in `account_id`, not a tenant id,
and Better Auth queries it over its own connection pool that never carries an
OpenGeni GUC. Consequently a query that reached the database layer without going
through the access layer can read another organization's workspace and
membership *metadata*, though never its content: every content table remains
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

Note that owner membership is null only as a *column default*. Since 0225 the
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

## Session-visibility and private-fork public activation

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

**Mutation-active only after an explicit per-organization cutover.**
`transition_session_visibility` and `fork_session_content` exist, are SECURITY
DEFINER, are granted to the runtime role, are listed in
`RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES`, and have a first-class adapter at
`@opengeni/db/session-tenancy`. `@opengeni/core` now owns the sole product
adapter call, reached by `PUT .../sessions/:id/visibility` and
`POST .../sessions/:id/forks`; `@opengeni/sdk` exposes matching methods. Both
routes require the canonical managed-cookie owner, the exact workspace/session
permissions, and the corresponding host authorization operation. Worker, MCP,
runtime, React, and web remain non-callers. The SQL function remains the sole
writer of `session.visibility.changed`; core fetches the returned durable event
id and sequence and performs best-effort live publication without appending a
second event or waking a workflow.

Migration 0303 itself is rolling and activates no organization. The drained
`bun run db:activate-session-tenancy -- --organization-id <uuid> --activated-by <operator>`
command verifies the canonical opt-in, required migrations, zero-valued tenancy
parity gates plus exact drainable/bounded lanes, while retaining the inventory
as contextual evidence, before inserting one immutable
`session_tenancy_activations` receipt. A mutation without that exact version-1
organization receipt fails closed.

0303 is also an intentional signature cutover: it removes the historical
eight-argument transition and fork routines and installs only the corresponding
nine-argument routines with a mandatory activation-version argument and no SQL
default. There is no compatibility wrapper because no legacy product caller
existed at the signature cutover, and an omitted version must fail with
undefined-function rather than infer or bypass activation. The 0225/0289
migration bodies remain historical checkpoints;
anything running against the fully migrated schema, including later migration
tests, must supply version `1` and operate under the exact durable receipt.

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
  proven transition advances the epoch, revokes old-epoch personal grants,
  clears staged personal delegations, preserves 0301 cache/pin behavior, and
  appends one event without a workflow wake.
- The first fork contract is same-workspace and private-only. It serializes a
  quiescent source, creates a new root and singleton group, copies the durable
  content allowlist (including typed reasoning/latency), and copies no live
  goal/turn, MCP, Variable Set, Rig, sandbox identity, credential, or personal
  grant.
- Both adapters return the exact durable event id and sequence required by a
  later core publisher.

The practical product consequence is deliberately bounded. Only an activated
organization's canonical managed-human owner may change an otherwise quiescent
same-workspace session between `workspace_shared` and `user_private`, or make an
independent same-workspace private fork. API keys, delegated/service callers,
administrators acting on another human's session, workers, MCP, runtime, React,
and web have no caller. The SDK requires an explicit idempotency key, and
visibility changes additionally require the current public authority epoch.
Subject-authorized session reads expose the secret-safe `tenancy` projection
only after activation. `test/session-visibility-contract-surface.test.ts` pins
that exact caller boundary.

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

### C. Membership lifecycle (0263 current)

The invitation, role, suspension, reactivation, offboarding, retention,
operator-driven destructive expiry, and multi-organization access projection
described above are active. The bounded managed web administration surface
described above is also active. Provider email delivery, unregistered-recipient
invitations, and automatic scheduling of the operator command remain deferred.

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
receipt, resource, and reason: an unresolved row records a *refusal* to infer
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
`bun run db:backfill-organization-memberships --organization-id <uuid>`
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
external identity *is* that human, and a persisted owner-role workspace
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
resumes. This is what makes repeated runs *converge*: a subject the driver
cannot resolve stays in its population permanently, so a fixed `LIMIT n` window
over an organization with more than `n` `user:`-kind subjects would return the
same first `n` rows on every pass and never reach subject `n + 1` at all. Durable receipt/unresolved-ledger persistence is the separate backfill
ledger slice; today the command's structured JSON report is the operator record.

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
`rigs_authority_shape_check`, `enrollments_authority_shape_check`) *require* a
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
  legacy row explicitly *as* workspace-owned, which writes nothing, so a fully
  reviewed row still reads NULL.
- **Rigs** - `origin_workspace_id` is not even a legacy marker. `createRig`
  retains a live non-scoped branch that inserts through Drizzle without it, so
  new rows keep arriving with a NULL origin today.
- **Connected Machines** - 0262 added `origin_workspace_id` and backfilled it
  from `workspace_id` in the same statement, while the ordinary
  `createEnrollment` upsert still leaves it NULL. The polarity is inverted: NULL
  marks a *post*-0262 ordinary row.

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
  Slice B provisions a personal workspace *without* a `workspace_memberships`
  row, so 0225's second branch cannot reach these rows even today - the
  population still grows until that derivation is extended, which is a phase F
  decision and not part of this backfill.
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
candidate predicate. A `--run-key` ledger is deliberately *not*: each batch
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
  (account, membership, kind, resource), so two *different* memberships can
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
  Document whose *proposed* effective scope is `user` must have an active
  authority owned by an active membership. Without one there is no reachable
  user resolution - it must fall back to workspace or deny.

**Lanes** are legacy populations, not corruption: a non-zero lane blocks a
cutover (`cutoverReady`) without failing the invariants. Every lane must
therefore have a *reachable* zero, or the cutover gate is structurally
unreachable rather than merely unmet. A lane is `drainable` only when a backfill
can actually take it to zero; a lane over immutable history is `observation`
and is reported over a bounded recent window, where the honest signal is "the
lane stopped being exercised".

They are the 0285 inventory populations plus these refinements.
`sessionsAttributableButUnattributed` is the *drainable* subset of ownerless
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

`connectionsLegacyUser` is the opposite case and is deliberately *not* bounded
today: 0256's `guard_connection_authority_write` still actively mints
`legacy_user` for any **new** connection whose subject holds no active
organization membership, and no migration upgrades an existing `legacy_user`
row to `user`. It is drainable only *after* the organization-membership
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
  constraints *require* `authority_id IS NULL` for organization/workspace scope,
  so a never-classified legacy row and a deliberately workspace-owned row are
  byte-identical. Any "unclassified" counter for them is structurally
  `total − userScoped`. (Documents are the exception that *does* have a
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

| Lane | Increments when | Emitted from |
| --- | --- | --- |
| `connection_legacy_user` | An accepted connection use resolves to `authority_scope = 'legacy_user'` - a personal row with no common authority or grant, admitted through `legacy_user_compatibility` provenance. | `apps/worker/src/activities/mcp-credentials.ts` |
| `connection_pre_snapshot_ref` | A workspace-scope connection ref carries no connection id, so accepted-use authority (0279) cannot identify the exact row and the request takes the unprivileged pre-snapshot resolution. | `apps/worker/src/activities/mcp-credentials.ts` |
| `workspace_writer_unattributed` | An API-direct persistable `/workspace` mutation is refused `authority_unattributed` because its writer has no recorded authority. | `apps/api/src/sandbox/channel-a.ts` |

The workspace-writer lane is scoped to the API-direct surface on purpose: that
is where the fence is a deliberate, observable refusal of a caller's request.
The worker's turn-admission lane does not raise it at all (it accepts a
recorded-but-legacy initiator by design), and the retained-process promotion
path in `apps/worker/src/sandbox-routing.ts` collapses every promotion fence
into one durable-output rejection without discriminating the code, so counting
there would need a separate change to that fence's contract.

**These counters are use rates, never burndown gauges, and must not be
relabelled as one.** Restating the finding plainly: *none* of the tenancy
compatibility populations is bounded on the current write paths. Each is still
open, so no row-count predicate over it can reach zero, and a backlog gauge
would read as a permanent unmigrated backlog - the same defect class that
already had to be removed from the inventory seam's resource counters.

- **`legacy_user` connections are not backfill residue.** Migration 0256's
  `bind_connection_authority` trigger is still the live classifier and is never
  superseded by 0264/0275/0279/0280, which only *read* the lane. It assigns
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
  so nothing ages out. The counter above therefore reports *refused mutations*,
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
  bare `dev` subjects can *never* acquire an anchor - the inventory's
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
contract described in "Session-visibility and private-fork public activation".
The bounded API/core/SDK owner caller is now active behind the per-organization
receipt. Remaining work includes web UI and personal-resource grant UX.

Cache and pin stripping is delivered by migration
`0301_session_snapshot_and_pin_visibility.sql`. Migration 0225 installed
`session_visibility_isolation` by enumerating relations that carry a foreign key
to `sessions.id`, so it reached 70 relations but could not reach
`session_list_snapshots.ordinary_session_ids` — a bare `uuid[]` with no foreign
key. 0301 closes both halves of that gap:

- A cached list page is stripped at the transition, not filtered on the read
  path. An `AFTER UPDATE OF visibility` trigger on `sessions` replaces the
  transitioned identity with the reserved all-zero UUID in every *other*
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

Severity was bounded: `transition_session_visibility` still has no product
caller, so this is a correctness fix ahead of activation rather than a live
exposure.

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

- provider invitation email delivery;
- invitations for unregistered humans;
- a personal `workspace_memberships` row or delegated personal-workspace access;
- user-resource authority/grant writes, discovery, or sharing;
- resource CRUD or discovery changes;
- worker, MCP, runtime, React, or web callers for the activated
  `transition_session_visibility` and `fork_session_content` lifecycle
  functions; cross-workspace/public fork, session sharing, attachment APIs, and
  personal-grant UI also remain out of scope. The bounded API/core/SDK owner
  caller and activation-gated subject read projection are active (see
  "Session-visibility and private-fork public activation");
- Connected Machine, rig, variable-set, connection, Codex, or Document
  materialization changes;
- an always-on retention deletion worker (0263 exposes a supported bounded
  operator command instead);
- provider, cloud, or deployment changes.
