# External users and embedded connection setup

Use these APIs only when the installed SDK and deployment expose them. This
guide describes implemented external identity, service lifecycle, core
Personal/private session access, and curated OAuth paths—not completion of every
white-label surface. Optional native linking is explicit delegation, not account
merging. Full provider coverage remains unfinished. Do not infer guarantees from
the presence of a contract type.

## Optional use of an existing native account

Ordinary embedding needs only `asUser`; never require native registration or
linking for a product user. For an existing OpenGeni user who deliberately wants
the product to use their native workspace access, begin a link through the
external client with `beginIdentityLink`. Show the returned challenge only in
the native consent URL fragment, never its query, logs or analytics. The native
`/identity-links/:linkId?organization=:organizationId#challenge=:challenge` page
requires the user's real native login, displays both identities and the requested
permissions, and permits narrowing before confirmation. The fragment is scrubbed
before the application mounts. A page reload requires reopening the original
consent URL. Poll `getIdentityLink` from the product backend for confirmation.

After explicit confirmation, choose linked mode on the backend:

```ts
const linked = serviceClient.asLinkedUser(authenticatedUser.id, {
  source: "my-product",
  linkId: confirmedLink.id,
  expectedLinkRevision: confirmedLink.revision,
});
```

Use the same source and opaque ID used at initiation. A confirmed link does not
change `asUser`, move external sessions or credentials, or merge accounts. New
linked work belongs to the native user. Requests intersect the key's permissions,
the live native user's permissions and the approved link ceiling. Never fall back
to service or external mode when linked authorization fails.

Link expiry is optional; null means until revoked. Either confirmed participant
can revoke using the observed revision. Accepted linked turns, scheduled task
revisions, child sessions and causal continuations retain the link restriction;
revocation denies later execution without requiring the original API key to stay
active. This is an execution-time check, not a promise to undo a remote operation
already started. Native access to native-owned resources remains intact. Do not
assume external-owned host MCP bindings transfer to the native owner through a
link: create a separate binding while explicitly acting as the native user.
Its owner revision is the native member's revision; linked work independently
retains the live link restriction. `listIdentityLinks(workspaceId, cursor?)`
provides a participant-only inventory, and native workspace settings expose the
same list/revoke behavior without retaining the original consent URL.

## Separate service administration from user requests

Keep one organization-key client on the trusted product backend. After product
authentication, derive the immutable external identity from the server session:

```ts
const actor = serviceClient.asUser(authenticatedUser.id, { source: "my-product" });
const transport = actor.connectTransport();
const providers = await transport.catalog(authorizedWorkspaceId);
```

Here `serviceClient`, `authenticatedUser`, and `authorizedWorkspaceId` are
host-owned dependencies, not fields accepted from the browser. `asUser` creates
a separate client and does not mutate the service client. It requires an
organization key; a workspace key or deployment access key is not a substitute.
Never retry a denied user request using the unscoped service client.

An organization key is trusted to assert and lazily provision product users;
there is no separate provisioning permission or registration ceremony. The first
authenticated request may create the identity anchor even if its later workspace
operation is denied. Workload permissions still restrict that operation. Derive
IDs from authenticated host records and bound onboarding in the host; never
forward arbitrary browser-supplied identities. Personal identity anchors are not
shared product-tenant workspaces or a way to obtain workspace membership.

Identity is scoped by organization, source and opaque external ID. Source
defaults to `default`; use a stable source namespace when multiple identity
systems share an organization. IDs are case-sensitive, not emails to normalize:
maximum 1024 UTF-8 bytes for the ID and 200 for source; empty strings, NUL and
invalid Unicode are rejected. A native-looking ID does not impersonate a native
user. Workspace mapping identity passed to `ensureWorkspace` is a separate
concept from this acting-user identity.

User mode lazily establishes an external identity but does not grant access to a
shared workspace. An explicitly authorized service onboarding operation may use:

```ts
await serviceClient.addExternalWorkspaceMember(authorizedWorkspaceId, {
  identity: { externalId: authenticatedUser.id, source: "my-product" },
  permissions: ["workspace:read", "connections:read", "connections:write"],
});
```

