<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# Organizations and identity threat model

Status: **proposed; independent review required before schema changes**

Companion decision: [`tenancy-identity-adr.md`](tenancy-identity-adr.md)

## 1. Scope and security objective

This model covers human identities, login accounts, browser login slots,
organizations, workspace memberships, invitations, recovery, switching, billing-owner
selection, audit, and authorization invalidation.

It does not redesign model-provider credentials, Codex allocation, capability policy,
attachment storage, or runtime DB-role provisioning. Those systems are in scope only at
their identity/tenancy interface.

Primary objective:

> A principal authenticated through one login account can learn about or act on only
> the organizations and workspaces authorized for its resolved human identity or
> explicit service grant, and no account/organization/workspace switch can reuse the
> prior actor's credentials, cached grants, drafts, uploads, streams, or provider state.

## 2. Assets

- Authentication sessions, password/reset state, upstream identity-provider tokens.
- Human-to-login-account bindings and recovery authority.
- Organization membership, roles, invitations, and billing-owner selection.
- Workspace resources, sessions, drafts, uploads, secrets, provider connections, and
  usage/billing records.
- API keys, delegated tokens, service principals, browser slots, SSE/NATS subscriptions.
- Audit evidence, export archives, deletion tombstones, and idempotency records.
- Tenant identifiers and even the existence/name of inaccessible organizations.

## 3. Trust boundaries

1. **Browser ↔ API:** cookies, CSRF, selected login slot, deep-link return state, XSS.
2. **Authentication adapter ↔ identity domain:** issuer/subject claims, assurance,
   account linking, session revocation.
3. **API/core ↔ Postgres:** authorization before query, transaction-local GUCs,
   composite foreign keys, FORCE RLS.
4. **Human actor ↔ durable workload:** delegated tokens, session control, background
   continuation after human access changes.
5. **Organization ↔ workspace:** administrative metadata versus resource content.
6. **Workspace ↔ workspace:** primary cross-tenant isolation boundary.
7. **OpenGeni ↔ embedded host:** external subject resolution, invitation delivery,
   cookie/session adapter, billing-owner policy.
8. **OpenGeni ↔ billing/identity/model providers:** identifiers from different domains
   that must not be confused.
9. **Export/delete worker ↔ object/database storage:** delayed destructive operations
   and tenant-scoped artifacts.

## 4. Attacker model

Assume:

- an ordinary member attempts horizontal or vertical privilege escalation;
- a malicious invite recipient replays, races, forwards, or alters an invitation;
- one login account is compromised while another account is active in the same browser;
- a browser has XSS-capable untrusted content or a malicious extension;
- requests and callbacks are reordered, duplicated, or retried across tabs/devices;
- an old API/worker binary runs during an additive migration;
- an embedded host is buggy but not intentionally granted database superuser access;
- stale processes retain prior access contexts, streams, or delegated tokens;
- a database row contains mismatched organization/workspace ids due to a programming
  error; and
- support/operator mistakes occur during transfer, deletion, export, or recovery.

Database superuser, host root, and malicious code executing with the environment's
master encryption keys are outside tenant-isolation guarantees, but their access must
remain operationally restricted and auditable.

## 5. Non-negotiable security invariants

1. **Identity is not email.** No automatic merge/link on email equality.
2. **Authentication is not authorization.** A valid login slot gives no tenant access
   without an active organization/workspace grant.
3. **Login account is not provider credential.** Auth issuer/subject, billing owner, and
   model-provider credential identifiers are type-distinct.
4. **Workspace remains the resource boundary.** Every resource query uses the exact
   organization/workspace pair under FORCE RLS.
5. **No ambient cross-account grants.** A selected browser slot, actor epoch, and access
   context change together.
6. **Only humans govern humans.** Non-human credentials never satisfy owner/admin or
   recovery quorum.
7. **Sensitive changes are locked and atomic.** Last-owner, transfer, invitation
   acceptance, and revocation cannot use an unlocked check-then-write sequence.
8. **Secrets are not observability.** Tokens, invitation secrets, cookies, reset links,
   and credential values never enter responses, events, logs, traces, screenshots, or
   audit metadata.
