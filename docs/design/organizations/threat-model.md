<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# Organizations and identity threat model

Status: **corrective revision after the third exact-head blocked review; independent approval required**

Companion decision: [`tenancy-identity-adr.md`](tenancy-identity-adr.md)

## 1. Scope and security objective

This model covers human identities, login accounts, browser login slots,
organizations, workspace memberships, invitations, deployment-wide identity recovery,
organization-scoped governance recovery, wrongful-merge identity separation,
deployment authority-plane/custodian lifecycle, personal-to-team conversion, external-
effect delivery reconciliation, switching, billing-owner selection, audit, and
authorization invalidation.

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
- Human-to-login-account bindings, human-enrolled recovery factors, and independently
  scoped deployment identity-recovery authority.
- Independent deployment identity-recovery and organization-governance-custody offline
  root digests, policies, custodian factors/lifecycle revisions, quorum, and notices.
- Merge/separation alias and resolver generations, source lineage, private quarantine,
  conversion barriers/decisions, and external intent/receipt evidence.
- Organization owner/recovery-steward custody and organization break-glass factors.
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
10. **Offline deployment roots ↔ runtime authority planes:** bootstrap, enrollment,
    eligibility, rotation, revocation, replacement, and lost-quorum reconstitution.
11. **OpenGeni ↔ external effect provider:** idempotency/status-query capability,
    ambiguous publish, receipts, compensation, and irreversible exceptions.

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
- support/operator mistakes occur during transfer, deletion, export, or recovery;
- recovery factors or approvers are compromised and attempt an identity merge;
- a lost native device remains offline or receives a push for the wrong tenant; and
- an incompatible old binary races canonical membership revocation;
- custodians or support operators attempt to self-enroll, lower quorum, cross planes, or
  rebuild authority after offline-root loss;
- a wrongful merge maps two people to one active resolver while stale aliases/logins
  race separation;
- conversion races custody, billing, deletion, transfer, or identity merge and a caller
  attempts an undeclared organization merge; and
- a provider accepts an effect immediately before the worker crashes or loses its
  receipt, causing duplicate or falsely finalized delivery.

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
6. **Only humans govern humans.** Non-human credentials never satisfy owner/admin,
   organization-recovery stewardship, the deployment identity-recovery approval
   threshold, or the deployment organization-governance-custody threshold.
7. **Sensitive changes are locked and atomic.** Last-owner, transfer, invitation
   acceptance, and revocation cannot use an unlocked check-then-write sequence.
8. **Secrets are not observability.** Tokens, invitation secrets, cookies, reset links,
   and credential values never enter responses, events, logs, traces, screenshots, or
   audit metadata.
9. **Revocation has bounded propagation.** New requests fail synchronously after commit;
   persistent channels and user-bound delegated tokens are revision-fenced.
10. **Old binaries cannot weaken isolation.** Additive migration and compatibility
    fields preserve the existing workspace/RLS boundary.
11. **Every data plane is an authority boundary.** Object keys, topics, indexes, caches,
    telemetry, jobs, callbacks, and private state are server-scoped and independently
    negative-tested; tags alone never authorize.
12. **Audit is append-only and scoped.** Ordinary app code cannot rewrite, erase, or
    expose actor/operator-global history through a null tenant predicate.
13. **Federation is absent until reviewed.** Domain/group claims grant nothing and no
    enterprise support is advertised by this revision.
14. **Human/login recovery is deployment-scoped.** No organization role, recovery
    steward, invitation, or tenant quorum can attach a login or change global human
    status; organization recovery changes one organization's governance only.
15. **Every active team organization has accountable humans.** Zero resources is not an
    exception: at least one active human owner and recovery steward remain until a
    fenced terminal deletion, and invitations/non-humans never count.
16. **Merge apply is not losslessly reversible.** Observation-window writes retain
    per-object lineage; disputes contain and repair forward without rewriting billing,
    credential, delete, external, personal-organization, or audit facts.
17. **Different people never share one active resolver after dispute containment.**
    Separation proves and generations every binding or leaves both paths contained;
    tenant grants and ambiguous private state are never guessed.
18. **Deployment custodians cannot mint their own authority.** Each recovery plane has
    an independent precommitted offline root, lifecycle, factors, revision, and fail-
    closed degraded/lost-root state.
19. **Conversion is not organization merge.** Personal-to-team conversion preserves one
    tenant/id graph and atomically activates human custody/billing; combining two
    organizations is unsupported and denied.
20. **Unknown external delivery is not success or failure.** Claims precede publish,
    provider capability fences retry, no blind republish occurs, and unresolved effects
    block ordinary merge finalization.

## 6. Threats and required controls

### T1. Automatic identity linking enables account takeover

**Attack:** An attacker controls a recycled/aliased email or compromises one provider
and becomes linked to a victim's human identity.

**Controls:**

- Unique login binding is `(issuer, provider subject)`, never email.
- Email is a verified claim used only for invitation matching/display.
- Linking requires proof of both active login accounts or a deployment identity-recovery
  ceremony.
- Linking, unlinking, merge, and recovery require step-up authentication, idempotency,
  security notification, and audit.
