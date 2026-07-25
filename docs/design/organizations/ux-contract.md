<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# Account → organization → workspace UX contract

Status: **corrective revision after the third exact-head blocked review; implementation remains gated**

Scope: web console behavior plus requirements for embedded hosts and CLI parity.

## 1. Experience goals

- Make the active human/login account, organization, and workspace unambiguous without
  turning the rail into a settings dashboard.
- Keep one compact primary switcher with progressive disclosure.
- Support multiple simultaneous login accounts without global logout or credential
  leakage.
- Recover deep links safely when the selected account/organization/workspace differs.
- Never discard a draft, unresolved upload, or in-flight mutation during a switch.
- Meet keyboard, screen-reader, mobile, touch, reduced-motion, light/dark, localization,
  self-hosting, and white-label requirements.
- Provide secure native/device and single-user modes without weakening the shared
  server-side identity or tenant model.

## 2. Information hierarchy

In collaborative/managed mode, the compact rail header shows three levels:

1. **Account** — avatar plus the selected login-account display name/email and issuer
   when needed to disambiguate.
2. **Organization** — organization name and personal/team indicator only when useful.
3. **Workspace** — prominent current workspace name and operational state.

The workspace remains the primary action. Account and organization rows are visually
quieter. In collapsed desktop mode, one workspace avatar opens the combined switcher;
the accessible name includes all three selected labels. On mobile, the same content is
a bottom sheet/full-height drawer, not nested hover menus.

Never present raw UUID fragments as the normal organization name. A diagnostic details
view may show copyable ids to authorized users. The narrowly gated single-user
simplification in section 16 may collapse the visible header to the workspace label;
account and organization remain named in accessible settings and in every destructive
or security ceremony.

## 3. Combined switcher

### 3.1 Trigger

The trigger communicates:

- selected login account;
- organization;
- workspace;
- workspace paused/unavailable state; and
- “Switch account, organization, or workspace” accessible name.

It has one tab stop. Opening places focus on the selected workspace item.

### 3.2 Menu structure

The menu/sheet contains:

- selected account summary and **Switch/add account** action;
- organizations for that human, with personal/team badges and current selection;
- workspaces within the highlighted organization;
- create/join/request-access actions only when authorized;
- organization settings and workspace settings links; and
- safe loading/error/empty states inline.

For one account/organization, omit useless chevrons but keep the label. Do not hide the
account identity when more than one login account is active.

### 3.3 Login-account picker

Each account row shows avatar, display name, verified email/claim, issuer label when
ambiguous, selected marker, and unavailable/re-authentication state. It never shows raw
provider tokens or tenant grants.

Actions:

- **Use this account** — runs switch preflight, then re-resolves grants;
- **Add another account** — isolated popup/new-tab transaction;
- **Manage accounts** — login/recovery settings;
- **Sign out this account** — scoped confirmation; and
- **Sign out all accounts** — distinct destructive confirmation.

If the account being removed is selected, the user chooses another valid account or
returns to the signed-out gate. The product must not silently select a different human
while unsaved work exists.

## 4. Navigation state machine

Every account, organization, workspace, deep-link, or sign-out transition uses:

`idle → preflight → blocked | committing → loading → ready | recoverable_error`

### 4.1 Preflight

Collect, without mutating state:

- locally dirty new-session draft;
- durable composer draft whose save is pending or conflicted;
- uploading, failed, or ready-but-unattached files;
- in-flight create/update/delete/billing/invite mutation;
- open modal/editor with unsaved data; and
- active old-tenant requests/streams that require cancellation.

No `resetSessionView`, cache clear, route change, or actor selection occurs before the
preflight resolves.

### 4.2 Blocked dialog

The dialog names the destination and groups blockers. Safe default and initial focus is
**Stay here**.

Available actions depend on blockers:

- **Save and switch** — wait for durable draft save; not available on conflict;
- **Wait for uploads** — keep dialog open with progress;
- **Cancel uploads and switch** — explicit destructive confirmation;
- **Discard local draft and switch** — names exactly what is discarded;
- **Resolve conflict** — returns focus to composer conflict UI; and
- **Stay here**.

