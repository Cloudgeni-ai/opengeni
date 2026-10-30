# Shared connection presentation

The console and embedding hosts consume the same React connection surfaces.
The SDK owns presentation and native connection orchestration; the server owns
authorization. See [product integration](product-integration.md) and
[MCP connection cutover](remote-mcp-credentials.md).

## Discovery and management

`ConnectPanel` composes native account inventory, acquisition and setup recovery.
Account management precedes discovery. Terminal attempts leave setup rather than
showing reconnect actions after success. Its optional SDK client resolves names
and authenticated marks by exact catalogue connection ID. Connected accounts are
directly expandable rows without a separate Manage step; disconnect retains
versioned confirmation.

`ConnectionDiscovery` lists native OAuth MCP services and exact active-account
status. Other provider adapters use the native Connect chooser. Unavailable
providers and providers without supported ownership are excluded from chooser
inventory, search and select options. Deployment diagnostics are not a customer
discovery surface. Generic MCP/API acquisition lives in a secondary custom picker.

Hosts may disable custom acquisition with `showCustomConnections` and include
ready native provider adapters with `showProviderConnections`. These are only
presentation switches: the backend must admit its chosen acquisition surface and
supply the matching filtered catalogue. The SDK contains no product-specific
service list. Hosts may compose other capability categories without adopting the
console's entire capabilities page.

## OAuth details and conversation use

`McpConnectionCard` without a session ID configures only a connection: it never
reads a session or selects tools.
`SessionMcpCapabilityCard` supplies a session target to that same implementation.
Console OAuth setup and embedded service discovery share it; existing console
management and non-OAuth adapters remain distinct surfaces. Initial detail reads
use an effect-lifetime fence independent of the action lock, so development
remounts cannot suppress replacement initialization.

`SessionCapabilityFrame` owns the in-chat recommendation shell and protected
dialog focus. Recommendations resolve against the live catalogue, use the native
Connect controller and exact host return URL, and require backend-verified
completion. An isolated provider window is reserved before discovery; successful
authorization attaches the capability while preserving existing selections.
An agent-proposed remote MCP endpoint uses this frame for a human-editable URL
review form; submitting it adds a catalog entry only after the authenticated
human's ordinary Capabilities permission check. The existing catalog card then
owns credentials, enablement and conversation tool attachment.
Personal accounts belong to the authenticated sender; sharing a conversation
does not delegate account access. No separate conversation consent is required.
Completion derives from live credentials and tool selection, never a browser
success flag.

Once a chat card's setup is verified (in-card connect or API key, an existing
connection used here, a personal account allowed here, or the OAuth return
handled by `finishMcpCapabilityOAuthReturn` and
`completeSessionCapabilityOAuth`), the client calls
`continueAfterCapabilitySetup`. The API checks that the agent's latest card for
that capability is in this chat, that the capability is now usable here, that
nobody has written since the card, and that the caller is the person whose
request it was. It then records one `capability_setup_completed` internal
update, deduplicated on the card event, which wakes the agent to continue
without the person having to say they are done. Failed or cancelled setup
never calls it, and its result never affects the setup the person finished.
Hosts with their own card flows call `client.continueAfterCapabilitySetup` after
verified setup; older servers answer 404, which the shared helper ignores.

Tool selection lives in `packages/react/src/session-capability-policy.ts`.
`sessionAuthRecommendation` matches recovery notices by exact native server or
connection identity; `SessionConnectionRequest` exposes it to embeds. Missing or
ambiguous matches never choose another account by provider domain.

Account choices narrow the authenticated sender's own accounts; they never grant
access. Multiple matching accounts require an explicit choice. Background work
inherits captured initiating-user authority. Authenticated catalogue marks use
`client.downloadCatalogAsset`; passive downloads are bounded and reject arbitrary
URLs.

## Shared conversation controls

`conversationTimeline` owns queue and optimistic-message reconciliation.
`SessionChrome` presents queue and goal signals with grouped activity.
`ChatComposer.footer` replaces normal controls inside the native controller;
annotations, draft recovery, attachments, keyboard delivery and confirmation stay
shared. Host translations are message overrides, not a separate locale subsystem.

`SessionCommands` supplies the shared background-command controller and panel.
Mount it only in the open activity drawer. It accepts the hook's explicit
client/workspace override and does not fetch history. Keep command and connection
setup implementations outside the initial session bundle.
## Duplicate OAuth accounts

All MCP OAuth callbacks use the shared owner/resource policy in
`apps/api/src/integrations/oauth-account-identity.ts`. Connect never implicitly
selects the first credential for a provider domain. Explicit reconnect binds the
exact connection and MCP URL. Callbacks serialize the workspace, owner and exact
resource bucket before inspecting or writing connections.

