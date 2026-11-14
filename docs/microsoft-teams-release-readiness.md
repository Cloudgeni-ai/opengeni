# Microsoft Teams release readiness

This runbook covers the Teams bot package and controlled rollout.
Source and package preparation are not deployment, tenant installation, publisher
verification, or Store approval. The environment policy in `opengeni-ops` enables
both features in staging and keeps production switches off with empty allowlists.
Those settings take effect through the normal release workflow; merging them does
not deploy the application or configure Microsoft credentials. Complete the checks
below in staging before approving a production rollout.

## Two independent integrations

The pilot supports personal conversations and explicitly approved group chats.
The existing channel route remains separately gated. The activity parser cannot
distinguish standard, private and shared channel types. The separate exact channel
allowlist denies every unapproved channel, even with broad bot rollout enabled.
An operator must verify a channel is standard before adding it; the allowlist is
not automatic channel-type detection. The separate Microsoft Teams tools connector lets an Opengeni
agent call Microsoft Graph under its selected user connection. Installing the
bot does not grant Graph access or authorize an Opengeni workspace.

Bot registration belongs to the deployment operator. Connecting a Teams
organization (tenant) belongs either to an operator-approved installer or, with
self-serve setup on, to that organization's own Microsoft 365 Global
Administrator or Teams Administrator. Workspace binding belongs to an
authorized Opengeni administrator. User account linking must establish the exact
Teams tenant/user and Opengeni human; matching email, display name, or a Teams
app installation alone is not that proof.

## Registration and tenant identities

Create the Entra app registration and Azure Bot resource in the operator's home
Microsoft tenant. Record these identities separately in private operator storage:

| Identity | Purpose |
| --- | --- |
| Home tenant ID | Bot service credential authority |
| Bot application/client ID | Azure Bot identity; manifest `bots[0].botId` |
| Teams package app ID | Stable app identity at manifest root; may differ from bot ID |
| Installing tenant ID | Customer/reviewer organization in incoming Teams activity |
| Opengeni organization/workspace | Native application authority, established by binding |

For a new Azure Bot use the supported single-tenant registration model. New
MultiTenant bot creation was deprecated July 31, 2025; do not use a tutorial that
creates one. A user-assigned managed identity is another Microsoft option, but
this implementation's client-secret configuration does not imply managed identity
support. Enable the Microsoft Teams channel and register the public HTTPS
messaging endpoint:

```text
https://YOUR_API_HOST/v1/integrations/teams/messages
```

The endpoint is configured on Azure Bot, not embedded in the Teams manifest.
Keep the bot client secret in the deployment secret store, never in the ZIP,
source control, logs, or reviewer instructions.

Home-tenant service authentication and customer Teams installation are different
boundaries. Do not interpret the home tenant as the only permitted activity
tenant, or infer external-tenant compatibility merely from successful home-tenant
testing. Test a controlled second tenant explicitly. Tenant custom-app policies,
installation approval, user linking, and any separately requested Graph consent
must each work. Bot messaging authentication is not user SSO or a Graph grant.