Do this only after the host has approved membership, not on every arbitrary
browser request. The service needs `members:manage` and may not grant authority
beyond its ceiling. Identical onboarding replays safely; different permissions
conflict instead of overwriting a subsequently reduced grant. Installation also
needs `capabilities:manage`; do not add it unless installation is a product
feature the user may perform. User requests intersect actual membership with
the initiating key's permissions. Service administration remains separate.

### Removal and account-wide lifecycle

Use the service client's existing `removeWorkspaceMember(workspaceId, subjectId)`
to remove an external actor from a shared workspace. It requires `members:manage`,
rechecks the live key, preserves the last-admin guard, and uses the same fenced
settlement/cancellation path as native removal. It does not disable the actor in
other workspaces. Ordinary `asUser` reads never restore removed membership.

For account-wide changes, call `serviceClient.updateExternalIdentityMembership(
organizationId, organizationMembershipId, request)`. The membership ID comes from
the identity returned by onboarding; the initial membership authorization
revision is 1. The request contains `kind` (`suspend`, `reactivate`, or `offboard`),
`expectedAuthorizationRevision`, a UUID `operationId`, and optional `reason`.
Keep the returned membership revision for the next transition. Reuse the exact
operation ID and body when reconciling an uncertain response, never a different
transition under the old ID. Replay still requires live service authority.

This endpoint requires the organization service key's explicit `account:admin`;
the external-user lane and native-user targets are rejected. Suspension disables
new external admission and uses the canonical organization protocol to revoke
work and grants. Reactivation restores admission only: workspace memberships,
scheduled work, and resource grants are not restored. Offboarding is terminal
through this API and follows the existing organization retention policy; it is
not immediate deletion of history or upstream provider consent. Audit records
identify the service key separately from native administering memberships.

### Personal workspaces and private sessions

An admitted external actor can access its exact provisioned Personal workspace;
`asUser` workspace discovery includes that pointer when the key permits
`workspace:read`. This is not a service-key fallback, and `ensureWorkspace`
continues to provision shared product-tenant workspaces only. Personal permissions
use the same non-administrative owner set as native Personal workspaces,
intersected with the key ceiling. No Personal member-management wildcard is added.

Core session creation, private-read authorization, listing, pinning, visibility
changes, and same-workspace fork operations use dedicated external owning-user
proof. The native-cookie flag remains false. Private creation still requires
platform readiness and, in shared workspaces, the existing organization private
session setting. Request-time session creation/tenancy commits recheck the live
key and identity generation; a failed recheck rolls back the mutation. Forking
private content into workspace visibility retains the existing explicit sharing
acknowledgment. Private sessions do not make shared-workspace Files or Sites
private. Full personal-resource, worker, stream, and scheduled-execution parity
still needs its own integrated verification; do not promise it from these core
session checks alone.

## Host bridge and browser ownership

Expose only the Connect operations the product needs through authenticated,
same-origin backend routes. Every route must authenticate the host session,
derive the actor and workspace mapping server-side, and apply the host's normal
CSRF protection to mutations. Never forward an arbitrary upstream URL, actor
header, organization ID or bearer supplied by the browser. Validate request
bodies and return credential-free projections; redact errors before display or
logging. Forward cancellation without assuming it rolls back server effects.

The backend transport implements catalog, accounts, pending, begin, get,
advance, cancel and disconnect. A browser `ConnectTransport` calls those host
routes; it never contains the organization-key SDK client. Use one
`ConnectController` per authenticated actor/workspace and dispose it when either
changes. `@opengeni/react/connect` provides optional unstyled `ConnectChooser`,
`ConnectSetup`, `ConnectAccounts` and `useConnect`. `ConnectPanel` composes the
three surfaces; import `@opengeni/react/connect.css` for its opt-in scoped styles.
The host still owns navigation and controller lifetime. Controller replacement
clears pending credential forms and prior account/catalog views.
Providing `returnUrl` to `ConnectAccounts` enables explicit reconnect bound to
the selected account's provider, ownership and ID; `ConnectPanel` wires this
automatically. Reconnect does not silently substitute a different account.