Authenticated verification adapters declare their identity metadata tuple
(including a tenant when identities are tenant-scoped); display names are never
identity. A repeated Connect for an active verified account returns its existing
ID without rotating credentials, resetting approvals or rewriting accepted work.
Changed permissions or an inactive account require explicit reconnect. A known
identity cannot change during reconnect.

OAuth and MCP do not require an account-identity endpoint. The policy never
treats opaque tokens, unverified JWTs or missing identity as proof that two
accounts are the same. A reviewed verification adapter can enable distinct
accounts without changing the persistence policy.

### How accounts are identified

Identity comes from the first of these that applies to the connection:

- The OAuth profile's own adapter: Slack, Gmail and Google Calendar.
- A reviewed adapter for the exact MCP URL in `accountIdentityVerifierFor`
  (`apps/api/src/integrations/oauth-profiles.ts`):

  | Service | Read | Identity | Label |
  | --- | --- | --- | --- |
  | Google Drive | Drive About | `googleDriveEmail` | email |
  | Atlassian Rovo (`/v1/mcp/authv2`, `/v1/mcp`) | `atlassianUserInfo` tool | `atlassianAccountId` | email, name |
  | Linear | `get_user` with `query: "me"`; optional `get_workspace` | `linearUserId` | email, name, workspace |
  | Notion | token response `workspace_id` and `user_id`; else a person from `notion-get-self` | `notionWorkspaceId`, `notionUserId` | email, name, workspace |
  | Asana (`/v2/mcp`) | `get_me` tool | `asanaUserId` | email, name |
  | Stripe | `get_stripe_account_info` tool | `stripeAccountId` | email, account name |

- Generic OpenID Connect, when nothing above applies, `openid` was granted and
  the authorization server's metadata advertises a `jwks_uri` or
  `userinfo_endpoint`. A token response `id_token` is used when its signature
  (asymmetric algorithms only), issuer, audience (our client id) and expiry
  verify; otherwise userinfo is called with the access token. The identity is
  the issuer-scoped `sub` (`oidcSubject`); `email` and `name` are only labels.
  The connection records `accountIdentityMethod: "oidc"`. Today this covers
  services such as PostHog, Zapier, Vercel, Mobbin and PagerDuty.

Identity reads run after the normal tool verification with the new token,
within a short budget that keeps time for saving the connection. Every read is
non-fatal: a failure leaves the identity unknown and is logged with a
secret-free reason (`tool_missing`, `tool_error`, `timeout`, `budget_exhausted`,
`invalid_identity`, `userinfo_http_<status>`, `id_token_<reason>`). A reconnect
of a verified account whose identity cannot be read is refused as unconfirmed
(`account_identity_unavailable`), not reported as a different account.

Some MCP URLs reach the same accounts (`accountMcpUrlGroup`, for example
`https://mcp.stripe.com/` and `https://mcp.stripe.com`). Connections through any
of them count as the same resource for duplicates and share one lock.

### One account per person when a service can't identify accounts

Services with no identity source (HubSpot, Sentry and Apollo among the
catalog's, and any custom MCP without OpenID Connect) follow a one-account
rule, enforced in `decideOAuthAccountConnection`:

- Each person sees at most one connection to the resource: a second one in
  the same owner bucket is refused.
- A personal connection is refused while a shared (workspace) one exists, and
  a shared one is refused while the person adding it has their own.
- Different people may each have their own personal connection, because each
  only sees their own. If a shared connection is then added, both stay, and
  they are labelled "Yours" and "Shared".
- Reconnecting an existing connection is unaffected.

The refusal reason is `account_limit_one`: "This service doesn't tell us which
account you signed in with, so you can connect one account. Disconnect it to
use a different one." A service that can identify accounts but whose read
failed this time answers `account_identity_unavailable` instead. Callbacks lock
the shared bucket and the requester's personal bucket, in that order, so
concurrent personal and shared connects cannot both pass.

Connections made before identity existed for a service have none. Adding
another account alongside one is refused with `account_reconnect_required`
("Reconnect your existing account once, then add another."); a reconnect
records its identity.

### What people and agents see

Connection lists (`GET .../connections`) add `accountIdentity` to OAuth MCP
connections: `verified` (the account is known), `reconnect` (the service
identifies accounts but this connection must be signed in again once) or
`single` (the one-account rule applies). The connector page uses it to hide
Add account and show the matching sentence instead, and to offer Reconnect on
an account that needs it.

Account rows and pickers mark each account "Yours" (the viewer's own) or
"Shared" (the workspace's), with "From <workspace>" when it was added
elsewhere. Agents see each account route as `<connector> — <account> · Yours`
or `· Shared`, so a personal and a shared connection never read the same.

Existing duplicate records are not deleted or rebound by this flow. Their
accepted session/schedule references and approval policies remain intact.
Account lists and pickers show available provider names, workspace names and
emails; internal IDs and hashes are not account labels.