- A merge preview enumerates affected organizations/roles without exposing secrets.
- There is no “helpful” sign-in-time email merge fallback.
- A binding already owned by another human can enter only the distinct, revision-fenced
  merge protocol in ADR section 15. Duplicate personal organizations, authority,
  recovery, billing, and private-owner conflicts must be resolved before apply.

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

### T7. Concurrent leave/demote/remove removes accountable human custody

**Attack:** Two owners remove/demote each other concurrently; the last owner leaves an
empty team organization; a suspension or identity merge removes the only accountable
human; or an invitation, API key, agent, deployment identity-recovery custodian, or
deployment organization-governance custodian is counted as the remaining owner or
recovery steward.

**Controls:**

- Lock the organization governance row, governance revision, and affected memberships
  in a deterministic order for leave/remove/demote/transfer/suspend/delete/merge and
  organization-recovery mutations.
- Evaluate the post-change set inside the transaction. Every `active` team organization
  has at least one active human owner and one active human recovery steward even when it
  has zero workspaces, billing, invitations, or resources.
- Invitations and non-human principals are excluded by type. Both kinds of deployment
  custodian are separate no-content authorities, not memberships, and never satisfy an
  active-organization count.
- Last-owner/steward leave or removal is rejected unless an already active proved human
  receives custody atomically. Explicit deletion retains custody until the terminal
  `deleted` transition deactivates the last memberships in the same transaction.
- Immediate identity suspension moves an otherwise orphaned organization to
  `governance_locked` atomically; a delayed deployment organization-governance-custody
  ceremony appoints a proved human before reactivation.
- Merge generation flip activates canonical owner/steward rows before source rows become
  inactive. Database constraints/indexes enforce personal-owner uniqueness where
  possible; narrow serialized domain functions enforce cross-table liveness.

**Tests:** Race zero-resource last-owner leave/remove, two-owner cross-removal,
owner-versus-steward demotion, identity suspension, identity merge cutover,
organization recovery, transfer, and deletion finalization. Prove one safe winner,
`governance_locked`, terminal deletion, or safe conflict—never an active state without
both required human capabilities.

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

**Attack:** Organization-A recovery stewards attach a login or restore a deployment-wide
human and thereby reactivate that human's organization-B/personal grants; an ordinary
support/operator session acts as a global recovery custodian; or global recovery
preserves compromised sessions and credentials.

**Controls:**

- Deployment identity recovery and organization governance recovery use separate
  tables, capabilities, state machines, database functions, audit scopes, and quorums.
- Human/login recovery accepts only closed authority paths: target-enrolled independent
  factors, or two/three distinct deployment identity-recovery custodians with the ADR's
  72-hour/seven-day delays. Organization roles, organization-governance custodians,
  invitations, tenant quorums, and non-human credentials never count.
- Organization recovery requires a globally active proved human and can mutate only one
  organization's membership/grants. Its SQL capability cannot address human/login rows,
  private-owner mappings, another organization, or a personal workspace.
- Global recovery increments the target security revision and revokes all browser/native
  slots, auth sessions, personal credentials, offline caches, delegated user tokens, and
  streams before exposing a newly proved path. Tenant service credentials remain with
  their tenant.
- Both operations are narrowly enumerated, step-up authenticated, rate limited, carry an
  incident/reason, notify existing paths/scoped security contacts, and append their
  distinct actor/deployment/organization audit events.
- Break-glass content access, if a deployment supports it, is a separate time-limited
  grant with prominent audit/notification and cannot be implicit.
- Recovery never creates an email-based identity merge.

**Tests:** Give one human active grants in organizations A/B plus a personal workspace.
Traverse every A-governance recovery transition and assert the global human/login
revision and all B/personal memberships, owner rows, sessions, credentials, billing,
and content remain byte-for-byte and authorization-equivalent unchanged. Then exercise
each global authority path and prove quorum, delay, notice, revision, and complete
session/credential revocation while every A/B/personal governance row and revision stays
unchanged. Fresh authorization may make independently active grants usable again, but
recovery creates or reactivates no grant.

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

### T17. Merge or recovery converts compromise into durable authority

**Attack:** A compromised account links a victim login, a recovery approver replays an
old ceremony, two personal organizations collapse silently, a merge apply transaction
is unbounded, or post-apply writes are lost/duplicated/misattributed by a claimed
reversal.

**Controls:**

- Link, merge, and recovery use the separate state machines in ADR section 15.
- Every transition checks operation generation, both starting human revisions, proof
  expiry, approver eligibility, and a unique idempotency key under lock.
- Existing-human merge requires fresh proof from both sources. An unavailable source
  first completes deployment identity recovery and then proves the new path; no
  organization quorum replaces proof. Ordinary merge cools 24 hours and a recovered
  path cools 72 hours.
- All pre-existing verified paths are notified at proposal, conflict decision, apply,
  dispute, containment, repair, and finalize. A dispute fences every stale callback and
  worker.
- Duplicate personal organizations require explicit keep/convert/delete prerequisites.
  Conversion/final deletion and destroyed/external facts are visibly irreversible;
  billing/personal entitlements enter hold and never sum automatically.