There is no generic “Continue” that hides data loss. Browser tab close/refresh uses the
native unload warning when a local-only draft/upload cannot be made durable.

### 4.3 Commit

Once blockers resolve:

1. Increment the client identity/navigation epoch.
2. Abort old requests and close old event streams.
3. Commit the selected login slot server-side when actor changes.
4. Clear actor/tenant-derived caches, attachment handles, integration selections, and
   transient UI state.
5. Navigate to the target route.
6. Resolve fresh access context/workspaces and initialize new streams.
7. Render destination content only if its epoch matches.

Late old-epoch responses are ignored, even if successful. A failed destination load
offers retry and safe return/default choices without rendering old data under the new
labels.

Even when the new login slot resolves to the same human, steps 1–7 still run. Human-owned
drafts/pins may reappear only after a fresh server fetch; the prior slot's memory cache,
decrypted connection, upload handle, auth material, and in-flight result are never
reused.

## 5. Deep-link recovery

### 5.1 Selected account has access

Open the exact route after normal authorization. Preserve session/document/query focus
only when it belongs to the same workspace.

### 5.2 Another active account has access

Show a neutral interstitial:

> This workspace is available with another signed-in account.

List only safe account summaries already attached to this browser session. **Open as
…** runs the full switch preflight. Never auto-switch actors.

### 5.3 No active account has access

Offer sign in, add account, request access, or open an accessible workspace. Preserve the
intended same-origin route in a signed short-lived return nonce. Do not reveal the target
organization/workspace name until access is proven.

### 5.4 Missing or revoked

Use one “Workspace unavailable” presentation for missing and unauthorized resources.
Explain that access may have changed, without confirming existence. Offer:

- retry access;
- open selected account's default workspace;
- switch/add account; and
- request access when the deployment supports a non-enumerating request flow.

If access is revoked while viewing the route, close streams, clear content, announce the
change, and move to this recovery state within the threat-model deadline.

## 6. Invitations

Invitation landing supports:

- loading/valid;
- sign-in/add-account required;
- target-account mismatch with safe account options;
- step-up required for sensitive roles;
- expired, cancelled, already accepted, replayed, and organization-unavailable;
- idempotent success; and
- retryable service/delivery error.

Before acceptance, show organization name only after the invitation secret is validated,
the proposed role/capabilities, workspace access to be granted, inviter display policy,
and expiry. Do not imply that joining an organization exposes every workspace.

Accept has a single in-flight state and is safe to retry. Success selects/open the
destination only after membership re-fetch; it does not discard current dirty work.

## 7. Organization and people settings

Organization settings separates:

- Overview (name, kind, ids for diagnostics);
- People and roles;
- Invitations;
- Billing and entitlements;
- Security and audit;
- Exports; and
- Danger zone (transfer/conversion/deletion).

Workspace settings owns workspace resource membership and API/service credentials.
Organization People may summarize workspace access but does not imply organization roles
grant content access.

Role UI distinguishes base role, **Organization owner**, **Organization recovery
steward**, and Billing capabilities. Owner and recovery steward appear as separate
human-custody counts even when one person holds both. Invitations, API keys, agents,
service principals, and either kind of deployment custodian never appear in either
count. The UI shows why an action is disabled (for example, “This is the last active
human recovery steward”), and requires explicit confirmation/step-up for owner or
steward changes.

Leave, remove, transfer, export, and delete explain scope and post-state. Destructive
buttons are never adjacent indistinguishable icon-only controls.

An active team organization with zero workspaces/resources still shows and enforces its
human owner and recovery-steward custody. A last owner/steward cannot leave, be removed,
or be demoted until an already active proved human accepts atomic transfer, or an
authorized owner starts explicit organization deletion. Deletion UI explains that
custody remains through **Deletion pending** and ends only when terminal deletion
commits; cancelling deletion preserves the same custody.

**Governance locked** is a distinct non-active safety state, not an empty organization.
It hides governance and membership mutation actions and explains that accountable human
custody was suspended. Existing workspace content remains available only through
independently active workspace grants and deployment policy. Organization settings
offers only status, safe export/support guidance, or the authorized deployment
organization-governance-custody ceremony. That ceremony names the organization, shows
delay/notices/approvals, requires the proposed owner/steward to prove their own sign-in,
and reactivates only after both human capabilities are present. It never says that an
invitation, agent, API key, or sign-in recovery can unlock governance.