Wire session timeline `onReconnect` to the host's connection experience. Use
`findConnectRecoveryAccount` from `@opengeni/connect` with fresh account metadata
and the event's exact connection ID, then begin setup for that account. A missing
ID or deleted account requires an explicit user choice, not a provider-name match.
Host-owned credential recovery stays in the product's account flow rather than
being sent to an OpenGeni credential setup page. The native session and runnable
host example use this same exact-account lookup.

## Durable OAuth and explicit installation

1. Read catalog readiness for the actual actor. The catalog covers generic,
   curated and first-party Connect adapters. Model-account pools retain their
   dedicated SDK APIs and device flow, described below; operator configuration
   is not a user-connect action.
2. Begin with explicit provider, ownership, a stable idempotency key and the
   exact return URL chosen by the trusted host backend. Persist the attempt ID
   in authenticated host state before navigation. Do not derive the return URL
   from an unchecked browser field.
3. For popup mode, invoke `authorizeConnectAttempt` directly from a user gesture
   with `createBrowserConnectNavigation(window)`. Blocked popups are errors;
   full redirect is an explicit host choice, not an automatic fallback.
4. Recover through `get` or authenticated `pending`. The callback preserves the
   stored return URL, including escaping and fragment, without adding status
   parameters. Popup messages and URL parameters never prove completion.
5. OAuth may commit credentials while the attempt remains
   `connected_but_incomplete`. Advance with `retry` to review an integration
   preview, then submit its preview ID/content hash and explicitly selected
   operation IDs. Never assume OAuth installed all operations.
6. Changed source requires a new preview and approval. Preserve revision and
   idempotency fields on retries. An uncertain provider effect is not permission
   to start a duplicate mutation with a fresh key.

Aborting polling stops observation, not setup. Explicit `cancel` stops setup
without revoking credentials already committed. `disconnect` currently revokes
local OpenGeni connection access, not upstream provider consent. Pass the observed
account `version` as `expectedVersion` to reject a stale selection. The shared
account component requires that version and explicit confirmation; an unknown
outcome requires live reload, not automatic replay. Provider-specific account
management remains unfinished.

## Embedded Sites

`@opengeni/react/sites` exports `SiteList`, `SiteDetail` and the structural
`SiteClient` host-proxy interface. The SDK's existing published-artifact methods
implement it. `asUser` retains the public client class and artifact methods.
Sites remain workspace-shared artifacts, not private session outputs.

Use `SiteList.onOpen` for host navigation. `SiteDetail` reuses the existing
opaque-origin `PublishedHtmlArtifactFrame`; never introduce a second renderer
or put backend keys in HTML. Supply only an authenticated, filtered `toolBridge`.
Use `createSiteToolBridge` from `@opengeni/sdk/site` with the exact artifact ID,
version ID and that version's `requestedTools`. Provide an authenticated catalog
transport and `callTool` backed by the host's `callWorkspaceSiteTool` SDK method.
The native console uses this same bridge. Recreate it when the actor or version
changes. It strips iframe-supplied authority, pins the Site context, and retries
only an explicit pre-execution stale-catalog response, never an uncertain effect.
For the Site's ordinary session SDK, optionally supply `fetchResponse` with your
authenticated host transport. The shared bridge applies the same bounded
`siteSessionPath` routing as the native console and forwards only content negotiation
and event replay headers; host authentication and tenant selection remain outside
the iframe. The bridge adds its pinned Site ID/version headers (never trusts
iframe-supplied ones), enabling the API's verified Site-origin attribution on
new conversations. `originSiteId=current` resolves to that pinned Site for
conversation filtering. Provenance does not grant access or replace the acting
user/workspace authority. Keep these headers through your authenticated proxy;
do not synthesize provenance from caller-supplied session metadata.
Omit this transport for tools-only Sites. Display uses
`getWorkspaceArtifactHtml` at the observed version, not a retained-source download.
It checks Site read authority every 15 seconds while loaded and clears the frame
on denial, scope replacement or version/status change. This is bounded UI
revalidation, not instantaneous revocation of downloaded HTML; bridge calls must
independently enforce current backend authority.

