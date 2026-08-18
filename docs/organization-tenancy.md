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

## Session-visibility and fork surfaces: shipped, deliberately inert

`0225_session_visibility_fork_activation.sql` is rolling, and it is the one
place in this document where the schema is ahead of the product. Read this
section before concluding either that session visibility "does not exist yet"
or that it is a usable feature. Both are wrong.

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

**Inert today.** `transition_session_visibility` and `fork_session_content`
exist, are SECURITY DEFINER, are granted to the runtime role, are listed in
`RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES`, and have a first-class adapter at
`@opengeni/db/session-tenancy`. Nothing in `apps/api`, `apps/worker`,
`apps/web`, `@opengeni/core`, `@opengeni/runtime`, `@opengeni/sdk`, or
`@opengeni/react` calls either one. Their only invocations are the
`packages/db` test lane, which uses them both to prove 0225's own fences and as
the only way to manufacture a `user_private` session for later migrations' RLS
coverage. The matching `SessionAuthorizationOperation` literals
`session.visibility.write` and `session.fork.create` are declared in
`@opengeni/contracts` and authorized nowhere, and the
`session.visibility.changed` event type has no TypeScript emitter - only the
SQL function writes it.

The practical consequence: **every production session is `workspace_shared`**,
so the restrictive policy always takes its `visibility = 'workspace_shared'`
branch and the private lane is exercised only by tests.

**This is a decision, not an oversight.** The functions stay in place because
dropping a shipped SECURITY DEFINER surface is its own migration risk, and
because the db test lane depends on them. They stay unwired because a
user-facing private toggle is not yet safe:

- `session_list_snapshots` caches a paginated result as a bare `uuid[]` of
  session ids with no foreign key to `sessions`, so it receives none of the
  restrictive policies. A snapshot captured before a transition keeps returning
  a now-private session id to other members until its TTL expires. This is the
  "cache/pin stripping" item below.
- `session_pins` *is* covered by the policy, which means a non-owner's existing
  pin row for a newly private session becomes both invisible and undeletable to
  them rather than being stripped.
- `fork_session_content` copies durable history into another workspace and has
  no destination-selection contract, permission check, or UI.
- Owner-only grants and cancellation semantics for personal attachment to
  shared sessions are still unbuilt.

`test/session-visibility-contract-surface.test.ts` pins this boundary: it fails
if any product package starts naming either entry point or authorizing either
operation. The first real caller must land together with an update to this
section and to that test.

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
reads while leaving visibility mutation and fork without a caller.

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

### E. Validate

Verify organization/membership/workspace consistency, one personal workspace
per active membership, stable authority uniqueness, provider-account collision
rules, session ownership, and zero partial delegations. Add read-only shadow
comparisons between legacy and proposed effective scopes. No mismatch may fall
back to user authority.

The phase's executable gate is the read-only parity seam (migration 0293):

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

Migration 0225 then delivered the database half: the owner-derivation and
direct-write fence trigger, visibility-aware read authorization, and the
`transition_session_visibility` / `fork_session_content` lifecycle functions.
Those two functions are shipped with runtime grants but have no caller outside
the `packages/db` test lane, so no production session leaves
`workspace_shared`. See "Session-visibility and fork surfaces: shipped,
deliberately inert" for exactly what is live and why the rest is held back.

Remaining activation work is therefore the *product* half plus its
prerequisites: an authorized API/SDK/UI surface for visibility mutation and
independent fork, cancellation semantics, cache/pin stripping (notably
`session_list_snapshots`, whose bare `uuid[]` cache is not covered by the
restrictive policies), and owner-only grants before enabling personal
attachment to shared sessions.

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
  `-- deployment-mode: maintenance` and have already crossed their boundary.
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

1. **Complete backfill.** `bun run db:inventory-tenancy --organization-id <uuid>`
   (migration 0285) must report zero for every population the activated subsystem
   consumes: `organizationMemberships.activeWithoutPersonalWorkspace`,
   `workspaceMemberSubjectsWithoutMembershipAnchor`, `sessions.ownerless`,
   `documents.legacyPersonalNullAuthority`,
   `codexCredentials.unattributedConnector`,
   `workspaceWriters.admissions.legacyUnattributed`, and
   `workspaceWriters.retainedProcesses.legacyUnattributed`. A single non-zero
   counter for a consumed population is a blocker.
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

As of the slice that introduced it, no runtime path reads the switch: canonical
activation is unshipped, so it reserves the name, pins the safe default in the
chart and `.env.example`, and gives every future activation slice one gate to
consult.

### What an operator must not do

- Do not restart a pre-activation image after an activation migration has
  committed, and do not attempt a mixed-version rolling rollback across one.
  This already applies to `0264` and `0275`.
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

- member-management UI and provider invitation email;
- invitations for unregistered humans;
- a personal `workspace_memberships` row or delegated personal-workspace access;
- user-resource authority/grant writes, discovery, or sharing;
- resource CRUD or discovery changes;
- a caller for the shipped `transition_session_visibility` and
  `fork_session_content` lifecycle functions: no API, SDK, worker, MCP, or UI
  surface for session visibility mutation, session sharing, or independent
  fork. Visibility-aware reads are *not* a non-goal - they are active (see
  "Session-visibility and fork surfaces: shipped, deliberately inert");
- Connected Machine, rig, variable-set, connection, Codex, or Document
  materialization changes;
- an always-on retention deletion worker (0263 exposes a supported bounded
  operator command instead);
- provider, cloud, or deployment changes.