### 7.1 Personal-to-team conversion and unsupported organization merge

The Danger zone offers **Convert personal organization to team** only for the current
personal owner and one named organization. The wizard is server-state-driven and shows:

1. unchanged organization/workspace/resource ids, URLs, and tenant ownership;
2. proposed active human owner and organization recovery steward, their proof/factor
   readiness, and the single-human break-glass warning when the same person holds both;
3. workspace collaborators who remain workspace-only and gain no organization role;
4. the billing authority's required explicit choice—terminate personal allowance,
   transfer an eligible balance/entitlement to this same organization, or initialize a
   new team policy—with posted ledger/payment/anti-abuse facts labeled immutable;
5. owner, collaborator, billing, and security notice destinations in masked/safe form;
6. the minimum cooling deadline, barrier conflicts, and irreversible kind cutover.

Progress maps exactly to **Review**, **Cooling off**, **Ready**, **Applying**,
**Converted**, **Blocked**, and **Aborted**. `Blocked` names the missing custody, factor,
billing, notice, or revision prerequisite and offers only safe correction/review;
`Aborted` confirms personal kind and billing stayed unchanged. Refresh and retry use the
same idempotent operation. While applying, the UI never shows team controls until the
atomic server cutover returns `Converted`; ordinary workspace content may continue
under its unchanged tenant.

The final confirmation says conversion cannot be undone, but it does not claim data was
moved or a second organization was combined. An identity-merge prerequisite links to
this separate wizard and remains blocked until `Converted`; it cannot start cooling on
`Ready` or `Applying`.

There is no organization-merge picker, drop target, or “combine organizations” action.
Any deep link, API capability, embedded-host action, or stale client attempt to name a
second organization renders the terminal safe result:

> Organization merge is not supported. No organizations, workspaces, resources,
> memberships, or billing records were changed.

The UI never offers client-side copy/reparent as an automatic fallback. Export, create,
invite, and separately authorized manual workflows may be explained without implying
equivalent ids, custody, history, or deletion.

## 8. Loading, empty, and error states

### Account

- no active account: managed sign-in gate;
- one active account: static summary plus add/manage;
- multiple: selected marker and account picker;
- re-auth required: retain label, block mutation, offer re-auth/remove;
- account revoked: remove sensitive cached content and show recovery.

### Organization

- none: personal bootstrap in progress, invite-only state, or create/join options by
  deployment policy;
- loading: fixed-size skeleton that does not flash prior tenant labels;
- partial failure: safe summaries with retry, no stale membership actions;
- governance pending: canonical organization actions unavailable until explicit human
  owner/steward and factor enrollment completes;
- governance locked: neutral locked canvas, no stale People/content controls, and only
  authorized custody-recovery guidance;
- governance locked with deployment custody unavailable: state explicitly that the
  exceptional path is not configured/viable; do not promise support unlock;
- conversion review/cooling/applying: retain personal/team labels exactly from durable
  state and never expose a partial team post-state;
- deletion pending: prominent status, blocked-create explanation, cancel if authorized.

### Workspace

- none in team org: create/request-access empty state;
- unavailable/revoked: non-enumerating recovery state;
- paused: visible status without implying access loss;
- switch load failure: remain on a neutral loading/error canvas, not old content under a
  new header.

## 9. Accessibility

- Meet WCAG 2.2 AA contrast in light/dark/high-contrast themes.
- Minimum 44×44 CSS-pixel touch targets on coarse pointers.
- Account/org/workspace trigger, selected markers, paused/revoked state, upload progress,
  and destructive blockers have text alternatives; color is never the sole signal.
- Keyboard: Enter/Space opens, arrows navigate, Home/End jump, typeahead searches,
  Escape closes without switching, Tab remains within modal/sheet, and focus returns to
  the trigger or logical destination.
- Screen readers receive concise live announcements for actor switch, workspace switch,
  revocation, invitation result, draft save, and upload cancellation. Do not announce
  every progress tick.