`canPublish` controls presentation only. The backend still requires
`artifacts:publish`; rollback/archive/restore preserve the observed current
version and require explicit confirmation. Failed mutations clear the loaded
state and require refresh rather than an unsafe retry. Authoring buttons and
prompts belong to the host: create an ordinary authorized session and navigate
to your existing session UI. There is no dedicated SDK authoring helper or
branded Site component button. Native Site UI reuse
and complete visual acceptance remain separate integration work.

## Credentials and focused acceptance

For a named curated API integration account, pass `installationTarget: {
instanceKey, displayName, expectedInstanceVersion? }` when beginning Connect.
Reconnect uses the exact current instance version; new accounts omit that version.
The attempt retains this choice through OAuth, operation preview and installation.
Without an explicit target, setup creates an independent account rather than
overwriting a default instance. OAuth success alone still requires operation review.

Fiken's `fiken-token` catalog entry is workspace-only. Submit the `apiToken` and
optional `defaultCompanySlug` fields through the credential action; OpenGeni verifies
the token and accessible companies before storage. Resume/replay the same attempt
and operation identity rather than submitting the secret to a new attempt after an
uncertain response. The separate workspace-only `fiken-oauth` entry uses the
deployment's registered Fiken OAuth application. It preserves the exact host
return URL and atomically commits the verified company account and completion
receipt. Reconnect checks the observed account version; callback replay does not
repeat the provider exchange. Neither adapter grants personal ownership.

Native/local/configured workspace setup and organization/workspace API-key setup
use the same durable Connect flow where the adapter supports them. Service keys
cannot create personal connections. Keep keys on the product backend; a callback
uses its signed initiating principal and current authority, not a new browser login.
An external Connect attempt also retains its original key/link restriction.
Changing clients does not replace it: if the initiating key or link was revoked,
start a new authorized setup rather than expecting a new key to revive the old
attempt. This short-lived setup rule is separate from accepted agent/scheduled
work, which does not depend on the original API key remaining active.

Short-lived inline MCP credentials remain a valid simple choice. Durable host
renewal is opt-in through the existing host credential port and explicit host
binding provenance; it is not required to use `asUser` or Connect. See
`docs/remote-mcp-credentials.md` when source is available. The host must validate
live actor/binding authority; the remote adapter alone does not implement
offboarding, native linking or a complete external execution gateway.

