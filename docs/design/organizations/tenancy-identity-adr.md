<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# ADR: human identity, login accounts, organizations, and workspace tenancy

Status: **corrective revision after the third exact-head blocked review; not approved for implementation**

Issue: OPE-10

Decision scope: generic identity and tenancy semantics for managed, configured, local,
embedded, white-label, SDK, and CLI use.

## 1. Context

The current system has a secure workspace resource boundary but an ambiguous
organization and identity model:

- `managed_accounts` is created one-for-one from a Better Auth user and owns that user's
  default workspace. The web UI presents the same row as an “organization.”
- `workspace_memberships` grants `user:<betterAuthUserId>` access to a workspace. There
  is no persisted organization membership.
- Better Auth's `auth_users`, `auth_sessions`, and `auth_identities` represent one
  ambient browser login. Better Auth calls a provider binding an “account”; that is not
  an OpenGeni organization, billing account, or model-provider credential.
- The rail derives organizations by grouping accessible workspaces by `accountId`.
- Billing, entitlements, usage, and credit rows are keyed directly to that `accountId`.
- Registered users can be added to a workspace by email, but unknown users cannot be
  invited. Self-leave and ownership transfer are absent.
- Workspace member removal prevents removing the caller or the last membership with an
  admin-shaped permission. A non-human subject can currently satisfy that check.
- The browser exposes one session user and one global sign-out action. It cannot retain
  multiple isolated login accounts.

The target must name each concept once, preserve the workspace as the resource and RLS
boundary, and remain usable by hosts that do not use Better Auth.

## 2. Decision summary

Adopt five distinct domain concepts:

1. **Human identity** — the stable internal person/actor record.
2. **Login account** — one authentication issuer/provider subject binding owned by a
   human identity.
3. **Organization** — the administrative, membership, organization-governance recovery,
   and default billing container. It is never the authority for deployment-wide human
   identity or login recovery.
4. **Workspace** — the resource tenancy and FORCE-RLS boundary inside exactly one
   organization.
5. **Entitlement owner** — an explicit typed owner (`organization`, `workspace`, or
   `personal`) for billing/entitlement policy, independent of every authentication or
   model-provider credential.

The existing `managed_accounts.id` remains the physical and compatibility identifier for
an organization. Public code and UI call it `organizationId`; legacy `accountId` fields
remain aliases for the same UUID through the compatibility window. A risky mass rename
or duplicate organization spine is not required to make the domain honest.

The workspace remains the operational authorization and data-isolation boundary. An
organization membership does not implicitly grant access to every workspace's content.

Human identity/login recovery is a deployment-scoped security ceremony independent of
every organization membership. Organization recovery changes only one organization's
governance rows and grants for an already authenticated human. Neither authority can be
silently substituted for the other.

The two deployment authority planes—identity recovery and exceptional organization-
governance custody—have independent offline trust roots, custodian enrollments,
factors, eligibility, quorums, revisions, degraded states, and lost-quorum
reconstitution. Tenant roles and ordinary support are outside both roots.

Personal-to-team conversion is a fenced change of one organization's kind that keeps
its id, workspaces, resources, and tenant ownership. **Organization merge is not
supported by this decision**: every API, SDK, CLI, host, migration, and UI request to
combine two organizations fails closed as `organization_merge_unsupported` until a
separate exact-head-reviewed design exists.

A proved post-apply finding that merge joined two different people uses a separate
identity-separation/reconstitution operation. It never rewinds history or lets one
authority decide tenant, billing, and private-state outcomes. External effects use a
durable capability-fenced delivery state machine; an ambiguous receipt blocks ordinary
merge finalization rather than permitting a blind republish or a silent success.

## 3. Canonical vocabulary

| Concept | Meaning | Must never mean |
| --- | --- | --- |
| Human identity | Stable person or recovery subject inside a deployment | A cookie, email address, provider token, organization, or Codex account |
| Login account | One `(issuer, provider subject)` authentication binding for a human | A model/provider credential, billing customer, organization, or workspace |
| Browser login slot | Revocable association between one browser session and one login account | A tenant grant |
| Organization | Administrative and membership container; physical id is the legacy `managed_accounts.id` | Authentication identity or resource isolation by itself |
| Organization membership | A human's standing and organization-level capabilities | Automatic read access to every workspace |
| Organization recovery steward | Active human membership authorized to recover governance inside exactly one organization | Human/login recovery authority or access to another organization/personal workspace |
| Deployment identity-recovery custodian | Separately enrolled deployment-level human authority for exceptional human/login recovery | Organization role, tenant content grant, support wildcard, or ordinary operator session |
| Deployment organization-governance custodian | Separately enrolled deployment authority that may restore proved human custody to a `governance_locked` team | Identity/login recovery authority, organization membership, content grant, or active-team owner/steward substitute |
| Workspace | Resource tenant within one organization; canonical RLS boundary | Human identity or billing credential |
| Workspace membership | Explicit human access to workspace resources | Login-session liveness or API-key validity |
| Service principal / API key | Non-human credential with its own attenuated grants | Human membership, owner, recovery contact, or last-human-admin substitute |
| Entitlement owner | Typed subject charged or limited by policy | Provider credential, login account, or cookie |
| Model/provider credential | Credential used to call an inference or integration provider | Login account or organization identity |

UI copy may say “account” only for a login account in the account switcher. Existing
wire fields named `accountId` are documented as deprecated organization-id aliases.

## 4. Entity model

### 4.1 Human identity

A human identity has a stable opaque id, display metadata, lifecycle status, security
revision, and timestamps. It may own multiple login accounts. It is the actor recorded
on human membership, invitation acceptance, recovery, and security audit events.

Rules:

- Email is a mutable claim, not identity and not a primary key.
- A matching email, even if verified, never automatically merges human identities.
- Identity merging or login-account linking requires explicit proof of both sides or a
  reviewed recovery ceremony. The action is step-up authenticated and audited.
- Removing one login account does not delete the human identity if another valid login
  or recovery path exists.
- Configured and embedded modes may supply a stable external human subject without
  storing Better Auth records. The host boundary must state whether the subject is a
  human, service principal, or unknown external subject.

### 4.2 Login account

A login account is unique by normalized issuer plus provider subject. It belongs to one
human identity and carries display-only issuer/email metadata, verification state,
status, and a revocation revision.

OpenGeni's login account is not Better Auth's `auth_identities` row. A Better Auth
provider identity may be the adapter record from which a login account is resolved, but
the domain contract remains provider-neutral.

Login-account rules:

- Provider subject, never email, is the durable external key.
- Upstream access/refresh tokens are credentials. They are encrypted or held by the
  authentication adapter and never returned in identity, organization, SDK, or audit
  payloads.
- Adding an account happens in an isolated, state-bound authentication transaction. It
  must not overwrite or log out an already active account.
- Unlinking revokes only that login account's browser slots and authentication sessions,
  unless the operator explicitly chooses “sign out everywhere.”
- The last usable login/recovery path cannot be removed without a recovery-approved
  identity deletion flow.

### 4.3 Organization

An organization has an opaque UUID, kind (`personal` or `team`), name, optional slug,
status, security revision, and timestamps. It is the parent of workspaces,
organization memberships, invitations, audit events, and default billing ownership.

Physical compatibility decision:

- `managed_accounts.id` is the organization id.
- `workspaces.account_id` is the organization foreign key.
- Existing `accountId` request/response fields and RLS GUC names continue to carry that
  same UUID. A caller supplying both `accountId` and `organizationId` must supply equal
  values or receive a validation error.
- No code may infer a human identity from an organization external id after the identity
  backfill is enabled.

### 4.4 Personal organization and workspace

Every managed human begins with one personal organization and one primary personal
workspace. “Personal” describes governance, not weaker tenancy:

- The personal workspace uses the same workspace routes, composite keys, FORCE RLS,
  metering, and audit controls as a team workspace.
- A human has at most one active personal organization in a deployment.
- The personal organization has exactly one personal owner identity while active.
- Additional collaborators can receive explicit workspace access. They do not become
  owners of the personal organization.
- Converting a personal organization to a team organization is explicit, step-up
  authenticated, and irreversible without a separate reviewed operation.
- A personal owner cannot “leave.” They may transfer/convert eligible resources or use
  the delayed identity/organization deletion flow.
- The primary personal workspace cannot be deleted independently while the personal
  organization is active. Team organizations may have zero workspaces.

### 4.5 Workspace

A workspace belongs to exactly one organization and remains the resource tenancy
boundary. Organization operations never rewrite a workspace id.

Required invariants:

- `(workspace_id, organization_id)` is unique on the workspace parent.
- Every workspace-scoped child carries both identifiers.
- Every child has a composite foreign key to the matching workspace pair; independent
  single-column foreign keys are not enough.
- Every workspace-scoped table uses `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL
  SECURITY`, `USING`, and `WITH CHECK` over both identifiers.
- The app role is non-superuser/non-`BYPASSRLS`; ordinary queries execute inside the
  exact organization/workspace GUC transaction.
- Route code calls the canonical access-grant boundary before reading a resource.
- Organization administration may expose workspace metadata without exposing workspace
  contents. Content access always requires a workspace grant or a separately
  authorized, time-bounded break-glass content grant. Organization governance recovery
  itself never grants content access.

Moving a workspace between organizations is out of scope for normal CRUD. A future move
is a dedicated migration ceremony that rekeys every child atomically/offline and proves
RLS isolation; changing only `workspaces.account_id` is forbidden.

### 4.6 Organization membership

Organization membership is persisted independently from workspace membership. It links
an active human identity or explicitly typed external principal to one organization.

Human base roles are:

- **owner** — governance, ownership transfer, organization deletion, role delegation;
- **admin** — membership/workspace administration within delegated limits; and
- **member** — organization discovery and explicitly granted workspace access.

Two sensitive roles are composable capability sets rather than higher base roles:

- **billing admin** — billing read/manage and entitlement administration; and
- **organization recovery steward** — approved recovery of membership, ownership, and
  grants inside this organization only.

An owner may receive all capabilities by policy, but implementations still persist and
check the capabilities so self-hosted deployments can separate duties. Organization
recovery does not implicitly grant workspace-content access, cannot attach/unlink a
login account, cannot change a human's deployment status or private-owner mappings, and
cannot mutate another organization or personal workspace. Billing does not imply
recovery or member management.

Deployment identity-recovery custodians are not organization memberships. Their
enrollment, factor custody, quorum, and audit scope are defined in section 15.4. Granting
or revoking an organization role can never create or remove that deployment authority.
Deployment organization-governance custodians are also separately enrolled under the
section 15.5 no-content capability. The two deployment custodian capabilities are
independent; holding one never grants the other.

Only an active human membership can count toward last-owner, last-administrator, or the
organization's recovery-steward invariant. Pending invitations never count. API keys,
delegated worker tokens, automated agents, service principals, and unknown external
subjects never satisfy a human-governance invariant.

### 4.7 Workspace membership

Workspace membership grants a human identity explicit resource permissions in one
workspace. It references the matching organization membership when one exists and
retains the legacy stable `subjectId` during compatibility.

Rules:

- Human access resolves from active membership on every request; a missing or revoked
  row means no access.
- Organization owner/admin status does not silently create a workspace read grant.
- A service credential carries its own grant and lifecycle. It is not inserted as a
  human solely to satisfy a roster or last-admin check.
- Role labels are presets; the permission set is the enforced authority. Unknown role
  strings never grant permissions.
- Grant updates, removals, and role changes lock the relevant organization and
  membership rows and increment the authorization revision in the same transaction.

## 5. Authorization roles and invariants

### 5.1 Capability outline