9. **Revocation has bounded propagation.** New requests fail synchronously after commit;
   persistent channels and user-bound delegated tokens are revision-fenced.
10. **Old binaries cannot weaken isolation.** Additive migration and compatibility
    fields preserve the existing workspace/RLS boundary.

## 6. Threats and required controls

### T1. Automatic identity linking enables account takeover

**Attack:** An attacker controls a recycled/aliased email or compromises one provider
and becomes linked to a victim's human identity.

**Controls:**

- Unique login binding is `(issuer, provider subject)`, never email.
- Email is a verified claim used only for invitation matching/display.
- Linking requires proof of both active login accounts or a recovery-admin ceremony.
- Linking, unlinking, merge, and recovery require step-up authentication, idempotency,
  security notification, and audit.
- A merge preview enumerates affected organizations/roles without exposing secrets.
- There is no “helpful” sign-in-time email merge fallback.

### T2. Ambient cookie or callback overwrites another active account

**Attack:** Adding account B replaces account A's cookie, or a callback binds B to A's
active tenant context. Later requests act with mixed identity and cached grants.

**Controls:**

- One opaque host-only browser-session cookie references server-side slots.
- Add-account uses a one-time state transaction, exact return origin, short expiry,
  issuer binding, PKCE where applicable, and a transaction-specific callback path.
- Callback completion adds only the expected slot; tenant selection is recomputed.
- Slot ids are unguessable and accepted only when attached to the same browser session.
- All client requests/subscriptions carry an identity epoch; stale responses are
  discarded after a switch.
- Cookies are `Secure` in HTTPS deployments, HttpOnly, appropriately SameSite, scoped
  to the narrowest host/path, and never mirrored to local storage.
- Cross-subdomain cookies require explicit host policy and dedicated tests.

### T3. CSRF changes active account, membership, billing, or deletion state

**Attack:** Another origin submits a cookie-authenticated mutation.

**Controls:**

- Origin/trusted-origin verification plus anti-CSRF token for every cookie-authenticated
  mutation, including active-slot switch and sign-out.
- No high-risk mutation over GET.
- Step-up challenge for ownership, recovery, sensitive role, export, and deletion.
- SameSite is defense in depth, not the only CSRF control.

### T4. Tenant-id confusion or IDOR crosses organizations/workspaces

**Attack:** A caller supplies organization A with workspace B, guesses a UUID, changes a
query parameter, or relies on an object id without workspace authorization.

**Controls:**

- Workspace route authorization occurs before data lookup.
- The account/organization id is taken from the verified grant/workspace, not trusted
  request metadata.
- If both legacy `accountId` and `organizationId` appear, unequal values are rejected.
- Composite `(workspace_id, organization_id)` foreign keys exist on every resource row.
- FORCE RLS uses both exact GUC values in `USING` and `WITH CHECK`.
- API not-found/forbidden behavior does not reveal inaccessible resource existence.
- Static route guards and real-Postgres negative tests cover every new endpoint/table.

### T5. Missing, stale, or leaked RLS context

**Attack:** A pooled connection retains another workspace GUC, a helper skips the
transaction wrapper, or a migration creates an unprotected table.

**Controls:**

- GUCs are transaction-local and set from an already verified workspace pair.
- Empty/invalid organization ids fail loudly before SQL.
- App role is non-owner/non-superuser/non-`BYPASSRLS` in verification.
- Every new workspace table has `ENABLE` + `FORCE`, `USING` + `WITH CHECK`, composite
  foreign keys, app-role grants, and schema-aware policy guards.
- Migration and test tooling enumerate protected tables; a missing policy is a failure.
- Cross-tenant reads/writes are tested on two organizations with equal-shaped data.
- Organization-scoped tables use an organization-only policy and cannot be queried under
  a different organization GUC.

### T6. Invitation enumeration, replay, forwarding, or escalation

**Attack:** An attacker discovers organization membership, reuses an accepted link,
forwards it to another identity, races cancel/accept, or edits the requested role.

**Controls:**