The request-time workspace tool gateway accepts verified external users and
organization service keys. Tool catalog/operation permission filtering and
existing approval semantics still apply. The new lanes recheck current key and
identity/membership permission ceilings around provider preparation and invocation;
they do not authorize an agent attempt as a service or inherit a creator's rights.
This request-time path is not a scheduled-delegation/binding-generation guarantee.
For explicit host references, it uses the separate optional `mcpGatewayCredentials`
callback (also implemented by the configured remote adapter). Its request has
`surface: "workspace_gateway"`, a request ID and verified actor/permissions, not
session/turn IDs. Gateway responses echo that request ID instead of a session ID.
Existing in-process `mcpCredentials` callbacks remain turn-only. Do not send
durable `hostBinding` references to this gateway; they still fail closed.
The SDK also exposes actor-scoped `createHostMcpBinding`, `getHostMcpBinding`, and
`revokeHostMcpBinding` registry operations. Registration takes an operation ID and
a credential-free `{ serverId, destinationUrl, connectionRef }` definition with
explicit host authority. Revocation takes the observed generation and is terminal.
Bindings survive organization-key replacement for the same authorized external
owner. These operations manage metadata only: no worker or scheduled execution
currently consumes the registration ID as execution authority. The reserved
`connectionRef.hostBinding` shape is `{ bindingId, generation }`; it fails closed
unless the backend installs a live execution validator. The broker revalidates
after resolution and discards credentials after revocation. The worker's direct-turn
validator requires an immutable accepted-work snapshot. Direct external-user
creates capture one through explicit selection; later turns do not inherit it.
The actor-bound SDK also exposes `issueHostMcpDelegation`, `getHostMcpDelegation`,
and `revokeHostMcpDelegation`. Issuance takes an operation ID, binding ID, expected
binding generation, and a native-shaped user grant (`session` or `always`).
Session grants require a session ID and expected authority epoch; shared-output
grants require acknowledgement. Read/write connection permissions and live
external-owner checks apply, including at transaction commit. Revocation uses
the observed delegation generation. These operations persist grant metadata;
select them explicitly on `createSession` with
`selectedHostMcpDelegations: [{serverId, delegationId, generation}]`. The selected
tool's configured URL and host binding reference must match; the operator's host
authority admission switch must be enabled. This does not auto-install or rewrite
tools. New sessions use reusable (`always`) grants with matching visibility.
Selections participate in idempotency: changed or omitted replay selections
conflict, and replay never recaptures. Capture rechecks external authority inside
the initial-turn transaction. `sendMessage` and `steerMessage` accept the same
explicit selection for each direct follow-up. Session-bound grants can be used
there; they must match that session and its authority epoch. The selected MCP
server must already belong to the session. Each message captures atomically and
its operation ID binds the selection; omission does not inherit a prior grant.
Same-session goal continuations and child-result resumptions inherit only the
exact causal turn's accepted selection. Live revocation still blocks use; a
revoked selection is not revived by resumption. Children inherit only the exact
spawning turn's `always` grants for servers they select with unchanged visibility;
session-bound grants never cross to a child. Realtime initial selection remains unsupported.
Use the same `selectedHostMcpDelegations` field on `createScheduledTask` or
`updateScheduledTask` for browser-independent jobs. Omitted update selections
preserve existing choices; `[]` clears them for future revisions. New/reusable
sessions require `always` grants and shared-output acknowledgement; an existing
session can use its exact session-bound grant. Native task revisions, including
first reusable-session materialization, freeze the selection. Runs and their
successors keep the scheduled origin and recheck live authority before credential
resolution and physical use. The original API key is not a durable credential.
Agent-created tasks automatically derive only eligible selections from their
live accepted turn when the selection field is omitted; do not assert an owner's
unselected grant through an agent call. Explicit `[]` disables this inheritance.
Ordinary inline credentials retain their existing behavior.
Legacy OAuth starts without verified external continuations fail closed. Curated
OAuth uses the shared Connect panel. Generic MCP OAuth is also available through
`actor.startConnectionOAuth(workspaceId, { mcpUrl, returnUrl, ... })`: the trusted
host backend supplies an exact absolute HTTP(S) return URL, without credentials
or control/space characters. The signed state encrypts the external continuation;
callbacks recheck the live key/identity/workspace before exchange and credential
commit, and consume the nonce before exchange. Both success and failure return
to the original string without appended parameters; the host must reload
authenticated connection state rather than treating navigation as proof of
success. Native `returnPath` behavior is unchanged. The shared panel also offers
`mcp-oauth`: server URL input, OAuth navigation, pending recovery, account listing
and reconnect. Its callback commits credentials and the completion receipt in
one transaction; callback replay never exchanges the code again. Completion is
connection-only, not an installed integration or a grant to every server tool.
The `mcp-bearer` adapter accepts a server URL and bearer credential. The
`mcp-headers` adapter accepts the URL and a JSON object in the secret `headers`
field for single- or multi-header authentication; transport headers, duplicate
case-insensitive names and malformed values are rejected before any commit.
Both persist only
encrypted material, and uses keyed operation digests. HTTPS without URL userinfo
or fragment is required. Reconnect keeps the same destination and observed account
version. Its connection-only completion means the credential was saved, not that
the server validated it or tools were installed; the normal credential resolver
enforces the saved MCP destination when it is used. Dedicated workspace model
provider credentials still use their own guarded flows. Uncertain mutations are
not automatically retried with a new operation ID.
Explicit provider denial or missing authorization code before exchange terminates
the attempt with a replayable failure receipt; start a new attempt to authorize
again. Unknown exchange or persistence outcomes are not treated as safe retries.
Provider-specific completion is intentional: a saved credential does not mean
that repository access, a review webhook, or source synchronization is enabled.