| Operation | Owner | Admin | Member | Billing admin | Org recovery steward |
| --- | --- | --- | --- | --- | --- |
| Read organization metadata | yes | yes | yes | only as needed | only as needed |
| Create workspace | policy default yes | delegated | no by default | no | no |
| Read workspace content | explicit workspace grant | explicit workspace grant | explicit workspace grant | no | no |
| Invite ordinary member | yes | delegated | no | no | no |
| Grant owner/org-recovery role | step-up + policy | no | no | no | org policy only |
| Manage billing | policy default | no by default | no | yes | no |
| Transfer ownership | yes, step-up | no | no | no | organization ceremony only |
| Delete organization | yes, step-up + delay | no | no | no | organization ceremony only |

Deployments may attenuate defaults but may not let a lower role grant authority it does
not hold.

### 5.2 Last-human-governance invariant

Every active team organization, including one with zero workspaces, no billing state,
and no invitations, must retain:

- at least one active human owner; and
- at least one active human organization recovery steward, which may be the same person
  only when deployment policy permits single-person governance and a separately
  enrolled organization break-glass factor exists.

The invariant is enforced under a transaction lock for remove, leave, demote, suspend,
unlink-last-login, transfer, delete, identity merge, and recovery operations. “Count then
update” without locking is forbidden. A deferred constraint alone is insufficient
because identity/login status also participates. Invitations and non-human principals
are excluded before the post-state is evaluated.

A last owner or recovery steward cannot leave, be removed, be demoted, or be absorbed by
an identity operation while the organization remains `active`. The safe choices are:

1. atomically transfer the required human role to another already active, authenticated
   human member;
2. cancel the mutation; or
3. run explicit organization deletion, retaining owner and recovery custody throughout
   `deletion_pending` and deactivating the final memberships only in the same fenced
   transaction that makes the organization terminal `deleted`.

If an identity must be suspended immediately for compromise and it is the last human
owner/steward, the same transaction moves the organization from `active` to
`governance_locked`, revokes the identity's access, and creates a deployment-custody
incident. `governance_locked` denies new grants, ownership changes, billing/credential
mutations, and resource creation. Deployment organization-governance custodians do not
count as owners; their only organization action is the delayed, audited section 15.5
ceremony to appoint a proved human owner/steward before returning the organization to
`active`.

Identity merge cutover creates the canonical human's derived owner/steward memberships
before deactivating source contributions in the same generation flip. No merge,
recovery, suspension, or deletion worker may expose an active intermediate state with
zero accountable humans.

Workspace-level administration likewise requires at least one active human able to
administer a non-personal workspace, unless the organization has an explicitly audited
owner recovery path. A service credential never counts.

## 6. Multiple active login accounts

### 6.1 Browser-session broker

One ambient Better Auth cookie cannot safely represent multiple simultaneous users.
Introduce a provider-neutral browser-session broker:

- one host-only, secure, HttpOnly browser-session cookie identifies a server-side
  browser session set;
- the set has zero or more independently revocable login slots;
- each slot binds one login account and authentication-session reference;
- the active slot is an explicit server-validated selection, not inferred from the
  tenant URL, email, local storage, or the last upstream callback;
- mutation requests carry CSRF protection and the selected slot/actor is included in
  authorization and audit context; and
- no upstream token or raw authentication-session token is exposed to JavaScript.

Adding a login account uses a popup/new-tab authentication transaction with a one-time
nonce, exact allowed return origin, short expiry, and transaction-specific callback
cookie/path. Completion adds a slot to the existing browser session set; it never
replaces the main cookie as a side effect.

### 6.2 Account selection and sign-out

- Switching a login slot changes the selected authentication path. The resolved human
  actor may remain the same when both accounts are linked to one human. Every switch
  still creates a new identity epoch, re-resolves grants, and carries no slot-local
  cache or credential from the prior slot.
- “Sign out this account” revokes one slot and its underlying auth session, clears only
  that actor's client caches, and selects another valid slot if the user confirms.
- “Sign out all accounts” revokes the entire browser session set and every child slot.
- Password reset, login-account compromise, or identity recovery increments the login
  revision and revokes all affected slots across devices.
- Organization membership removal does not globally log the human out; it invalidates
  that organization's grants and routes.

Cookie names, domain behavior, and adapter mechanics may vary by host, but the isolation
properties above are mandatory. Cross-subdomain cookies are opt-in deployment policy,
never a library default.

## 7. Invitations

An invitation is an expiring, single-use grant proposal, not a membership and not an
authorization token for normal APIs.

It records:

- organization id and optional workspace grant templates;
- target type: normalized verified-email claim, existing human identity, or a
  host-resolved external subject;
- proposed base role/capabilities, bounded by the inviter's delegable authority;
- inviter identity, creation/expiry timestamps, status, revision, and acceptance actor;
- a random secret whose hash is stored; and
- delivery metadata that contains no reusable authentication credential.

Acceptance rules:

1. Authenticate or add a login account without destroying existing login slots.
2. Verify the invitation secret, expiry, status, organization status, and target claim
   using non-enumerating responses.
3. Require step-up authentication for owner, billing-admin, or organization-recovery-
   steward grants.
4. Lock invitation and membership rows.
5. Bind or resolve the human identity explicitly; never merge identities by email.
6. Create/update organization and workspace memberships atomically.
7. Mark the invitation consumed and append the audit event in the same transaction.

Repeat acceptance by the same resolved identity is idempotent. Acceptance by a
different identity, replay after cancellation/expiry, and role changes after issuance
fail closed. Resending rotates the secret and invalidates the prior link.

## 8. Billing and entitlement ownership

Billing/entitlement ownership is a typed reference independent of login accounts,
provider credentials, and workspace resource tenancy:

- `organization` — shared organization balance/plan;
- `workspace` — workspace-specific policy or cost center; and
- `personal` — human-owned allowance that can be applied only according to explicit
  policy.

The data model uses an owner row with one checked typed target (or equivalent concrete
foreign-key tables), not an unchecked `(owner_type, owner_id)` pair. A workspace owner
reference also includes/validates the organization-workspace pair.

Existing billing rows backfill to organization ownership with
`organizationId == legacy accountId`. The billing/quota owner defines the detailed
ledger and entitlement semantics. OPE-10 only requires:

- ownership type is present in every public billing/entitlement response;
- changing a login account or model-provider credential cannot silently change who is
  billed;
- changing a billing owner is authorized, idempotent, and audited;
- usage always retains the resource organization/workspace plus the resolved billing
  owner; and
- provider credential labels or ids are never accepted as tenancy ids.

## 9. Lifecycle operations

### 9.1 Leave

- A member may leave an organization after a step-up check when policy requires it.
- An owner/admin/recovery holder may leave only if the locked post-change state preserves
  every last-human-governance invariant.
- Empty organization is not an exception: the last owner/steward must transfer custody
  or complete explicit deletion; leave never means implicit abandonment.
- Leaving removes organization and workspace human grants atomically, increments the
  authorization revision, and triggers invalidation. It does not delete shared data.
- A personal owner cannot leave their personal organization.

### 9.2 Remove or revoke

- An actor cannot remove a peer/higher role without explicitly delegated authority.
- Self-removal uses the leave operation rather than a hidden admin bypass.
- Revocation commits before the API reports success. New requests fail immediately
  after commit; streams and delegated capabilities follow the threat-model deadlines.
- Organization-owned service credentials survive a human removal unless explicitly
  selected or policy-bound to that human. Personal/user-owned credentials are revoked.

### 9.3 Transfer ownership

The recipient must be an active human member with a freshly proved usable login.
Transfer locks both memberships and the organization, requires step-up authentication,
updates roles/capabilities and recovery state atomically, and records old/new owners.
The former owner remains with an explicit selected role; no implicit access is retained.
The post-state must still contain an active human owner and organization recovery
steward; an invitation, service principal, deployment identity-recovery custodian, or
deployment organization-governance custodian cannot be the recipient membership.
Neither custodian capability counts toward active-team custody merely because it is
deployment authority.

### 9.4 Export

Export is an asynchronous, authorization-rechecked job. The download is encrypted or
short-lived, single-tenant, and auditable. Its manifest lists scope, omissions, actor,
organization/workspace ids, and creation/expiry. Secret values, auth tokens, provider
credentials, password hashes, and unredacted security logs are excluded by default.

### 9.5 Delete

Organization deletion is delayed and stateful: `active → deletion_pending → deleted`
with cancellation during a policy-defined grace period.

Before entering `deletion_pending`, require an owner/recovery-approved step-up flow,
resolve billing obligations, stop or transfer active workloads, cancel invitations,
and offer/export data according to deployment policy. The transition blocks new
resource creation and high-risk credential operations. Final deletion runs as a fenced,
idempotent job and writes a tombstone/audit record that cannot restore access.

Immediate FK cascade from an organization settings click is forbidden. A failed final
delete remains resumable and does not expose partially deleted data to another tenant.
Owner and recovery-steward memberships remain active and accountable while deletion is
nonterminal. Finalization first fences every job/grant/credential and then changes the
organization to `deleted` and deactivates those memberships atomically. An empty team
organization follows this same explicit path; last-owner leave never substitutes for
deletion.

### 9.6 Human identity or login-account deletion

Deleting a login account unlinks one authentication path. Deleting a human identity is
a separate privacy/recovery operation that first transfers or deletes personal assets,
resolves every organization role, revokes all login sessions and personal credentials,
and preserves minimally necessary pseudonymous audit/billing records under policy.

### 9.7 Personal-to-team conversion

Personal-to-team conversion changes exactly one existing personal organization into a
team organization without moving or renumbering it. The operation records a unique
`(organization_id, idempotency_key)`, expected organization kind/governance revision,
personal owner human/security revision and fresh step-up proof, proposed owner and
recovery-steward custody, factor/custody revisions, billing/entitlement revision and
decision, notice set, cooling deadline, barrier generation, and audit/outbox ids.
Only one nonterminal conversion, delete, transfer, kind change, or identity-merge
prerequisite may hold the organization barrier.

| Current state | Event and precondition | Next state | Durable effect |
| --- | --- | --- | --- |
| absent | current personal owner passes operation-bound step-up | `review` | Fence inputs; build revision-bound custody, collaborator, billing, and effect manifest |
| `review` | active human owner and recovery steward accept, factors are usable, billing decision is explicit, and notices are deliverable | `cooling_off` | Install conversion barrier; notify owner, workspace collaborators, billing owner, and security contacts; start policy minimum cooling |
| `review` | custody, billing, proof, policy, or notice prerequisite cannot be met | `blocked` | Preserve personal kind and all ids/resources; expose exact prerequisite |
| `review` or `cooling_off` | proved owner cancels before cutover | `aborted` | Consume generation, remove barrier, preserve personal kind and billing policy |
| `blocked` | new idempotent revision-bound review resolves every prerequisite | `review` | Rebuild the whole manifest; no partial approval is inherited |
| `cooling_off` | dispute or owner/custody/billing/organization revision changes | `aborted` | Fence callbacks and remove barrier; no kind or billing change |
| `cooling_off` | deadline passes and every proof, factor, notice, decision, and revision revalidates | `ready` | Require final owner step-up and exact-generation worker claim |
| `ready` | exact generation locks organization, custody, billing owner, and barrier rows | `applying` | Deny conflicting kind/custody/billing/delete/transfer/merge-prerequisite mutations |
| `ready` | any input is stale | `aborted` | Remove barrier; require a new generation and cooling period |
| `applying` | kind flip, team custody activation, billing decision, revisions, outbox, and audit commit atomically | `converted` | Same organization/workspace/resource ids become team-owned; conversion is now irreversible |
| `applying` | crash or transaction abort before commit | `ready` | No partial conversion is visible; retry exact generation after revalidation |

The team post-state has at least one active proved human owner and one active proved
human organization recovery steward before `kind = team` becomes visible. One human may
hold both capabilities only under the existing single-human break-glass policy with a
distinct organization factor. Deployment custodians, invitations, agents, service
principals, API keys, and workspace-only collaborators never satisfy either capability.
Existing workspace collaborators keep exactly their workspace grants; conversion does
not infer an organization membership or capability from collaboration.