- Store only a strong random token hash; compare in constant time.
- Generic pre-auth responses and rate limits prevent target/org enumeration.
- Invitation payload is server-side and immutable; role/capabilities are never accepted
  from the callback client.
- Expiry, cancellation, organization status, target claim, and inviter delegability are
  rechecked under row lock at acceptance.
- Consumption and membership grant commit atomically with one winner.
- Sensitive roles require step-up and may require second approval by policy.
- Resend rotates the secret; revoke invalidates all outstanding delivery links.

### T7. Concurrent leave/demote/remove creates an ownerless organization

**Attack:** Two owners remove/demote each other concurrently; an API key is counted as
the remaining administrator.

**Controls:**

- Lock the organization governance row and affected memberships in a deterministic
  order.
- Evaluate the post-change set of active human identities, including usable recovery
  paths, inside the transaction.
- Non-human principals are excluded by type, not name prefix alone.
- Database constraints/indexes enforce personal-owner uniqueness where possible; a
  serialized domain transaction enforces cross-table liveness.
- Concurrency tests run simultaneous leave/demote/remove/transfer operations and prove
  one safe winner or safe conflict.

### T8. Revoked member retains cached, streaming, token, or tab access

**Attack:** A removed user continues through a cached `AccessContext`, SSE/WebSocket,
delegated user token, old browser tab, queued request, or stale React query.

**Controls and target guarantees:**

- Revocation transaction marks membership inactive, increments authorization revision,
  removes personal workspace state as policy requires, appends audit, and writes a
  durable invalidation outbox event.
- Any new HTTP/MCP mutation or read beginning after commit re-resolves/revision-checks
  the grant and fails.
- Persistent user-facing streams subscribe to invalidation and revalidate on heartbeat;
  they close within **5 seconds** of committed revocation.
- User-bound delegated tokens carry identity/membership revision and are checked at
  every API/tool boundary; a later call fails even if token expiry is in the future.
- Browser clients increment an identity epoch, abort old fetches, close old streams, and
  discard responses from the previous epoch.
- Membership removal does not implicitly validate or invalidate independent
  organization-owned API keys. Personal/user-owned credentials are explicitly revoked
  in the same operation.
- Tests use two tabs plus a live stream and assert no post-revocation resource payload.

**Durable workload exception:** A model/provider call already admitted under workspace
workload authority may not be recallable. Human revocation removes that person's
view/control/tool authority; it does not silently kill organization-owned autonomous
work. Any requested workspace pause/cancel is a separate explicit, audited control
operation. Results still persist only under workspace RLS.

### T9. Global logout or password reset affects the wrong account

**Attack:** Signing out one active account destroys all slots, or reset of A leaves A's
other sessions live while revoking B.

**Controls:**

- Slot and login-account ids are explicit in revocation APIs and audit.
- “This account,” “this device,” and “all accounts/devices” are separate confirmations.
- Password reset and compromise bump only the affected login-account/identity revision,
  then revoke all of its slots across browser session sets.
- If the selected slot disappears, the client shows an actor-change interstitial before
  selecting another slot when dirty work exists.

### T10. Privilege escalation through role presets or custom permissions

**Attack:** An admin grants owner/recovery/billing permissions they do not possess, or an
unknown role string maps to broad permissions.

**Controls:**

- Role labels are presets; enforced permissions are validated enums/capability records.
- Delegation is subset-checked against actor authority plus non-delegable policy.
- Owner/recovery grants require a dedicated endpoint and step-up, not generic member
  patch.
- Unknown roles grant nothing and fail validation on mutation.
- Before/after authority is audited without secrets.

### T11. Billing is charged to a login/model account by confused identity

**Attack:** Switching login accounts or Codex credentials changes the billed entity,
or a caller supplies a provider-account id as an organization id.

**Controls:**

- Typed entitlement-owner ids are distinct from login and provider credential ids.
- Usage retains resource organization/workspace and resolved entitlement owner.
- Billing owner is derived server-side from policy and verified grants.
- Changing owner is idempotent, step-up/permission checked, and audited.
- Wire schemas reject wrong identifier types/relationships; labels are never keys.