`github-personal` preserves personal OAuth account and repository-selection proof.
`github-app` discovers installations, asks the host user to choose one, then
requires fresh owner proof before binding repository access. `github-lens` uses
the same chooser behavior but creates separate Review Bot registrations, webhook
routing and repository review bindings; it requires an active Review Bot Pack,
managed compute, and workspace administration plus secret-write permission.
Neither GitHub App flow is a generic stored user token. Pending organization-owner
approval is incomplete setup, not a connected account. Discovery currently supports
at most 99 existing installations plus the new-install option; a larger result
fails explicitly instead of silently selecting or dropping installations.

`slack-bot` is a workspace bot installation, while `slack-personal` is the official
personal Slack MCP authorization flow. Do not substitute one for the other.
`x` and `reddit` use the existing social-account domain and OAuth scopes. Workspace
social setup requires workspace administration; personal setup requires a verified
owning user. Native and host clients share callback receipts and exact returns.
Social accounts remain limited by the existing one-personal-account-per-provider
semantics. Account IDs with `social:`, `github-installation:` and `lens-registration:`
prefixes are opaque SDK identifiers; use Connect transport disconnect rather than
passing these to generic credential APIs.

Social reconnect requires the observed account ID and version. The callback must
prove the same upstream account and cannot overwrite a concurrent refresh,
disconnect or reconnect. Reload accounts after a conflict before asking the user
to start another attempt.

`mcp-install` installs an available, no-credential MCP capability after probing it;
it does not manufacture a connection. The credential-input action can contain
bounded `options` for fields: render these as selectors, not free-text account IDs.
The shared React setup surface already does this for MCP and API-source choices.

Model accounts retain their dedicated SDK and pool APIs rather than pretending
to be ordinary Connect credentials. `pollDeviceAuthorization` from
`@opengeni/connect` supplies bounded, abortable device polling, and
`DeviceAuthorization` from `@opengeni/react/connect` supplies optional presentation.
Keep opaque device state on the server. SuperGrok user pools require ordinary
workspace membership; a synthetic personal-workspace owner grant alone is not
enough. Verified external users follow the same restriction as native users.

Known Connect callbacks recover the exact saved return URL even after state
expiry. This is navigation recovery only: expired state cannot exchange or save
credentials. Poll the attempt for its actual status after returning.

`openapi` and `graphql` setup accepts a document/endpoint URL and an optional
existing connection ID. The server performs pinned source discovery and returns
an explicit operation preview. Public services do not create fake credentials.
Installation re-resolves the source and checks its revision/hash, ownership and
the selected operations. Personal installations require a personal connection.
The source is immutable once previewed. Each setup gets an independent named
installation unless the host deliberately supplies an observed instance target.

`atlassian`, `google-drive-knowledge` and `google-drive-publish` preserve the
first-party connectors rather than substituting curated API definitions.
They require personal ownership; completion means the credential was committed,
not that all projects, spaces or folders were selected or synchronized.
Atlassian source selection uses `browseAtlassianSources`, `saveAtlassianSources`
and `setAtlassianLifecycle`, retaining explicit destination, cadence and read
policy. Google Drive publishing requires an existing knowledge connection in
`reconnectAccountId`, additional provider consent and an explicitly picked writable
folder. Publication writes retain the existing default `ask` policy. Native
Atlassian and Drive connect buttons consume the same durable setup surface.

`examples/embedded-product` is a runnable loopback host reference with explicit
authentication/CSRF seams, shared Connect/Site UI, and Edit-with-Geni into ordinary
session hooks/timeline/approval/structured-input, versioned session control, and
shared durable composer/queue controls, explicit schedule management, and bounded
workspace-file uploads. Schedule operations retain native permission and approval
semantics, not a new execution delegation guarantee. Its fixed-user demo auth
is opt-in and must never be exposed publicly. Native and embedded authoring
prompts live in their respective products, not the SDK. The example's optional
trusted `completionHref` keeps completion links in the host product.
No helper grants tool permissions or changes model billing/approval/scheduling.

Test concurrent users without actor-header bleed, cross-workspace denial,
membership/key permission reduction, exact return URL preservation, pending
recovery after opener loss, duplicate callbacks, changed-source reapproval and
explicit operation selection. Keep existing session approvals and scheduling
semantics. Do not claim provider, browser or scheduled-renewal conformance from
a transport unit test.