Workspace rows, resources, URLs, tenant pairs, service credentials, jobs, and ordinary
data writes remain under the same organization/workspace authority throughout. The
barrier fences kind, custody, billing, deletion, transfer, and identity-merge
prerequisite changes, not ordinary resource writes. Personal allowances, credits, and
billing policy enter `conversion_hold` during cooling. The current billing authority
must select exactly one reviewed outcome—terminate personal allowance, transfer an
eligible balance/entitlement to the same organization as team-owned, or initialize a
new team policy. Posted ledger, payment, tax, entitlement-consumption, and anti-abuse
facts remain immutable; unsupported transfer stays `blocked` rather than being guessed.

Every notice and confirmation says the ids and resources remain, collaborators gain no
organization capability, billing follows the selected outcome, and the kind flip is
irreversible. An identity merge that names this conversion as a duplicate-personal-org
prerequisite cannot enter merge `cooling_off` until conversion is terminal
`converted`; `blocked` or `aborted` conversion leaves the merge blocked. A later
personal organization is created only through normal uniqueness-checked creation, not
by undoing this operation.

This protocol does not combine two organizations. Organization merge, organization-
to-organization resource consolidation, and an implicit workspace move are
unsupported and fail closed as `organization_merge_unsupported`; adding them requires
a separate ADR, threat model, migration plan, UX contract, and independent review.

## 10. Audit and invalidation contract

Security-relevant actions append sanitized audit events with:

- organization/workspace ids when applicable;
- actor human identity, login account, browser slot, or service principal id;
- effective role/capabilities and authentication strength;
- action, target type/id, request/idempotency id, outcome, and timestamp;
- before/after role or status summaries; and
- hashed/coarsened network/client metadata according to deployment policy.

Never record invitation secrets, cookies, session tokens, password/reset material,
provider credentials, variable values, or raw export contents.

Membership and login changes increment a monotonic authorization/security revision in
the same transaction. Cached access contexts, persistent streams, browser slots,
delegated user tokens, and background actions must compare the appropriate revision.
The exact deadlines and workload exceptions are defined in the threat model.

Audit storage is not an ordinary mutable tenant table. Section 18 defines its separate
append authority, scope, integrity chain, retention, and lawful-erasure behavior.

## 11. API, SDK, CLI, and embedded-host contract

### 11.1 API

- Workspace routes remain canonically workspace-scoped and authorize before data access.
- Add organization and identity summary endpoints without weakening workspace checks.
- Responses add `organizationId`; legacy `accountId` remains equal during the
  compatibility window.
- Actor context exposes the selected login-account summary and human identity id only
  to the authenticated actor; tenant APIs do not expose other members' login bindings.
- Mutations support idempotency and typed error envelopes. Invitation lookup and
  inaccessible deep links avoid resource enumeration.
- Personal-to-team conversion exposes the exact durable state and revision-bound
  manifest from section 9.7. No endpoint accepts a second organization id as a merge
  target; such requests return `organization_merge_unsupported` without moving data.

### 11.2 SDK and CLI

- SDK clients select organization/workspace explicitly; they never derive tenancy from
  an email, provider account, or model credential.
- Browser SDKs use the host session broker; server SDKs use an explicit credential and
  actor context. No SDK stores raw multi-account tokens in local storage.
- CLI account profiles live in OS credential storage, display issuer + account label,
  and require explicit organization/workspace selection when ambiguous.
- `--organization`/`organizationId` is an administrative selector; `--workspace` remains
  the resource selector and must belong to that organization.
- SDK/CLI conversion methods target one personal organization and surface every
  durable state. They provide no organization-merge helper, and a host/server reporting
  `organization_merge_unsupported` is a terminal capability result, not a fallback to
  client-side resource moves.

### 11.3 Embedded and white-label hosts

The domain must not require Better Auth, a product-specific brand, or a specific email
provider. Hosts may supply provider-neutral ports for:

- login subject resolution and step-up assurance;
- browser/session-slot storage;
- invitation delivery and verified-claim resolution;
- organization naming/branding policy;
- audit export/sink; and
- billing/entitlement-owner resolution.

Host ports return typed ids and assurance metadata. They do not bypass OpenGeni's
workspace grant or RLS boundary. Brand strings, routes, icons, and email copy are host
configuration, never hard-coded tenancy semantics.

An embedded host may render the personal-to-team protocol but cannot implement an
organization merge behind OpenGeni's API. A request or capability advertisement for
organization merge must remain absent or return `organization_merge_unsupported`.

## 12. Deep links and navigation

A workspace deep link is resolved against all active login slots without leaking tenant
existence:

1. If the selected slot has access, open it.
2. If another active slot has access, offer an explicit “Open as …” transition; do not
   silently change actor while a draft/upload exists.
3. If no active slot has access, preserve the intended path in a signed, short-lived
   server nonce and offer sign-in/add-account/request-access.
4. If the resource is missing or revoked, show the same unavailable state plus safe
   accessible-workspace choices.

Switching actor, organization, or workspace uses the destructive-navigation preflight
in the UX contract. Old requests, event streams, and caches are fenced by an identity
epoch before the new route commits.

## 13. Rejected alternatives

### Treat Better Auth user as the organization

Rejected: it prevents shared organizations, conflates authentication with billing, and
makes multi-account UI and recovery unsafe.

### Treat verified email as human identity

Rejected: email changes, aliases, enterprise reassignment, and provider compromise make
automatic linking an account-takeover path.

### Make organization the RLS resource boundary

Rejected: it broadens data visibility and breaks the established workspace isolation
contract. Organization administration and workspace content have different authority.

### Rename every `account_id` in one migration

Rejected: it creates a high-overlap, high-lock, mixed-version cutover with no product
benefit. A compatibility alias is honest and safer.

### Put multiple authentication tokens in browser local storage

Rejected: XSS or confused client code would expose every active account and make
per-account revocation unreliable.

### Count API keys as last administrators

Rejected: credentials cannot receive recovery notices, prove a person is present, or
perform accountable governance.

### Merge organizations as part of identity merge

Rejected: identity equality does not prove that two independent tenant, billing,
custody, retention, integration, or contractual authorities may be combined. This ADR
defines only in-place personal-to-team conversion. Organization merge remains
unsupported and fail-closed until separately designed and reviewed.

## 14. Implementation approval criteria

Schema/API work may begin only after an exact-head independent review approves this ADR
and the companion threat model. Later implementation is acceptable only when it proves:

- no automatic email identity linking;
- multiple isolated login slots and per-slot sign-out;
- persisted organization membership plus explicit workspace grants;
- human-only owner and organization-recovery custody for every active team organization;
- deployment-scoped human/login recovery independent from organization governance;
- independent deployment authority-plane roots, custodian lifecycle/reconstitution,
  and fail-closed degraded or unavailable modes;
- revision-fenced wrongful-merge identity separation with no invented tenant grants;
- atomic personal-to-team conversion with explicit billing/custody outcomes and no
  organization-merge fallback;
- durable external-delivery reconciliation that never blindly republishes and blocks
  merge finalization on unresolved effects;
- single-use invitations and step-up for sensitive roles;
- synchronous grant invalidation plus bounded stream/token invalidation;
- typed billing ownership independent of login/model credentials;
- legacy `accountId` equality and old-binary safety;
- real PostgreSQL composite-FK and FORCE-RLS cross-tenant isolation; and
- the responsive, accessible, draft-safe switching contract.

## 15. Login linking, identity merge, separation, and recovery protocols

Five operations are distinct and never share a permissive fallback:

- **Link login account** attaches one not-yet-owned authentication binding to one
  existing human identity. It never combines two existing human identities.
- **Merge identities** makes two existing human identities resolve to one canonical
  human after every authority and asset conflict is settled.
- **Separate/reconstitute identities** contains and repairs a wrongful merge that joined
  different people, restoring independent authentication only after closed deployment
  proof and scoped owner decisions under section 15.7.
- **Recover human identity/login** restores a deployment-wide authentication path under
  section 15.4. Its authority is independent of every organization.
- **Recover organization governance** changes membership/ownership inside exactly one
  organization under section 15.5. It cannot attach a login, change human status, or
  activate another tenant or personal workspace.

A login binding already owned by a different human returns `identity_merge_required`.
Neither email equality, organization authority, nor a successful provider callback
changes that result.

### 15.1 Link-account transition table

The durable link operation has a unique `(target_human_id, idempotency_key)` and an
expected target human security revision.

| Current state | Event and precondition | Next state | Durable effect |
| --- | --- | --- | --- |
| absent | selected target slot passed recent step-up | `proof_pending` | Store nonce hash, target revision, issuer, return origin, expiry |
| `proof_pending` | callback proves new `(issuer, subject)` and state/PKCE | `validated` | Reserve binding under unique issuer/subject constraint |
| `proof_pending` | expiry, state mismatch, cancel | `aborted` | Consume nonce; no binding change |
| `validated` | binding is unowned and target revision still matches | `applying` | Lock target human, binding, operation, and session set |
| `validated` | binding belongs to target human | `applied` | Idempotent success; no duplicate slot |
| `validated` | binding belongs to another human | `conflict` | Release reservation and return merge-required reference |
| `applying` | atomic attach, revision bump, audit append succeed | `applied` | Attach account and optionally add an independently revocable slot |
| `applying` | transaction abort/crash | `validated` | Retry from unchanged durable state; no partial attach |

“Recent step-up” means an adapter assurance accepted by deployment policy and completed
within ten minutes for this exact operation. Callback proof is single-use and expires
after ten minutes. A retry with the same idempotency key returns the stored state;
reusing a key with different inputs fails. An organization owner or recovery steward
cannot substitute organization approval for the target human's proof.

### 15.2 Identity-merge transition table

The merge operation records ordered source ids, proposed canonical id, both starting
security revisions, evidence ids, conflict decisions, irreversible-boundary
acknowledgments, approvers, and a fencing generation. Only one nonterminal identity
operation may mention either human.