- A merge barrier freezes ownership/governance/billing/private-owner mutations. Inactive
  derived rows stage in at-most-500-row/250-ms batches; a short digest/revision-checked
  generation flip activates them and revokes sessions/tokens without locking every
  object in one transaction.
- During the 30-day observation window every affected write records per-object owner,
  tenant, actor/source lineage, revisions, operation/idempotency, digest/tombstone, and
  external intent/receipt. Missing provenance denies the write.
- A dispute contains the human, revokes credentials, and builds a forward-only repair
  manifest. Tenant data stays tenant-owned; scoped authorities decide memberships,
  private ownership, and compensating billing/external actions. Credentials are
  reissued, deletes restore only from extant tombstones, and audit is append-only.
- Repair approvals expire without releasing containment. Completion reports retained,
  transferred, revoked, quarantined, compensated, and irreversible facts; no lossless
  reversal or inverse ledger is promised.

**Tests:** Traverse every transition/event pair, including duplicate/reordered callback,
expired proof, revision/barrier change, dispute at the deadline, crash at every staging,
cutover, provenance, containment, and repair boundary, deterministic retry, approval
expiry, and finalization. Generate concurrent post-apply writes from both source-login
lineages and organization/service actors for every conflict class. Prove no implicit
owner, role, billing, recovery, credential, private-data, delete, external-effect, or
personal-organization outcome and no unbounded cutover transaction.

### T18. A non-database plane crosses tenants

**Attack:** A caller forges an object prefix, subscribes to a NATS wildcard, manipulates
search ACL tags, collides a cache key, follows a webhook redirect, claims another
tenant's job, or learns tenant data from raw logs/metrics.

**Controls:**

- ADR section 16 is the required authority registry for database, object, NATS, search,
  cache, observability, jobs, callbacks, webhooks, provider connections, and private
  state.
- Every identifier and capability is derived from a verified durable owner tuple. A
  callback/payload/query never supplies its own trusted tenant scope.
- Object capabilities fix operation, key prefix, size/type, checksum, expiry, and exact
  tenant pair; server-side copy validates both source and destination.
- Broker JWTs enumerate publish/subscribe subjects; no client wildcard can widen them.
- Search authorization is checked before query and after result. ACL/index tags alone
  are not authorization.
- Cache keys include plane, owner tuple, and revision; a cached value repeats the owner
  tuple and is rejected on mismatch.
- Jobs authorize at enqueue and claim; webhook retries preserve the original durable
  destination/owner and do not follow an unapproved redirect.
- Shared logs/traces/metrics contain no content/secrets and tenant dashboards query a
  capability-checked projection, not arbitrary raw labels.

### T19. Mutable or mis-scoped audit destroys evidence

**Attack:** Ordinary app code updates/deletes an audit row, a tenant queries events with
`organization_id IS NULL`, a privileged rewrite changes both events and database chain
head, or deletion silently erases identity-security evidence.

**Controls:**

- The app can execute only the dedicated append function; it has no table/sequence/
  partition mutation ownership. Append-deny trigger and deployment grant assertions are
  defense in depth.
- Scope is explicit (`actor`, `deployment_identity`, `organization`, `workspace`,
  `operator`, or public integrity checkpoint). Null tenant is never a visibility
  wildcard.
- Per-scope locked sequence/hash chains and externally signed retention-locked heads
  detect rewrite, truncation, removal, and reordering beyond the normal DB role boundary.
- Security mutation and audit append commit together. Rollback leaves neither effect.
- A versioned retention schedule is mandatory. Crypto-erasure/pseudonymization preserves
  chain evidence; statutory hard erasure records a signed range certificate instead of
  pretending the chain is continuous.
- Operator read/compliance erasure uses distinct short-lived roles and is itself
  appended/audited.

### T20. Mixed versions restore a revoked grant

**Attack:** An old API writes legacy `subject_id` after canonical revocation, an old
worker claims a v2 job, or a rollback reads a permissive stale legacy projection.

**Controls:**

- Migration section 7 defines exactly one authority for each phase.
- Canonical cutover waits for zero incompatible protocol leases and grants the versioned
  non-login database capability only to compatible deployments.
- For canonical tenants, legacy direct DML and legacy-role reads are database-denied.
  Request flags or settable GUCs cannot claim compatibility.
- Canonical grant/revoke writes canonical row, legacy projection, revision, outbox, and
  audit atomically under the governance-row lock.
- Any projection/revision disagreement fails closed and quarantines. No asynchronous
  reconciliation can turn disagreement into a grant.
- Pre-v2 rollback after cutover is intentionally unavailable; only a compatible forward
  recovery can serve the tenant.

### T21. Native/device storage or callback crosses accounts

**Attack:** Credentials land in shared preferences/WebView storage, OS backup clones a
slot to another device, a custom-scheme callback is hijacked, refresh replay survives,
lost-device caches remain readable, or push leaks another tenant's content.

**Controls:**

- ADR section 19 applies the same server-side session set/slot/revision semantics to
  browser and native clients.
- Native installations use proof-of-possession keys and OS secure storage. PKCE plus
  verified app/universal links, loopback, or device flow binds callback ownership.