### T12. Deep link leaks tenant existence or silently changes actor

**Attack:** A guessed link reveals an organization name; opening a link auto-switches to
another login account and discards a draft/upload.

**Controls:**

- Missing and inaccessible workspace responses use the same public unavailable state.
- Cross-slot access discovery returns only safe summaries to the already authenticated
  browser session; it never exposes raw membership/login details.
- Actor switch is explicit and passes the dirty-navigation preflight.
- Intended return path is server-signed, same-origin, allow-listed, short-lived, and
  single-use to prevent open redirect.
- Old tenant data remains hidden until switch commit and access revalidation.

### T13. Navigation loses a durable draft or strands an upload

**Attack:** Account/workspace switch resets composer state while save is pending, sends a
file to the prior workspace, or later attaches an old workspace file to a new message.

**Controls:**

- Switching preflight enumerates dirty local draft, unresolved remote draft save,
  uploading/failed attachments, and in-flight mutations.
- Stay is the safe default. Proceed requires saved/explicitly discarded draft and
  completed/cancelled uploads.
- Upload handles are immutable and carry organization/workspace ids; attachment at send
  revalidates both.
- Aborted/pending uploads are reaped by their owning subsystem; no file id is retagged
  across workspaces.
- The old identity epoch is fenced before new-route initialization.

### T14. Recovery bypasses least privilege

**Attack:** A recovery admin reads workspace content, installs a login account, or
transfers ownership without notice.

**Controls:**

- Recovery capability is separate from workspace read and billing.
- Recovery operations are narrowly enumerated, step-up authenticated, rate limited,
  require reason/incident id, and notify existing verified contacts.
- Break-glass content access, if a deployment supports it, is a separate time-limited
  grant with prominent audit/notification and cannot be implicit.
- Recovery never creates an email-based identity merge.

### T15. Export or deletion crosses tenants or erases evidence

**Attack:** Export job runs after actor revocation, archive URL is reusable, delete
partially cascades, or audit evidence disappears with the organization.

**Controls:**

- Export/delete jobs carry exact organization/workspace scope, idempotency key, actor,
  authorization revision, and fencing generation.
- Authorization and deletion state are rechecked when the worker claims and before it
  publishes an artifact or destructive batch.
- Archives use tenant-prefixed object keys, encryption, checksum, short-lived one-use
  download, and content allow/deny manifests.
- Delete is delayed, batched/resumable, and blocks conflicting writes. It never changes
  tenant ids on surviving rows.
- Minimal pseudonymous security/billing tombstones survive according to policy and are
  readable only by authorized operators.

### T16. Embedded host accidentally bypasses authorization or RLS

**Attack:** A host injects a user by email, reports a workspace without organization,
uses a table-owner connection, or treats host ACL tags as authorization.

**Controls:**

- Host adapter returns typed stable subject, principal kind, issuer, and assurance; email
  alone is insufficient.
- Direct core calls require the same access grant and workspace pair as HTTP routes.
- Production conformance uses a non-owner FORCE-RLS role even in a dedicated schema.
- Host policy may attenuate but not bypass composite-key/RLS invariants.
- Conformance suite covers managed and injected identity adapters.

## 7. Session and credential invalidation matrix

| Change | Browser slot | Auth session | Org/workspace grant cache | Persistent stream | User delegated token | Org API key | Running workload |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Switch active slot | retained, deselected | retained | new actor epoch | old closed | old user token rejected by actor/revision | unchanged | unchanged |
| Sign out one account | affected slots revoked | affected login sessions revoked per scope | affected actor cleared | affected closed | affected rejected | unchanged unless personal/policy-bound | unchanged |
| Remove org membership | retained | retained | org revision invalidated | ≤5 s close | rejected at next boundary | unchanged unless personal/policy-bound | continues under workspace authority |
| Remove workspace membership | retained | retained | workspace revision invalidated | ≤5 s close | rejected at next boundary | unchanged unless personal/policy-bound | continues unless separately paused/cancelled |
| Password reset/compromise | all affected-account slots revoked | all affected-account sessions revoked | affected actor cleared | affected closed | affected rejected | personal keys revoked by policy | organization workload unchanged |
| Delete organization finalizes | affected route access removed | identity login may remain | organization invalidated | closed | rejected | org keys revoked | must already be stopped/transferred |