| Current state | Event and precondition | Next state | Security behavior |
| --- | --- | --- | --- |
| absent | proposer proves one source | `evidence_pending` | Notify all verified paths on both identities |
| `evidence_pending` | fresh proof of one usable login on each source | `conflict_review` | Both identities remain separate; build revision-bound manifest |
| `evidence_pending` | unavailable source completes section 15.4 recovery and then gives fresh proof | `conflict_review` | Organization recovery is never accepted as source proof; use 72-hour cooling below |
| `conflict_review` | every conflict and irreversible prerequisite is resolved | `cooling_off` | Install merge mutation barrier; wait 24 hours, or 72 hours after identity recovery |
| `conflict_review` | unresolved conflict or separation-of-duty violation | `blocked` | No alias, authority, owner, or tenant change |
| `blocked` | authorized decisions complete and source revisions unchanged | `conflict_review` | Rebuild and reapprove the complete manifest |
| `cooling_off` | dispute, proof revocation, barrier violation, or revision change | `aborted` | Remove barrier; preserve evidence and reason |
| `cooling_off` | deadline passes and proofs/revisions/notices remain current | `ready` | Require final step-up; freeze owner/governance/billing/private-owner mutations |
| `ready` | worker claims exact generation | `staging` | Materialize inactive derived rows and effect manifest in bounded batches |
| `ready` | proof/revision/approval revalidation fails | `aborted` | Consume generation; remove barrier; require a new operation |
| `staging` | next at-most-500-row/250-ms batch commits | `staging` | Record checkpoint/digest; staged rows remain invisible to authorization |
| `staging` | full manifest staged and source/barrier revisions match | `applying` | Enter short cutover; no unbounded all-object transaction |
| `staging` | crash, timeout, or stale manifest | `staging` or `aborted` | Retry exact checkpoint or discard staged generation; no visible partial merge |
| `applying` | alias/generation flip, revisions, session revocation, outbox, and audit commit | `applied_observation` | Canonical resolution starts; 30-day dispute/containment window starts |
| `applying` | crash/serialization failure | `staging` | Cutover did not commit; revalidate the staged generation |
| `applied_observation` | dispute submitted before deadline | `contained` | Increment security revision, revoke sessions/credentials, deny sensitive human mutations |
| `contained` | investigation proves the sources were the same person and rejects dispute | `applied_observation` or, only after the deadline and section 15.8 gate, `finalized` | Append reason; issue only fresh sessions after proof; never run an inverse ledger |
| `contained` | investigation proves or cannot exclude that the sources were different people | `contained`; child separation `evidence_pending` | Start the distinct section 15.7 operation under a new generation; the originating merge remains contained historical evidence and neither person authenticates through the merged resolver |
| `contained` | dispute is upheld but the sources are still proved to be the same person | `repair_review` | Build section 15.6 provenance manifest and keep fail-closed containment |
| `repair_review` | scoped authorities approve a complete forward plan | `repairing` | Fence plan generation; expired/incomplete approvals do nothing |
| `repairing` | bounded idempotent repair batches finish without an irreversible/unresolved exception | `repaired` | Append complete outcome report; issue no implicit grant or restored credential |
| `repairing` | bounded idempotent repair batches finish with declared irreversible/unresolved exceptions | `repaired_with_exceptions` | Append complete exception/outcome report; issue no implicit grant or restored credential |
| `repairing` | crash/serialization failure | `repairing` | Retry exact checkpoint; already committed effects are not inverted |
| `applied_observation` | 30 days pass with no dispute and every external intent is terminal-acceptable under section 15.8 | `finalized` | Alias remains; source/write lineage stays retained under policy |
| `applied_observation` | 30 days pass while any external intent is not terminal-acceptable under section 15.8 | `finalization_blocked` | Keep lineage and reconciliation active; timeout is never treated as delivery success |
| `finalization_blocked` | every intent becomes receipt-confirmed, failed-confirmed, or compensated | `finalized` | Append delivery outcome digest; retain lineage under policy |
| `finalization_blocked` | scoped authorities durably approve an unresolved irreversible exception | `repaired_with_exceptions` | Append signed exception/outcome report; never relabel unknown delivery as success |

Merge proof is fresh control of at least one usable, non-recovery login account on each
source, with step-up bound to the merge id. A missing proof is never replaced by an
organization role or organization recovery-steward quorum. The unavailable human must first
complete deployment-scoped identity recovery under section 15.4 and then prove the
recovered path; a merge involving that path receives the 72-hour cooling period. A
compromised, suspended, newly added during this operation, or operation-target identity
cannot approve its own recovery or bypass proof.

Every proposal, proof, conflict decision, prerequisite completion, dispute, containment,
repair decision, apply, and finalize sends a non-secret notice to all pre-existing
verified paths. Delivery failure does not shorten cooling. It blocks readiness when
policy requires a reachable notice path. A dispute consumes the current worker claim so
a stale callback cannot continue applying.

The merge mutation barrier is checked by every owner, organization-governance, billing,
and private-owner mutation involving either source. Ordinary workspace data may
continue under its unchanged tenant owner during cooling/staging. The staging worker
orders stable keys, commits at most 500 rows or 250 ms per batch, stores a manifest
hash/checkpoint, and never exposes staged rows. The short cutover locks only the two
human security rows, merge barrier/generation, affected governance summary revisions,
and session-generation rows in deterministic order; it verifies the full staged digest
before flipping canonical resolution. This replaces the unbounded promise to lock every
object in one transaction.

A personal-to-team conversion named by the conflict manifest is a separate section 9.7
operation. Merge remains in `conflict_review` or `blocked` until that operation is
terminal `converted`; `ready`, `applying`, `blocked`, or `aborted` never satisfies the
prerequisite. The merge mutation barrier and conversion barrier have one deterministic
lock order and cannot both be claimed by different generations. Combining the two
organizations themselves is not a conflict resolution: organization merge is
unsupported and returns `organization_merge_unsupported`.

### 15.3 Deterministic merge conflict resolution

The preview is a server-generated, revision-bound manifest. Every row is resolved or
the merge remains `blocked`.

| Conflict | Required decision; no silent default |
| --- | --- |
| Two active personal organizations | Keep exactly one as personal. Any other section 9.7 conversion must reach `converted`, or delayed export/deletion must reach its declared terminal state, before merge cooling. Conversion, finalized deletion, external side effects, and destroyed facts are labeled irreversible; cancel is always available. Organization merge fails closed, no workspace moves implicitly, and no later merge repair promises to undo them. |
| Duplicate organization memberships | Preserve a contribution per source and compute one explicit canonical grant. Block if organization policy forbids combined duties. Sensitive capabilities require that organization's normal approval; merge cannot invent them. Every active team organization must retain a human owner and recovery steward after cutover. |
| Pending invitations | Retarget only after inviter authority and target proof are rechecked; exact duplicates are cancelled with audit. Accepted/expired records remain immutable. |
| Recovery authority | Human/login recovery authority remains deployment-scoped and is never unioned from organizations. Re-evaluate each organization's owner/recovery-steward invariant independently; a source being absorbed or a compromised path cannot approve. |
| Personal entitlement/billing state | Place both personal owner records in `merge_hold`. The billing owner explicitly chooses one surviving allowance or an approved ledger transfer. Posted charges, credits, anti-abuse facts, and external provider effects are never summed or reversed automatically. Organization/workspace billing is unchanged. |
| Drafts, pins, uploads, connections, personal keys | Retain source and object lineage and stage mappings through the owner effect manifest. Same-object collisions receive distinct stable ids; deletes and secret material are never reconstructed from the manifest. |
| Existing audit identity | Never rewrite it. Append canonical/alias and repair references while old events retain original actor ids and integrity chains. |
| Active sessions and credentials | Revoke all source slots, auth sessions, personal keys, refresh families, and user-bound delegated tokens at cutover. Reauthentication creates fresh canonical credentials; repair never restores old credentials. |

Applying a merge creates an alias from absorbed to canonical human and activates only the
staged generation. For each shared organization it activates one canonical membership
with the approved authority, then marks source contributions inactive while retaining
their exact provenance. Private-owner mappings follow the same derived/source lineage.
The generation flip preserves every active team's human owner/recovery-steward invariant.
Authorization reads only the active canonical generation; it never dynamically unions
source rows.

There is no automatic or lossless post-apply reversal. Personal-organization conversion
or deletion, hard deletes, audit facts, billing/provider postings, notifications, and
external jobs may be irreversible. A dispute after apply uses containment and the
forward-only, per-object repair contract in section 15.6. The absorbed identity, source
contributions, manifest, and provenance are not physically compacted merely because the
30-day window expires; later retention/compaction must preserve audit and declared
lineage.

### 15.4 Deployment-wide human identity and login recovery

Human/login recovery is deployment-scoped because one human, its login bindings,
human-private state, and active memberships may span many unrelated organizations. Its
authority is stored outside organization membership and cannot be granted by an
organization owner, admin, recovery steward, invitation, billing role, or tenant API.

#### 15.4.1 Deployment authority-plane root of trust and custodian lifecycle

There are two separate deployment authority-plane instances:

1. `identity_recovery`, whose custodians may satisfy only the closed human/login
   recovery paths in section 15.4.2; and
2. `organization_governance_custody`, whose custodians may satisfy only the exceptional
   locked-organization path in section 15.5.

Each plane is rooted in a precommitted offline deployment authority controlled through
operator/deployment ceremony, not by a tenant, ordinary support, a runtime app role, or
the custodians themselves. Each stores its own root public-key/factor digest, policy
version, configured quorum and eligibility age, status/revision, notice destinations,
and last verified ceremony. Root secret material remains offline. The two digests,
factors, enrollments, approvals, and database capabilities are independent even if the
same proved person is eligible for both roles; possession or quorum in one plane never
counts in the other.

The shared plane-state vocabulary has plane-specific rows and generations:

| Current state | Event and precondition | Next state | Security behavior |
| --- | --- | --- | --- |
| `unconfigured` | operator chooses an explicit mode and commits root/policy digest | `enrollment_pending` or `disabled_unavailable` | No custodian recovery operation is accepted |
| `enrollment_pending` | separately proved custodians/factors satisfy configured viable quorum and eligibility policy | `enabled` | Activate exact eligible set under a new plane revision |
| `enrollment_pending` | operator records the path intentionally unavailable | `disabled_unavailable` | Preserve reason; UI/API cannot advertise that recovery path |
| `enabled` | ordinary removal/rotation would leave post-state below viable quorum | `enabled` | Deny mutation unless one atomic replacement preserves quorum |
| `enabled` | compromise immediately revokes a custodian/factor and drops viable quorum | `degraded` | Commit revocation and revision first; all custodian-dependent recovery fails closed |
| `degraded` | eligible atomic replacement restores configured quorum without root reconstitution | `enabled` | Activate replacement before predecessor is finally revoked |
| `degraded` | offline root authorizes lost-quorum incident and long-cooling rebuild | `reconstituting` | Freeze all recovery approvals/operations in this plane; notify deployment security contacts |
| `reconstituting` | cooling completes and offline-root signatures, independent incident basis, factors, eligibility, notices, and revision revalidate | `enabled` | Atomically activate new eligible set, rotate plane generation, and revoke superseded set |
| `reconstituting` | incident is cancelled or proposed set/evidence becomes stale while the offline root remains valid | `degraded` | Discard the inactive proposed set; keep recovery denied and require a new reconstitution generation |
| `degraded` or `reconstituting` | offline deployment root is unavailable, invalid, or disputed | `disabled_unavailable` | Keep plane unavailable; never let runtime actors or remaining custodians self-expand authority |
| `disabled_unavailable` | a later offline-root ceremony creates a new reviewed generation | `enrollment_pending` | No recovery operation is enabled until enrollment again proves viability |

`degraded`, `reconstituting`, and `disabled_unavailable` reject new claims and prevent
pending claims from applying. A compromise revocation never waits for a replacement or
cooling period. Lost-quorum reconstitution requires offline-root proof, a separately
approved incident/legal basis, notices through precommitted channels, and at least a
seven-day cooling period; policy may lengthen but not shorten it. The root cannot
authorize a target recovery while rebuilding the custodian plane. If the root cannot
be used, unavailability is the safety result—not a lower quorum, tenant vote, support
override, or first-operator bootstrap.

Every custodian is a distinct proved human operator identity with a dedicated
hardware-backed/offline factor and no-content capability. Its plane-local lifecycle is:

| Current state | Event and precondition | Next state | Durable effect |
| --- | --- | --- | --- |
| `absent` | offline root and separate enrollment operator approve exact human/factor/plane | `enrollment_pending` | Store proof/factor digest, approvers, plane revision, nonce, and notice; grant nothing |
| `enrollment_pending` | custodian proves factor and accepts duties | `cooling_off` | Start policy cooling; self-enrollment and cross-plane factor reuse are denied |
| `enrollment_pending` | proof/acceptance fails, expires, is disputed, or enrollment is withdrawn | `revoked` | Consume nonce and generation; no capability or approval becomes usable |
| `cooling_off` | deadline and enrollment/root/human/factor revisions revalidate | `active_ineligible` | Activate no-content capability but do not count toward quorum |
| `cooling_off` | dispute or root/plane/human/factor revision change | `revoked` | Consume enrollment generation; a later attempt repeats enrollment and cooling |
| `active_ineligible` | minimum eligibility age passes without dispute/compromise | `active` | Count only under the current plane revision |
| `active` or `active_ineligible` | old and new factor proof start a rotation | `factor_rotation_pending` | Old factor remains current; pending factor cannot approve |
| `factor_rotation_pending` | cooling and both proofs/revisions revalidate | `active_ineligible` | Atomically replace factor, bump custodian revision, and restart eligibility age |
| `factor_rotation_pending` | rotation is cancelled/expires or new-factor proof fails while the old factor remains uncompromised/current | prior `active` or `active_ineligible` state | Discard pending factor, bump operation revision, and retain only the old factor's prior eligibility |
| `active` or `active_ineligible` | planned removal begins and post-state/replacement is viable | `revocation_pending` | Stop new approvals; retain current approvals only until their short expiry |
| `revocation_pending` | eligible replacement is active or remaining post-state meets quorum | `revoked` | Revoke factor/capability and bump plane revision |
| `revocation_pending` | planned removal is cancelled and current factor/human/plane revisions revalidate | prior `active` or `active_ineligible` state | Bump operation revision; restore no approval that expired while removal was pending |
| any non-revoked state | compromise or factor loss is confirmed | `revoked` | Revoke immediately; invalidate approvals and move plane to `degraded` when quorum is lost |