- Conversion, separation, authority-plane, and delivery reconciliation use textual
  durable-state headings, semantic progress/status markup, absolute deadline plus
  relative time, and one live announcement per state transition; color/spinner alone
  never conveys blocked, degraded, quarantined, unknown, or unavailable.
- Long cooling/reconciliation flows survive refresh and return focus to the state
  heading; approval/factor tables have meaningful row/column headers and do not expose
  one claimant's private proof details to another assistive-technology tree.
- Nested levels use correct menu/listbox/dialog semantics; do not create invalid nested
  interactive controls.
- Respect reduced motion; no essential state depends on animation.
- Truncation retains an accessible full label and supports 200% zoom/reflow.
- Mobile safe-area insets and on-screen keyboard do not hide actions.

## 10. Privacy and security presentation

- Show email/issuer only to the signed-in person and authorized account-management UI.
- Other organization members see the deployment's approved member label, not login
  providers or linked accounts.
- Never render secrets, invitation tokens, full auth/session ids, provider credentials,
  or unredacted network metadata.
- Clipboard “copy id” actions are explicit and excluded from normal switcher content.
- Account and organization avatars are untrusted media: use safe image policy/fallbacks
  and do not load cross-tenant private URLs without authorization.

## 11. Embedded, white-label, and CLI parity

### Embedded/white-label

- Hosts can replace product name, logo, terminology strings, routes, invitation delivery,
  and account-management shell.
- Hosts cannot collapse login account and organization identifiers or bypass workspace
  selection/RLS.
- Components accept capability/policy data rather than assuming hosted billing, email,
  or Better Auth.
- Hosts may render one-organization personal-to-team conversion but must omit
  organization merge or surface `organization_merge_unsupported`; they cannot emulate
  it by copying/reparenting resources.
- The compact switcher can render standalone inside an embedded host and emits a
  cancellable preflight request before state change.

### CLI

- `auth list` shows locally configured login profiles without secrets.
- `auth use` changes profile explicitly; `auth logout` defaults to one profile and needs
  an explicit all flag for all profiles.
- Organization/workspace ambiguity prompts interactively or errors in noninteractive
  mode; it never silently chooses by matching label.
- Deep-link/device flow preserves intended organization/workspace only in signed state.
- Credentials live in OS credential storage with file-permission fallback warnings.
- CLI conversion names one organization, shows durable state, and requires explicit
  billing/custody inputs; any second-organization/merge argument fails without writes.

## 12. Browser verification matrix

The implementation is not candidate-ready without real-browser evidence for:

| Dimension | Required cases |
| --- | --- |
| Width/input | 320 px mobile, 768 px tablet, 1024/1440 desktop; touch and pointer |
| Theme | light, dark, high contrast where supported |
| Account | one, multiple, add, re-auth, sign out one, sign out all |
| Organization | personal, team, empty active team, none, many, governance pending/locked, conversion review/cooling/applying/converted/blocked/aborted, organization-merge unsupported, deletion pending/finalized |
| Workspace | none, one, many, paused, inaccessible, revoked mid-view |
| Invite | valid, wrong account, sensitive-role step-up, expired, replayed, accepted |
| Navigation blockers | local draft, saving draft, draft conflict, uploading, failed upload, in-flight mutation |
| Network | normal, slow, offline/retry, late old-epoch response |
| Accessibility | keyboard-only, screen-reader announcements, 200% zoom, reduced motion |
| Native/device | add/switch slot, per-account/device/all-device logout, offline expiry, lost device, callback failure, push isolation |
| Identity security | link; irreversible merge prerequisites; bounded staging/apply; dispute/containment/forward repair; different-person separation proof/staging and all four terminals; duplicate personal organizations; deployment identity recovery; organization-A governance recovery with organization-B/personal noninterference |
| Deployment authority | both independent plane cards; every plane/custodian state; enrollment/eligibility/rotation/removal/replacement/compromise; degraded/lost-quorum/root-unavailable; fewer-than-three governance-custodian path unavailable |
| External delivery | receipt-confirmed, failed-confirmed, delivery-unknown, reconciling, exact-key retry eligible/ineligible, compensation, irreversible exception, finalization blocked |
| Human custody | last owner/steward leave/remove/demote; transfer; suspension to governance locked; deletion finalization; merge cutover; invitations/non-humans never count |
| Local mode | first-owner bootstrap, simplified one-of-each shell, collaboration enablement |

