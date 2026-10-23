# Microsoft Teams release readiness

This runbook covers the Teams bot package and controlled rollout.
Source and package preparation are not deployment, tenant installation, publisher
verification, or Store approval. Keep runtime switches off until an operator has
completed the relevant checks below.

## Two independent integrations

The pilot targets personal conversations and standard team channels. The current
activity parser distinguishes personal conversations from channels, but cannot
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
session inside that shared workspace; this does not allow binding a Personal
workspace or grant the bot a canonical managed-browser session. Channel sessions
remain workspace-visible. Both incoming work and outgoing replies recheck the
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

Start with dedicated pilot tenant/workspace entries while both broad switches
remain false. Include Microsoft's actual reviewer tenant/workspace only after
it is known; never broaden access to all tenants to get a submission reviewed.
Keep reviewer accounts, tenant IDs and credentials outside the repository.

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

The package advertises personal conversations and team channels only. It makes
no group-chat, file-transfer, tab, SSO, RSC, shared/private-channel, or Graph
permission claim. Do not add one merely to satisfy a validator: implement and
verify that capability first. Manifest 1.25 meets the documented minimum schema
for channel-enabled Store submissions from July 2026; it does not by itself prove
all current channel-specific Store policies are met.

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
   channel mention starts/reuses its thread and replies in that thread. Ordinary
   channel traffic does not trigger work or become ambient indexed content.
5. Duplicate delivery does not create duplicate work. Restart/retry and outbound
   uncertainty preserve truthful receipts. Verify cleanup/revocation and that a
   different tenant, conversation or workspace cannot reuse a stored binding.
6. Group chats, attachments and invoke activities are ignored by the message
   normalizer. Verify that behavior. Private/shared channel type is not currently
   classified automatically: verify each allowed channel is standard. A channel
   absent from the exact allowlist must be denied even with broad rollout enabled.
   Remove an entry and verify pending work/replies stop.
7. Test the same package in a controlled external tenant under its own app
   policy, using a real non-home-tenant user. Verify isolation and expected denial
   for an external tenant not on the pilot allowlist.
8. If the Graph connector is included in the release, authorize it separately,
   check its exact delegated permissions and expiry/revocation behavior, and
   exercise read operations with known fixtures. Sending messages needs explicit
   test authorization and a disposable conversation; never post to real users
   merely as a connectivity probe.
9. Verify onboarding, help/error states, uninstall/disconnect and reconnect on
   Teams desktop, web and mobile. Record any unsupported behavior honestly.

Reference: [custom app upload](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload).

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