- Rotating refresh-token family replay revokes the slot. Restored credentials without
  the installation key are rejected.
- Encrypted cache namespace includes installation, slot, human, exact tenant pair, and
  revisions. High-sensitivity content is offline-disabled; all other content expires
  within 24 hours without online revision check and resists clock rollback.
- Lost-device action revokes installation/slots/token families/push registrations and
  wrapping record. Remote wipe is explicitly best effort.
- Push contains only an opaque id, is scoped at registration and enqueue, and requires a
  fresh authorized fetch before rendering.

### T22. Same-human aliases leak private state between slots

**Attack:** Two linked login accounts reuse a slot cache or decrypted connection because
they resolve to the same human; or a legacy `user:<id>` draft is assigned to the wrong
human during merge/backfill.

**Controls:**

- ADR section 17 declares a canonical owner for drafts, pins, connections, keys,
  uploads, preferences, slot caches, and auth tokens.
- Durable human-owned state may be freshly fetched across same-human login accounts;
  slot-local caches, auth tokens, upload handles, decrypted connections, and in-flight
  responses are never reused.
- Human-owned rows that touch resources also carry the exact tenant pair. Upload attach
  rechecks pair and revision.
- Legacy subject augmentation requires one unambiguous login-to-human binding and keeps
  source provenance/stable ids. Ambiguity is quarantine, never email-based assignment.
- Merge retains immutable source mappings, staged owner lineage, and every post-apply
  provenance record; duplicate ids remain stable/disambiguated and ambiguous repair is
  quarantined rather than dropped, overwritten, or automatically reversed.

### T23. Federation claims or first caller seize governance

**Attack:** A domain/group/administrator claim grants an organization role despite no
federation lifecycle, or the first remote request to an unauthenticated self-hosted
instance becomes owner.

**Controls:**

- Federation is explicitly deferred by ADR section 20. Domain, group, role, and email
  claims grant nothing; unsupported federation endpoints/configuration fail closed.
- Generic issuer/subject authentication creates only a login account. Membership and
  recovery require explicit audited governance operations.
- Bootstrap uses an operator-delivered 256-bit single-use secret plus configured-human
  or loopback/OS proof, never first-request wins.
- An unauthenticated listener outside allowed loopback/private operator policy refuses
  startup. Unknown and non-human subjects cannot own or recover.
- Bootstrap is one locked idempotent transaction with stable installation ids and a
  human identity-recovery factor. A distinct organization break-glass factor is enrolled
  before single-person stewardship/collaboration enables; all normal tenant/RLS
  semantics remain active.

### T24. Wrongful merge leaves two people sharing one active identity

**Attack:** A same-person merge was wrong, but repair keeps absorbed aliases/logins
resolving to the canonical human, assigns both people's credentials to whichever person
answers first, recreates a deleted personal organization, unions tenant grants, or
copies ambiguous private state.

**Controls:**

- Different-person evidence first commits containment and revokes every source/
  canonical browser/native slot, auth session, refresh family, personal credential,
  delegated token, cache/wrapping record, push registration, and stream. No old merged
  resolver authorizes during review.
- ADR section 15.7 is a separate revision-fenced operation with fresh proof from both
  claimants plus the closed current deployment identity-separation quorum. Tenant roles,
  governance custodians, support, billing authority, and email equality never count.
- Cutover prefers the retained source human id. Replacement occurs only for a
  structurally unusable id and records immutable `replacement_of`; absorbed→canonical
  history becomes a non-authorizing tombstone while two current resolver generations
  independently self-resolve.
- Every login is freshly proved for one claimant or quarantined. Human/login status and
  security generation changes make stale alias/login/cache reads deny.
- Each organization approves only its own memberships/roles/custody; deployment
  identity authority cannot invent a tenant grant. Tenant-owned data stays tenant-
  owned. Unique private lineage may transfer after proof; joint/ambiguous state is
  quarantined from both.
- Converted/deleted personal organizations and posted/audit/external facts remain
  irreversible. At-most-500-row/250-ms inactive staging and one digest-checked atomic
  resolver/owner/revocation cutover prevent partial split.
- Exact terminals are separated, separated-with-quarantine, separated-with-
  irreversible-exceptions, or contained-unresolved. Failed proof/authority keeps both
  claimant paths contained; it never restores shared active resolution.

**Tests:** Traverse every transition and terminal outcome with duplicate/reordered
proofs, stale plane/login/human/tenant/billing revisions, missing tenant approval,
ambiguous private owner, deleted/converted personal organization, and unavailable
retained id. Crash/race at every staging, alias/resolver/login/human generation,
revocation, outbox, and audit boundary while old logins continuously authorize. Prove
there is never a visible partial split, two people resolving to one active human, a
revived credential, an invented tenant grant, recreated personal organization, or
unquarantined ambiguous row.

### T25. Custodians self-expand authority or lose quorum/root

**Attack:** A custodian enrolls a confederate, reuses one factor/person across planes,
rotates/removes under stale quorum, delays compromise revocation, continues recovery
while below quorum, or lets support/remaining custodians rebuild after the offline root
is lost.

**Controls:**