Evidence must include the defect/baseline and verified result, be scrubbed of identities,
emails, tokens, tenant ids, file content, and billing details, and be attached to the
durable issue history.

## 13. Acceptance checks

- The selected account, organization, and workspace are always knowable.
- Switching one level never silently changes another actor or discards work.
- Account-specific sign-out does not destroy unrelated active accounts.
- Deep links recover across active accounts without leaking inaccessible tenants.
- Old-tenant network results never render after epoch switch.
- Draft/upload guards are exercised, not mocked away.
- Empty/loading/error/revoked/invite states are intentionally designed.
- Conversion never grants collaborators, changes tenant ids, or suggests organization
  merge; unsupported attempts show a no-change result.
- Wrongful-merge separation never offers shared temporary sign-in, and every terminal
  state truthfully distinguishes quarantine, irreversible exceptions, and containment.
- Recovery UI never promises unavailable custodian/root paths, and delivery-unknown UI
  never presents blind retry or implied success/failure.
- Keyboard, screen-reader, mobile, and both themes pass with useful evidence.
- No brand, hosted billing provider, Better Auth, or Codex-specific assumption is baked
  into the reusable contract.

## 14. Login linking, identity merge/separation, and recovery UX

The UI never labels identity merge as merely “link account.” The product exposes five
distinct actions with distinct consequences in account or organization settings:

- **Add sign-in method** for an unowned login binding;
- **Merge two existing identities** when both bindings already own identities;
- **Separate identities after a wrongful merge** only from a contained different-person
  incident and under closed deployment proof;
- **Recover sign-in or human identity** when a deployment-wide authentication path or
  global human status is unavailable or compromised; and
- **Recover organization governance** inside exactly one named organization.

Linking shows target human/account summary, issuer, callback origin, ten-minute proof
expiry, and a cancel action. A provider callback that discovers another owner stops at
`Merge required`; it does not continue with an email-based confirmation.

The merge wizard renders the server's revision-bound conflict manifest. It requires an
explicit decision for:

- which personal organization remains personal and whether each other one is converted
  to team, exported/deleted first, or the merge is cancelled, with conversion/finalized
  deletion labeled an irreversible prerequisite that must complete before cooling;
  conversion links to section 7.1 and satisfies the prerequisite only at **Converted**;
  organization merge is shown as unsupported, never as an alternative;
- the exact source contributions and proposed canonical organization/workspace grants,
  with each active team's owner/steward post-state and separation-of-duty block;
- pending invitation duplicates;
- deployment identity-recovery effects (which are never unioned from organizations) and
  each organization's separate owner/recovery-steward outcome;
- personal billing/entitlement hold and billing-owner decision; and
- counts and owner categories for drafts, pins, uploads, connections, and keys without
  exposing their secret content.

No preselected destructive answer is allowed. Every irreversible prerequisite and known
external/posted effect requires a separate explicit acknowledgment; cancel remains
available until cutover. The review screen names both identities, the canonical
survivor, affected organizations, sessions and personal credentials that will be
revoked, the 24-hour or post-recovery 72-hour cooling deadline, notification
destinations in masked form, the **30-day dispute and containment window**, and the fact
that audit identities and irreversible facts are not rewritten.

Progress maps one-to-one to durable states: **Evidence pending**, **Conflict review /
blocked**, **Cooling off**, **Aborted**, **Ready**, **Staging**, **Applying**,
**Applied—observation window**, **Contained**, **Repair review**, **Repairing**,
**Finalization blocked**, **Repaired with/without exceptions**, and **Finalized**.
Staging may show bounded progress and a safe cancel/retry result, but staged rows are
not presented as active access. There is no
**Reversible** or **Reversed** state and no promise that merge can restore destroyed
facts. Refresh/retry reads the same durable operation; it never starts another merge.

