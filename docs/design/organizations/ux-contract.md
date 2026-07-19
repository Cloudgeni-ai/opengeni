<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# Account → organization → workspace UX contract

Status: **proposal; implementation follows approved ADR/threat model**

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

## 2. Information hierarchy

The compact rail header shows three levels:

1. **Account** — avatar plus the selected login-account display name/email and issuer
   when needed to disambiguate.
2. **Organization** — organization name and personal/team indicator only when useful.
3. **Workspace** — prominent current workspace name and operational state.

The workspace remains the primary action. Account and organization rows are visually
quieter. In collapsed desktop mode, one workspace avatar opens the combined switcher;
the accessible name includes all three selected labels. On mobile, the same content is
a bottom sheet/full-height drawer, not nested hover menus.

Never present raw UUID fragments as the normal organization name. A diagnostic details
view may show copyable ids to authorized users.

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

Role UI distinguishes base role from Billing and Recovery capabilities. It shows why an
action is disabled (for example, “last human owner”), never counts an API key as a
person, and requires explicit confirmation/step-up for owner or recovery changes.

Leave, remove, transfer, export, and delete explain scope and post-state. Destructive
buttons are never adjacent indistinguishable icon-only controls.

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

## 12. Browser verification matrix

The implementation is not candidate-ready without real-browser evidence for:

| Dimension | Required cases |
| --- | --- |
| Width/input | 320 px mobile, 768 px tablet, 1024/1440 desktop; touch and pointer |
| Theme | light, dark, high contrast where supported |
| Account | one, multiple, add, re-auth, sign out one, sign out all |
| Organization | personal, team, none, many, deletion pending |
| Workspace | none, one, many, paused, inaccessible, revoked mid-view |
| Invite | valid, wrong account, sensitive-role step-up, expired, replayed, accepted |
| Navigation blockers | local draft, saving draft, draft conflict, uploading, failed upload, in-flight mutation |
| Network | normal, slow, offline/retry, late old-epoch response |
| Accessibility | keyboard-only, screen-reader announcements, 200% zoom, reduced motion |

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
- Keyboard, screen-reader, mobile, and both themes pass with useful evidence.
- No brand, hosted billing provider, Better Auth, or Codex-specific assumption is baked
  into the reusable contract.