- Identity recovery and organization-governance custody have separate precommitted
  offline deployment roots, policy digests, factors, rows, capabilities, revisions,
  eligibility ages, quorums, notices, and audits. Tenants, support, runtime app roles,
  and custodians are outside both roots.
- Plane states are unconfigured, enrollment-pending, enabled, degraded,
  reconstituting, and disabled-unavailable. Custodian states cover enrollment,
  cooling, active-ineligible, active, factor-rotation pending, revocation pending, and
  revoked; approvals count only current `active` rows/factors.
- Enrollment/lifecycle changes require separated operator/offline-root duties and exact
  revision fencing. Ordinary quorum-losing removal denies. Composite replacement makes
  an eligible successor active before predecessor revocation.
- Confirmed compromise revokes immediately and invalidates approvals; if quorum falls,
  the plane becomes degraded and custodian-dependent recovery fails closed.
- Lost-quorum reconstitution requires the precommitted offline root, independent
  incident/legal basis, notices, at least seven-day cooling, and no recovery operations
  during rebuild. Root loss/dispute selects disabled-unavailable; authority never
  self-expands or lowers quorum.
- Fewer than three eligible governance custodians makes exceptional unlock explicitly
  unavailable. The same person in both planes still has distinct enrollments/factors
  and no cross-plane authority.

**Tests:** Traverse every plane/custodian transition, approval at eligibility boundary,
stale factor/root/policy/plane revision, concurrent remove/replace/rotate, compromise
during an in-flight recovery, and offline-root loss during reconstitution. Prove
cross-plane factor/approval use, self-enrollment, support/tenant enrollment, stale quorum,
recovery in degraded/reconstituting/unavailable state, sub-three governance unlock, and
rootless rebuild all deny with durable audit.

### T26. Conversion races create an uncustodied team or implicit organization merge

**Attack:** Personal-to-team conversion flips kind before human custody, grants
workspace collaborators organization roles, loses/duplicates billing allowances,
races delete/transfer/identity merge, partially commits after crash, changes resource
ids, or accepts a second organization as a covert merge target.

**Controls:**

- ADR section 9.7 uses one revision-bound idempotent operation with owner step-up,
  explicit active human owner and recovery steward/factors, billing decision, notices,
  cooling, and barrier generation.
- The barrier serializes kind, custody, billing, delete, transfer, and merge-prerequisite
  mutations while ordinary tenant-owned data writes continue under unchanged ids.
- Applying atomically activates team custody, applies exactly one terminate/eligible-
  transfer/new-team billing decision, flips kind, bumps revisions, and appends outbox/
  audit. Crash before commit returns to ready with personal kind unchanged.
- Existing organization/workspace/resource ids and collaborator workspace grants are
  unchanged; no implicit organization capability is derived. Posted ledger, tax,
  payment, entitlement-use, and anti-abuse facts remain immutable.
- Identity merge cannot cool until the conversion is `converted`. Organization merge,
  consolidation, and implicit workspace move are unsupported and fail closed as
  `organization_merge_unsupported` across API/SDK/host/database surfaces.

**Tests:** Traverse absent/review/cooling/ready/applying/converted/blocked/aborted with
stale proof/factor/governance/billing/barrier revisions, notice failure, one-human break-
glass, zero resources, many workspace-only collaborators, and each billing decision.
Race every fenced mutation and crash before/after every cutover write. Assert ids/data/
collaborator grants remain unchanged, post-state human custody holds, ledger facts do
not duplicate, merge cooling waits, and every two-organization request denies.

### T27. Ambiguous external delivery duplicates or hides an effect

**Attack:** A provider accepts a webhook/payment/notification immediately before the
worker crashes; the retry changes payload/key or republishes blindly, a non-idempotent
provider executes twice, timeout is mislabeled failure, or merge finalizes while the
receipt is unknown.

**Controls:**

- Before publish, one durable `prepared` intent stores stable effect/idempotency key,
  request digest, destination/owner, provider capability snapshot/version, and owning
  authority revisions. `publish_claimed` commits before network I/O.
- Verified receipt and definitive pre-accept failure are separate terminal facts. Any
  ambiguous post-claim crash selects `delivery_unknown`; it is neither success nor
  failure and is never blindly republished.
- Queryable providers are queried by exact effect key after ambiguity. Idempotent retry
  is allowed only with the identical key/digest, after query when available, and under
  the unchanged capability version. Non-queryable/non-idempotent providers receive one
  at-most-once publish; missing receipt stays unknown.
- Reconciliation uses bounded backoff. Compensation is a separately claimed child
  delivery record with its own key/digest/capability snapshot and needs owning-subsystem
  plus exact tenant/billing authority. Its receipt marks only the append-linked relation
  compensated; unknown/failed compensation never overwrites or resolves original
  ambiguity. An unresolved irreversible exception needs scoped current approvals and
  remains visibly unknown, not success.
- Merge cannot ordinarily finalize while any intent is prepared, claimed, unknown,
  reconciling, or compensation-pending. At 30 days it becomes finalization-blocked;
  exception approval forces repaired-with-exceptions and a signed report.