Every notified identity receives a safe **Dispute this change** path during cooling and
the applied-observation window. A post-apply dispute first shows **Contained**: affected
human sessions/credentials are revoked, sensitive identity/governance/billing/private
owner changes are fenced, and existing objects are neither silently moved nor deleted.
The subsequent review lists per-category lineage and proposed forward outcomes for
memberships, invitations, private assets, billing/entitlements, credentials, deletes,
audit, external effects, and personal organizations. Each row ends as retained,
transferred, revoked, quarantined, compensated, or irreversible. Approval expiry after
14 days is visible and does not release containment. The signed completion report names
remaining exceptions and available export/support options without exposing the other
identity's private content.

### Separate identities after a wrongful merge

This surface appears only after merge containment determines that two different people
were, or may have been, joined. Until a terminal separation cutover, the header says
**Identity contained—sign-in disabled** and explains that every source/canonical slot,
session, personal credential, delegated token, cache, and stream is revoked. It never
offers “use the canonical account for now,” because both people must not resolve to one
active identity.

The revision-bound review separately shows, without exposing one claimant's secrets to
the other:

- fresh proof status for each claimant and the independent deployment identity-
  separation quorum/incident basis;
- whether the retained source human id can be reactivated or a replacement with
  immutable lineage is required;
- every login as **proved for claimant A**, **proved for claimant B**, or
  **quarantined**—never inferred from email/label;
- each personal organization as retained, unavailable because previously converted/
  deleted, or unresolved, with no promise of recreation;
- per-organization membership/role/custody decisions awaiting that organization's own
  authority, explicitly stating that deployment identity authority cannot grant them;
- unique private rows proposed for transfer and joint/ambiguous rows proposed for
  quarantine; and
- posted/deleted/audit/external facts that are irreversible or still delivery-unknown.

Progress maps exactly to **Evidence pending**, **Separation review**, **Blocked**,
**Cooling off**, **Ready**, **Staging**, **Applying**, **Separated**,
**Separated with quarantine**, **Separated with irreversible exceptions**, or
**Contained unresolved**. Cooling shows at least seven days, notices, disputes, and
current plane/revision status. Staged rows are labeled inactive. Refresh/retry resumes
the same generation; a stale proof/callback cannot reopen sign-in.

After any `Separated*` outcome, the UI requires each person to authenticate again and
does not revive an old slot or credential. A signed completion report lists only that
viewer's resolver/login outcomes plus scope-safe retained/transferred/revoked/
quarantined/irreversible categories. **Contained unresolved** says no safe proof/
authority was available and neither claimant can sign in through the merged resolver;
it offers a new full incident attempt only when prerequisites change, not a weaker
tenant/support override.

### External delivery and merge finalization

External-effect rows use truthful labels: **Prepared**, **Publishing claimed**,
**Receipt confirmed**, **Failed before acceptance**, **Delivery unknown**,
**Reconciling**, **Compensation pending**, **Compensated**, or **Irreversible exception
approved**. `Delivery unknown` says the provider may have accepted the effect. It shows
last checked time, provider query/idempotency capability in safe terms, next bounded
reconciliation step, owning scope, and support/authority action without showing payload,
secret, destination credential, raw receipt, or provider key.

There is no generic **Retry** after ambiguity. A button appears only when the server says
exact-key idempotent retry is permissible, and its confirmation says the exact stored
request is reused; query is preferred when available. A non-queryable/non-idempotent
effect says **Automatic retry unavailable—duplicate effect risk**. Compensation and
unresolved-exception actions appear only to the exact owning subsystem plus tenant or
billing authority and clearly create a separately claimed child effect/report rather
than editing history. Its status is shown beside the preserved original delivery state;
a failed or unknown compensation never makes the original look compensated.

At the 30-day deadline, unresolved effects render **Finalization blocked**, not
Finalized or Failed. The page names affected categories and continues reconciliation.
If scoped authorities approve an unresolved irreversible exception, the terminal label
is **Repaired with exceptions** with a signed report; the UI never relabels an unknown
receipt as delivered.

### Recover sign-in or human identity

This deployment-level surface cannot be launched from an organization role control. It
states:

> This recovery affects this human identity across this deployment. Existing active
> organization and personal-workspace grants are not changed, but they may become usable
> again after sign-in is restored.

