<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# ADR: human identity, login accounts, organizations, and workspace tenancy

Status: **proposed; not approved for implementation**

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
3. **Organization** — the administrative, membership, recovery, and default billing
   container.
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

## 3. Canonical vocabulary

| Concept | Meaning | Must never mean |
| --- | --- | --- |
| Human identity | Stable person or recovery subject inside a deployment | A cookie, email address, provider token, organization, or Codex account |
| Login account | One `(issuer, provider subject)` authentication binding for a human | A model/provider credential, billing customer, organization, or workspace |
| Browser login slot | Revocable association between one browser session and one login account | A tenant grant |
| Organization | Administrative and membership container; physical id is the legacy `managed_accounts.id` | Authentication identity or resource isolation by itself |
| Organization membership | A human's standing and organization-level capabilities | Automatic read access to every workspace |
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
  contents. Content access always requires a workspace grant or a separately audited
  recovery path.

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
- **recovery admin** — approved account/organization recovery actions.

An owner may receive all capabilities by policy, but implementations still persist and
check the capabilities so self-hosted deployments can separate duties. Recovery does not
implicitly grant workspace-content access. Billing does not imply recovery or member
management.

Only an active human membership can count toward last-owner, last-administrator, or
recovery quorum. API keys, delegated worker tokens, service principals, and unknown
external subjects never satisfy a human-governance invariant.

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

| Operation | Owner | Admin | Member | Billing admin | Recovery admin |
| --- | --- | --- | --- | --- | --- |
| Read organization metadata | yes | yes | yes | only as needed | only as needed |
| Create workspace | policy default yes | delegated | no by default | no | no |
| Read workspace content | explicit workspace grant | explicit workspace grant | explicit workspace grant | no | no |
| Invite ordinary member | yes | delegated | no | no | no |
| Grant owner/recovery role | step-up + policy | no | no | no | recovery policy only |
| Manage billing | policy default | no by default | no | yes | no |
| Transfer ownership | yes, step-up | no | no | no | recovery ceremony only |
| Delete organization | yes, step-up + delay | no | no | no | recovery ceremony only |

Deployments may attenuate defaults but may not let a lower role grant authority it does
not hold.

### 5.2 Last-human-governance invariant

Every active team organization with resources, billing state, active invitations, or a
nonterminal deletion must retain:

- at least one active human owner; and
- at least one active human with recovery authority, which may be the same person only
  when deployment policy permits single-person recovery.

The invariant is enforced under a transaction lock for remove, leave, demote, suspend,
unlink-last-login, transfer, and delete operations. “Count then update” without locking
is forbidden. A deferred constraint alone is insufficient because identity/login status
also participates.

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

- Switching a login slot changes the human actor, then recomputes organization and
  workspace grants. It never carries cached grants from the old actor.
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
3. Require step-up authentication for owner, billing-admin, or recovery-admin grants.
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

The recipient must be an active human member with a verified login/recovery path.
Transfer locks both memberships and the organization, requires step-up authentication,
updates roles/capabilities and recovery state atomically, and records old/new owners.
The former owner remains with an explicit selected role; no implicit access is retained.

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

### 9.6 Human identity or login-account deletion

Deleting a login account unlinks one authentication path. Deleting a human identity is
a separate privacy/recovery operation that first transfers or deletes personal assets,
resolves every organization role, revokes all login sessions and personal credentials,
and preserves minimally necessary pseudonymous audit/billing records under policy.

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

### 11.2 SDK and CLI

- SDK clients select organization/workspace explicitly; they never derive tenancy from
  an email, provider account, or model credential.
- Browser SDKs use the host session broker; server SDKs use an explicit credential and
  actor context. No SDK stores raw multi-account tokens in local storage.
- CLI account profiles live in OS credential storage, display issuer + account label,
  and require explicit organization/workspace selection when ambiguous.
- `--organization`/`organizationId` is an administrative selector; `--workspace` remains
  the resource selector and must belong to that organization.

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

## 14. Implementation approval criteria

Schema/API work may begin only after an exact-head independent review approves this ADR
and the companion threat model. Later implementation is acceptable only when it proves:

- no automatic email identity linking;
- multiple isolated login slots and per-slot sign-out;
- persisted organization membership plus explicit workspace grants;
- human-only last-owner/recovery concurrency enforcement;
- single-use invitations and step-up for sensitive roles;
- synchronous grant invalidation plus bounded stream/token invalidation;
- typed billing ownership independent of login/model credentials;
- legacy `accountId` equality and old-binary safety;
- real PostgreSQL composite-FK and FORCE-RLS cross-tenant isolation; and
- the responsive, accessible, draft-safe switching contract.