## 8. Audit-event minimum set

At minimum record successful and failed high-risk attempts for:

- login account add/link/unlink, slot switch, per-account/all-account sign-out;
- identity merge/recovery and step-up challenge result;
- organization create/convert/rename/status/delete/cancel-delete;
- invite create/resend/cancel/expire/accept/reject;
- membership add/remove/leave, role/capability change, ownership transfer;
- billing/entitlement-owner change;
- personal/service credential create/revoke;
- export request/claim/complete/download/expire; and
- authorization invalidation delivery failure/retry.

Routine read events and every harmless switch need not flood the main audit log if a
separate security-session history provides equivalent evidence. Sensitive mutations do.

## 9. Verification required before implementation acceptance

### 9.1 Deterministic unit/contract tests

- No email-based auto-link path.
- Delegation subset and non-delegable owner/recovery capabilities.
- Invitation expiry, target mismatch, replay, resend rotation, idempotent same-identity
  retry, and concurrent acceptance.
- Personal/team lifecycle and last-human-owner/recovery post-state calculation.
- Legacy `accountId`/new `organizationId` equality and mismatch rejection.
- Cookie/slot selection, per-account sign-out, CSRF/origin, callback state, open-redirect
  rejection, and stale identity-epoch response discard.

### 9.2 Real PostgreSQL tests

Use two organizations, two workspaces per organization, two humans, one API key, and
equal-shaped rows. Run as the real non-owner app role with FORCE RLS:

- cross-organization/workspace SELECT/INSERT/UPDATE/DELETE returns zero/fails;
- wrong composite pair cannot be inserted even by a migration-owner test connection;
- every new resource table has FORCE RLS, both policy clauses, and app grants;
- pooled transaction context does not leak between sequential tenants;
- organization-only tables remain invisible under another organization;
- concurrent owner demote/remove/leave/transfer preserves human governance;
- revocation and invitation consumption serialize correctly; and
- forward migration/backfill is idempotent on legacy, partial, duplicate, and empty data.

### 9.3 API/SDK/embedded tests

- Every route checks grant before resource fetch and returns typed non-enumerating errors.
- Browser, server SDK, CLI profile, and embedded direct-core calls resolve the same actor
  and tenant pair.
- Old clients ignore additive fields; new clients tolerate old-server feature absence.
- User membership removal does not accidentally revoke independent organization keys or
  leave personal keys active.
- A delegated token with stale revision fails even before expiry.

### 9.4 Browser tests

With two real active login accounts and two tenants, verify desktop/mobile,
keyboard-only, screen reader, light/dark, slow network, two tabs, and reduced motion:

- add/switch/sign-out-one/sign-out-all;
- cross-account deep link, inaccessible/revoked link, invite accept/expired/replayed;
- dirty draft, draft-save conflict, in-progress/failed upload, and switch cancellation;
- old stream closes and no stale old-tenant response renders after switch; and
- focus restoration, announcements, target size, contrast, and safe mobile sheet.

Scrub screenshots/recordings before attaching them to the issue.

## 10. Residual risks and explicit non-claims

- A provider request already admitted before human revocation may complete. The control
  is workspace isolation and removal of human view/control, not impossible recall.
- Malicious code with database superuser, host root, or master credential keys can bypass
  tenant controls; operational isolation remains required.
- Browser XSS can act through an unlocked session even when HttpOnly protects token
  extraction. CSP, dependency hygiene, step-up, and bounded slots reduce blast radius
  but do not make XSS harmless.
- Cross-subdomain cookies broaden compromise scope and remain a deployment risk even
  with correct implementation.
- Organization deletion cannot promise immediate physical erasure from backups; policy
  must disclose backup retention and restoration handling.

Any implementation that weakens an invariant to address a residual risk requires a new
ADR and independent security review.