The Azure Bot resource type and the Entra app registration's supported account
types are separate settings. Keep the Azure Bot resource single-tenant. A
single-tenant app registration is enough for mentions, but
[conversation context](#conversation-context) in any tenant other than the home
tenant needs a multi-tenant registration; see
[Conversation context outside the home tenant](#conversation-context-outside-the-home-tenant).

Reference: [Azure Bot registration](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration?view=azure-bot-service-4.0).

## Runtime gates

| Setting | Purpose |
| --- | --- |
| `OPENGENI_TEAMS_BOT_ENABLED` | Broad bot rollout; default false |
| `OPENGENI_TEAMS_BOT_ALLOWED_TENANT_IDS` | Explicit pilot/reviewer tenant admission while broad rollout is off |
| `OPENGENI_TEAMS_BOT_ALLOWED_CHANNEL_IDS` | Exact operator-verified standard channels as `tenantId:channelId`; empty denies all channels |
| `OPENGENI_TEAMS_BOT_ALLOWED_GROUP_CHAT_IDS` | Exact approved group chats as `tenantId:conversationId`; empty denies all groups, independently of broad rollout |
| `OPENGENI_TEAMS_BOT_SETUP_ADMIN_IDS` | Explicit operator-approved `tenantId:actorObjectId` installer pairs |
| `OPENGENI_TEAMS_BOT_SELF_SERVE_SETUP_ENABLED` | Lets a tenant administrator of an admitted tenant connect it after a Microsoft sign-in; default false |
| `OPENGENI_TEAMS_WORKSPACE_ROUTING_ENABLED` | Lets a connected tenant's 1:1 chats start work in any workspace of the organization the linked person can use, within the organization's reach; default false. Turn it on only after every replica runs a release that reads `teams_bot_routes.agent_id` |
| `OPENGENI_TEAMS_BOT_CLIENT_ID` | Bot's Entra application ID |
| `OPENGENI_TEAMS_BOT_CLIENT_SECRET` | Server-only bot credential |
| `OPENGENI_TEAMS_BOT_TENANT_ID` | Home tenant used to acquire bot service tokens |
| `OPENGENI_TEAMS_APP_NAME` | The name the bot uses for itself in its welcome, help and notices (default `Opengeni`, at most 30 characters); set it to the package's `name.short` |
| `OPENGENI_MICROSOFT_TEAMS_TOOLS_ENABLED` | Independent broad Graph-tools rollout; default false |
| `OPENGENI_MICROSOFT_TEAMS_ALLOWED_WORKSPACE_IDS` | Explicit tools pilot/reviewer workspace admission |

Initial setup and account linking require a verified managed browser session.
Only shared workspaces administered by that human can be selected. Confirming
setup also links that verified Teams actor to the signed-in human atomically;
the installer does not need a second account-link confirmation. Other people
follow their own account-link flow, which proves their Teams identity with a
Microsoft sign-in (see [Account linking](#account-linking)). The installer
allowlist is explicit operator approval of a Teams actor, not proof that the
actor holds a Microsoft tenant administrator role. Keep it empty until the
operator has independently approved the intended installer. Personal messages use
the dedicated Teams private-conversation authority seam to create an owner-only
session. Like a Slack bot DM, a new 1:1 chat lands in the sender's own Personal
workspace (named by their active organization membership) while Personal
workspaces are on and they can start chats there; otherwise it stays in the
installation's shared workspace. A chat that starts landing in the Personal
workspace is a fresh conversation, and turning Personal workspaces off returns
to the earlier one; a first message still waiting to start its Personal chat
then gets the usual admission notice. The bot is still installed in, and its link still belongs
to, the shared workspace, so losing access there stops the chat. (With workspace
routing on, 1:1 chats follow
[Workspace routing](#workspace-routing) instead: they can start work in any
workspace the organization lets Teams reach, and each message is checked against
the target workspace.) This does not
grant the bot a canonical managed-browser session. Channel and group-chat
sessions stay in the shared workspace and remain workspace-visible. Both
incoming work and outgoing replies recheck the
current session audience: a direct message requires the exact linked owner and
`user_private` visibility; a channel requires shared visibility. A later audience
change blocks both directions rather than reusing a stale route grant. Human approvals happen in the authenticated Opengeni
chat reached from the accepted-task link.

An empty tenant/workspace allowlist with its broad switch off admits nobody.
The channel allowlist is always required for channel messages, independently of
the broad switch; personal messages do not need a channel entry. Its comma-separated
entries pair the tenant UUID with the complete opaque channel ID, preserving any
colons inside that ID. Removing an entry stops new work and pending replies for
that channel. Use the settings
parser's documented list format. An allowlist permits setup/use only at its
rollout boundary; it does not bypass membership, binding, account linkage,
provider token validation, tool policy, or approval checks.

Use dedicated test tenants and workspaces in staging. Its enabled broad switches
do not bypass the explicit installer/channel allowlists or account-linking checks.
Production remains fully off with empty allowlists until a separately reviewed
rollout change. If a restricted reviewer environment is needed, use exact
pilot/reviewer tenant and workspace entries with its broad switches false; never
broaden access merely to get a submission reviewed. Keep reviewer accounts,
tenant IDs and credentials outside the repository.

## Self-serve organization setup

With `OPENGENI_TEAMS_BOT_SELF_SERVE_SETUP_ENABLED=true`, an organization that adds
the app (for example from the Teams Store) connects itself. Admission still
comes first: `OPENGENI_TEAMS_BOT_ENABLED=true` admits every tenant (the Store
setting), while broad rollout off with `OPENGENI_TEAMS_BOT_ALLOWED_TENANT_IDS`
admits only listed tenants (a staged rollout). Production keeps both off until
ops turns them on. Operator-approved installers keep working alongside it.

1. A person whose tenant has no active connection messages the bot in a 1:1
   chat, or adds it in the personal scope. They get a welcome that says a
   Microsoft 365 Global Administrator or Teams Administrator connects Opengeni
   once for everyone, with a **Connect your organization** link. The link holds
   a signed proof (one hour, enough to sign up for Opengeni and create a shared
   workspace first) of the Teams tenant, the Teams user and the 1:1 chat. Group chats and channels never get this reply.
2. The setup page requires the Opengeni browser sign-in of a human and a shared
   workspace they administer. Choosing **Connect workspace** starts a Microsoft
   sign-in (authorization code with PKCE) through the bot's Entra app, at the
   tenant-specific authority of the Teams tenant. The signed state binds the
   setup proof, the tenant, the Teams user, the Opengeni person and the
   workspace; the PKCE verifier and OIDC nonce are derived from it on the server
   and never pass through the browser.
3. Microsoft returns to the setup page, which sends the code and state with the
   setup proof in the person's own authenticated request. The API checks the
   state's binding against the proof and the browser session, redeems the code,
   and verifies the ID token signature from Microsoft's published keys, issuer
   `https://login.microsoftonline.com/<tenant>/v2.0`, audience (the bot client
   ID), expiry and nonce. `tid` must equal the Teams tenant, `oid` the Teams
   user, and `wids` must contain Global Administrator
   (`62e90394-69f5-4237-9190-012177145e10`) or Teams Administrator
   (`69091246-20e8-4a56-aa4d-066075b2a7a8`).
4. The tenant is bound to the workspace and the installer is linked, as with an
   operator-approved setup, and the bot confirms in the installer's 1:1 chat.

People without either role see why on the setup page: ask your Microsoft 365 or
Teams admin to message Opengeni in Teams and connect it. `wids` lists only
active role assignments, so an administrator whose role is eligible through
Privileged Identity Management activates it first. Microsoft personal accounts
(tenant `9188040d-6c67-4c5b-b112-36a304b66dad`) can never self-serve.

An operator-approved installer (`OPENGENI_TEAMS_BOT_SETUP_ADMIN_IDS`) gets the
setup link only in reply to their own 1:1 message, never on an install event,
whose sender needn't be the person whose chat it is. Because setup links the
installer's Teams account, they too sign in to Microsoft on the setup page.
Their sign-in must be the Teams user the setup link names (`tid` and `oid`),
but needs no administrator role. A setup link forwarded to someone else is
refused with `user_mismatch` and connects nothing.

What self-serve cannot do: bind a tenant the person doesn't administer (the
Microsoft sign-in must be the same Teams user and hold an administrator role in
that tenant), replace, take over or move an active connection, or bind a
workspace that is already bound to another tenant. Even two setups racing never
rotate an active installation.

What a tenant administrator can do with a connection that already exists:

- **Active**: nothing through self-serve, and there is no operator transfer
  either. An Opengeni administrator of the bound workspace disconnects it there
  first; until then a Teams administrator can block the app in the Teams admin
  center.
- **Disconnected, same workspace**: a Global Administrator or Teams
  Administrator who is an Opengeni administrator of that workspace reconnects
  it.
- **Disconnected, another workspace**: only a Global Administrator can move it.
  The removal of the old binding and the new connection are one transaction, so
  a failed move changes nothing. The old binding is deleted together with its
  account links, routes and their delivery records (inbox and outbox, including
  unknown or failed sends); the Opengeni sessions and their history remain. The
  old workspace gets a `connection.disconnected` audit record with reason
  `released_by_tenant_administrator`, the counts of removed links and routes,
  and the Microsoft administrator as `microsoft:<tenant ID>:<object ID>` (not
  the Opengeni identity in the new workspace). This keeps a binding left behind
  by a departed admin, consultant or trial from locking the organization out.

A setup proof is single-use (its nonce is recorded at install), and Microsoft
codes are single-use and PKCE-bound.

Each setup refusal, and each refused account link, is a 4xx whose
`details.code` is `teams_connection_refused` and whose `details.reason` names
the refusal (for example `not_tenant_admin`, `user_mismatch`,
`move_requires_global_admin` or `opengeni_account_linked`). Its message says
what happened and what to do next, and the setup page and the link dialog show
it as is. The wording never names the workspace, account or person that holds a
conflicting connection, and nothing about an existing binding is revealed before
the tenant administrator sign-in passes.

A workspace links one Teams account per Opengeni account, and links survive a
disconnect. When the installer's Opengeni account is already linked to a
different Teams account in the chosen workspace, setup refuses with
`opengeni_account_linked` and changes nothing (the setup link stays usable).
The setup page then offers **Unlink and connect**: it starts setup again with a
new Microsoft sign-in and `replaceOwnLink: true`. The API removes only the
signed-in person's own link in that workspace, as **Unlink account** does, and
only after the administrator sign-in and every binding check pass and that link
is what refused the install, so a refused or abandoned attempt keeps the link.
When the installer's Teams account is linked to another Opengeni account
(`teams_account_linked`), nothing is removed and they sign in to Opengeni with
that account instead. A refused account link from the plugins page
(`link_opengeni_account_linked`) tells the person to unlink in the Teams
integration and get a new link.

Replies to tenants that have not connected are bounded across every API
replica, in separate budgets so one kind can't use up another:

- Connect cards for people who message the bot: one per person per ten minutes,
  six per person and 200 per tenant per day, 2,000 per hour overall.
- Welcomes when someone installs the app: one per person and 25 per tenant per
  day, 500 per hour overall. A tenant that pre-installs the app for everyone
  gets only a few cards.
- Short 1:1 text replies, once a person's or tenant's cards are used up: no
  cooldown, 30 per person and 1,000 per tenant per day, 5,000 per hour
  overall. They carry no card or identity proof and point to `help`, which
  always answers with the Connect your organization card. The work or school
  account notice for personal Microsoft accounts uses the card budget, then
  this one. The reply to a 1:1 message with only a file, an image or no text
  uses only this one.
- Short text replies in group chats and channels (connect first, or this
  conversation isn't turned on): one per person per minute, 10 per person and
  200 per tenant per day, 2,000 per hour overall, because everyone there sees
  them.
- `help` and `unlink` are never limited: they are what every limited reply
  points to, and they start no agent work.
- With self-serve on, people in a tenant that isn't admitted get a short
  not-available notice when they message the bot: one per person and 20 per
  tenant per day, 200 per hour overall, never for installs. With it off, such
  messages are ignored as before.

The counts are kept in the database (`teams_bot_onboarding_limits`, migration
`1300_teams_bot_onboarding_limits.sql`): content-free rows keyed by a hash of
the budget and the person, tenant or deployment, using the database clock, and
removed once both the window's start and the last reply are two days old. A
refused reply changes no existing row, and a window starts with its first
reply. A replica that can't reach the database counts in its own memory until
it can, so replies stay bounded and still go out. A reply Teams clearly refused
or never received (a 4xx other than throttling, or unreachable) is given back to
the person's and tenant's counts, once; the deployment's hourly count keeps it,
so replies Teams keeps refusing can't retry without limit. A throttled reply
(429) keeps every count: Teams throttles per conversation, so a person flooding
their own chat is bounded by their own caps and can't use up other tenants'
replies. Its redelivery then gets the short reminder. An install's welcome is also claimed once in the database (see
[In-Teams experience](#in-teams-experience)).

### Entra app configuration

Self-serve sign-in and the account-link sign-in use the bot's own Entra
application (`OPENGENI_TEAMS_BOT_CLIENT_ID`) and its existing client secret. Do
not reuse the Microsoft 365 tools connector app. Setup by an operator-approved
installer and account linking need the redirect URI and API permissions below
on every deployment, including one without self-serve setup. On that app
registration:

- **Supported account types**: accounts in any organizational directory
  (multi-tenant).
- **Authentication → Add a platform → Web → Redirect URI**:
  `<web base URL>/teams/connect`, where the web base URL is
  `OPENGENI_WEB_BASE_URL` (or `OPENGENI_PUBLIC_BASE_URL` when unset), for example
  `https://app.example.com/teams/connect`. No implicit-grant or ID-token boxes
  are needed.
- **Token configuration → Add groups claim → Directory roles**, for the ID
  token. This sets `groupMembershipClaims` to `DirectoryRole` in the manifest
  (`All` also works). Without it Microsoft omits `wids` and every sign-in is
  treated as a non-administrator.
- **API permissions**: Microsoft Graph delegated `openid` and `profile`. These
  need no administrator consent. Complete publisher verification before a Store
  launch: some tenants block people from consenting to unverified multi-tenant
  apps, and then only a Global Administrator can sign in.

Staging acceptance for self-serve, in the dedicated test tenant:

1. Setting off: a non-allowlisted person in an unconnected admitted tenant gets
   no reply, and setup without operator approval is refused.
2. Setting on: the person gets the welcome once; a repeat within ten minutes
   gets nothing.
3. A non-administrator completes the Microsoft sign-in and sees the ask-your-admin
   message; nothing is connected.
4. Signing in to Microsoft as a different user than the Teams sender is refused.
5. A Teams Administrator (or Global Administrator) connects a shared workspace
   they administer, gets the confirmation in Teams, and can start work.
6. After connection, other people get the account-link card rather than a setup
   link.
7. After disconnecting, a Teams Administrator can reconnect only in the original
   workspace; a Global Administrator can move it to another shared workspace.
8. A person without an administrator role opens their own account link, signs in
   to Microsoft with their Teams account and is linked.
9. A workspace member opens someone else's account link and signs in to
   Microsoft as themselves: the link is refused with a message naming the Teams
   account it is for, and nothing is linked.
10. A guest from another organization messages the bot, opens their link and
    signs in to Microsoft with their home account. Microsoft signs them in to
    the connected tenant as its guest, and they are linked.

## Account linking

A person in a connected organization who isn't linked yet gets a **Link
account** card in their 1:1 chat. Its URL opens the workspace's integrations
page with a signed link proof in the fragment: the tenant, the Teams user
(`aadObjectId`), their Teams display name, the workspace and installation
generation, a single-use nonce and a 10-minute expiry. The proof is not enough
to link: someone it is forwarded to could otherwise link the sender's Teams
account to their own Opengeni account, and the sender's Teams messages would
then run with their access.

1. The page asks **Link your Teams account?** and explains that the person
   signs in to Microsoft with the account they use in Teams. **Sign in with
   Microsoft** sends the proof to
   `POST /v1/workspaces/:workspaceId/integrations/teams/link/microsoft-sign-in`
   in the person's own authenticated browser request. The API checks the proof
   against the workspace's current installation and returns a Microsoft sign-in
   URL, exactly as for setup (bot Entra app, tenant-specific authority of the
   Teams tenant, authorization code with PKCE, `openid profile`, the
   `/teams/connect` redirect URI). Its signed state has the purpose
   `teams-account-link` and binds the proof nonce, tenant, Teams user, Opengeni
   person and workspace.
2. The proof and workspace wait in the tab's session storage, never in a URL
   Microsoft sees. Microsoft returns to `/teams/connect`, which recognizes the
   link sign-in by its state and sends the proof with the code and state to
   `POST …/teams/link`.
3. The API checks the state's purpose and binding against the proof and the
   browser session and verifies the ID token as for setup: Microsoft's keys,
   issuer for the Teams tenant, audience, expiry and nonce. `tid` must equal the
   proof's tenant and `oid` its Teams user; no administrator role is needed.
   Only then does it link, so link conflicts are never revealed before the
   identity is proven.

A guest signs in to the connected (resource) tenant, because the authority
names it. Their ID token carries that tenant's `tid` and the object ID of their
guest account there, which is the `aadObjectId` Teams sends for them, so they
link like anyone else. Microsoft personal accounts (consumer tenant) can't
link (`link_consumer_tenant`).

A Microsoft account other than the link's Teams user, by `oid` or `tid`, is
refused with `link_identity_mismatch`. The message names the Teams account the
link is for (its display name; links issued before the name was added say "a
different Teams account") and the Microsoft account that signed in
(`preferred_username`, else `name`), and says to open the link again with that
account or get a link for one's own account. A refused or abandoned sign-in
doesn't use up the link, so its owner can retry within the 10 minutes. A link
request without a Microsoft sign-in is refused with `link_sign_in_required`; a
sign-in state for another link, person or workspace, or a setup sign-in, with
`link_sign_in_expired`.

An organization that blocks user consent to the bot's Entra app must have an
administrator consent to it once before people can link; the page then explains
that a Global Administrator needs to approve Opengeni.

## Generate a package

Run from the repository with its pinned Bun and installed dependencies. Supply
real registered IDs and approved public legal pages. These are packaging inputs;
the generator does not read the bot secret or enable runtime access.

```bash
export OPENGENI_TEAMS_APP_ID='YOUR_STABLE_TEAMS_PACKAGE_GUID'
export OPENGENI_TEAMS_BOT_CLIENT_ID='YOUR_REGISTERED_BOT_GUID'
export OPENGENI_PUBLIC_BASE_URL='https://YOUR_API_HOST'
export OPENGENI_TEAMS_WEBSITE_URL='https://YOUR_PRODUCT_WEBSITE'
export OPENGENI_TEAMS_PRIVACY_URL='https://YOUR_APPROVED_PRIVACY_PAGE'
export OPENGENI_TEAMS_TERMS_URL='https://YOUR_APPROVED_TERMS_PAGE'
export OPENGENI_TEAMS_APP_VERSION='1.0.0'
export OPENGENI_TEAMS_APP_NAME='Opengeni Assistant'
# Optional: a longer full app name; it defaults to OPENGENI_TEAMS_APP_NAME.
# export OPENGENI_TEAMS_APP_FULL_NAME='Opengeni Assistant'
# Optional: the publisher name and Microsoft AI Cloud Partner Program ID.
export OPENGENI_TEAMS_DEVELOPER_NAME='Opengeni'
export OPENGENI_TEAMS_MPN_ID='7181379'
bun scripts/generate-teams-app-manifest.ts --package-dir /absolute/private/path/teams-package
```

For the Opengeni Store listing the legal URLs are `https://opengeni.ai`,
`https://opengeni.ai/privacy` and `https://opengeni.ai/terms`; the generator
still requires them explicitly. `OPENGENI_TEAMS_APP_NAME` (default `Opengeni`,
at most 30 characters) sets `name.short`, the name Teams shows in chat.
`OPENGENI_TEAMS_APP_FULL_NAME` sets `name.full` (at most 100 characters),
which Teams uses where a longer name fits, and defaults to the short name. The
Store requires the Partner Center listing name, the manifest app name and the
name in the bot's welcome message to match, so set the same
`OPENGENI_TEAMS_APP_NAME` in the API runtime (see [Runtime gates](#runtime-gates)):
the bot then uses it for itself in its welcome, help and notices, while text
about the service and accounts still says Opengeni. `Opengeni` is already
reserved in Partner Center, so the Opengeni listing, both manifest names and
the bot's name are `Opengeni Assistant`. Neither name may use "Teams" or
"Microsoft": the Store allows those only for apps in an official partnership
with Microsoft. `developer.name` defaults to `Opengeni`, the
Partner Center publisher name (the legal entity is Cloudgeni AS), and must match
the publisher shown in Partner Center; set `OPENGENI_TEAMS_DEVELOPER_NAME` (at
most 32 characters) for another publisher. `developer.mpnId` defaults to
Opengeni's PartnerGlobal ID `7181379`; set `OPENGENI_TEAMS_MPN_ID` to another
numeric ID, or to `none` to leave it out (for example for a private staging
package); an empty value uses the default. Anyone publishing their own
deployment's package must set both to their own publisher, or `none` for the
partner ID. The manifest's full description and command descriptions name the
bot by `OPENGENI_TEAMS_APP_NAME` and the service, accounts and workspace
Opengeni; a deployment that rebrands the product itself must change that copy
in the generator too, because the Store requires the name to be consistent
across the metadata.

The short and full descriptions are generated for the enabled scopes. They name
Microsoft Teams on first reference, say that the app is an AI agent whose
replies can be wrong and how to report one, state the one-time administrator
setup, the Opengeni account in the connected organization and the
account link, with the website as the way to sign up, and list the main
limitations (text messages only; approvals and private information requests
open Opengeni in a web browser). Copy `description.short` and
`description.full` verbatim from the submitted `manifest.json` into Partner
Center, and update both whenever you regenerate the package (the copy depends
on the app name, scope flags, website URL and generator version):
the Store requires them to match.

The bot declares `commandLists`: in personal chats `help`, `link`, `unlink` and
three prompt starters (`Research a topic`, `Draft a message`, `Plan a project`);
in enabled group chats, `help`. In a connected organization the bot
answers `help` and `unlink` itself, without starting agent work, and `link`
replies with the account-link card (or says the account is already linked);
prompt starters are ordinary messages to the agent.

Store submission gate: don't submit until every listed command and prompt
starter gets a reply with a way forward in every tenant and account state.
The Store configuration is `OPENGENI_TEAMS_BOT_ENABLED=true` (every tenant is
admitted), self-serve setup on (`OPENGENI_TEAMS_BOT_SELF_SERVE_SETUP_ENABLED`)
and the personal-only package. In it:

- A person in a work or school tenant that isn't connected gets the Connect
  your organization card when installing the app and for 1:1 messages. `help`
  and `unlink` carry the same card (`help` with the usual help text first).
  Non-admins are told to ask their admin to message Opengeni in Teams and
  connect it.
- Once a person's or tenant's cards are used up, a short text reminder answers
  instead: "Your organization hasn't connected Opengeni yet. Send **help** to
  see how to connect it." (after "Welcome to Opengeni." for an install).
  `help` is never limited, so it always answers with the card.
- A personal Microsoft account (the consumer tenant) is told on install, for
  messages, and in `help` and `unlink`, that Opengeni needs a work or school
  account and to sign in to Teams with one.
- A linked person whose workspace access doesn't allow starting chats is told
  so and asked to get access from an Opengeni admin in their organization.
- A 1:1 message with only a file or an image, or no text, is told that
  Opengeni reads text messages only and to send the request as text.
- Onboarding replies are limited per person, per tenant and across the
  deployment, counted in the database (`teams_bot_onboarding_limits`) so every
  API replica shares them; a replica that can't reach the database counts in
  its own memory instead. Connect cards: one per person per 10 minutes, 6 a
  day, 200 per tenant a day, 2,000 an hour overall. Install cards: 1 per person
  a day, 25 per tenant a day, 500 an hour. Reminders: no cooldown, 30 per
  person a day, 1,000 per tenant a day, 5,000 an hour. Only a person who
  exceeds both their card and reminder budgets in a day (over 36 messages) gets
  no reply until the next window, and even then `help` and `unlink` still
  answer with the card.

Outside the Store configuration, these cases still have gaps:

- A tenant that isn't admitted (`OPENGENI_TEAMS_BOT_ENABLED` off and not on
  the tenant allowlist) gets the not-available notice for a 1:1 message, once
  a day per person. It names `OPENGENI_SUPPORT_EMAIL` as the contact when that
  is set; installing the app there sends no welcome. A notice Teams throttles
  keeps its count, so that person gets no notice again that day.
- With self-serve setup off, an admitted tenant that isn't connected answers
  only `help` and `unlink` (and the welcome), which name
  `OPENGENI_SUPPORT_EMAIL` when set; `link` and prompt starters from anyone
  other than a setup administrator get no reply.
- In shared conversations (not in the personal-only package): a mention in a
  group chat or channel that isn't on the allowlist gets "Opengeni isn't turned
  on in this conversation", and with self-serve setup on, a mention in a tenant
  that isn't connected gets a reminder to message the bot directly. Both come
  from the shared-conversation budget, at most one per person a minute.

The output directory must not exist. The generator writes `manifest.json`,
`color.png` (192 × 192), and `outline.png` (32 × 32, white on transparent),
using the existing Opengeni favicon brand path. With no arguments it prints only
the manifest. Use a distinct app/bot registration and short name for staging;
retain the app ID and increment the numeric package version for updates.

Zip the three files at the archive root, not the enclosing directory:

```bash
cd /absolute/private/path/teams-package
python3 -m zipfile -c ../opengeni-teams.zip manifest.json color.png outline.png
python3 -m zipfile -l ../opengeni-teams.zip
```

The package defaults to personal conversations. Explicitly set
`OPENGENI_TEAMS_APP_GROUP_CHATS=true` to include group chats and
`OPENGENI_TEAMS_APP_CHANNELS=true` to include team scope (approved channels).
With team scope the manifest also declares `supportsChannelFeatures: "tier1"`,
which the Teams admin center requires for manifest 1.25 team-scope uploads. It
only allows the app to be added to shared and private channels;
`OPENGENI_TEAMS_BOT_ALLOWED_CHANNEL_IDS` still decides which channels are served.
Approving a private or shared channel puts what its members post to Opengeni
in a chat visible to the connected workspace, so approve only channels whose
members may share with that workspace.
`OPENGENI_TEAMS_APP_CONVERSATION_CONTEXT=true` adds
[conversation context](#conversation-context): `webApplicationInfo` with the bot
ID and the resource-specific consent (RSC) application permissions
`ChannelMessage.Read.Group` (with team scope) and `ChatMessage.Read.Chat` (with
group chats). Without it the package makes no RSC claim. It never makes a
file-transfer, tab, SSO, or Graph permission claim. Do not add unsupported
channel capabilities merely to satisfy a validator: implement and verify them
first. Manifest 1.25 does not by itself prove Store policy compliance.

Validate the generated ZIP in Teams Developer Portal and retain its report.
Local unit tests verify identity separation, safe metadata, least-capability
claims, actual icon dimensions/pixels and overwrite refusal; they do not replace
Microsoft schema/package validation or live installation.

References: [app packaging](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/apps-package),
[manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema),
[icon requirements](https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/root-icons?view=m365-app-1.26).

## Obtain a development tenant

Microsoft 365 production access does not automatically confer Developer Program
E5 sandbox eligibility or Teams administrator rights. Joining the program,
qualifying for a sandbox and provisioning that sandbox are distinct steps.
Current eligibility paths include qualifying Visual Studio subscriptions,
eligible partner/ISV programs and Premier/Unified Support customers. Confirm
the account's actual eligibility in the Developer Program dashboard; a
successful sign-in alone is not sufficient.

Current onboarding requires a valid billing account even for the free E5
developer sandbox. For an existing organizational billing account, the operator
needs the appropriate billing permissions, accepted MCA, active billing profile
and invoice section, and a qualifying active Azure subscription under them.
Microsoft documents additional payment/spending-limit requirements. These are
operator prerequisites, not steps the bot registration can bypass. Sandbox use
must remain development-only; paid add-ons are a separate purchasing decision.
Do not promise automatic eligibility or silently create a paid subscription to
work around onboarding.

References: [Developer Program eligibility (September 2026)](https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program),
[sandbox billing and setup](https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-get-started).

## Private acceptance before Store submission

Custom app upload is the first testing route, subject to the target tenant's
policies. Upload the ZIP to the dedicated test tenant through Teams/Developer
Portal or its administrator; public Store listing is not needed for this step.

Record the deployed SHA, configuration revision, package hash/version, tenant,
workspace, client versions, test case, observed result, and sanitized receipt
location in private release evidence. Use Codex subscription models for agent
acceptance, never deployment-credit models.

Required acceptance cases:

1. Broad switches off and no allowlist: setup and activity admission fail closed.
   Add only the test tenant/workspace; an unrelated tenant/workspace stays denied.
2. Invalid signature, wrong token audience/issuer, expired token, wrong bot ID,
   missing tenant/user and spoofed service URL are rejected before work dispatch.
3. Install in the home tenant; link the exact human and authorized workspace.
   An unbound/unlinked sender cannot obtain workspace data or start agent work.
4. Personal message creates/reuses the correct private conversation. A standard
   channel mention starts/reuses its thread and replies in that thread; a later
   mention in the same thread continues the same chat. Ordinary channel traffic
   never triggers work. With a conversation-context package, post unmentioned
   messages in a thread, then mention Opengeni and verify the answer uses them;
   mention again and verify only the newer messages are added. They are kept only
   as the bounded, expiring context window below, never as indexed content.
5. Duplicate delivery does not create duplicate work. Restart/retry and outbound
   uncertainty preserve truthful receipts. Verify cleanup/revocation and that a
   different tenant, conversation or workspace cannot reuse a stored binding.
6. Group chats require their exact allowlist entry and an explicit bot mention,
   even with broad rollout enabled. Verify every participant is linked and has
   workspace access, group work uses a distinct workspace-visible session, and
   personal history is never reused. Change membership or unlink a participant;
   verify old pending replies stop and a newly accepted audience gets fresh history.
   Verify inline `text/html` representations accompanying canonical `activity.text`
   are accepted without parsing or fetching HTML. Files, images, URL-backed HTML,
   mixed attachment arrays and every invoke other than the feedback
   `message/submitAction` remain rejected.
   Private/shared channel type is not classified automatically: verify each
   allowed channel is standard. A channel absent from its exact allowlist must
   be denied even with broad rollout enabled. Remove an entry and verify pending
   work/replies stop.
7. Test the same package in a controlled external tenant under its own app
   policy, using a real non-home-tenant user. Verify isolation and expected denial
   for an external tenant not on the pilot allowlist.
8. If the Graph connector is included in the release, authorize it separately,
   check its exact delegated permissions and expiry/revocation behavior, and
   exercise read operations with known fixtures. Sending messages needs explicit
   test authorization and a disposable conversation; never post to real users
   merely as a connectivity probe.
   The connector also searches chat and channel messages (Microsoft Search limited
   to `chatMessage`) and looks up colleagues with `User.Read.All`, which needs
   administrator consent. Verify a search finds a known fixture message, that a
   request for other entity types is refused, and that the colleague lookup
   returns a known user's manager and direct reports.
9. Verify onboarding, help/error states, uninstall/disconnect and reconnect on
   Teams desktop, web and mobile. Record any unsupported behavior honestly.
   Check the first-run and AI experience described in
   [In-Teams experience](#in-teams-experience): one welcome on personal install,
   `help` answered without agent work, typing while a reply is produced, rendered
   Markdown, the AI generated label and feedback buttons on agent replies (web and
   desktop only), and `unlink` with its confirmation.

Reference: [custom app upload](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload).

## In-Teams experience

Everything the bot says outside agent replies is fixed text in
`apps/api/src/integrations/teams-experience.ts`; none of it calls a model. The
welcome and help content is chosen by the person's state (personal or shared
conversation, organization connected or not, account linked or not).

- **Welcome.** Adding the bot in personal scope (an authenticated
  `conversationUpdate` naming the bot in `membersAdded`) sends one welcome: what
  Opengeni does, that replies are AI-generated, the account requirement, the main
  limitations and how to get help. An unlinked person in a connected organization
  also gets a "Link account" button. The welcome holds no identity proof, since
  proofs expire after ten minutes and a welcome may be read much later: the button
  sends `link` as the person, whose authenticated message gets a fresh link card.
  Teams can deliver one install several times and to any API replica, so each
  replica first claims the chat's welcome in `teams_bot_welcomes` (a hash of the
  tenant and conversation, no content); an install of the same chat within ten
  minutes isn't welcomed again on any replica, and messages never repeat it.
  Claims older than a day are removed as later welcomes are sent. The install
  never fails once a welcome may
  have arrived. When Teams clearly refused the send, the claim is given back,
  and a throttled or unreachable send answers 503 so that Teams redelivers.
  When the send may have arrived (a timeout, a Teams 5xx), or the replica
  stopped between claiming and sending, the claim is kept: that install gets no
  welcome rather than a second one. Teams may accept a message with a card with
  an empty 202 and no message id; that counts as delivered. A linked person's
  first 1:1 chat adds one line
  about AI and `help` to the "Started" notice. In an organization that hasn't
  connected Opengeni and has self-serve on, the installer gets the
  "Connect your organization" card instead of this welcome; see
  [Self-serve organization setup](#self-serve-organization-setup).
  The bot only answers in tenants enabled for rollout, so a tenant used to
  review the app must be in
  `OPENGENI_TEAMS_BOT_ALLOWED_TENANT_IDS` (or broad rollout must be on).
- **Commands.** Commands run after the tenant and channel or group allowlist
  checks. A whole message of `help` (or `commands`) gets the help text in the
  same conversation, for linked and unlinked people, without starting agent work.
  `link` gives an unlinked person the usual link card and tells a linked person
  they already are. In a 1:1 chat, `unlink` (or `disconnect`) asks for
  confirmation; its button
  sends `unlink confirm`, which removes the person's Teams link with the same
  logic as the web unlink. Anyone may always remove their own link. In shared
  conversations `unlink` points to the 1:1 chat.
- **Replies once per message.** Replies the bot sends itself (help, `link`,
  `unlink`, the link card, onboarding replies, reminders and notices) don't go
  through the inbox, so just before the first send for a message the replica
  claims it in `teams_bot_reply_claims` (a hash of the tenant, conversation and
  activity id, no content); a message that gets no reply writes nothing. A
  message Teams redelivers, after a slow or failed response and to any
  replica, isn't answered again for ten minutes. When nothing reached the
  person and Teams clearly refused the send (such as throttling), the claim is
  given back so the redelivery answers. If the claim can't be made, the reply
  goes out anyway. Claims older than a day are removed as later replies are
  sent. Notice cards (such as "Started") carry a plain-text summary and card
  fallback text for clients that can't show cards. Microsoft doesn't document
  Teams using either for an Adaptive Card's notification preview, so
  notifications for these cards may still show a generic preview.
- **Typing.** After a message is queued, the bot sends Teams typing activities
  about every three seconds until the reply, request for input or failure of
  the turn that answers it is queued for Teams, the message is refused, or five
  minutes pass. Admission records that turn on the inbox row (`turn_id`) and the
  drain stamps `replied_at` when it queues that turn's output, so in a busy chat
  an earlier turn finishing doesn't end typing for a later message. A message
  admitted without a known turn (by an older release) falls back to the chat:
  any reply, request or failure after it was queued (the route's
  `relevant_event_sequence` moving past its value at queue time). A cancelled
  turn queues nothing, so typing for it ends at the five minutes. One loop runs
  per chat; a newer message takes it over and restarts the five minutes. A
  redelivered message starts none. The loop lives in the process that accepted
  the message and is best-effort.
- **Markdown.** Messages are sent with `textFormat: "markdown"`. Agent Markdown
  Teams can't show in text messages is rewritten: each table row becomes a list
  item led by its first cell in bold, with every other cell on its own nested
  line as `Header: value` (cells joined on one line ran together), headings
  below level three become bold lines, setext headings become ATX headings,
  images become links and horizontal rules are dropped. Teams shows paragraphs
  with no gap between them and joins a line to the one before it, so a heading
  or a line that is only bold text (`**Next steps**`) right after a paragraph
  gets an empty `<br>` paragraph before it, and such a bold line is kept on its
  own line; after a list, quote or code block Teams already leaves a gap. The
  help and welcome text go through the same rules. Text that
  looks like an HTML tag (`List<string>`) is backslash-escaped outside code so
  Teams doesn't swallow it; autolinks, link targets and `<br>` are kept. Code is
  left as written: fenced blocks (including fences nested in list items),
  indented code blocks and code spans. Lines over 4 KB get only that escaping.
  A code block split across 20,000-byte parts is
  closed and reopened with only its fence and language, and room for the closing
  fence is kept, so no part exceeds the limit. Verify tag-like text on desktop,
  web and mobile during acceptance.
- **Notices.** Opengeni's own notices about a chat's session (Started, needs
  your input or approval, could not finish) and the refusal notices go out as
  an Adaptive Card with the notice text and a labelled button (Open in
  Opengeni, Open Opengeni, Continue in Opengeni), never a bare URL. The outbox
  stores `link: "session"` and the card text; the button's URL is built when
  the notice is sent. The stored `text` still writes the URL out, which is what
  a replica from before notice cards sends during a rolling deploy. In a
  channel thread Teams starts a new message header after a card, so the
  agent's answer that follows has its own header with the AI label instead of
  being grouped under the notice. In 1:1 and group chats Teams groups
  consecutive bot messages anyway; there the Started notice comes only before
  a chat's first answer.
- **AI label and feedback.** Agent replies (from `turn.completed`) carry the
  schema.org `AIGeneratedContent` message entity and `channelData.feedbackLoop`.
  The authenticated `message/submitAction` feedback invoke passes the same tenant
  and channel or group allowlist checks as messages, and is accepted only for a
  delivered agent reply in the same conversation and installation generation,
  from a linked person with the permissions the HTTP feedback route requires
  (`workspace:read`, `sessions:create` and `sessions:read`) and session access to
  that chat (only its owner for a 1:1 chat). It is recorded through the ordinary
  Opengeni feedback store (`feedback_submissions`) on the chat and turn (on the
  chat alone if the turn is gone), with an idempotency key derived from the
  Teams activity, so a redelivered invoke records once. Each rating is its own
  row, so a person who changes their rating leaves both; the latest is current.
  Written feedback is kept up to 4,000 UTF-16 code units, the feedback store's
  limit, without splitting a character. A chat whose session is gone, or that
  the person may no longer see, answers the invoke and records nothing. The
  reply is found by its Teams message id through the partial index
  `teams_bot_outbox_delivered_message`, then its chat by primary key.
  With workspace routing, a 1:1 reply's feedback is checked against the chat it
  belongs to rather than the installation's workspace: the reacting person must
  be the chat's linked owner, with live organization membership and current
  access to the chat's workspace (their own Personal workspace included). On a
  chat with an agent anyone in the organization may use, it is recorded as that
  agent (`teams-agent:<agentId>`) while the agent is still open to them.

## Publisher verification and Store submission

Publisher verification establishes publisher identity; it does not certify code,
grant API permissions, or replace tenant consent. Use the organization's verified
Microsoft AI Cloud Partner Program account and associate its PartnerID with the
appropriate Entra registration. Confirm verified publisher state in the actual
portal, rather than treating completed paperwork as completion.

Prepare a separate release checklist:

- Verified Partner Center developer account, publisher identity and owned domain.
- Public privacy, terms and support pages with actual Teams data handling,
  retention/deletion, subprocessors, account requirements and support contact.
- Accurate listing copy, matching icon assets and screenshots; no unsupported
  SSO, full-channel, Graph, compliance or certification claims.
- Developer Portal validation report and completed private acceptance matrix.
- Stable reviewer environment, working test accounts, exact setup steps and
  access/consent requirements; isolated data and explicit reviewer allowlists.
- Review current bot/channel, AI-generated-content and security requirements in
  the Store validation guidelines. Resolve gaps before claiming readiness.
- Submit the production-ready package through Partner Center, respond to
  Microsoft's validation report, and retain the exact approved package version.
- Broaden runtime rollout only through the operator's authorized release process
  after readiness evidence; Store approval alone is not a rollout command.

Keep private pilot distribution, organizational catalog publication and public
Store publication distinct. An unpublished beta should not be submitted as a
production-ready app. Publisher Attestation is separate from Publisher
Verification; complete applicable compliance-program steps at the appropriate
listing stage.

References: [publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview),
[Store publication](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/appsource/publish),
[Store validation](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/appsource/prepare/teams-store-validation-guidelines),
[submission failures](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/appsource/resolve-submission-issues).

## Workspace routing

`OPENGENI_TEAMS_WORKSPACE_ROUTING_ENABLED` (default false) lets a connected
tenant's 1:1 chats start work in any workspace of the connecting organization
that the linked person can start chats in, like a Slack bot DM. Turn it on only
after every replica runs a release that reads `teams_bot_routes.agent_id`
(migration 1373); an older replica would admit an agent route as a plain chat.
With it off, nothing changes: 1:1 chats use the installation's workspace or the
person's Personal workspace, and linking needs `sessions:create` there.

With it on:

- **Linking** is an organization fact, like Slack's: any active full member of
  the installation's organization can link, still bound to the Microsoft `tid`
  and `oid` of the Teams user. The **Link account** card opens
  `/teams/connect`, not one workspace's page. A person who isn't a member gets
  `link_not_organization_member`.
- **Where a message goes**, first match wins: `in <Workspace>: …` for one
  message; `<App name>: …` for the main assistant; an agent addressed by name
  (`Name: …`, `Name, …` or `+name`), which also becomes the chat's choice; the
  person's remembered choice; their Personal workspace; their only workspace;
  otherwise a **switch** card with the message parked until they pick (one
  card per person, 24 hours, single use). Agents are the organization's shared
  agents in workspaces the person can use; Only me agents and agents in
  Personal workspaces are never listed. Agent replies carry an
  "**Agent** · Workspace" header, a one-off `in <Workspace>: …` message's
  replies a "**Workspace**" header, and the first reply after a real choice
  names the workspace the chat is saved in. A one-off continues the person's
  chat in that workspace (same route as a switch there); it doesn't change the
  remembered choice.
- **Agents anyone in the organization may use** (Who can use it: Anyone in
  <organization>, see [agents.md](agents.md#anyone-in-the-organization)) are
  also listed, addressed and remembered for people who aren't in their
  workspace, with Slack's open-agent rules: only in 1:1 chats; Teams'
  `getMemberById` must say the sender is a full member (`userRole` "user") of
  the connected tenant, never a guest, read on every queued message; the
  linked person must be an active full member of the organization, read live
  at enqueue (inside the enqueue transaction), at admission and before every
  delivery, with the agent still open and in reach. The chat has its own
  route (`teams-agent:` route ids), runs as the agent's read-only service
  principal `teams-agent:<agentId>` with Slack's open-agent permissions and
  session options, is visible to the workspace's members (no link to it is
  sent), and its first reply says so once. Members of the workspace keep
  their own Only me chat with the agent. No Teams-only setting, and no
  migration. During a rollout a replica without this release fails closed on
  these routes: it refuses their admission (the agent principal fails its
  proof check) and drops their replies (the session isn't the person's Only
  me one), and it forgets a stored choice of such an agent ("You can no
  longer start chats in …"), so a person may need to ask or switch again.
  Unlike Slack's agent picker, the Teams switch card lists these agents
  (after the person's own), because a Teams 1:1 chat has no other place to
  discover them. A person's own agent keeps its name when an organization
  agent elsewhere has the same one. Turns that workspace members start in
  the shared chat in Opengeni are not sent to the asker.
- **Authority** is read live at enqueue (before and inside the enqueue
  transaction), at admission and before delivery: active organization
  membership, the person's live authority in the target workspace (membership
  or their own Personal workspace), and the organization's reach. Stored
  choices and switch cards are memory, never authority; a choice that no longer
  works is refused ("You can no longer start chats in **X** from Teams"), never
  served from another workspace. Each route, choice and card row has a
  same-account CHECK and composite foreign keys to its organization, and an
  agent named by a stored choice or card option is checked, in the writing
  transaction, to be a shared agent of that workspace (agents never move). A
  reach change committed while a message's access is checked refuses it
  (`reach_version` is read before the check and again under the installation
  lock), and the message is checked once more.
- **Limits.** A switch card holds at most 100 numbered rows, with room for up
  to 50 workspaces however many agents there are; `switch <name>` and stored
  choices still reach anything beyond the card. The agent directory reads up
  to 1,000 agents, the person's own workspaces' and open agents first.
- **Reach** is the organization admin's limit, stored on the installation
  (`reach_workspace_ids`, null for every workspace, and
  `reach_personal_workspaces`). It uses the same **Available in Opengeni**
  control as Slack's, on the Teams card in **Capabilities**, and the same rule:
  an organization owner or administrator who administers the connected
  workspace. `GET`/`PUT /v1/workspaces/:workspaceId/integrations/teams/reach`
  read and change it with a version check. The connected workspace is always
  in reach.
- **Group chats and channels** are unchanged: they use the installation's
  workspace and the server-side allowlists.

To test on staging: two shared workspaces and one shared agent, a linked
person in both, then `switch`, `in <Workspace>: …`, `Agent: …`, a workspace the
person can't use (refused), and a reach limit set by an organization admin
(refused, then allowed again).

## Disable and recover

Each tenant/workspace binding stays fixed while active. Disconnect pauses that
binding; reconnect uses the same tenant and workspace. With self-serve setup, a
Global Administrator of the tenant can move a disconnected binding to another
workspace (see Self-serve organization setup); nothing else transfers either
side.

Remove the pilot/reviewer allowlists and keep broad switches false to close
admission. Revoke a compromised credential at its Microsoft authority and rotate
it through the deployment secret store. Disabling rollout or uninstalling the
Teams package is not deletion of Opengeni session history, nor is it proof that
Microsoft user grants were revoked. Follow the connector's native disconnect and
retention paths. Preserve immutable history and delivery evidence when diagnosing
a failure; do not replay an uncertain outbound send blindly.

The bot connection details expose pending, unknown and failed delivery counts
for the current linked human's routes.
Unknown or failed sends show a Needs attention notice. An unknown provider outcome
is intentionally never resubmitted automatically, because the original message
may already have arrived. Open the Opengeni chat from the accepted-task link in
Teams to inspect progress and complete approvals; retain delivery evidence when
escalating a missing reply. These diagnostics are not proof of successful live
Microsoft delivery.


Disconnect disables the existing tenant/workspace binding and cancels pending work.
Reconnect uses that same binding. Replacing the Teams organization bound to a
workspace is not supported; only a Global Administrator's self-serve setup moves
a disconnected organization to a different workspace.
The retained binding preserves existing conversation and delivery history.

## Approved group chats

Group chats are opt-in through `OPENGENI_TEAMS_BOT_ALLOWED_GROUP_CHAT_IDS`:
exact tenant UUID and conversation ID pairs, separated by commas. Tenant admission
alone never enables a group. Set `OPENGENI_TEAMS_APP_GROUP_CHATS=true` when generating
an internal package to advertise personal and `groupChat` scopes. Default packages
advertise personal chats only; no unsupported all-channel feature is claimed.

Only explicit bot mentions are admitted. Each participant must link their own
Opengeni account in a direct chat and hold current read access to the connected
workspace. The sender also needs permission to create sessions. Connector chat
membership supplies the complete roster (up to 250 humans); missing identities,
unknown bots, foreign tenants, oversized rosters, and failed lookup refuse work.
No Graph permission is needed; the optional RSC permission only adds
[conversation context](#conversation-context). Identity proof links are never
posted to the group.

Group work is workspace-visible, not a private group ACL. It receives a distinct
native session and keeps the accepted sender's native turn authority. Personal
chat history is never reused. Changed membership or account mapping retires the
old route; returning to an earlier roster creates fresh history. Every outbound
part checks the current roster and live account mappings again. Old pending
replies are refused after an audience change.

Microsoft membership lookup and message delivery are separate operations, so
there remains a provider-side race between the last lookup and sending. Teams
may also expose already-posted chat history to members added later. Use approved
internal groups whose participants may share this workspace's content; this is
not a replacement for Teams history-sharing policy.

Authenticated inbound diagnostics record fixed rejection reasons, bounded schema
paths and attachment counts (including the count of HTML representations), without
message content, provider identifiers, URLs or credentials. These records run only
after Connector authentication and help distinguish ignored activity shape from
rollout, bot identity and installer-policy denials. They do not prove a reply was
delivered. Unsupported attachments remain rejected.

Teams inline `text/html` representations accompanying canonical `activity.text`
are accepted, matching Microsoft's [receive-message payload](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability#receive-a-message-activity).
Only the canonical text is consumed. HTML is never parsed or fetched; URL-backed
HTML, files, images, and mixed attachment arrays remain rejected.

## Conversation context

When someone mentions Opengeni in an approved channel thread or group chat, the
agent also sees the recent messages people posted there without mentioning it,
as a Slack thread mention does. Teams delivers those messages to the bot only
when the installed package carries resource-specific consent: generate it with
`OPENGENI_TEAMS_APP_CONVERSATION_CONTEXT=true` (see
[Generate a package](#generate-a-package)), publish it as a new package version,
and update the app in each team where it is installed. Microsoft enables
all-message delivery in a group chat only after the app is installed into that
chat again, so remove and re-add it in existing group chats. The installer
consents to the RSC permissions when adding or updating the app. With an older
package nothing changes: only the mention itself is visible.

- Every human message Teams delivers in an approved channel or group chat of an
  active installation is kept in `teams_bot_context_messages`: plain text (at
  most 4,000 characters), sender name and Entra object ID, time, thread root and
  whether it was a mention Opengeni accepted. Attachments are noted, never
  fetched. Teams edits replace the kept text and deletions remove it. Personal
  chats, bots and unapproved conversations are never kept. What starts work is
  unchanged: only a fresh, explicit mention does.
- The window is bounded: the newest 100 messages per channel thread or group
  chat, for seven days. Reads ignore older rows; they are deleted as new messages
  are recorded in the workspace, and all of them when the installation is
  disconnected. When someone is added to a group chat, its kept messages are
  deleted and messages from before that moment are never kept or read again,
  even if Teams delivers one late, so a newcomer never gets answers built from
  history Teams did not show them.
- Context attached to a mention becomes part of that Opengeni chat and stays
  with the chat's history, like the mention itself.
- A mention that starts a chat gets up to 30 earlier messages of its thread or
  group chat, oldest to newest, within an 8,000-character budget. A new channel
  post that mentions Opengeni gets up to five earlier channel posts instead. A
  later mention that continues the same chat gets only what was posted since the
  previous accepted mention. The context is attached to that one user message as model
  context, labelled as other people's messages and not instructions.
- Opengeni's own replies and file contents are not included. A failed context
  read never blocks the mention.
- A channel thread is identified by the root post in the conversation ID
  (`;messageid=<root>`), because Teams can omit `replyToId` on replies. A later
  mention anywhere in the thread continues the same chat.

Opengeni does not call Microsoft Graph for this; it only keeps what Teams
delivers to the bot. Messages posted before the context package was installed
are not available. Teams delivers unmentioned channel messages for standard
channels; private and shared channels are not covered. Reference:
[receive all conversation messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-for-bots-and-agents).

### Conversation context outside the home tenant

Consenting to the RSC permissions creates a service principal for the bot's
Entra app in the installing tenant. Entra can only do that for a multi-tenant
app registration. With a single-tenant registration, installing or updating the
context package in any other tenant fails at consent: the app stays on its
earlier version, no grant is recorded, and creating the service principal by hand
fails with `NoBackingApplicationObject`. The tenant's consent settings do not
help. The home tenant works either way, so test a second tenant before release.

Before offering conversation context to customer tenants:

- **Multi-tenant app registration.** Set the bot app registration's supported
  account types to multiple organizations (`signInAudience`
  `AzureADMultipleOrgs`). Leave the Azure Bot resource single-tenant. Entra's
  option to allow only listed tenants is useful for a pilot; it is in preview.
  Changing the audience changes nothing else on the registration, but Entra
  rejects the change if the registration has an App ID URI other than
  `api://<appId>` or one on a verified domain. To undo it, set it back to single
  tenant (`AzureADMyOrg`).
- **Publisher verification.** Tenants that allow consent only to apps from
  verified publishers can block an unverified app. Verify the publisher on the
  production app registration first;
  see [Publisher verification and Store submission](#publisher-verification-and-store-submission).
- **A certificate, not a client secret.** Once the registration is
  multi-tenant, the bot credential can request app-only tokens in every tenant
  that has consented. Production should use a certificate credential, stored
  only in the deployment secret store and rotated on a schedule. The current
  implementation reads a client secret (`OPENGENI_TEAMS_BOT_CLIENT_SECRET`)
  only, so certificate support needs a code change before this goes to
  production.
- **A short note for customer admins**, for example:

  > Opengeni asks for two resource-specific permissions. In a team where it is
  > installed, `ChannelMessage.Read.Group` lets it receive the messages posted in
  > that team's channels. In a group chat where it is installed,
  > `ChatMessage.Read.Chat` lets it receive that chat's messages. The team
  > member or chat member who adds the app grants them, only for that team or
  > chat; removing the app ends the grant. Admins control this with the Team RSC
  > and Chat RSC consent settings. The grant would also allow app-only Microsoft
  > Graph reads of those messages; Opengeni does not make any.
  >
  > Opengeni only answers when someone mentions it. From channels and group
  > chats approved for your Opengeni deployment, it stores each message's text,
  > the sender's display name and Entra object ID, and the time. It stores
  > nothing from personal chats or other bots, and never fetches attachments.
  > It keeps at most the newest 100 messages per thread or group chat, uses only
  > the last seven days, and deletes older messages as new ones arrive. Edits
  > and deletions in Teams are applied. Removing the app stops new messages but
  > does not delete stored ones; disconnecting Teams from the workspace deletes
  > them all. Messages attached to a mention as context stay in that Opengeni
  > chat's history, like the mention itself.