**Tests:** Crash immediately before/after intent commit, publish claim, send, provider
acceptance, receipt append, status query/result, compensation claim, and receipt. Inject
response loss, duplicate/reordered workers, capability change, query timeout, false
local timeout, and non-idempotent provider. Prove exact-key/digest behavior, at most one
non-idempotent publish, no blind republish, scoped compensation/exception denial, and a
truthful terminal or finalization-blocked state.

## 7. Session and credential invalidation matrix

| Change | Browser slot | Auth session | Org/workspace grant cache | Persistent stream | User delegated token | Org API key | Running workload |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Switch active slot | retained, deselected | retained | new actor epoch | old closed | old user token rejected by actor/revision | unchanged | unchanged |
| Sign out one account | affected slots revoked | affected login sessions revoked per scope | affected actor cleared | affected closed | affected rejected | unchanged unless personal/policy-bound | unchanged |
| Remove org membership | retained | retained | org revision invalidated | ≤5 s close | rejected at next boundary | unchanged unless personal/policy-bound | continues under workspace authority |
| Remove workspace membership | retained | retained | workspace revision invalidated | ≤5 s close | rejected at next boundary | unchanged unless personal/policy-bound | continues unless separately paused/cancelled |
| Password reset/compromise | all affected-account slots revoked | all affected-account sessions revoked | affected actor cleared | affected closed | affected rejected | personal keys revoked by policy | organization workload unchanged |
| Deployment identity recovery | every target-human slot revoked; only newly proved slot may be issued | every target-login session revoked | all actor caches denied by new human/login revision, then active grants freshly resolve | all target-human streams closed | all target-human tokens rejected | tenant service keys unchanged; personal keys revoked | tenant-autonomous workload unchanged |
| Deployment custodian compromise | affected custodian operator slots revoked for plane action | affected factor/operator sessions revoked | plane approval cache denied by custodian/plane revision | no tenant stream implied; operator channel closes | every pending custodian approval rejected | tenant keys unchanged | plane recovery operations deny; tenant workloads unchanged |
| Organization-A governance recovery | unchanged | unchanged | A revision invalidated; B/personal revisions byte-equal | A streams close as grants change; B/personal unchanged | only A-scoped token affected | only explicitly A human-bound key affected | A policy only; B/personal unchanged |
| Merge dispute containment | every canonical-human slot revoked | every source/canonical session revoked | canonical human denied pending forward repair | all human streams closed | all human-bound tokens rejected | personal keys revoked; tenant keys unchanged | tenant-autonomous workload follows tenant authority |
| Wrongful-merge separation cutover | every source/canonical slot stays revoked; fresh slots only after split | every old login session/family revoked or binding quarantined | old alias/resolver/private-owner generations denied; tenant grants freshly resolve per approved outcome | every source/canonical human stream closed | every old human-bound token rejected | personal keys revoked/reissued after proof; tenant keys unchanged | tenant-autonomous workload follows tenant authority |
| Personal-to-team conversion | retained | retained | organization kind/governance/billing revision refreshed; workspace grants unchanged | reconnect only if governance revision affects channel | unchanged unless explicit billing/custody policy | organization keys unchanged | same tenant ids/authority; ordinary work continues |
| Delete organization finalizes | affected route access removed | identity login may remain | organization invalidated | closed | rejected | org keys revoked | must already be stopped/transferred |

Native/device invalidation uses the same rows plus these host effects:

| Change | Installation/slot | Secure-store token family | Offline cache | Push registration |
| --- | --- | --- | --- | --- |
| Switch slot | installation retained; new epoch | families isolated | old namespace sealed; no reuse | old slot registration inactive |
| Sign out account on device | affected slot revoked | affected family revoked | affected namespace key deleted | affected registration deleted |
| Sign out device | all device slots revoked | all device families revoked | all local wrapping keys deleted | all device registrations deleted |
| Account compromise | affected-account slots on all devices revoked | replay family denied globally | unreadable after key/revision/24 h bound | affected registrations deleted |
| Device lost | whole installation revoked | installation proof and families denied | remote wipe best effort; secure store/expiry are guarantees | all installation registrations deleted |

### 7.1 Data-plane adversarial matrix

For every row below seed equal-shaped tenant A/B resources and actor A/B resources.

| Plane | Mandatory denied operations |
| --- | --- |
| DB workspace/org/actor | missing context; wrong pair; actor-global enumerate; tenant-null visibility; all CRUD |
| Object/upload/export | forged prefix; signed PUT/GET reuse; cross-tenant copy; callback key substitution; expired capability |
| NATS/stream | wildcard publish/subscribe; forged JWT scope; stale revision delivery; cross-tenant replay |
| Search/index | forged ACL/tag; wrong namespace; stale indexed grant; result from deleted/revoked tenant |
| Cache/idempotency | owner-key collision; stale revision; same key across tenants; actor A retrieving actor B value |
| Logs/traces/metrics/analytics | raw secret/content; unauthorized tenant dashboard; join through reused label; erased identity reidentification |
| Jobs/workflows/outbox | payload scope substitution; stale user claim; old worker claim; retry changing owner; cross-tenant batch without operator role |
| Callback/webhook/integration | replay; wrong signature/state; redirect scope change; secret read; destination owner mutation during retry |
| Provider/private state | login id used as provider/tenant id; same-human slot cache reuse; ambiguous legacy owner; cross-owner credential selection |
| Authority plane/custodian | cross-plane root/factor/approval; stale eligibility or plane revision; self-enrollment; quorum-losing mutation; degraded/rootless recovery |
| Alias/resolver/separation | historical alias authorization; stale generation; wrong claimant login; tenant-grant invention; ambiguous private transfer; partial split |
| Conversion | second organization target; stale barrier/custody/billing revision; collaborator role escalation; resource reparent; partial kind flip |
| External delivery | wrong key/digest/owner/capability version; duplicate claim; blind/non-idempotent republish; unscoped compensation/exception; unknown finalization |