Enrollment, activation, rotation, revocation, and replacement require distinct operator
and offline-root duties as configured; a custodian cannot approve their own lifecycle
mutation. Every transition is fenced by expected plane, root-policy, custodian, human,
and factor revisions. Replacement is one composite generation that makes the eligible
replacement active before revoking the predecessor; two independent mutations cannot
temporarily pass a stale quorum check. Approval eligibility is evaluated both when an
approval is recorded and when a recovery applies.

For `organization_governance_custody`, fewer than three distinct eligible custodians
means the exceptional unlock path is explicitly unavailable; it is never advertised as
“contact support.” For `identity_recovery`, each configured self/locked-out/factorless
path records whether its factor and two-/three-custodian quorum is viable or explicitly
unavailable. A plane may remain enabled for a viable stronger or self-recovery path
while another path is recorded unavailable, but no request may silently fall across
paths.

Custodian actions use separate no-content roles, incident ids, short approval lifetimes,
and operator/deployment audit. A custodian receives no tenant discovery or workspace
content access and cannot approve their own recovery or an operation in which they are
a source/target.

#### 15.4.2 Human/login recovery operation

The recovery operation has a unique idempotency key, target security revision, exact
requested effects, evidence/approval ids, authority path, cooling deadline, notice set,
and fencing generation.

| Current state | Event and precondition | Next state | Durable effect |
| --- | --- | --- | --- |
| absent | non-enumerating deployment recovery request | `requested` | Store target-handle hash, requested effects, incident, expiry; no tenant scope |
| `requested` | target resolves and requester begins proof | `evidence_pending` | Notify all pre-existing verified paths; bind one-time evidence nonces |
| `requested` | target absent, rate limit, cancel, or expiry | `expired` or `aborted` | Consume handles/nonces; reveal no identity existence |
| `evidence_pending` | one approved deployment authority path completes | `cooling_off` | Record factors/custodians, affected-grant digest, notices, and freeze login/recovery mutations |
| `evidence_pending` | failed/replayed factor, ineligible custodian, or expiry | `aborted` | Consume generation; append sanitized deployment audit |
| `cooling_off` | dispute or target/custodian/evidence revision change | `disputed` | Fence callbacks/workers and revoke operation nonces |
| `cooling_off` | deadline passes and evidence/notices revalidate | `ready` | Require final fresh requester/custodian proof |
| `ready` | exact generation claims target/login/session rows | `applying` | Set recovery fence and deny all target-human requests before side effects |
| `ready` | revalidation fails or operation expires | `aborted` | Remove operation freeze; consume generation |
| `applying` | requested effects, global revision, revocations, outbox, and audit commit | `applied` | Revoke old paths and expose only newly proved authentication material |
| `applying` | transaction abort/crash | `ready` | Retry exact generation from unchanged visible state |

Approved authority paths are closed and versioned:

1. **Self recovery:** fresh control of one pre-existing phishing-resistant login/recovery
   method plus a distinct pre-enrolled offline target factor; minimum 24-hour cooling.
2. **Locked-out recovery:** one pre-enrolled offline target factor plus two distinct
   active deployment identity-recovery custodians; minimum 72-hour cooling.
3. **Factorless exceptional recovery:** only when deployment policy explicitly enables
   it, three distinct custodians using separately held factors, an independently approved
   incident/legal basis, and minimum seven-day cooling. Otherwise it fails closed and no
   login is attached.

Any path that counts custodians requires the `identity_recovery` authority plane to be
`enabled`, the exact path to be recorded viable, and every approval to come from an
`active` eligible custodian under the same current plane revision. A transition to
`degraded`, `reconstituting`, or `disabled_unavailable`, or any root/policy/custodian
revision change, disputes the operation and prevents apply. Self recovery remains
available only when its own target-held factor path is configured viable; it never
borrows an unavailable custodian path.

Quorum counts distinct proved humans and distinct factor roots. A target, compromised or
newly enrolled custodian, organization administrator, service credential, or ordinary
support session never counts. Policy may require more approvers or longer delays but
cannot replace deployment authority with an organization quorum.

Allowed effects are only: revoke compromised login accounts and every dependent slot/
session/token family; attach a newly proved unowned login; rotate target recovery
material; or restore the deployment status of the same human. Apply increments the
human/login security revisions, revokes all browser/native slots, authentication
sessions, personal credentials, offline caches, and user-bound delegated tokens, and
closes streams before a fresh slot can authorize. Organization-owned service credentials
remain organization-owned. The durable revocation outbox is committed with the deny
revision; delivery lag never restores access.

Recovery does not add, remove, reactivate, or rewrite any organization/workspace
membership, organization role, billing owner, personal workspace, or tenant-owned
resource. Restoring the global human status may make that human's independently active
existing grants usable again, but only this deployment-scoped ceremony can do so.
Organization-A governance recovery cannot invoke it, cannot mutate the target's global
status, and cannot expose organization-B or personal state. Notifications go to every
pre-existing verified path and, by policy, non-secret security contacts in affected
organizations without disclosing other memberships. Audit records the deployment scope,
authority path, quorum/factors, affected-grant digest, revocations, notices, and outcome;
it never records secret factor material.

`aborted`, `disputed`, `expired`, and `applied` are terminal. A new attempt uses a new
idempotency key/generation. Organization ownership transfer and identity merge remain
separate operations.

### 15.5 Organization-scoped governance recovery

Organization governance recovery exists only to restore accountable custody inside one
organization. The operation stores exactly one `organization_id`, its governance
revision, requested membership/grant effects, eligible active human stewards, approvals,
notices, deadline, incident, and generation. Its database capability cannot address
human/login tables or another organization.

| Current state | Event and precondition | Next state | Durable effect |
| --- | --- | --- | --- |
| absent | authorized request names one organization and effects | `requested` | Record org revision and non-content incident; notify org security contacts |
| `requested` | globally active target human proves login and org quorum/factor completes | `cooling_off` | Freeze this org's owner/steward mutations; minimum 72-hour cooling |
| `requested` | target globally suspended/unproved, quorum absent, or inputs stale | `blocked` | Require section 15.4 first or deployment-custody path; change nothing |
| `cooling_off` | dispute, approver loss, org/target revision change | `aborted` | Fence callbacks and remove org mutation freeze |
| `cooling_off` | deadline and notices revalidate | `ready` | Require final step-up by proved actor/approvers |
| `ready` | exact generation locks org governance and memberships | `applying` | Recompute post-state including owner/steward invariant |
| `applying` | one-org membership/grant/revision/audit commit | `applied` | Invalidate only this organization's grants and routes |
| `applying` | crash/serialization failure | `ready` | Retry from unchanged visible state |

Normal quorum is two distinct active human organization recovery stewards who are not
the target of the change. A deployment may allow one proved owner/steward plus a
separately enrolled organization break-glass factor for a single-human organization.
That factor is organization-scoped and cannot recover a login. If the only human cannot
authenticate, deployment identity recovery must complete before ordinary organization
recovery.

An exceptional deployment-custody path never makes a custodian an owner and never grants
content. It first moves the organization to `governance_locked`, requires three distinct
separately enrolled deployment organization-governance custodians with separate
factors who are `active` under an `enabled` current plane revision, seven-day cooling
and notices, and may only appoint a globally active, freshly proved human as owner and
recovery steward. If that authority plane is unconfigured, enrollment-pending,
degraded, reconstituting, disabled/unavailable, below three eligible custodians, or
changes revision during the ceremony, the operation blocks or aborts fail-closed and
the organization remains `governance_locked`. This capability is independent from
deployment identity-recovery custody; holding either one never grants the other. The
same transaction then restores `active`. A personal organization cannot use this path
to replace its personal owner; it must recover the existing human globally or use the
separate delayed personal-organization/identity deletion procedure.

Allowed organization effects are scoped membership activation/deactivation, owner or
recovery-steward transfer, and revocation of human-bound grants/credentials in this
organization. The operation cannot link/unlink login accounts, change human status,
remap human-private owners, alter another membership, or touch unrelated personal
workspaces. It increments only the organization's and changed memberships' revisions,
revokes only affected tenant routes/streams/tokens, and appends organization-scoped audit
plus operator audit for break-glass use.

Tests must seed one human across organizations A and B plus a personal workspace and
prove every organization-A recovery transition leaves the target human/login revision,
B membership/grants, personal-owner rows, B/personal sessions, billing, credentials,
and content byte-for-byte and authorization-equivalent unchanged.

`blocked`, `aborted`, and `applied` are terminal for one organization-recovery
generation. After global identity recovery, custody enrollment, or another prerequisite
changes, a caller must create a new idempotency key/generation and re-run all notices,
delay, proof, quorum, and revision checks; a blocked callback never resumes.

### 15.6 Post-apply write lineage, containment, and forward-only repair

For 30 days after merge cutover, every write authorized by the canonical human or using
an owner mapping changed by the merge must append `merge_write_provenance` in the same
database transaction as the write intent. External work records the intent before
publish and follows the capability-fenced delivery states in section 15.8; a missing
receipt is not evidence of failure or success. A write that cannot durably link its
provenance fails closed; there is no best-effort observation path.

Each record contains merge id/generation and monotonic sequence; object type/stable id;
owner plane and before/after owner ids; exact organization/workspace when applicable;
actor human/login/slot and pre-merge source lineage, or the organization/service
principal that acted; authorization/security revisions; request/idempotency/outbox and
external-receipt ids; operation kind; before/after digests or tombstone (never secret
content); and one conflict/reversibility class. Per-object lineage links the apply-time
source contribution, every post-apply write, and any later repair effect.

| Class/effect | Deterministic containment and repair outcome |
| --- | --- |
| Shared organization/workspace data | Remains owned by that tenant. It is never split merely because the human actor is repaired; tenant authorities decide later human grants. |
| Membership, role, owner, recovery-steward change | Freeze on containment. Each affected organization's current authority approves one forward assignment; committed revocations are preserved and authority is never duplicated by default. |
| Invitation | Accepted/expired/cancelled facts stay immutable. A needed grant uses a new invitation after repair; no token or consumed invitation is revived. |
| Source-attributable private draft/pin/upload/preference | May transfer to a reconstituted proved human when lineage is unique and tenant scope still authorizes it. Stable ids remain; collisions are explicit. |
| Joint/ambiguous private state | Quarantine from both humans until an explicit owner decision; never copy secrets or guess from email/login label. |
| Delete or destructive edit | Restore only from an existing policy-valid tombstone/version. Hard-deleted or overwritten facts are reported irreversible, not reconstructed. |
| Billing/entitlement/provider posting | Posted ledger and provider facts remain. An authorized billing owner may append a compensating transfer/credit; no automatic refund, balance duplication, or anti-abuse reset. |
| Login credential, API key, session, delegated token | Revoke and reissue after proof. Old secret material is never restored, split, or copied. Organization service credentials remain with their tenant unless that tenant revokes them. |
| Audit/security evidence | Never rewrite or split prior events. Append alias, containment, decision, repair, and exception links to the immutable chains. |
| Webhook, notification, job, or other external effect | Cannot be assumed recalled or delivered. Follow section 15.8; apply a separately keyed compensation only when the owning subsystem and scoped tenant/billing authority support one. Unknown delivery remains visible and blocks ordinary finalization. |
| Personal-organization conversion/finalized deletion | This was an acknowledged prerequisite and remains irreversible. At most restore an available export into a new, separately authorized tenant; never claim original ids/data were losslessly recovered. |