It lists only the requested global effects, such as revoke a compromised login, attach
a newly proved unowned method, rotate a human recovery factor, or restore the same
human's global status. It shows the selected closed authority path, distinct proved
factors, eligible/received deployment identity-recovery custodians, 24-hour/72-hour/
seven-day minimum delay, masked notice destinations, incident/legal approval where
required, expiry/dispute state, and final fresh-proof requirement. Organization owners,
organization recovery stewards, invitations, service credentials, and ordinary support
sessions are never displayed as eligible global approvers.

The selected identity authority path also shows its plane state and current
availability. `Degraded`, `Reconstituting`, or `Disabled—offline root unavailable`
blocks submit/apply and states that tenant administrators and support cannot lower the
quorum. If the self-recovery path remains independently viable, it is presented as a
different closed path, never an automatic fallback.

Before apply, the confirmation explicitly says every browser/native slot, auth session,
personal credential, offline cache, user-bound delegated token, and live stream for the
human will be revoked before the new path is usable. It also says organization-owned
service credentials and organization governance are unchanged. Failure to meet factor,
custodian, notice, delay, or current-revision requirements produces a fail-closed result
with no login attached; it never offers a weaker organization-scoped fallback.

### Recover organization governance

This organization-settings surface names exactly one organization in its heading,
confirmation, notices, and durable status. Its scope warning states:

> This can change human ownership or recovery stewardship only in **{organization}**.
> It cannot recover sign-in, change global human status, or affect another organization
> or personal workspace.

The ordinary flow shows eligible active human organization recovery stewards,
organization-scoped approvals/delay, requested membership/custody effects, governance
revision, notices, and incident/reason. A deployment-custody flow appears only for
`governance_locked`; it names separately enrolled **deployment organization-governance
custodians**, is visually and textually distinct from deployment identity-recovery
custodians, requires a delayed audited ceremony, and requires the proposed human to
prove their own usable login. Successful completion re-fetches only the named
organization's custody and grants; all other organization/personal summaries remain
unchanged. Any scope or revision mismatch fails closed rather than broadening recovery.

If the governance-custody plane is not `Enabled` with at least three eligible
custodians, this surface says **Exceptional governance recovery unavailable** and names
the safe configured/unconfigured/degraded/reconstituting/offline-root-lost state. It
does not show a support CTA that implies unlock authority. Ordinary steward or
organization-factor recovery remains separately shown only when actually viable.

### Deployment authority-plane administration

Deployment security settings render two separate cards: **Identity recovery authority**
and **Exceptional organization-governance custody**. Each card shows its own root digest
fingerprint (never secret material), policy/revision, path/quorum configuration, state,
viability, notice status, and last verified ceremony. Shared human names do not visually
join the cards, and the UI explicitly says enrollment/factors/approval in one plane has
no authority in the other.

Plane status labels are **Unconfigured**, **Enrollment pending**, **Enabled**,
**Degraded**, **Reconstituting**, and **Disabled—unavailable**. Custodian rows expose
**Enrollment pending**, **Cooling off**, **Active—not yet eligible**, **Active**,
**Factor rotation pending**, **Revocation pending**, and **Revoked**, with eligible-at/
approval-expiry times. No tenant/content discovery link is present.

Enrollment, activation, planned removal, factor rotation, replacement, compromise
revocation, and lost-quorum reconstitution are distinct step-up wizards that show
offline-root/operator separation, exact current revisions, cooling/eligibility,
notices, and post-state quorum. Ordinary removal is disabled if it loses quorum unless
an atomic replacement is ready. **Revoke compromised custodian now** remains available
and warns that the plane may become degraded and all dependent recovery will stop.

Lost-quorum reconstitution shows the precommitted offline-root requirement,
independent incident basis, at least seven-day cooling, complete recovery freeze, and
new eligible set. If the offline root is unavailable, only **Disable as unavailable**
and audited operator guidance remain; there is no lower-quorum, tenant-vote, support,
or first-admin option. Fewer than three governance custodians displays **Exceptional
organization unlock unavailable** and product copy elsewhere must match.

## 15. Native/device session UX

Native clients present the same independently revocable account slots as web, but name
the installation/device in security settings. **Signed-in devices** shows last verified
time, approximate platform label, contained accounts, and status without exposing token,
push, hardware key, or full network identifiers.