Passing DB RLS tests does not waive any row in this matrix.

## 8. Audit-event minimum set

At minimum record successful and failed high-risk attempts for:

- login account add/link/unlink, slot switch, per-account/all-account sign-out;
- deployment identity-recovery request/factor/custodian eligibility/cooling/dispute/
  apply and complete revocation outcome;
- each deployment authority-plane root/policy/mode/state change and custodian enroll/
  activate/eligibility/rotate/revoke/replace/compromise/lost-quorum/reconstitute outcome;
- organization governance-recovery request/steward/custody eligibility/cooling/apply and
  cross-organization noninterference result;
- identity merge evidence/conflict/prerequisite/barrier/staging/cutover/observation/
  containment/repair/finalize, including every provenance and irreversible-effect
  classification;
- wrongful-merge separation proof/authority/decision/barrier/staging/resolver cutover/
  login disposition/revocation/quarantine/irreversible/contained-unresolved outcome;
- organization create/personal-to-team review/cooling/billing decision/cutover/blocked/
  aborted/rename/status/delete/cancel-delete and rejected organization merge;
- external intent prepare/publish claim/receipt/failure/unknown/query/retry/compensation/
  irreversible exception/finalization-blocked outcome;
- invite create/resend/cancel/expire/accept/reject;
- membership add/remove/leave, role/capability change, ownership transfer;
- billing/entitlement-owner change;
- personal/service credential create/revoke;
- export request/claim/complete/download/expire;
- authorization invalidation delivery failure/retry;
- audit retention/legal-hold/crypto-erasure/hard-erasure certificate and integrity-head
  sign/export/verification failure;
- native installation/slot/token-family/push registration create/revoke/replay; and
- bootstrap claim/refusal/recovery/collaboration enablement.

Routine read events and every harmless switch need not flood the main audit log if a
separate security-session history provides equivalent evidence. Sensitive mutations do.

## 9. Verification required before implementation acceptance

### 9.1 Deterministic unit/contract tests

- No email-based auto-link path.
- Delegation subset and non-delegable owner/recovery capabilities.
- Invitation expiry, target mismatch, replay, resend rotation, idempotent same-identity
  retry, and concurrent acceptance.
- Personal/team lifecycle and last-active-human-owner/recovery-steward post-state
  calculation.
- Legacy `accountId`/new `organizationId` equality and mismatch rejection.
- Cookie/slot selection, per-account sign-out, CSRF/origin, callback state, open-redirect
  rejection, and stale identity-epoch response discard.
- Every link/merge/deployment-recovery/organization-recovery transition,
  proof/quorum/cooling/revision/noninterference rule, conflict resolution, barrier and
  bounded staging retry, post-apply write classification, containment, forward repair,
  approval expiry, irreversible exception, and source-contribution preservation.
- Every authority-plane and custodian lifecycle transition, independent root/factor/
  eligibility/quorum revision, atomic replacement, immediate compromise, lost-quorum
  reconstitution, root-unavailable, and cross-plane denial case.
- Every identity-separation transition/terminal, retained-id/replacement lineage,
  alias/login/human resolver generation, complete revocation, per-tenant decision,
  personal-org irreversibility, unique-private transfer, and ambiguous quarantine case.
- Every personal-to-team state/race, custody/factor/billing decision, unchanged tenant id
  and workspace-only collaborator rule, plus organization-merge fail-closed result.
- Every external delivery state and crash point, exact key/digest/capability retry rule,
  query-first reconciliation, at-most-once provider, scoped compensation/exception,
  and finalization gate.
- Empty active team last-owner/steward leave/remove/suspend/merge/recovery/delete races;
  invitations, agents, service principals, API keys, and either kind of deployment
  custodian never satisfy the active human invariant.
- Issuer/subject/email/slug normalization fixtures and tombstone generation/reuse.
- Bootstrap first-claim race/restart/recovery and federation claim rejection.

### 9.2 Real PostgreSQL tests

Use two organizations, two workspaces per organization, two humans, one API key, and
equal-shaped rows. Run as the real non-owner app role with FORCE RLS:

- cross-organization/workspace SELECT/INSERT/UPDATE/DELETE returns zero/fails;
- wrong composite pair cannot be inserted even by a migration-owner test connection;
- every new resource table has FORCE RLS, both policy clauses, and app grants;
- pooled transaction context does not leak between sequential tenants;
- organization-only tables remain invisible under another organization;
- concurrent owner demote/remove/leave/transfer preserves human governance;
- zero-resource active team organizations retain owner/steward custody; suspension moves
  safely to `governance_locked`, and terminal delete deactivates custody atomically;