A dispute first commits containment: increment the human security revision, revoke all
canonical human sessions/personal credentials, seal private-owner mutations, and deny
new identity/merge/governance/billing actions by that human. Organization-autonomous
jobs may continue only under their own tenant authority. Containment does not delete,
move, or duplicate an object.

`repair_review` materializes a paginated manifest from the apply-effect manifest plus every
provenance record. It shows each affected human and scoped authority: proposed owner,
retained tenant, revocation, quarantine, compensating effect, and irreversible fact.
Every organization approves only its own membership/governance outcomes; billing owners
approve ledger compensation; the deployment identity authority approves new human/login
resolution; private owners approve uniquely attributable private transfers after proof.
A single global approver cannot decide all planes.

Repair-plan approvals expire after 14 days or any referenced revision change and must be
regenerated. Expiry never releases containment. Bounded idempotent batches use stable
keys/checkpoints and append an outcome for every manifest row. Completion is `repaired`
or `repaired_with_exceptions`; the user-visible signed report names retained,
transferred, revoked, quarantined, compensated, and irreversible categories and the
remaining support/export options. There is no state named “reversed.”

If no dispute arrives, the observation window expires after 30 days and the merge
finalizes only after section 15.8 proves every external intent receipt-confirmed,
definitively failed, compensated, or durably approved as an unresolved irreversible
exception. Otherwise it enters `finalization_blocked`; time cannot convert unknown
delivery into success or failure. An approved unresolved exception forces
`repaired_with_exceptions` and a signed report. The special containment entry point
expires only after a permitted terminal outcome, while retained provenance follows a
declared audit/security retention schedule and later incidents use normal identity-
recovery and forward-repair procedures. Finalization or timeout never destroys lineage
needed to explain committed facts.

### 15.7 Wrongful-merge identity separation and reconstitution

This operation exists only after containment finds that a merge joined, or cannot
safely exclude having joined, two different people. It is not merge cancellation,
ordinary unlink, identity recovery, or tenant governance recovery. The merged resolver
stays fail-closed from the initial containment commit: every source/canonical login,
slot, session, personal credential, delegated token, cache, and stream is revoked, and
no login may resolve both claimants to one active human while review continues.

The operation stores a unique idempotency key; merge id/generation; retained source,
canonical, and any replacement human ids; all starting human/login/security/alias/
private-owner/tenant-governance/billing revisions; claimant proof and deployment
authority ids; login disposition; personal-organization constraints; per-plane owner
decisions; notices, dispute and cooling deadlines; barrier/staging manifest digest;
revocation/outbox ids; and a separation fencing generation. Only one nonterminal
link/merge/recovery/separation operation may mention either claimant or resolver.

Authority is closed and deployment-scoped. Each person must give fresh operation-bound
proof tied to a pre-merge login, independently enrolled offline factor, or a completed
section 15.4 recovery path that is cryptographically/administratively tied to that
person's retained lineage. In addition, the configured identity-separation path must
receive its current quorum of distinct `active` deployment identity-recovery custodians
under one `enabled` plane revision—at least two when both claimants retain factors and
three plus independent incident/legal approval if either is factorless. Claimant proofs
are mandatory but count only as claimant proofs: neither claimant/merge source/target,
nor an organization owner/steward/quorum, governance custodian, billing authority,
support session, invitation, or email equality can substitute for a required deployment
custodian or scoped owner approval. If this authority or proof cannot be established,
containment remains; the system never guesses which person owns a binding.

| Current state | Event and precondition | Next state | Security behavior |
| --- | --- | --- | --- |
| absent | contained merge opens different-person incident under exact merge generation | `evidence_pending` | Snapshot revisions/lineage; notify both claimants and deployment security; merged resolver remains denied |
| `evidence_pending` | both claimant proofs and deployment quorum validate | `separation_review` | Build revision-bound alias/login/private/tenant/billing/effect manifest |
| `evidence_pending` | proof/authority expires, conflicts, or cannot be established | `contained_unresolved` | Consume operation generation; keep both claimants and every merged resolver path contained |
| `separation_review` | all deployment, login, private, tenant, billing, and irreversible decisions are complete | `cooling_off` | Install separation barrier; minimum seven-day cooling; send full non-secret notice set |
| `separation_review` | any required scoped decision is absent or ambiguous | `blocked` | Change no resolver or owner generation; keep containment |
| `blocked` | complete revised decisions and all starting revisions still match | `separation_review` | Rebuild and reapprove the entire manifest |
| `cooling_off` | dispute, notice failure required by policy, authority-plane change, or referenced revision change | `contained_unresolved` | Fence callbacks/workers; keep containment; a retry uses a new generation |
| `cooling_off` | deadline passes and every proof/authority/decision/revision revalidates | `ready` | Require final fresh claimant/custodian proofs |
| `ready` | exact generation claims alias, human, login, owner, tenant-summary, and session rows | `staging` | Freeze identity/login/private-owner/merge/transfer/delete/conversion prerequisites |
| `ready` | any final input is stale | `contained_unresolved` | Discard inactive staging; keep merged resolver denied |
| `staging` | next stable-key at-most-500-row/250-ms batch commits | `staging` | Record checkpoint/digest; no staged resolver or owner row authorizes |
| `staging` | complete digest and all barrier revisions match | `applying` | Enter short atomic generation cutover |
| `staging` | crash, timeout, or stale digest | `staging` or `contained_unresolved` | Retry exact checkpoint or discard inactive generation; no partial separation is visible |
| `applying` | resolver/login/human/owner generations, revocations, outbox, and audit commit with no quarantine/exception | `separated` | Two independently resolving human identities exist; neither receives an implicit tenant grant |
| `applying` | same atomic cutover commits with ambiguous private/external rows quarantined | `separated_with_quarantine` | Authentication is separated; named rows remain unavailable pending scoped decision |
| `applying` | same atomic cutover commits with irreversible deleted/converted/posted/external exceptions | `separated_with_irreversible_exceptions` | Authentication is separated; signed report records every exception and any quarantine |
| `applying` | crash or serialization failure before commit | `staging` | Revalidate exact digest; visible state remains contained and unsplit |

`separated`, `separated_with_quarantine`,
`separated_with_irreversible_exceptions`, and `contained_unresolved` are terminal for
that operation generation. `blocked` remains nonterminal but contained. A later attempt
from `contained_unresolved` uses a new idempotency key, repeats proof/notices/cooling,
and cannot inherit stale decisions.

Alias cutover never deletes history. The retained absorbed/source human id is
reactivated for one proved claimant whenever its id and integrity lineage remain
usable; a new human id is created only if the retained id is corrupt, legally erased,
or otherwise structurally unusable, and it receives an immutable `replacement_of`
edge. The old absorbed→canonical alias becomes a non-authorizing historical tombstone.
Two current resolver records then map independently to the reconstituted humans under
the new generation. Human and login statuses and their security generations change in
the cutover; stale aliases or old generations always deny.

Every login binding is freshly proved for one claimant and atomically reassigned, or is
quarantined with no authentication use. Provider callback, display label, and email
cannot decide. Before either person reauthenticates, cutover again revokes all source
and canonical browser/native slots, provider auth sessions, refresh families, personal
credentials and keys, offline/cache wrapping records, user-bound delegated tokens,
push registrations, and streams; only a later fresh proof creates a new-generation
slot. Tenant-owned service credentials remain tenant-owned.

Personal-organization uniqueness is recomputed per reconstituted human. An extant
personal organization and uniquely proved owner lineage may transfer to that claimant,
but a personal organization irreversibly converted to team or terminally deleted is
never recreated or changed back. A person may therefore finish with no personal
organization and use normal creation later if uniqueness/policy allow. Organization
merge remains unsupported.

Deployment identity authority decides only human, resolver, and login outcomes. Each
organization's current authorized human governance approves only its own memberships,
roles, owner/recovery-steward post-state, and human-bound tenant credentials; absence of
tenant approval leaves the prior contribution revoked/quarantined and never invents a
grant. Billing owners approve only compensating ledger/entitlement effects. Uniquely
lineage-attributable private state may transfer to the freshly proved claimant when any
tenant scope still authorizes it. Joint, conflicting, or ambiguous private state is
quarantined from both people; secrets are never copied or inferred. Tenant-owned data
never moves merely because the actor identity separates.

Notices are sent at incident open, proof, decision, cooling, cutover, and terminal
outcome to every safe pre-merge/current path and scoped security contact. A dispute
fences the worker and leaves containment. Barrier lock order matches merge and section
9.7 conversion; ordinary tenant data writes may continue under tenant authority, but
identity, login, private-owner, governance-assignment, billing-compensation, and
prerequisite mutations named by the manifest are fenced. External effects follow
section 15.8; unknown delivery cannot be republished and becomes quarantine or an
explicit irreversible exception without delaying the safety-critical resolver split.

### 15.8 External delivery reconciliation

Every merge-observation, repair, separation, conversion-prerequisite, notification,
webhook, provider, or other external effect uses one durable delivery record linked to
its owning operation/provenance row. A compensation is a new child effect with its own
delivery record and an append-only relation to the original; it never overwrites the
original state, receipt, failure, or ambiguity evidence. Before any publish attempt,
`prepared` stores a stable effect/idempotency key, canonical request digest,
destination/owner scope, provider capability snapshot and version, whether idempotent
publish and status query are supported, compensation capability, attempt limit, and
authority revisions. A retry may never alter key, digest, destination, scope, or
capability snapshot.

| Current state | Event and precondition | Next state | Durable behavior |
| --- | --- | --- | --- |
| `prepared` | exact worker atomically claims the one permitted publish under current owner/provider revisions | `publish_claimed` | Commit claim/attempt before network I/O; no other worker may publish |
| `publish_claimed` | provider returns a verified acceptance/result receipt | `receipt_confirmed` | Append provider receipt digest/id and observed time; never republish |
| `publish_claimed` | provider definitively proves rejection before accepting the effect | `failed_confirmed` | Append failure proof; no effect compensation is assumed necessary |
| `publish_claimed` | process/network crashes or response is ambiguous after claim | `delivery_unknown` | Record ambiguity boundary; never infer success/failure or blindly republish |
| `delivery_unknown` | provider supports status query and bounded reconciler claims current generation | `reconciling` | Query by exact provider effect/idempotency key; do not send effect payload |
| `reconciling` | status query proves accepted/result | `receipt_confirmed` | Append queried receipt/proof |
| `reconciling` | status query proves definitive pre-accept failure | `failed_confirmed` | Append provider status proof |
| `reconciling` | status remains unknown/transient | `delivery_unknown` | Schedule bounded exponential backoff with jitter and an absolute review deadline |
| `delivery_unknown` | provider is idempotent but non-queryable and policy authorizes exact-key retry | `publish_claimed` | Reuse identical key/digest under a new fenced attempt number; capability/version change blocks retry |
| original `delivery_unknown` or `receipt_confirmed` | owning subsystem plus scoped tenant/billing authority approve a separate compensating effect | original unchanged; relation `compensation_pending`, child `prepared` | Store a new child key/digest/capability snapshot and append-only relation before any child publish |
| relation `compensation_pending` | child follows the same claim-before-I/O machine and reaches `receipt_confirmed` | relation `compensated`; child remains `receipt_confirmed` | Append aggregate compensation outcome while preserving both delivery histories; no inverse-history claim |
| relation `compensation_pending` | child is `publish_claimed`, `delivery_unknown`, `reconciling`, or `failed_confirmed` | `compensation_pending` | Preserve original and child evidence; unknown child reconciles normally and a definitively failed child does not classify the original as compensated |
| `delivery_unknown` | scoped authorities approve an unresolved, non-compensatable fact after investigation | `irreversible_exception_approved` | Store signed incident, approvers, expiry/current revisions, and user-visible exception; never label delivery success |