Actions are separate and explicit:

- **Sign out this account on this device**;
- **Sign out all accounts on this device**;
- **Sign out this account on all devices**; and
- **Mark device lost**, which revokes the installation, every slot/token family, and
  push registration and explains that remote wipe is best effort.

Adding an account opens an OS-verified app/universal link, loopback, or device-code flow.
An unverified custom-scheme callback produces a safe failure and cannot select an
account. The app displays the expected issuer/host before leaving and validates the
server operation after return.

Offline presentation is metadata-minimal. High-sensitivity content says **Online access
required**. Other encrypted cached content displays its last verified time and a fixed
expiry no later than 24 hours; clock rollback cannot extend it. At expiry, revocation,
secure-store failure, installation mismatch, or backup restore to another device, the
app seals/removes the cache and requests reauthentication without flashing old content.

Push notifications contain generic copy such as “OpenGeni has an update” unless the app
has fetched and authorized the opaque notification id while unlocked. Account/tenant
labels and content do not appear in OS push payloads. Opening push runs account/tenant
resolution and the normal switch preflight; it never silently changes actor.

Native accessibility, dirty-work, epoch, cache, and deep-link requirements are identical
to web. Device evidence includes offline, lost, replayed refresh, wrong callback, reused
push token, secure-store unavailable, and two-account/two-tenant cases.

## 16. Local/self-hosted bootstrap and simplified single-user UX

Before bootstrap completes, the shell shows a local/operator claim screen only on an
allowed listener. It asks for the one-time operator-delivered bootstrap secret and the
configured/OS-bound human proof; it never offers “continue as first user.” It explains
that one personal organization/workspace and a human identity-recovery factor will be
created. It separately explains that the same human cannot exercise single-person
organization stewardship or enable collaboration until a distinct organization
break-glass factor is enrolled and acknowledged.
Concurrent claim, reused secret, unknown/non-human subject, or remote-listener refusal
uses a generic safe error and operator instructions. Restart by the same proved human
returns the exact existing setup rather than duplicating it.

Secure deployment setup separately asks the operator to configure each deployment
authority plane with an offline root and pending enrollment, or mark it
**Disabled—recovery unavailable**. The first human, bootstrap secret, personal owner,
ordinary support, and the other plane are never offered as root substitutes. Root
fingerprints and policy revision are acknowledged without displaying/storing root
secret material. Bootstrap completion does not auto-enroll the first human as either
custodian.

Before the shell advertises any recovery path, a summary shows it as **Viable** or
**Unavailable** under the current factor/custodian quorum. Fewer than three eligible
governance custodians means exceptional team unlock is unavailable; setup may continue
only after the operator acknowledges that exact limitation. A plane sharing a human
with the other still presents separate enrollment, factor, cooling, and revision.

`single_user_simplified` mode may activate only from the server capability when
collaboration is disabled and exactly one active human, login slot, personal
organization, and workspace exist. In that mode:

- the primary rail trigger may show only workspace name/status;
- redundant account/organization switch rows, People, and Invitations are hidden;
- accessible Settings still names account, organization, workspace, recovery status,
  ids in diagnostics, export, and danger-zone scope; and
- sign-out, recovery, export, delete, credential, and billing confirmations always name
  their complete owner/scope.

The UI must not infer simplified mode from list length alone. It renders normal
collaborative controls immediately when the signed server capability disappears.
**Enable collaboration** is a step-up security flow that verifies both the human
identity-recovery factor and the distinct organization break-glass factor, explains
roles/invitations/content boundaries, disables simplified mode, and only then enables
invitations/additional humans. Workspace/organization ids, URLs, drafts, keys, and
resources remain unchanged; there is no “upgrade migration” that loosens RLS.

Acceptance evidence covers first-claim race/restart, separate identity/organization
recovery-factor enrollment, both plane-mode choices and root fingerprints, every
custodian lifecycle state, degraded/lost-root/fewer-than-three unavailability,
simplified desktop/mobile/keyboard/screen-reader shell, destructive scope labels, and
the collaboration transition with the same tenant ids and no stale simplified cache.