- organization-A recovery cannot call global identity functions or alter seeded
  organization-B/personal rows/revisions, while deployment recovery enforces independent
  custodian/factor quorum and complete revocation;
- plane/custodian functions cannot cross roots/capabilities or run below quorum; stale
  eligibility/approval denies and rootless/degraded/reconstituting recovery is absent;
- merge staging/cutover and observation-window provenance remain bounded/idempotent;
  missing lineage denies and forward repair preserves immutable/irreversible facts;
- separation staging/cutover never exposes a partial resolver, stale alias/login denies,
  all old credentials remain revoked, tenant/private decisions stay scope-correct, and
  contained-unresolved authenticates neither claimant;
- conversion serializes against every barrier race, preserves ids/resources/collaborator
  grants, commits kind/custody/billing atomically, and exposes no organization-merge
  database capability;
- delivery claims/queries/receipts/compensation are owner- and generation-scoped; crash
  tests prove at-most-one non-idempotent publish and unresolved rows block finalization;
- revocation and invitation consumption serialize correctly; and
- forward migration/backfill is idempotent on legacy, partial, duplicate, and empty data;
- the app role cannot update/delete/truncate audit history, actor/operator scope cannot
  leak, hash segments verify, and mutation rollback leaves no orphan audit event;
- legacy/new grant and revoke races obey phase authority; old roles cannot read or write
  canonical tenants and disagreement denies; and
- actor-global RLS/capabilities prevent one human from enumerating another.

### 9.3 API/SDK/embedded tests

- Every route checks grant before resource fetch and returns typed non-enumerating errors.
- Browser, server SDK, CLI profile, and embedded direct-core calls resolve the same actor
  and tenant pair.
- Old clients ignore additive fields; new clients tolerate old-server feature absence.
- User membership removal does not accidentally revoke independent organization keys or
  leave personal keys active.
- A delegated token with stale revision fails even before expiry.
- Every data-plane row in section 7.1 has an integration/conformance negative test.
- API/SDK/CLI/embedded conversion accepts one organization only; organization merge
  returns `organization_merge_unsupported` without resource writes.
- Deployment-plane status/lifecycle, separation disposition, delivery unknown/
  reconciliation, and scoped compensation/exception APIs reject stale/cross-plane or
  caller-selected authority.
- Native secure-store unavailable/backup restore/callback hijack/refresh replay/offline
  expiry/device loss/push token reuse fail closed.

### 9.4 Browser tests

With two real active login accounts and two tenants, verify desktop/mobile,
keyboard-only, screen reader, light/dark, slow network, two tabs, and reduced motion:

- add/switch/sign-out-one/sign-out-all;
- cross-account deep link, inaccessible/revoked link, invite accept/expired/replayed;
- dirty draft, draft-save conflict, in-progress/failed upload, and switch cancellation;
- identity merge irreversible-prerequisite acknowledgments, staging, applied-observation,
  dispute containment, approval expiry, per-category forward-repair outcomes, and
  irreversible exceptions without any reversal promise;
- wrongful-merge different-person containment, separation proof/cooling/staging,
  separated/quarantine/irreversible/contained-unresolved presentations, and fresh
  reauthentication only after cutover;
- both deployment authority-plane status/lifecycle surfaces, degraded/reconstituting/
  unavailable recovery, factor rotation/replacement, and fewer-than-three governance-
  custodian exceptional-unlock absence;
- personal-to-team review/cooling/custody/billing/cutover/blocked/aborted plus explicit
  organization-merge unsupported result;
- external delivery unknown/reconciling/compensation/finalization-blocked/irreversible-
  exception states without a misleading retry or success label;
- deployment identity recovery with global-scope/revocation/reactivated-grant warning,
  and organization-A governance recovery with an exact-org scope warning and unchanged
  organization-B/personal presentation;
- empty active team last-owner/steward disabled actions, atomic transfer, deletion
  pending/finalized, suspension to `governance_locked`, and delayed deployment
  organization-governance custody;
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
- Identity merge cannot promise lossless post-apply reversal. Personal-organization
  conversion/deletion, hard deletes, billing/provider postings, audit facts, and external
  effects may be irreversible; containment and explicit forward repair are the
  supported security response.
- Identity separation can restore independent authentication but cannot recreate a
  deleted/converted personal organization, reverse posted/audit/external facts, or
  assign ambiguous private state safely; quarantine or a signed irreversible exception
  may remain indefinitely.
- Losing a deployment plane's offline root can make its recovery path permanently
  unavailable. The design intentionally does not provide a tenant/support/self-
  custodian bypass.
- A non-queryable, non-idempotent provider may leave delivery permanently unknown after
  response loss. Scoped compensation or explicit irreversible exception is truthful;
  automatic retry or assumed failure is not.
- Organization merge is not claimed. Personal-to-team conversion and identity merge do
  not authorize tenant/resource consolidation.

Any implementation that weakens an invariant to address a residual risk requires a new
ADR and independent security review.