An original effect is terminal-acceptable for merge finalization only when it is
`receipt_confirmed`, `failed_confirmed`, or `irreversible_exception_approved`, or its
linked compensation relation is `compensated`. `prepared` is safely claimable, but any
original or child `publish_claimed`, `delivery_unknown`, or `reconciling`, and any
`compensation_pending` relation, blocks ordinary finalization. A definitive local
failure counts as `failed_confirmed` only when evidence proves that exact effect could
not have been accepted; a failed compensation child does not resolve an unknown
original.

Provider idempotency is mandatory when supported, and every retry reuses the exact key
and digest. After an ambiguous crash, status query is preferred and must run before an
idempotent retry when available. For a provider that is neither queryable nor
idempotent, the committed claim is at-most-once: exactly one publish attempt is allowed;
a missing receipt remains `delivery_unknown` until compensation or explicitly approved
irreversible exception. It is never automatically retried. A capability/version change
after `prepared` requires reviewed reconciliation and cannot silently reinterpret the
old record.

Compensation and exception authority is scoped. The owning subsystem proves technical
support, the exact tenant authority approves tenant effects, and the billing authority
approves ledger/payment effects; deployment identity authority cannot decide those
planes. Approvals expire on referenced revision changes. Reconciliation is bounded in
rate and duration but not converted to success by timeout. The 30-day merge deadline
therefore selects `finalization_blocked` while any record is unresolved; a durable
irreversible exception permits only `repaired_with_exceptions` with a signed report.

Crash tests stop immediately before/after intent commit, publish claim, network send,
provider acceptance, receipt append, status query/result append, compensation claim,
and compensation receipt. Duplicate/reordered workers, provider timeout, response loss,
capability-version change, and database failure must prove at most one non-idempotent
publish, exact-key idempotent retry only, no blind republish, and a truthful terminal or
blocked state.

## 16. Complete tenant and actor data-plane authority

Every persistent or derived datum declares exactly one canonical authority plane.
“Tag then filter” is never an authorization boundary.

| Plane/resource | Canonical owner and namespace | Non-forgeable enforcement | Revocation/deletion and required negative test |
| --- | --- | --- | --- |
| Workspace database rows | `(organization_id, workspace_id)` | Composite FK plus FORCE RLS `USING`/`WITH CHECK` under transaction-local verified context | Revision invalidation; two-tenant CRUD with equal-shaped ids |
| Organization governance rows | `organization_id` plus actor/target ids | Organization RLS or narrow security-definer function after capability check; no null/global tenant visibility | Membership/status revision; cross-org list/mutate denial |
| Human/login/session/identity-recovery rows | human, login account, session-set, or deployment recovery operation id as declared; never organization-derived | No direct app-role table access. A narrow function derives human/login from an opaque authenticated slot/session capability and current revision. Deployment recovery functions require the enabled identity-plane generation and independently active custodian capabilities; they cannot accept an organization role as authority | Login/human/plane revision; actor A cannot enumerate actor B; organization-A steward cannot invoke global recovery or affect B/personal state; degraded/lost-quorum paths deny |
| Organization recovery rows | exact `organization_id`, governance revision, target active human, and scoped operation generation | Organization mutation function derives authority from active human steward membership or separate enabled deployment organization-governance-custody plane/capability; its SQL surface cannot address human/login tables or another organization | Org/plane revision and org-only invalidation; cross-org/global-human equality and degraded-plane denial tests |
| Merge/separation barrier, resolver generation, manifest, and write lineage | operation/generation, source/canonical/reconstituted human ids, exact object owner plane/id and tenant pair, actor source lineage | Owner/governance writes check active barrier; resolver reads accept only current non-tombstoned generation; observation writes append provenance transactionally | Missing provenance denies; containment never resolves two people to one active human; separation cannot invent tenant/billing grants or rewrite audit facts |
| Personal-to-team conversion | exact organization id, kind/governance/billing revisions, owner proof, custody and barrier generation | Narrow conversion function locks one organization and activates human team custody plus selected billing outcome atomically; ordinary workspace writes retain unchanged tenant pair | Delete/transfer/merge-prerequisite races serialize; collaborator grants stay workspace-only; organization merge request denies |
| External delivery records | stable effect key/digest, provider capability version, exact owning subsystem and tenant/billing scope | Claim commits before publish; query/idempotent retry uses exact key; non-queryable/non-idempotent delivery is at-most-once; scoped functions alone approve compensation/exception | Crash cannot blind-republish; unknown remains visible and blocks ordinary merge finalization |
| Object data and signed uploads | owner tuple plus immutable `(organization_id, workspace_id)` prefix | Server constructs key and signed capability after grant check; object key/scope from callback is ignored | Revoke signer, expire URL, reap owner prefix; cross-prefix GET/PUT/copy denial |
| NATS/events/streams | exact tenant pair and optional actor/revision | Broker JWT publish/subscribe allow-list minted server-side; API rechecks grant before subscribe and payload dispatch | Revoke JWT/consumer and close ≤5 s; cross-tenant wildcard publish/subscribe denial |
| Search/index/vector data | tenant pair on document and index partition | Service capability fixes namespace; authorization prefilter plus result-time grant check. ACL tags are defense in depth only | Delete/tombstone index entries; query with forged/missing ACL tag returns nothing |
| Caches/idempotency/materialized views | plane + canonical owner tuple + security revision | Server-derived key; no caller-supplied tenant prefix; values carry owner tuple and revision | Revision makes stale entry unusable before async purge; collision tests across tenants/actors |
| Logs/traces/metrics/analytics | pseudonymous tenant/actor scope and data classification | Telemetry sink credentials are not product credentials; tenant dashboards query an authorized projection, never raw labels | Policy retention/redaction; no secrets/content; equal labels cannot join tenants |
| Jobs/workflows/outbox | owner tuple, authority mode, enqueue revision, fencing generation | Enqueue and claim both authorize; worker loads scope from durable row, not payload/callback | Revoked user-bound job fails; org-autonomous job follows explicit exception; forged claim denied |
| Callbacks and inbound webhooks | opaque handle resolving to durable owner tuple and expected state | Signature/nonce/replay check then server lookup; callback tenant ids are ignored | Consume/revoke handle; replay, wrong destination, and cross-tenant delivery denied |
| Outbound webhooks/integrations | typed human/organization/workspace connection plus destination | Secret decrypted only after owner grant; payload projection is owner-scoped; redirect is not followed across allow-list | Disable/revoke and erase secret by policy; retry cannot change owner or URL scope |
| Provider/model connections | typed owner and, when usable for work, exact tenant pair | Provider credential resolver accepts typed ids only after workspace/billing policy; login ids are rejected | Human removal affects personal connections only; cross-owner selection and log leakage denied |
| Actor-private drafts/pins/keys/uploads | section 17 typed owner plus tenant pair where applicable | Actor capability/RLS and server-side owner derivation | Human/login/slot switch matrix and legacy-subject migration tests |

Support and operators have no wildcard through the ordinary app role. Break-glass uses a
separate role, incident/ticket id, approved scope, short expiry, read/write purpose, and
append-only audit. It cannot retrieve auth/provider secret values. Cross-tenant batch
jobs use a separate migration/operator role, enumerate their scope, and never reuse a
tenant request connection.

Every new storage, bus, cache, search, observability, webhook, or background subsystem
must add a row to this matrix and pass: tenant A cannot read/write/subscribe/copy/search
tenant B; actor A cannot inspect actor B's global/private state; a missing owner context
fails; and revocation/deletion behaves as declared.

## 17. Canonical ownership of subject-private state

Human-owned state follows the person across linked login accounts. Authentication
secrets and slot-local caches do not.

| State | Canonical durable owner | Same-human account switch | Additional scope |
| --- | --- | --- | --- |
| Composer/new-session drafts and pins | human identity | Available only after fresh server fetch; never copied between slots | Exact organization/workspace; session id where attached |
| Personal integration/provider connection | human identity | Available when its explicit tenant policy permits | Optional exact organization/workspace; secret stays server-side |
| Organization/workspace connection | typed organization/workspace owner | Account-independent; requires current human grant | Exact owner pair and entitlement policy |
| Login/auth provider token | login account | Never shared | Authentication adapter only |
| Personal API/credential key | human identity | Not exposed; authority may continue if policy permits | Explicit tenant grants and human revision |
| Organization service key | organization/workspace | Unchanged by account switch or human removal | Explicit service grant/revision |
| Unattached upload | human identity plus tenant pair | Can be rediscovered after fresh authorization; handle is not reused from cache | Immutable organization/workspace and draft/session binding |
| Attached file/resource | workspace | Normal workspace access | Composite tenant pair |
| Server preferences/recent items | human identity, with tenant pair where relevant | Freshly reloaded | No cross-human fallback |
| Browser/native cache, push registration | session slot/device installation | Never reused, even if next slot resolves to same human | Human/login/tenant/revision embedded and checked |

Legacy `user:<BetterAuthUserId>` rows are augmented only through an unambiguous
login-account-to-human binding. Canonical and legacy owner are synchronously dual-written
until cleanup. If two legacy subjects later resolve to the same human, rows keep source
provenance and stable ids; deterministic duplicate rules choose display/order, never
drop content. Ambiguous/missing mappings are quarantined and hidden from v2 rather than
assigned by email. A same-human switch may fetch human-owned state from the server after
the new epoch, but cannot reuse the previous slot's memory cache, upload handle,
decrypted connection, or in-flight response.

Identity merge does not erase these source-owner mappings. The apply manifest links each
source row to one derived generation, and section 15.6 records every observation-window
write with source/actor/tenant lineage. Forward repair may transfer only uniquely proved
human-private ownership. Tenant-owned rows stay with their organization/workspace;
ambiguous private state is quarantined rather than copied or guessed.

Wrongful-merge separation follows section 15.7: a uniquely attributable row may move
to one freshly proved reconstituted human under a new owner generation, while joint or
ambiguous rows stay quarantined from both. The historical merge alias and old owner
mapping remain immutable lineage, not an authorization fallback.

## 18. Append-only, scoped, tamper-evident audit

