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

Bot setup belongs to the deployment operator. Workspace binding belongs to an
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

Reference: [Azure Bot registration](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration?view=azure-bot-service-4.0).

## Runtime gates

| Setting | Purpose |
| --- | --- |
| `OPENGENI_TEAMS_BOT_ENABLED` | Broad bot rollout; default false |
| `OPENGENI_TEAMS_BOT_ALLOWED_TENANT_IDS` | Explicit pilot/reviewer tenant admission while broad rollout is off |
| `OPENGENI_TEAMS_BOT_ALLOWED_CHANNEL_IDS` | Exact operator-verified standard channels as `tenantId:channelId`; empty denies all channels |
| `OPENGENI_TEAMS_BOT_ALLOWED_GROUP_CHAT_IDS` | Exact approved group chats as `tenantId:conversationId`; empty denies all groups, independently of broad rollout |
| `OPENGENI_TEAMS_BOT_SETUP_ADMIN_IDS` | Explicit operator-approved `tenantId:actorObjectId` installer pairs |
| `OPENGENI_TEAMS_BOT_CLIENT_ID` | Bot's Entra application ID |
| `OPENGENI_TEAMS_BOT_CLIENT_SECRET` | Server-only bot credential |
| `OPENGENI_TEAMS_BOT_TENANT_ID` | Home tenant used to acquire bot service tokens |
| `OPENGENI_MICROSOFT_TEAMS_TOOLS_ENABLED` | Independent broad Graph-tools rollout; default false |
| `OPENGENI_MICROSOFT_TEAMS_ALLOWED_WORKSPACE_IDS` | Explicit tools pilot/reviewer workspace admission |

Initial setup and account linking require a verified managed browser session.
Only shared workspaces administered by that human can be selected. Confirming
setup also links that verified Teams actor to the signed-in human atomically;
the installer does not need a second account-link confirmation. Other people
follow their own signed account-link flow. The installer
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
to, the shared workspace, so losing access there stops the chat. This does not
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
export OPENGENI_TEAMS_APP_NAME='Opengeni'
bun scripts/generate-teams-app-manifest.ts --package-dir /absolute/private/path/teams-package
```

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
  A redelivered install within ten minutes isn't welcomed again (per API process),
  and messages never repeat it. A linked person's first 1:1 chat adds one line
  about AI and `help` to the "Started" notice. The bot only answers in tenants
  enabled for rollout, so a tenant used to review the app must be in
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
  Teams can't show in text messages is rewritten: tables become one list item per
  row, headings below level three become bold lines, setext headings become ATX
  headings, images become links and horizontal rules are dropped. Text that
  looks like an HTML tag (`List<string>`) is backslash-escaped outside code so
  Teams doesn't swallow it; autolinks, link targets and `<br>` are kept. Code is
  left as written: fenced blocks (including fences nested in list items),
  indented code blocks and code spans. Lines over 4 KB get only that escaping.
  A code block split across 20,000-byte parts is
  closed and reopened with only its fence and language, and room for the closing
  fence is kept, so no part exceeds the limit. Verify tag-like text on desktop,
  web and mobile during acceptance.
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

## Disable and recover

The initial release keeps each tenant/workspace binding fixed. Disconnect pauses
that binding; reconnect uses the same tenant and workspace. Disconnect does not
permit transferring either side to another binding.

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
Reconnect uses that same binding. Moving a Teams organization to a different
workspace, or replacing the Teams organization bound to a workspace, is not supported.
The retained binding preserves existing conversation and delivery history.

## Approved group chats

Group chats are opt-in through `OPENGENI_TEAMS_BOT_ALLOWED_GROUP_CHAT_IDS`:
exact tenant UUID and conversation ID pairs, separated by commas. Tenant admission
alone never enables a group. Set `OPENGENI_TEAMS_APP_GROUP_CHATS=true` when generating
an internal package to advertise personal and groupchat scopes. Default packages
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
  deleted, so a newcomer never gets answers built from history Teams did not
  show them.
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

The bot's Entra app is single-tenant, so this does not read Microsoft Graph:
an app-only Graph token in a customer tenant would need a multi-tenant app
registration. Messages posted before the context package was installed are not
available. Teams delivers unmentioned channel messages for standard channels;
private and shared channels are not covered. Reference:
[receive all conversation messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-for-bots-and-agents).