Audit events are written through a narrow `append_audit_event` database function owned
by a dedicated no-login audit owner. The function derives actor/scope from the verified
transaction/session capability, checks a closed action schema, and does not accept a
caller-selected human or tenant as authority. The runtime app role may execute that
function but has no direct `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, trigger-disable,
sequence-owner, or partition-owner privilege on audit storage. An append-deny trigger is
defense in depth; deployment verification checks actual grants. Migration and compliance
roles are separate from both app and audit writer.

Each event has one scope kind:

- `actor` — visible only to the affected human through a sanitized self-history;
- `deployment_identity` — human/login recovery, identity merge/separation, deployment
  authority-plane/custodian lifecycle, and the deployment component of organization-
  governance-custody evidence visible only to the affected
  human through a sanitized view and to the dedicated deployment security role; never
  to an organization merely because the human is its member (the named organization
  also receives its separately scoped governance event);
- `organization` — visible to authorized organization auditors;
- `workspace` — exact organization/workspace pair and authorized workspace auditor;
- `operator` — platform incident/privileged activity, never tenant-visible by a null
  tenant predicate; or
- `public_integrity` — non-sensitive chain checkpoints only.

`organization_id IS NULL` never means visible to every tenant. RLS/policy functions
match the declared scope and verified actor/tenant; only the separate operator role can
read operator events. Security mutations append audit in the same database transaction
as the governed change. Failed attempts that have no domain transaction append through
a bounded independent security-event path with request/idempotency correlation.

Within each scope shard, a locked chain head allocates a monotonic sequence. The event
hash covers canonical encoded immutable core fields, encrypted-payload digest, prior
hash, scope, sequence, policy version, and key id. Sensitive optional payload is a
separate encrypted envelope referenced by that digest. A deployment signing service
periodically signs chain heads and exports them to retention-locked/WORM-capable storage
outside the database role boundary. Key rotation starts a linked segment; verification
uses retained public keys. Database hash chaining detects ordinary corruption; external
signed heads make privileged rewrite/truncation detectable. Export includes events,
segment links, signed heads, and a verifier manifest.

Retention is class- and jurisdiction-policy driven, not “forever” or ordinary tenant
cascade. Governance enablement requires an explicit versioned schedule for security,
billing, operator, and routine events plus backup expiry. Core events use a pseudonymous
actor reference from creation and are never rewritten during normal deletion. Normal
deletion destroys the separately scoped identity map and/or encrypted-payload key while
retaining immutable sequence/hash/digest evidence. A legally required hard erasure of a
core event is executed only by a separately approved compliance job: it first records a
signed erasure certificate and range commitment in the external chain, then removes the
specified core/payload material and never makes the remaining chain appear intact when
it is not. Legal hold overrides scheduled erasure only through audited compliance
authority.

Acceptance must prove the runtime app cannot update/delete/truncate audit rows, tenant
and actor scope isolation, concurrent sequence ordering, transaction rollback behavior,
hash/export verification, key rotation, retention expiry, crypto-erasure, hard-erasure
certificate verification, and detection of row rewrite/removal/reordering.

## 19. Common session-set contract for browser and native devices

A **session set** is a host container for independently revocable login slots. Browser
sets are referenced by the HttpOnly cookie described above. Native sets are bound to a
registered installation and proof-of-possession public key; private keys and rotating
refresh material live only in the OS secure store (Keychain, Keystore, TPM-backed store
where available). Shared preferences, ordinary files, logs, clipboard, and embedded
WebView local storage are forbidden credential stores.

Each slot records session-set/installation id, login account, auth-session reference,
selected state, generation, expiry, last online revision, and status. Selection,
reauthentication, account-scoped logout, device-scoped logout, and all-device compromise
revocation have the same server semantics on every host. Native refresh tokens rotate
on every use; replay revokes the token family and slot. A device id is not a human or
tenant grant.

Native installation and slot transitions are durable and idempotent:

| Object/current state | Event and precondition | Next state | Effect |
| --- | --- | --- | --- |
| installation absent | server challenge + generated hardware/secure-store key | `registering` | Bind nonce, public key, app identity, expiry; no account/tenant grant |
| `registering` | proof-of-possession and app/callback verification pass | `active` | Create installation/session set generation 1 |
| `registering` | proof fails, expires, or is cancelled | terminal/absent | Consume challenge; store only rate-limit/audit evidence |
| `active` | old-key proof + server challenge rotates key | `active` | Increment installation generation and revoke prior key |
| `active` | risk signal requires step-up | `suspended` | Deny refresh, push fetch, and offline renewal |
| `suspended` | fresh account proof accepted | `active` | Increment generation; issue new rotating token family |
| `active` or `suspended` | device loss, admin revoke, key replay | `revoked` | Revoke all slots/families/push registrations/wrapping record |
| slot absent | isolated add-account operation begins | `proof_pending` | Bind issuer, installation generation, nonce/PKCE, callback |
| `proof_pending` | provider proof and server state pass | `active` | Attach independently revocable login slot/token family |
| `active` | auth assurance/session expires | `reauth_required` | Deny protected fetch/mutation/offline renewal |
| `reauth_required` | isolated reauthentication passes | `active` | Bump slot generation and rotate family |
| any nonterminal slot | logout, account revoke, family replay, installation revoke | `revoked` | Deny forever; a new slot receives a new id/generation |

`revoked` ids and keys are tombstoned and never rebound to another installation, login,
human, or push token. Retrying the same registration/add operation returns its durable
state; different inputs under the same key fail.

Native authorization uses PKCE and an exact claimed HTTPS universal/app link or an
explicit loopback/device-code flow. Callback state binds installation, slot operation,
issuer, redirect target, nonce, and expiry. Custom schemes are allowed only when the OS
provides verified app ownership; otherwise the device-code flow is required. A callback
cannot select a slot or tenant until the owning app resumes and verifies server state.

Local durable caches are encrypted, partitioned by installation + slot + human + exact
tenant pair, and fenced by slot and authorization revision. High-sensitivity data is
offline-disabled by default. Other offline data carries a server-signed
`offline_valid_until` no more than 24 hours after the last successful revision check.
The client also stores the highest signed server time and elapsed monotonic time in the
secure store; wall-clock rollback, reboot, or missing anti-rollback state cannot extend
the signed deadline. Deployments may shorten but not lengthen the bound. After local
expiry the client shows metadata-free reauthentication, not stale content. Device loss
revokes the installation, every slot/token family, local encryption-key wrapping record,
and push registrations. Remote wipe is best effort; secure storage, local expiry, and
server revocation are the guarantees.

Push registrations belong to one installation and slot, with allowed tenant scopes and
revision. Push payloads contain only opaque notification ids—no tenant name, content,
prompt, document title, email, or secret. The server rechecks the current grant before
enqueue and the client rechecks after fetch. Slot/account/device revocation deletes the
registration; a token observed under another owner is rejected rather than rebound.

Native switching runs the same dirty-work preflight and always creates a new identity
epoch. Tests cover secure-store absence, backup/restore to a different device, callback
hijack, refresh replay, offline expiry/clock rollback, device loss while offline,
per-slot/per-device/all-device logout, push token reuse, and two-account/two-tenant cache
isolation.

## 20. Enterprise federation is explicitly deferred

This revision does not claim SCIM, SAML organization federation, verified-domain
ownership, IdP group/role mapping, JIT enterprise membership, or organization-wide SSO
enforcement. Generic OIDC/SAML authentication may supply a stable issuer/subject login
account, but it supplies no organization membership, role, recovery authority, merge,
or billing ownership.

Accordingly:

- domain-claim, group, role, administrator, and email-domain inputs are ignored for
  authorization and rejected by governance mutation schemas;
- there is no domain claim/takeover/release UI or API and no “enterprise federation”
  feature advertisement;
- a new/recycled issuer or subject creates a distinct login binding and requires the
  normal explicit link/merge protocol; it never migrates by email;
- upstream deactivation revokes that login path and its sessions when the auth adapter
  reports it, but cannot silently delete organization membership or shared data; and
- configured/embedded hosts must call explicit membership APIs under their own audited
  service authority; injected group/domain claims are not grants.

Adding federation requires a separate reviewed ADR covering verified-domain lifecycle,
takeover/release, SSO enforcement and break-glass, SCIM/JIT authority, group mapping,
issuer/subject migration and recycling, deprovisioning deadlines, and session/token
revocation. Until then, unsupported federation configuration fails closed.

## 21. Secure local/self-hosted bootstrap and simplified mode

No-auth/single-user deployment never makes the first network caller an owner. Startup
creates or loads one installation id and one 256-bit single-use bootstrap secret in an
operator-controlled channel (service-owner-only `0600` file, local console, or
deployment secret manager). It is never written to normal logs or returned by an
unauthenticated remote endpoint. If authentication is absent and the API listens on any
non-loopback TCP interface, startup fails closed; an OS-local socket may be allowed only
with peer-credential verification.

The operator must also choose an explicit independent mode for each section 15.4.1
deployment authority plane during secure configuration: provision an offline root and
enter `enrollment_pending`, or record `disabled_unavailable` with a reason and recovery
warning. A tenant bootstrap secret, first human, personal owner, ordinary support
identity, or one plane's root can never become the other plane's trust root. Root public
digests/policy revisions are committed before custodian enrollment; raw root material
stays offline and is not derived from the installation/bootstrap secret.

Canonical enablement proves every advertised path viable under its exact current root,
policy, eligibility age, and quorum, or records that path unavailable. In particular,
fewer than three configured eligible organization-governance custodians makes
exceptional locked-team unlock unavailable, and the UX/API must say so. A self-hosted
operator may intentionally run without either deployment-custodian path, but cannot be
shown a support/recovery promise for it; target-held self-recovery and organization-
scoped break-glass remain only if independently configured and viable.

Bootstrap claim requires either an authenticated configured human issuer/subject or a
loopback/OS-bound local-human proof plus the secret. Its durable transition is:

| Current state | Event and precondition | Next state | Effect |
| --- | --- | --- | --- |
| `unclaimed` | valid secret + proved human + unique idempotency key | `recovery_ack_pending` | One serializable transaction creates the identity/tenant rows and encrypted one-time recovery-factor envelope |
| `unclaimed` | different concurrent claimant loses row lock | `unclaimed` | Deny generically and audit; winner alone commits |
| `recovery_ack_pending` | same human, secret, and idempotency key retry | `recovery_ack_pending` | Return exact ids and the same decryptable one-time envelope; create nothing |
| `recovery_ack_pending` | proved display/storage of recovery factor | `complete` | Verify factor, destroy delivery envelope/bootstrap verifier, append audit |
| `recovery_ack_pending` | different claimant/input or expired claim session | unchanged/blocked | Deny; only section 15.4 deployment identity recovery may rotate the pending factor |
| `complete` | any bootstrap retry | `complete` | Return already-configured state only after normal authentication; never reveal factor |

The claim transaction creates: human identity, login/external binding, personal
organization, primary workspace, owner organization/workspace memberships,
organization recovery-steward capability, offline identity-recovery factor hash,
bootstrap operation, and append-only audit event. The raw factor exists only in an
envelope encrypted from the bootstrap secret,
installation id, and proved-human context; it is never logged or stored plaintext.
High-risk governance and collaboration remain disabled until acknowledgment. A unique
installation key and idempotency key make crash/retry by the same proved human converge
to the exact existing ids and envelope. A concurrent/different claimant, unknown
principal, or non-human principal is denied and audited. After acknowledgment, the
secret/verifier cannot be regenerated without the section 15.4 deployment identity
recovery procedure proving installation/target authority and preserving existing tenant
ids.

Single-user policy may let owner and organization recovery steward be the same human
only with a separately enrolled organization break-glass factor, while human/login
recovery uses a distinct offline identity factor. Service principals and an
unclassified `local`/`unknown` subject become neither owner nor either recovery
authority. Losing both login and offline identity factor follows section 15.4's
factorless deployment path when explicitly enabled, otherwise fails closed; it never
creates a second personal organization.

Bootstrap does not enroll the first human as a deployment identity-recovery or
organization-governance custodian. Either role follows its plane-local offline-root,
factor, cooling, eligibility-age, and separation-of-duty ceremony after bootstrap. If
one person is later enrolled independently in both, their factors, revisions,
approvals, and authority remain non-interchangeable.

A `single_user_simplified` capability is presentation policy, not a weaker data model.
It is available only when collaboration is disabled and exactly one active human, one
login slot, one personal organization, and one workspace exist. The shell may show only
the workspace label and put account/organization details in accessible settings; it may
hide invite/people/switch actions. All tenant ids, composite keys, FORCE RLS, audit,
revisions, owner/steward checks, deployment identity-recovery separation, and typed
credentials remain active.

Enabling collaboration is a step-up, audited transition that verifies recovery,
disables simplified capability, exposes normal governance UI, and only then permits
invitations/additional humans. It does not migrate or weaken existing data. Tests cover
first-claim races, crash after every write boundary, restart idempotency, stolen/expired
secret, remote-listener refusal, unknown/non-human subject rejection, recovery-secret
rotation, each authority-plane mode and root/custodian lifecycle, fewer-than-three
governance-custodian unavailability, lost-root fail-closed behavior, and simplified-to-
collaborative transition with unchanged ids and isolation.
