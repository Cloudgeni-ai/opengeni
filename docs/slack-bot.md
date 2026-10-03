# Slack identities and connections

One configured Slack app serves user-account OAuth and OpenGeni's separate bot integration within one deployment. Each deployed environment uses its own app and credential triplet. User-account MCP tools run through OpenGeni's reviewed **Slack Web API bridge**, not Slack's Marketplace-restricted hosted MCP transport. A user token reads permitted conversations and sends as the authenticating human. The bot uses its separate bot token, routing, and authority.

| Connection | Slack author | OpenGeni ownership | Intended use |
| --- | --- | --- | --- |
| Slack account API MCP bridge | The human who authenticated | Stock UI: personal; Connect API also permits an explicitly shared workspace grant | Exact accepted user account for channels, users, recent messages, threads, DMs, and sends |
| OpenGeni workspace bot | The configured deployment bot user | Workspace installation | Bot-member conversations, DM/mention/command/shortcut tasks, replies, Geni reactions, and explicit task-file delivery |

Personal rows are visible only to their owner. Shared account rows are workspace-visible, and using one acts as the human who deliberately shared it. Accepted work freezes the exact selected Connection; the bot, personal, and shared authorities never substitute for each other. The stock Slack account page manages one canonical account per ownership in each OpenGeni workspace: reconnecting another Slack account replaces that row. It does not offer an add-another-account flow.

### Unlisted pilot and rollout

`OPENGENI_SLACK_ACCESS_MODE=limited` is the default. Personal tools omit search, file access, canvases, channel administration, and bulk backfill. History and replies return at most 15 messages per requested page. A deployment-global, content-free Postgres quota admits at most one request per minute per app/Slack workspace/method across both bot and personal tokens; it also shares provider `Retry-After` cooldowns. Throttled calls report the delay without prompting a reconnect. Messages arriving in authenticated events remain usable when optional surrounding history is throttled. Geni reactions resolve their exact message using `reactions.get` and add at most one optional thread page, preserving channel and attachment checks.

`full` removes the proactive one-minute history ceiling and requests the safe optional bot search grants on future installs. Use it only after Slack confirms the app's eligibility. It does **not** add search tools: Real-time Search also requires a trusted Slack interaction action token, so generic agent `slack_bot_search` is no longer registered. Marketplace approval alone does not add scopes to existing grants; new scopes require Slack reauthorization/reinstallation and may require workspace-admin approval. Existing broader grants remain valid for the reviewed API tools, including older comma-delimited stored scopes.

Before activating migration `0597_slack_api_rate_limits.sql`, stop all old/new API and worker processes, supply the complete runtime login list with `OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES`, migrate, provision roles, and start the matching binary. Its new global table changes the exact runtime-posture contract; do not restart a pre-0597 binary afterward. This implementation is covered by mocked provider and isolated database regressions. A fresh external-workspace install and personal connect/send acceptance remain a release check; do not claim production delivery from those tests.

Slack permits unlisted apps for early customer pilots; commercial scale and hosted MCP/Real-time Search remain subject to [Slack distribution](https://docs.slack.dev/app-management/distribution/) and [MCP app identity requirements](https://docs.slack.dev/ai/slack-mcp-server/#app-identity). [Web API limits](https://docs.slack.dev/apis/web-api/rate-limits/) apply independently of authentication.

## Provider identity and deployment prerequisites

Slack renders the message author from the OAuth principal and renders `Sent using @…` from Slack app/provider metadata. An existing Slack app may serve the account API MCP bridge and may retain its current name. The first-party workspace-bot flow is stricter: if that surface is used, an authorized Slack app administrator must configure the same app as follows rather than adding generated text or changing message payloads:

1. Set the production Slack app name to `OpenGeni`. Use an environment-qualified app name such as `OpenGeni Staging` for a non-production deployment so administrators can distinguish simultaneous installations.
2. Set the bot user display name to the deployment's exact configured identity: `OpenGeni` in production or `OpenGeni Staging` in managed staging.
3. Configure both exact redirect URLs:
   - `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/oauth/callback` for user-account OAuth.
   - `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/slack/callback` for workspace-bot installation.
4. Enable direct/public OAuth distribution. A Slack Marketplace listing is not required.
5. Keep the client credential server-side and configure the deployment with:
   - `OPENGENI_SLACK_CLIENT_ID`
   - `OPENGENI_SLACK_CLIENT_SECRET`
   - `OPENGENI_SLACK_SIGNING_SECRET` (required before workspace-bot installation is offered, because Events API, commands, shortcuts, and interactive actions all depend on signature verification)
   - `OPENGENI_SLACK_BOT_DISPLAY_NAME` (`OpenGeni` by default; `OpenGeni Staging` in managed staging)
   - `OPENGENI_INTEGRATIONS_ENABLED=true`
   - `OPENGENI_INTEGRATIONS_STATE_SECRET`
   - `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`
   - `OPENGENI_PUBLIC_BASE_URL`

Keep Slack MCP enabled on the app for the existing OAuth discovery identity and configure the reviewed user grants emitted by `bun run slack:manifest`. **Apply the manifest's bot scopes to the Slack app before deploying a version that requests them.** Manifest and install URL use `openGeniSlackBotRequestedScopes` with the same access mode. Limited mode does not request search. Reaction read and file write stay optional for older installed grants, with their existing per-feature checks. Client credentials remain server-side; users never paste tokens into OpenGeni.

Changing Slack app metadata is provider administration outside this repository. Reconnect affected user-account OAuth grants and reinstall an affected bot through OpenGeni only when the provider requires a fresh grant; do not replace one authority with another.

## Slack account MCP bridge

The catalog and discovery identity remain exactly `https://mcp.slack.com/mcp`. The existing OAuth starter uses the deployment-managed Slack client, PKCE S256, and signed single-use state bound to the exact organization, workspace, human, and chosen ownership. The stock UI starts a personal grant; explicit Connect API workspace ownership remains supported. The callback rechecks live owner authority before exchanging or persisting, verifies the user token with `auth.test`, and stores a scope-filtered reviewed catalog. It never authenticates to hosted MCP for tool discovery. A permanently rejected returned grant is preserved as `needs_reauth`; transient verification failures preserve the grant for a later retry.

The signed-in user's account-linking surface is **Capabilities → Slack connections → Your Slack account**, separate from the adjacent **OpenGeni workspace bot** installation card:

1. **Connect my Slack account** starts the existing user-account OAuth flow. The browser sends only the official resource/provider target and the return path; Slack client credentials remain deployment-managed.
2. The card shows only non-secret subject-owned metadata: connection health, granted personal scopes, last use, and access-token expiry. It never shows the private connection UUID, token, client credential, or workspace-bot installation details.
3. **Reconnect my Slack account** reuses the current subject's row when it still exists. The callback preserves the generic subject-scoped capability reference and never publishes that row's UUID into workspace capability configuration.
4. **Disconnect** requires an explicit confirmation and revokes local OpenGeni use of that subject-owned row. It does not disconnect the workspace bot or revoke provider-side access in Slack.

Status copy follows the broker's actual lifecycle. An active row whose access token reached its expiry time remains connected with refresh pending because the broker refreshes on use. `needs_reauth` after an expired/rejected refresh and `error` require reconnect. `revoked` is shown as disconnected and remains an eligible in-place reconnect target. Raw provider errors are not rendered in the browser.

Legacy rows may contain more than one subject-owned Personal Slack OAuth connection for the same subject and provider. UUID-free UI, reconnect, and broker lookup collapse those rows with one deterministic order: `active`, `needs_reauth`, `error`, then `revoked`; within one status, `updated_at DESC`, `created_at DESC`, then immutable connection UUID `DESC`. Migration 0132 can assign the same `updated_at` to multiple backfilled rows, so the creation and UUID tie-breakers are required and no uniqueness or destructive deduplication is assumed.

The resulting `connections` row has `subjectId` and `createdBySubjectId` set to the authenticating OpenGeni subject. Subject-owned capability configuration stores only a generic `{ providerDomain: "slack.com", kind: "oauth2", subjectScope: "subject" }` reference; it never publishes or persists the private connection UUID in a workspace capability projection.

Enforcement is fail-closed across the full lifecycle:

- Connection list/get/update/delete and OAuth reconnect require the exact subject.
- Tool catalog discovery exposes only the current subject's personal connection readiness, never another subject's UUID or metadata.
- Runtime and Codemode token resolution use the immutable human initiator captured for the turn.
- A service or scheduled-task initiator can use a personal connection only through its immutable frozen personal-delegation snapshot; it never infers one from the creator or current user.
- Two different OpenGeni users in the same workspace resolve different Slack rows even when both use `slack.com` and `oauth2`.

Slack writes API-bridge messages as the authenticating Slack human and supplies the configured app attribution. OpenGeni must pass the user's requested message content to the reviewed Slack API tool unchanged: it does not prepend or append author, requester, requested-by, or proxy text.

Deleting the OpenGeni personal connection removes local use of that grant; it does not uninstall the Slack app or revoke the grant at Slack. Revoking the grant at Slack causes later verification or refresh to fail and the local connection to require reconnect. Use Slack administration when provider-side revocation is required.

## Workspace bot manifest

The default `limited` manifest requests 17 bot scopes and 11 separate user scopes for the account API MCP bridge:

```yaml
display_information:
  name: OpenGeni
features:
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: OpenGeni
    always_online: false
  slash_commands:
    - command: /opengeni
      description: Start an OpenGeni task in this channel
      should_escape: false
      url: https://app.opengeni.ai/v1/integrations/slack/commands
  shortcuts:
    - callback_id: opengeni_message
      description: Start an OpenGeni task from this Slack message
      name: Open in OpenGeni
      type: message
oauth_config:
  redirect_urls:
    - https://app.opengeni.ai/v1/integrations/oauth/callback
    - https://app.opengeni.ai/v1/integrations/slack/callback
  scopes:
    bot:
      - app_mentions:read
      - canvases:read
      - channels:history
      - channels:read
      - chat:write
      - commands
      - files:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - users:read
      - reactions:read
      - files:write
    user:
      - channels:read
      - groups:read
      - im:read
      - mpim:read
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - users:read
      - im:write
      - chat:write
settings:
  event_subscriptions:
    bot_events:
      - app_home_opened
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - reaction_added
    request_url: https://app.opengeni.ai/v1/integrations/slack/events
  interactivity:
    is_enabled: true
    request_url: https://app.opengeni.ai/v1/integrations/slack/interactions
  is_mcp_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

The production defaults above are customizable for a separate non-production app. The managed staging manifest is generated with:

```bash
OPENGENI_PUBLIC_BASE_URL=https://staging.app.opengeni.ai \
OPENGENI_SLACK_APP_NAME='OpenGeni Staging' \
OPENGENI_SLACK_BOT_DISPLAY_NAME='OpenGeni Staging' \
OPENGENI_SLACK_COMMAND=/opengeni-staging \
OPENGENI_SLACK_SHORTCUT_NAME='Open in OpenGeni Staging' \
bun run slack:manifest
```

This changes the provider app name, bot display name, slash command, shortcut label, and every provider callback URL. Keep `OPENGENI_SLACK_BOT_DISPLAY_NAME` and `OPENGENI_SLACK_COMMAND` set to the same exact values in the API runtime so installation verification, signed command delivery, and the generated provider manifest cannot drift. For managed Kubernetes, `bun run deployment:runtime-artifacts` carries `OPENGENI_SLACK_CLIENT_ID`, `OPENGENI_SLACK_CLIENT_SECRET`, `OPENGENI_SLACK_SIGNING_SECRET`, `OPENGENI_SLACK_BOT_DISPLAY_NAME`, and `OPENGENI_SLACK_COMMAND` into the generated runtime environment. Populate the three credential values from the matching environment's Slack app before publishing the runtime Secret; a staging release must never reuse the production triplet. `OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED` rides the same generated runtime environment and is emitted only when it is set, so leaving it unset keeps the code default, which is now routing **on**. Set it explicitly to `false` in that environment to opt a deployment out. See [Which workspace Slack work lands in](#which-workspace-slack-work-lands-in).

Generate the canonical JSON manifest with `bun run slack:manifest`. Its URL/name overrides remain unchanged; set `OPENGENI_SLACK_ACCESS_MODE=full` only when eligible to request the optional bot search scopes. The separate user grants cover the nine reviewed API tools. `settings.is_mcp_enabled` retains the existing OAuth discovery surface. Bot verification evaluates only granted bot scopes; user grants never widen the bot principal. Reactions and file delivery retain their optional grants and workspace settings. Do not add `channels:join`, `chat:write.public`, `chat:write.customize`, administration, or enterprise-search grants. Slack's native invite prompt handles missing bot membership. The bot allowlist still accepts previously granted safe search scopes without enabling an unusable generic search tool.

## Install and connect the workspace bot

`files:write` is an optional bot grant, requested by the canonical manifest but
not required for existing installations to remain eligible. Apply the generated
manifest to the Slack app before reinstalling the OpenGeni workspace bot. Older
installations keep their existing reads and task replies; explicit file delivery
reports that a Slack administrator must reinstall to grant `files:write`. A
personal Slack connection is neither required nor substituted for this bot grant.

1. In the intended OpenGeni workspace, open **Capabilities → Integrations → Slack**.
2. Use the Slack sheet's **Set up** action (or **Reconnect** for a repair reinstall). The button calls OpenGeni's authenticated OAuth-start API; it is not a static provider link.
3. OpenGeni creates high-entropy, signed, single-use state bound to the exact account, workspace, subject, and install or reinstall action, then redirects to Slack workspace selection and consent.
4. Slack returns the browser to `/v1/integrations/slack/callback`. OpenGeni consumes the state once and exchanges the temporary code server-side.
5. OpenGeni verifies the exact Slack workspace, bot ID, bot user ID, token type, display name, and scope set before storing the bot token in the encrypted connection credential column.

The sheet's **Connection** block shows the secret-free installation binding: exact Slack team ID/name, bot ID, bot-user ID, OpenGeni account name/ID, workspace name/ID, binding state, and binding version. Configuration actions still require the existing `connections:write` or workspace-admin authority. Tokens, OAuth codes, authorization headers, and raw state are never projected.

Slack's bot installation endpoint is protected by the bound one-time state and exact redirect URI. The implementation does not claim or add PKCE to this provider-specific bot flow unless Slack documents support for it.

The bot connection is a workspace-shared `app_install` row (`subjectId = null`) in exactly the OpenGeni workspace that initiated installation. It is not organization-wide and is never implicitly shared to another OpenGeni workspace. API responses, browser URLs, events, tool results, and audit metadata contain only non-secret connection and principal facts.

`slack_installation_bindings` is the durable team-routing authority. One active Slack team still points to exactly one OpenGeni account and **home** workspace: one credential, one connection, one binding. The callback takes a transaction-scoped team lock before connection mutation; an exact same-workspace team/bot/bot-user reinstall rotates the encrypted credential in place and preserves the connection UUID used by routing and scheduled tasks. Concurrent exact-principal callbacks converge on that row. A different OpenGeni workspace or Slack bot principal receives an actionable conflict and no second connection is created. Reassignment of the binding is intentionally out of scope: there is no last-write-wins move operation or access-link shortcut.

Where a conversation's **work** lands is a separate, additive fact. See [Which workspace Slack work lands in](#which-workspace-slack-work-lands-in).

Migration `0212_slack_installation_bindings.sql` backfills one newest row only when all verified legacy rows for a team agree on the exact account/workspace and bot principal. Exact-principal duplicates remain stored but are non-authoritative. Conflicting legacy rows retain their provider credentials and are marked `quarantined`; routing and reinstall fail closed until an explicit forward fix resolves them. The database trigger fences rolling-old writers before they can commit a second binding. After migration, roll forward with binding-aware code rather than dropping the ledger or guessing a tenant; removing the binding authority is not a supported rollback.

## Start and continue OpenGeni work from Slack

### Explicit file delivery in the task thread

Slack-created tasks include the first-party `slack_bot_upload_file` tool. It takes
an explicitly selected retained `fileId` (also the artifact UUID returned by
`sandbox_file_publish` or image generation) and one stable `operationId` UUID.
The destination is the exact session's existing Slack interaction, not a channel,
user, bot connection, or URL supplied by the agent. Nonempty, ready, SHA-256-bound
files up to 25 MiB are supported. Personal files remain in private task threads;
shared/externally shared and archived conversations are refused. There is no
automatic attachment scraping or upload triggered by assistant Markdown.
Private shortcuts and handoffs must finish their durable bot-DM route rekey
before any file delivery; Slack's live conversation must be an IM with the linked
requester. The original source conversation is never a destination.

Source-file read authority, the live initiating attempt, the linked task requester,
installation identity, current bot scope, and channel membership are rechecked
before provider requests. Routed tasks use the installation's home credential
while their file and delivery ledger remain in the source task's workspace.

The source-local `opengeni_private.slack_file_upload_operations` ledger binds an
operation to its exact file, session, interaction, principal, and request digest.
It checkpoints the allocated Slack file ID before transferring bytes and marks completion started before
`files.completeUploadExternal` can share them. Temporary upload URLs and original
bytes never enter the ledger, tool result, or audit metadata. A completed retry
returns its original identity without another upload. A lost byte-transfer
response may replace an **unshared** temporary file, never a file whose completion
started. Uncertain completion is read/reconciled by exact file, bot principal,
channel, and thread; it is never blindly replayed. Reuse the same `operationId`
for recovery rather than creating a new intended delivery.

Without the optional grant or a confirmed outcome, keep the authenticated
OpenGeni artifact reference available and report the concrete blocker. Do not
claim that an image was posted to Slack merely because it was retained in OpenGeni.
This tool does not add arbitrary-channel delivery or scheduled-task file posting.
After deploying this support, newly created Slack tasks receive the tool subject
to deployment policy. Existing sessions and accepted attempts keep their frozen
tool selections; use a new Slack task or an authorized session-policy update
rather than automatically widening their authority.

### Private App Home task inbox

Opening the OpenGeni app's **Home** tab publishes one bounded, private task inbox for the exact Slack user. An explicitly linked Slack identity is resolved to its current OpenGeni subject and rechecked for live workspace membership, `sessions:read`, host session-list scope, account, workspace, connection, and installation authority before task data is sent to Slack. The view groups action-required or failed tasks, active tasks, and recent completions; each control is an authenticated OpenGeni deep link, so opening or changing a task goes through the ordinary browser authorization boundary.

An unlinked or access-revoked identity receives a content-free connect/access view. A link or membership change immediately before publication replaces the task view instead of retaining stale task text. `views.publish` replaces the user's whole Home view, so duplicate `app_home_opened` deliveries converge without a second inbox or provider-side task record. The projection is read-only: it does not read ambient Slack messages, grant workspace access, create a session, answer a question, approve a tool, or write Documents, Knowledge, Memory, preferences, or policy.

Authenticated Slack users can start work through four configured entry points:

- mention `@OpenGeni` in a channel or existing thread;
- invoke `/opengeni <task>` in a channel (the single argument `info` is reserved for the ephemeral info card below and starts no work);
- direct-message the OpenGeni bot, or use the **Open in OpenGeni** message shortcut when explicitly sending a human-to-human DM message. A human-DM shortcut imports only the selected message, then moves acknowledgement, progress, results, and continuation into that user's OpenGeni bot-DM thread; the bot never joins, reads, or posts workspace output into the source human DM.

  **Privacy here is `slack_interactions.visibility`, not session tenancy.** Slack never creates a `user_private` session: it sends no `visibility` in the create payload, so every Slack-origin session takes the ordinary `workspace_shared` default. (`createSessionForRequest` is also called without its authorization argument, which is what an Only-me payload would additionally require.) That is a statement about the session row, not about who can read it. The interaction's `private` visibility is a real OpenGeni access boundary in its own right: `requireSessionAuthorization` denies every subject except the owning one, an agent reaches it only from the same root session, and `listSessionsForSubject` excludes it from every other subject's list. Keeping the privacy on the interaction rather than the session row is what leaves session tenancy, sandbox selection, and the Only-me create rules untouched.
- after a workspace admin enables **Capabilities → Slack connections → Reaction summon**, add the configured exact emoji reaction (default `:genie:`) to one message in an allowed bot-member conversation.

Reaction summon is disabled by default. Only `workspace:admin` can enable it, choose the exact emoji name without colons, and select all bot-member conversations or an explicit allowlist. Existing installations without `reactions:read` remain usable for mentions, commands, DMs, shortcuts, and tools, but the admin UI blocks reaction enablement until the bot is reinstalled with the canonical manifest. Slack Connect/shared conversations fail closed unless the separate shared-task policy below authorizes an exact private handoff.

### New-session selections

A new task started from a mention, command, direct message, shortcut, or reaction starts from what the destination workspace offers every new session, not from the person's last website composer selection. A composer selection is one chat's explicit narrowing (for example a short connector list, no repositories, or one Variable Set), and a Slack message has no composer to show or change it, so it would silently narrow every Slack task after it.

- **Connectors** follow the workspace default connector policy, exactly as a new website chat that does not change its connectors. That policy includes the person's own personal connections when it includes connected servers, and they stay executable only through the ordinary delegation snapshot frozen on the accepted turn.
- **OpenGeni tools** are the workspace default selection, or the deployment default. Mentions, commands, DMs, and shortcuts always add the seven read-only Slack context tools listed below, whatever the base selection is. Reactions do not add them, so a reaction-started task keeps its bounded context.
- **Repositories** are the person's own recently used repositories in this workspace: those on the top-level sessions they started here that were active in the last 30 days, most recent first, at most five. A repository counts only through its current entry in the workspace GitHub App catalog (the same catalog, and the same `github:use` permission, as the website's repository picker), on its default branch; another member's sessions never count, a repository that was itself attached automatically to an earlier Slack task never counts (so automatic attachments cannot keep renewing themselves), and archived or empty repositories are skipped when GitHub reports that. Session creation revalidates every one against the workspace's installation grant. A person with no recent repositories gets none, and the agent can still find and clone repositories through its GitHub tools. GitHub is asked only when there is a recent repository to look up; a GitHub outage or an unconfigured App starts the task without repositories rather than failing it, and logs `[slack-interactions] workspace repositories unavailable`.
- **Clones of these repositories are best effort.** Each one carries `optional: true` on its repository resource, so one that cannot be cloned (for example an empty repository, or a ref that no longer exists) is skipped with a warning, reported as `skippedOptionalRepositories` on the `repository-clone` operation event, and never fails sandbox setup for the task. Each optional clone is bounded to 60 seconds (and all of them together to 90 seconds of the setup command) when the sandbox has a `timeout` binary, so a hung fetch is skipped the same way; the stock images carry one. A repository a person or caller attaches explicitly keeps the strict behavior: a failed clone still fails setup, and its clone is not bounded. Losing access after the task started is handled the same way: before each turn's strict GitHub App allowlist recheck and installation-token mint, the worker drops, for that turn only, every optional repository the workspace allowlist no longer admits and, when this deployment's GitHub App mints the tokens, every one the installation can no longer reach on GitHub (deleted, or removed from the App); a GitHub error while checking also sits it out rather than failing the turn. The dropped mount paths are reported as `skippedOptionalRepositories` on a `sandbox.operation.completed` event named `optional-repository-access`, with a count-only worker log line. This only ever removes a repository from the turn; every remaining repository still goes through the unchanged strict checks, and an explicitly attached repository that loses access still fails the turn.
- **Sandbox Environment and Variable Sets** follow the workspace default Sandbox Environment and its default Variable Sets. The person's explicitly picked Variable Sets and compute target are not carried over.
- **Model** is the one composer choice that carries over, and only when the person explicitly chose it, because a model choice narrows nothing. Otherwise the existing Slack model fallback and the server-side default apply.

This read does not consume or change the website draft. Draft text, goals, uploaded files, and visibility are not imported. Existing Slack threads retain their session configuration. A create retried after its reserved session shell committed replays that shell's exact selection instead of resolving defaults again, so a retry never changes what a task started with.

The first message does not list connectors, repositories or the Sandbox Environment. New interactions leave `slack_interactions.session_defaults_line` null. An interaction bound before that change may still carry a frozen line; a repair or a control update of its acknowledgement keeps those bytes and their post-ledger identity rather than conflicting with a message Slack already shows.

### Links to another deployment

Staging and production are separate deployments, and a workspace or session id from one does not exist in the other. When an accepted Slack message, the thread context imported with a mention, or the reacted message and thread context of a reaction-started task contains an OpenGeni workspace or session link whose host is a different deployment under the same parent domain as this one (for example `staging.app.opengeni.ai` versus `app.opengeni.ai`), the accepted message carries a short model-context note naming that deployment. The agent then tells the person the link is for the other deployment instead of reporting the session as not found or asking for access that no grant here can give. Links to this deployment and URLs on unrelated sites are left alone.

### Shared-conversation task policy

Slack Connect, pending-external conversations, and MPIMs use an immutable workspace policy authority exposed at `GET`/`PUT /v1/workspaces/:workspaceId/slack-task-policy`. No active policy means deny. A workspace admin may activate a CAS-fenced revision containing exact Slack team and conversation allowlists, guest/external-initiator flags, an MPIM flag, `sharedConversationMode`, and `resultPublicationMode`.

An allowed shared invocation is never delivered back into the shared conversation. After rechecking the exact installation, bot membership, conversation/user facts, and active policy immediately before reading Slack content, OpenGeni marks the interaction private and delivers progress and results in the initiating user's bot DM. As above, the session row itself remains `workspace_shared`; the privacy rides `slack_interactions.visibility`, which is enforced on both surfaces. The immutable origin row retains the source team/conversation/thread plus the exact policy revision and version, but not the source message text.

Results return to the source thread only after the initiating user clicks the requester-bound publication action. The click rechecks the installation, live identity link and grants, exact active policy revision/version, conversation membership and shared facts, and terminal result immediately before the provider post. Policy drift, lost membership, installation drift, duplicate delivery, or an ambiguous provider outcome cannot produce a new post. `approval_required` and `allow` both require this deliberate click; the former records that workspace policy requires per-result approval, while the latter permits requester-initiated publication without a separate administrator decision. `never` exposes no publication action.

On a matching reaction, OpenGeni rechecks the live workspace setting, installation scope, exact linked Slack identity, `sessions:create` plus `sessions:control`, bot channel membership, and channel policy before reading message content. It retrieves only the exact reacted message and a bounded containing-thread projection, marks the reacted message explicitly, and routes the work to the canonical root thread. Direct, safe, sufficiently specified requests begin immediately; the session asks one concise question only when information is materially missing or the requested action is risky, irreversible, or authorization-sensitive. Distinct authorized reactions that resolve to the same root thread share its canonical session but each contribute one event-ID-keyed task exactly once. Remove/re-add and Slack retry deliveries converge through the same stable reaction identity, so they cannot create duplicate sessions or task messages.

The reaction path may import only image files attached to the exact reacted message—never parent, sibling, thread, preview, or link-unfurl files. Explicit app mentions, bot DMs, and replies in an existing OpenGeni task thread use the same authority for images attached to the exact invocation, including file-only messages; nearby context attachments are never imported. The signed event stores only a bounded file-presence fact, so text-only DMs and replies do not trigger an extra provider read. Before downloading anything, OpenGeni re-fetches each selected Slack file through the verified workspace bot, rechecks exact non-shared channel membership and file sharing, and caps the selection at four files, 4 MiB each, and 16 MiB total. Only complete PNG, JPEG, and WebP bytes whose Slack declaration, HTTP content type, structural signature, size, and digest agree are accepted. Private downloads allow only bounded HTTPS Slack file hosts and one validated redirect; interactive Slack pages, markup, truncation, polyglots, unsupported types, and credential or authority ambiguity fail closed. Supported bytes are imported into deterministic tenant/source-bound workspace files, while the session and event history retain only file references, safe mount paths, MIME, and size—not Slack URLs, object keys, credentials, or inline data. Unsupported or invalid individual files produce bounded omission notices and do not prevent other valid images or the text-only task from continuing.

Every top-level bot DM durably reserves a new private OpenGeni session ID for the linked OpenGeni subject before session creation begins. Authorization and listing use that reservation until the same ID is bound as the session root, so a crash or concurrent read before binding cannot expose the session to another workspace subject. A reply in its Slack thread continues that exact session; a separate top-level DM creates a separate session. Installing the bot for a workspace never converts private DM sessions into workspace-visible sessions.

A channel mention, command, or message shortcut creates one workspace-visible session whose authorization follows both the Slack channel and live OpenGeni workspace grants. Channel shortcuts retain the same bot-membership requirement as mentions and commands. A message shortcut from a one-to-one human DM is the deliberate exception to membership lookup: Slack's signed interaction supplies only the selected message, OpenGeni marks the interaction private to the invoking linked subject, and the durable route is rekeyed to a new thread in that subject's OpenGeni bot DM before any progress or result is delivered. Two linked users invoking the shortcut on the same human-DM message receive separate interactions and bot-DM routes. Mentioning OpenGeni inside an unmapped existing thread adopts that thread as the session surface, including when Slack delivers the threaded mention as a generic message event. The exact accepted invocation remains the visible session message and title. Bounded containing-thread or channel context, plus any safe imported-attachment manifest, is attached to that same message as `modelContext`: the model receives it, but ordinary timeline and session UI projections omit it. A top-level mention receives only bounded channel history ending at that invocation, so references such as "this" or "the previous message" can be resolved without unbounded channel ingestion. Once mapped, linked and authorized OpenGeni workspace participants can continue the same session by replying in that thread. An ordinary unmapped thread reply is ignored rather than creating work implicitly.

Top-level group-DM/MPIM messages do not start tasks unless an exact active shared-task policy enables MPIM private handoff. Slack Connect, MPIM, and administratively restricted conversation invocations otherwise fail closed before content is read or retained. The one-to-one human-DM shortcut remains a separate initiating-user-private path: it imports only Slack's signed selected message and never opens or posts into the source DM.

The bot's first message for accepted work is one sentence that is itself the absolute session link, `<session URL|OpenGeni started this task>.`, with a single **Stop** button while the task runs. When routing made a genuine choice the workspace is named inline, `OpenGeni started this task in *Workspace*.` (see [Saying where the work went](#saying-where-the-work-went)). After that the originating thread gets at most three progress posts globally per interaction, plus durable human-input questions, approvals, stop/cancellation, failures, blockers, and one final result. No later message repeats the session link or the workspace. The human-DM shortcut and the shared-conversation private handoff link the same way from `OpenGeni started a private task` and keep their privacy sentence. A reaction-started task's first message links from the same sentence, names the emoji, keeps its short how-to, and has no button, because a reaction never shows the one-time hint.

Messages carry no standing how-to prose. The how-to appears exactly once per Slack identity per installation, inside that identity's first acknowledged task, and never again. It says to reply in the thread to continue or reply `stop` to stop, and points to `<command> info` for the rest. It does not mention scheduling: whether the agent can create a schedule depends on the session's tools and the person's `scheduled_tasks:manage`, neither of which is frozen with that text, so the live-gated [`<command> info` card](#the-command-info-card) names it when both hold. New tasks have no **Status** button, no task controls card, and no **Make recurring** link.

Because `slack_bot_post_operations` binds one operation id to one request digest that covers the message text, and an acknowledgement is re-rendered whenever it is repaired, that decision is a frozen fact rather than a live question. `resolveSlackInteractionFirstTaskHint` resolves it once and writes it to `slack_interactions.first_task_hint` in the same transaction that claims `slack_bot_user_links.first_task_hint_interaction_id` (migration 0327). Every later render replays the frozen boolean, so a repair after a crash, a lost provider response, or a replica race reproduces identical bytes, and unlinking plus relinking the Slack identity cannot flip an acknowledgement that already rendered. Resolution happens before the provider post and raises on failure into the ordinary retryable inbox path, so no post operation is ever bound to text that depended on an unresolved answer. The private-handoff and human-DM acknowledgements keep their distinct privacy sentence, and the reaction-summon acknowledgement keeps its own wording and never consumes the hint.

The opening sentence is a frozen fact for the same reason. `slack_interactions.start_message_line` (rolling migration 0537) is rendered once, when the session binds, from the session URL, the frozen workspace label, and the task's origin, and a replayed bind never rewrites it, so a later change to the web base URL or the workspace name cannot change the bytes of a first message the ledger already holds. The column is also the format discriminator: a null line means the interaction was bound before compact messages, or by an older image during a rolling deploy, and it keeps the previous format described below. A compact first message posts under its own operation id (`slack-ack:<interaction>:start`), so an older image that repairs the same interaction during a rolling deploy posts a second message rather than wedging on a digest conflict.

**Stop** pauses the session through the canonical session control, exactly like replying `stop`, and requires `sessions:control` plus the exact requester binding described below. The press updates the first message in place: its sentence and any hint stay, a `Stopped.` line is added, and **Resume** replaces **Stop**. **Resume** resumes the session and puts **Stop** back. Nothing new is posted. The replacement button is reserved under an action key derived from the pressed handle before the message is updated, and only then is the pressed handle settled, without superseding the replacement, so a retried click reproduces the same update. Replying `stop` in the thread performs the same swap. When the task settles (a result, a failure, or a cancellation closes its delivery), the delivery pump updates the first message once more to drop the button and retires the pending handle; if the first message was still being retried at that point, its acknowledgement retires the button once its own post completes. A first message Slack no longer has does not fail the delivery, and its handle is retired anyway. A press racing the settle can leave the requester's own Stop or Resume on a finished task until the next settle; it can only pause or resume that session. A follow-up in the same thread gets no new button, and replying `stop` still pauses it. A pause or resume from the web does not change the button: pressing Stop on a session that is already paused is a no-op pause that shows Resume. Every render of the first message (the post, an acknowledgement repair, a Stop or Resume update, the settle update) is a pure function of the frozen sentence, the frozen hint decision, and the handle it shows, and a button is rendered from its handle whatever the handle's status, so a repair after a press renders exactly the bytes the post ledger already holds.

Interactions bound before compact messages keep the previous format byte for byte: a separate **Open in OpenGeni** link, any frozen defaults line, the previous hint text, **Status** and **Stop** on the acknowledgement, a new task controls card with **Status** and **Stop** or **Resume** after a Status, Stop, or Resume press, **Make recurring** on the Status reply for a requester who holds `scheduled_tasks:manage`, and the `-> Workspace` line on every message. A press replaces the message it was pressed on; when that message is the acknowledgement of the interaction that won the hint, the update re-appends the hint and any frozen defaults line, so pressing **Status** cannot destroy the only copy a Slack identity is ever shown. Their control buttons are also rendered from their reserved handles whatever the handles' status, so an acknowledgement repair after a press reproduces the posted bytes instead of conflicting. Nothing touches their acknowledgement when the task settles. A control button an older image rendered on a compact interaction during a rolling deploy gets that format's outcome too, including the controls card that carries Resume. Completed results carry the result text plus the ordinary requester mention, and, in the shared-conversation flow, the publication action block; no continuation prose and no recurring action. Server-owned interaction delivery resolves the verified workspace bot under the dedicated `service:slack-interaction` principal; the initiating human's grants authorize session creation and control but are never substituted as the provider credential principal. Every bot post disables Slack link and media unfurling. When terminal assistant/result text is exactly equal or one is a safe boundary-aligned prefix of the other, only the contiguous terminal-shaped suffix is coalesced; earlier distinct progress and non-prefix outputs remain separate. The same durable turn and delivery evidence applies across pages, retries, restarts, and replica claims rather than content hashes or cross-task similarity. Each progress event durably claims one of its three slots and a stable Slack post-operation identity before provider delivery, so duplicate claims cannot exceed the cap.

Approval requests are projected as bounded Block Kit cards containing only the action name and opaque action handles—never raw tool arguments, credentials, or provider request data. **Approve once** and **Reject** invoke the existing exact `user.approvalDecision` boundary. A single-select human question may expose up to five option buttons plus Skip; more complex questions retain the ordinary thread-reply fallback. A new task's first message exposes **Stop** or **Resume**; an interaction bound before compact messages keeps **Status** and **Stop** or **Resume** on its acknowledgement and control cards. Every click is signed, acknowledged into the durable inbox before processing, and bound to the exact installation, originating Slack user, linked OpenGeni subject, interaction, session, message operation, target, and expiry. The processor rechecks all of those facts plus live workspace access immediately before calling the canonical session lifecycle. Duplicate or stale clicks converge on one decision and the original card is updated through a separate durable `chat.update` operation ledger. Approving one call never changes future connector policy.

### Blocked workers and paused goals

**Both notices are off by default and are switched on per workspace.** The workspace setting `slackOrchestrationNotices` carries one boolean per notice (`childRequiresAction`, `goalPaused`); absent, malformed, or partially invalid settings resolve to both disabled through `resolveWorkspaceSlackOrchestrationNoticeSettings`, so only an explicit opt-in ever posts. An unsolicited Slack post is worse than a missed one, and the in-app rail and priority feed already surface a blocked child worker and a paused goal. The two checkboxes live beside the reaction shortcut in the Slack integration settings and persist through the ordinary workspace-settings patch. A disabled notice takes the same "nothing to post for this event" path as an undeliverable one: no Slack post, no post-operation ledger row, and the delivery cursor advances past the event exactly as it would have. Every pre-existing Slack card type is unaffected by the switch. Turning a notice on applies to events appended afterwards: the delivery cursor has already advanced past everything that arrived while it was off, and OpenGeni deliberately does not replay that history into the thread.

A Slack-originated session can spawn child workers, and those children are never themselves mapped to a Slack thread. When a child blocks on human input or a tool approval, its parent receives the bounded `child_requires_action` notice, and the delivery pump turns that one notice into a single pointer card: `A worker you started needs input.`, one bounded single-line preview of the first question (or the count of waiting tool approvals), and an **Open in OpenGeni** link to the child session. The card is a pointer, not a second question card - the human answers on the child's own OpenGeni card, and no subject id, credential, or raw tool argument crosses into Slack. A notice whose exact `(child, turn, generation)` boundary already carries a `child_requires_action_resolved` row on the parent, or whose own row is `superseded` or `cancelled`, posts nothing: Slack delivery runs behind the session, and a card announcing a worker that is no longer blocked is worse than no card. That check reads only the parent's own rows. The deferred child lifecycle notices (`child_progress`, `child_waiting_capacity`, `child_requires_action_resolved`, `child_paused`) post nothing, so the thread stays quiet.

A goal that pauses because it ran out of budget (`limits`) or hit the continuation cap (`max_auto_continuations`) posts one bounded line - `Goal paused (budget).` or `Goal paused (continuation cap).` - plus the session link. A `user_pause`, `api`, or `agent` pause is a decision the human or their agent already made, `no_progress` is not a stop the human must act on, and `goal.resumed` is never announced.

Both use the same durable per-event post-operation ledger as every other delivery, keyed on the parent session event, so reaper retries, replica claims, and a replayed delivery page converge on one message. Both also draw on the same durable per-interaction slot budget as assistant progress (three posts per Slack task), so an orchestration that fans out to many blocked children cannot turn one thread into a feed; past the cap a notice goes silent exactly like a fourth progress message. The budget is shared rather than per-category because the ceiling worth enforcing is the total number of posts the human did not ask for. A slot is claimed only when a card is actually going to be posted, so a skipped, stale, or already-resolved notice never consumes one, and the claimed row never becomes terminal-coalescing evidence. Rolling migration `0329_slack_orchestration_delivery_events.sql` adds `system.update.pending` and `goal.paused` to the delivery claim's event types; an older API image simply drains the extra claim without posting.

Completion, failure, cancellation, and action-required posts mention only the exact Slack user who initiated the mapped task and only while its durable requester binding remains valid. Channel participants may still continue a workspace-visible thread, but they cannot operate another user's approval/control buttons. Reply `stop` in the mapped thread remains a compatible pause path; on a compact task it also swaps the first message's Stop to Resume, exactly as pressing Stop does. Start a new top-level DM or invoke OpenGeni again to create a new session. Neither is advertised on every post: the one-time first-task hint names `stop` and points to `<command> info`, which names both.

New tasks carry no scheduling action in Slack. `<command> info` tells a caller who holds `scheduled_tasks:manage` how to repeat a task on a schedule: ask OpenGeni in the task's thread (only when they also hold `sessions:control` and new Slack tasks in the workspace get the `scheduled_tasks_create` tool), or open Schedules. **Make recurring** survives only on the **Status** reply of an interaction bound before compact messages, and only while the requester who pressed Status still holds `sessions:read` plus `scheduled_tasks:manage` in that workspace. It opens the authenticated Schedules editor with the exact source session selected, a conservative one-hour/skip-overlap draft, and an explicit prompt field. The link carries only the session UUID: Slack text is not copied into the URL, and no task or monitoring exists until the user reviews and submits the canonical schedule form. Session visibility/control and schedule authority are rechecked by the ordinary browser/API path, and a deployment without an absolute web base URL omits the action instead of failing the card.

### The `<command> info` card

`/opengeni info` (the configured command plus the single argument `info`) answers with an ephemeral Block Kit card and nothing else. It never reaches the durable inbox, never verifies channel membership, never posts through the bot, and never creates a session, so it is safe in any conversation where the command is available. Before any workspace-identifying text is echoed it re-proves the exact Slack identity link and the live workspace grant for that identity's OpenGeni subject, in the same account, with `sessions:read`; an unlinked identity receives the ordinary signed connect view and an identity whose subject holds no live grant is told to request access. Every line is gated on the grant that authorizes it: continuing and stopping a task require `sessions:control`, starting a new task requires `sessions:create`, and repeating a task on a schedule requires `scheduled_tasks:manage`. That last line suggests asking OpenGeni in the task's thread only when new Slack tasks in the workspace get the `scheduled_tasks_create` tool (the workspace or deployment default tool selection), and otherwise only links to Schedules. Only the destination line (which OpenGeni workspace the work lands in, with an absolute workspace link) is unconditional, and reaching the card at all already required `sessions:read`. It is a projection of what the caller can already do, never an action.

Slack identities must be explicitly linked to an OpenGeni subject in the same account and workspace. An unmapped identity receives a private bot DM containing a signed, 15-minute, workspace/connection/team/user-bound link token and no session is created. The managed human continuation verifies the token and live installation route before revealing the proven workspace name or creating token-free state; an existing `sessions:create` grant completes linking immediately, while an unavailable subject may create a reviewable access request without being granted the workspace first. Invalid signatures or timestamps, replayed/duplicate provider identities, inactive or ambiguous installations, missing bot channel access, revoked OpenGeni access, malformed payloads, and cross-tenant ambiguity fail closed. Slack retries, reconnects, worker restarts, and session resumes converge through the durable inbox, private session reservation, route binding, session idempotency key, delivery cursor, per-event progress ledger, and Slack post-operation ledger. Inbox and delivery retries honor durable `retry_at` fences; Slack HTTP 429 responses honor bounded `Retry-After`, transient failures use bounded exponential backoff, and a delivery closes after eight failed claims or an explicitly permanent provider error.

The link stays inside `/workspaces/:workspaceId/capabilities`. New bot messages put the signed bearer in the URL fragment so it is not sent in HTTP request lines, reverse-proxy logs, referrers, or managed-auth callback URLs. Legacy query-form values are scrubbed from the browser location but deliberately rejected rather than exchanged because a query bearer may already have reached an HTTP access log; the bearer is never written to browser storage. After managed sign-in, OpenGeni exchanges the fragment bearer for durable token-free state bound to its exact digest and claims, the authenticated subject, account/workspace, Slack installation/team/user, expiry, and monotonic version. If the subject already has `sessions:create`, linking completes once. Otherwise the unavailable-workspace shell shows `You need access to **[workspace]** to connect your Slack account.` only when the signed proof safely establishes the workspace name, with a non-enumerating fallback, and replaces the ordinary default-workspace action with **Request access** and **Cancel**.

A requested continuation is visible only to workspace member administrators. Approval uses the canonical workspace-membership grant, then completes the exact Slack identity link in the same transaction; denial, requester cancellation, expiry, tamper, replay, cross-subject reuse, and cross-workspace reuse never grant access or reassign an existing Slack identity. Every mutation is CAS- and idempotency-fenced, the request and operation rows use FORCE RLS, and audit metadata excludes the bearer and its digest. Approval can also complete after a separate canonical member grant is observed, but never before that live grant exists. Terminal failures tell the user to request a fresh link from Slack.

A completed turn without nonblank output is not a finished Slack task. Recorded input waits and pacing yields advance the delivery cursor without a result post and keep the interaction open for a later result. Earlier commentary is never substituted for a missing result, and Slack does not fabricate a success message. Budget exhaustion instead sends one actionable billing/usage-limit notice to check credits and usage limits and reply to resume, then closes delivery as failed. Internal diagnostics are not echoed to Slack. Ordinary nonblank results keep the existing once-only progress/result coalescing. A per-message assistant completion that the worker streams (it carries a provider `messageId` or a `phase`) is never a Slack post: commentary is activity, and a streamed final message is delivered once by its `turn.completed`, so the post carries the requester mention instead of gaining it through an edit that Slack does not notify. The one reply Slack posts from a turn without output is the `reply` its `turn.completed` records: the answer a human's message received before the turn waited for input again, such as a status answer while children still run. It is posted once with the requester mention and leaves delivery open for the eventual result.

Agents write ordinary Markdown because the same reply renders in the OpenGeni console, and Slack message text does not render Markdown. Delivery therefore converts model-authored text (progress posts, the recorded `reply`, the final result, the terminal update that rewrites a coalesced progress post, and an approved shared-result publication) to Slack mrkdwn at the Slack sink, in `apps/api/src/integrations/slack-mrkdwn.ts`: headings become bold lines, `**bold**` and `__bold__` become `*bold*`, `***both***` becomes `*_both_*`, `~~struck~~` becomes `~struck~`, `[label](https://...)` becomes `<https://...|label>`, and `-`/`*`/`+` bullets become `•` with their indentation. Numbered lists and block quotes are already Slack syntax. Fenced code blocks (at any indentation, so code nested under a list item too) and inline code are never rewritten; the opening fence only loses its language tag, which Slack would print as the first code line. Links Slack cannot open, such as `artifact:` and `sandbox:` links, are left as written. Provider citation handles (U+E200 `cite` ... U+E201, which Codex web search can emit without a resolvable annotation table) are removed, as the OpenGeni timeline already hides them. This is formatting at a third-party sink, not content redaction: session events, model history, and every other surface keep the exact text, and fixed notices, cards, and mentions are not passed through the converter. Because `slack_bot_post_operations` and the `chat.update` ledger bind an operation id to a digest over the exact bytes, an operation that an earlier release already bound to the unformatted bytes keeps them: the ledger reports that conflict from its durable claim before any Slack write, and delivery retries once with the unformatted bytes under the same operation id instead of wedging the interaction. Operation ids and action handles never change.

Slack message, thread text, and reaction-imported image references are task-local input only. The interaction path does not automatically write them to Documents, Knowledge, Memory, preferences, Workspace Charter, instructions, or policy. A reaction-started session receives bounded projected context and exact imported files alongside the destination workspace's new-session defaults. It does not automatically add general Slack history or mutation tools. Delivery excludes private reasoning, secrets, credentials, raw logs, raw provider responses, and unbounded output, and bot/self/subtype events are suppressed to prevent notification loops.

## Which workspace Slack work lands in

One Slack team installs into one home workspace, but an organization's teams often work in several. Per-channel and per-DM routing decides where each conversation's work actually runs, within that installation's own organization. It is governed by `OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED`, **on by default**. Setting it to `false` restores the previous behaviour exactly: every conversation uses the installation's workspace, and the resolver short-circuits there before any routing read.

### Home and target

Two tenancies, not one relocated workspace. The bot credential is workspace-owned and every provider call is fenced on it, so a routed session cannot post using another workspace's connection.

| scope | owns |
|---|---|
| **home** = the installation binding's `(account, workspace)` | the `connections` row and bot credential; the post, update and delete ledgers; `slack_interaction_inbox`; `slack_bot_user_links` identity; App Home; reaction-summon settings; Slack task policy; the route and prompt tables |
| **target** = the routed `(account, workspace)` | the `slack_interactions` row; its action handles; progress deliveries; shared-task origins; the access grant; the session and every session event |

The interaction edge and the delivery pump build their bot client from home. Two qualifications, both deliberate:

- Delivery and shared-result publication resolve home through the installation binding, and fall back to the interaction's **own** tenancy when that binding no longer resolves or now names a different connection. That fallback is what the code did unconditionally before routing existed, so keeping it means no delivery that used to succeed starts failing. It cannot post from the wrong workspace: the post ledger claims the connection under the tenancy it was given and fails when that tenancy does not own it.
- The read-only bot tool set frozen onto a Slack-origin session runs under the session's own grant, so on a routed session it resolves a connection from the *target* workspace. A routed session must not be handed the installation workspace's Slack credential through a model-facing tool, which means a target workspace with no Slack connection of its own simply has no bot tools.
 Reaction-summon settings and Slack task policy stay home as well: they govern what may be read out of a Slack conversation, which is an installation-surface concern rather than a property of whoever the task belongs to. A shared-task origin follows the routed task but records the home tenancy of the exact policy revision it froze.

Cross-organization routing is blocked by a table CHECK (`target_account_id = account_id`). Relaxing that later is a rolling migration; adding it later would not be.

### The decision order

Made from durable facts before any agent runs, so it can never be a model judgement. First match wins.

1. **A mapped thread keeps its workspace**, unconditionally, including after the channel has been pointed somewhere else, and including when the flag is switched back off. Its session genuinely lives there.
2. **A strict `in <workspace>: ...` prefix**, parsed only at the start of what the person typed, after any leading mention of the bot, and matched case-insensitively against the exact name of a workspace they can already start work in. It applies to that one message and never writes a route. A prefix naming something unreachable or ambiguous is a **refusal**, not a suggestion that quietly falls through. A message shortcut or a reaction carries someone else's text, so a prefix found there is not an instruction.
3. **The channel's remembered answer**, from the picker or an administrator.
4. **A direct message** uses an explicit DM route, or the person's own personal workspace, derived from their active organization membership pointer. The workspace id is derived and never accepted from a Slack payload or a route row.
5. **A sole candidate**, because one workspace is not a choice. This is what keeps an ordinary installation quiet.

   Counting candidates in a channel deliberately ignores personal workspaces. A channel thread routed into one member's private space would be invisible to everyone else in that channel, and since every member of a managed organization is provisioned a personal workspace, counting them would mean nobody ever had exactly one candidate - an organization with a single shared workspace would be asked to choose in every channel despite having no choice to make. A bot DM is the opposite case and still resolves the sender's own personal workspace at step 4. One consequence follows: a person whose only workspace is their own is refused in a channel rather than quietly working somewhere the channel cannot see.
6. Otherwise OpenGeni **asks once**.

A reaction summon never reaches step 6. It carries no text of the reacting person, so there is no prefix to parse, and it never asks: an unresolved reaction keeps the installation's own workspace, exactly as it did before routing existed.

### Asking once

The first message in a conversation OpenGeni has no route for gets a card in that person's own bot DM, listing only workspaces they can start work in. Nothing is created anywhere while the question is open: the request is parked and re-queued only once they answer, so a card nobody clicks leaves no session and no half-started work. Answering commits the choice, the remembered route, and the re-queued request together, and later messages in that conversation never ask again.

One live card per person per conversation. A shared channel has many people in it, and asking one of them must not swallow another's request. A card that ages out is settled and the next message asks afresh.

### Nobody is quietly served from somewhere else

The invariant is one sentence: a person who cannot reach the routed workspace is **never** given a session in another workspace they happen to belong to, and no session is created. What they are *told* is not one sentence. Three paths refuse independently, and only one of them ever offers a link.

| path | when | what the person gets |
|---|---|---|
| **a Slack message** (mention, command, DM, shortcut, thread reply) | any resolved route except the installation's own workspace and a mapped thread - so `prefix`, `channel`, `dm_route`, `dm_personal` or `sole_candidate` - whose `resolveSlackTargetAuthority` refused | a bot DM plus the Slack access-request link, minted for the workspace they actually need |
| | a prefix naming a workspace they cannot reach, or an ambiguous one | a DM naming what they asked for, plus the workspaces they *can* use when there are any. No link: the workspace they named may not be one OpenGeni will confirm to them |
| | no candidate workspace at all, and nothing else to route on - no mapped thread, no prefix, no channel route, and no DM route. In a channel this also covers someone whose only workspace is their own personal one, since a channel does not count that as a candidate | the generic "ask an OpenGeni administrator" DM. No link, same reason |
| | a mapped `thread` route they have lost - where every thread reply lands - or the installation's own workspace, which is every route while the flag is off | nothing. The pre-routing permanent `identity_access_revoked` failure |
| | any resolved route whose grant is live but lacks `sessions:create` | nothing. The permanent `sessions_create_denied` failure. Reachable for a `channel`, `dm_route` or `thread` target, and for `installation` while the flag is off; a candidate-derived route cannot reach it, because the candidate filter already required that permission and a personal-workspace grant is minted with it |
| **the picker** | the workspace they clicked refuses authority or `sessions:create` | a DM naming that workspace, no link, and the card is left intact so they can pick another |
| **a reaction summon** | no candidate workspace at all | the same generic administrator DM |
| | a route resolved, then authority or `sessions:create`/`sessions:control` refused | nothing. A summon has no conversation of its own to answer into, so every authority failure here is the silent permanent one |

Three details in the first two rows are easy to over-promise. The DM can only *name* the workspace when its name is already in front of it: labels are looked up in the candidate list, so a prefix, a personal workspace, and a sole candidate always carry one, while a channel or DM route usually does not and the DM says "another workspace" instead. Usually, not always - a stale `workspace_memberships` row whose organization membership was suspended is still a candidate, so that refusal does name the workspace. The link belongs to the first row alone: the picker and the reaction path never offer one, and a deployment with neither a web nor a public base URL, or with no Slack signing secret, degrades it to the plain breadcrumb "OpenGeni Settings → Integrations → Slack".

Turning the flag on does change what a lost-access person sees, and that is worth stating rather than eliding. With routing off the resolver short-circuits to the installation's workspace, so an authority failure was always one of the two silent paths. With it on, a single-workspace installation resolves a sole candidate instead - before any question is asked - and posts a refusal where the old code said nothing. The candidate list's membership half is a `workspace_memberships` join fenced on the account and filtered on `sessions:create` or `workspace:admin`, but with no organization-membership check, while the grant re-checks live organization authority - so those two legitimately disagree, and this is exactly where. Its personal-workspace half is derived from an active organization membership and so does not diverge the same way. Two further changes land with the flag: a channel message with two or more *shared* candidates now gets the picker rather than the installation's workspace, though a reaction summon never asks and keeps the old fallback, and a bot DM goes to the sender's own personal workspace when they have one, without asking.

The identity link itself stays in the installation's workspace even when the request is for a routed one, because that is where the Slack pump reads it.

Routing never bypasses identity: an unlinked Slack user is still asked to link first.

### Saying where the work went

A routed task names its workspace once, inline in its first message - `OpenGeni started this task in *Workspace*.` - so work never lands somewhere surprising. The name appears only when routing made a genuine choice - a prefix, a channel route, a DM route, or a personal workspace. A sole candidate, an installation whose people have one workspace, and a reaction that fell back to the installation all made no choice, and naming it would be noise. A mapped thread inherits the label frozen on the interaction it reuses. The name is frozen on the interaction when it binds, read after authorization, because a rename between the original post and a reconciliation would make the post ledger's byte comparison raise. The first message escapes it for Slack mrkdwn.

No other message of the task repeats it. Every one of them - progress, questions, approvals, notices, failures, results, and click outcomes - is posted in the first message's thread: a slash command's and a private handoff's first message starts that thread, and the route is rekeyed onto it. A task message posted anywhere else would have to carry the name itself; today the only one is an approved shared-conversation publication, which posts the result into the source thread and has never named the workspace. Interactions bound before compact messages keep the previous `-> Workspace` line on every message. For a labelled compact interaction every later message's operation id moves to a `:v3` seed, away from the bytes an older image renders with the line; progress posts keep their durable random operation id, so a delivery that finds one already bound to the line's bytes by an older image retries once with those bytes under the same id.

### Administering it

**Capabilities → Slack** lists every channel the bot has been invited to with where its work lands, and an administrator can set or clear each one. Reading it needs `workspace:admin`, the same gate as the reaction-channel allowlist, because it names workspaces across the organization. An administrator may only point a channel at a workspace they could start work in themselves, and the whole batch is authorized before anything is written. Clearing a channel puts it back to asking once.

Direct messages are a rule rather than a control: they always use each person's own workspace unless that person chose otherwise.

### Deliberately unchanged

App Home stays home, so it lists the installation workspace's tasks rather than aggregating routed ones. The "anyone in this channel may use this workspace" access mode is a separate piece of work: nothing here changes which channels the bot can read, `verifyChannelAccess`, or the reaction-channel allowlist semantics.

## Channel access and tools

- Channel listing can discover public channels and reports whether the bot is a member.
- Reading history or posting in a public channel requires existing bot membership.
- A private channel is visible and usable only after a Slack member invites the bot.
- OpenGeni never auto-joins a channel and does not request `channels:join` or `chat:write.public`.
- Direct messages use `im:write` to open a DM, then post as the bot.
- Thread replies are read through their top-level message timestamp and may be posted by supplying that same timestamp.
- File and canvas reads are limited to channels where the bot is already a member. Results expose bounded file metadata and text content, never Slack private-file URLs or credentials.
- For a PNG, JPEG, or WebP file ID in thread context, `slack_bot_file_content` returns fully decoded, validated image content on explicit request (up to 640 KiB, directly shared to a non-shared channel). Larger files return `image_result_too_large` rather than failing at the model's 1 MiB result limit. This does not import surrounding attachments into the session or make them available to other sessions. Text files still use bounded pages. Unsupported image formats and Slack Connect channels remain unavailable through this path.

The generic first-party MCP exposes `slack_bot_list_channels`, `slack_bot_channel_history`, `slack_bot_thread_replies`, `slack_bot_list_users`, `slack_bot_list_files`, `slack_bot_file_info`, `slack_bot_file_content`, and `slack_bot_delete_message`. `slack_bot_search` remains a reserved contract name but is not registered: Real-time Search needs a trusted server-owned interaction token in addition to eligible scopes. Scheduled runs whose task has a person-chosen channel also get `slack_bot_prepare_message` and `slack_bot_send_prepared_message` (see [Scheduled tasks](#scheduled-tasks)). Connector-wide tools are explicit-only for ordinary sessions. `slack_bot_post_message` remains an accepted stored tool-name value for backward-compatible session and delegated-token parsing, but it is deliberately not registered on the generic model-facing MCP: a caller UUID, tool-call ID, turn ID, attempt ID, generation, request content, or JSON-RPC ID does not prove one durable logical delivery across model operations. A session started from a Slack mention, command, DM, or shortcut always freezes the seven read-only list/history/thread/user/file tools on top of its base selection so it can retrieve bounded context on demand; it does not expose deletion, because the durable interaction pump owns replies to the originating thread. Internal interaction delivery and governed Memory publication call the server-owned Slack client directly with operation IDs reserved in their durable ledgers. Threaded internal posts bind the parent message timestamp and return it in the result so placement can be verified. Message deletion accepts an operation UUID, the exact channel ID, and the exact message timestamp; Slack permits the bot token to delete only messages authored by that bot. Outside a scheduled session, calls require `connections:read`; the connection ID is optional when exactly one eligible active bot is installed. That selection reads workspace connection metadata and collapses exact-principal duplicates, it does NOT consult the installation binding ledger: the ledger is the team-to-installation authority used by the inbound event edge, not the outbound tool selector. Legacy exact-principal duplicate connection rows are non-authoritative. A scheduled session can use only its immutable selected bot connection ID.

Slack AI huddle notes are canvases. Sharing that canvas into a channel where the bot is a member lets OpenGeni read the notes and exposes the associated `huddleTranscriptFileId`. For transcript content, OpenGeni requests the expanded `files.info` projection with `include_transcription=true` and reads the returned `huddle_transcription` object from the transcript or parent canvas. If Slack omits that projection and redirects the private download to an interactive user page, OpenGeni reports `huddle_transcript_requires_participant_access` and never treats Slack web-client HTML as transcript content.

Before posting or updating a card, the Slack adapter places repeated action IDs in separate actions blocks so Slack accepts workspace pickers and single-select questions. This provider serialization preserves button values and action IDs. Durable request digests retain the original logical blocks, allowing a previously rejected card to retry with its existing operation receipt.

Each internal server-owned post requires one durable `operationId` UUID reserved by the owning interaction or publication ledger. OpenGeni binds it to the connection, target, thread, and protected text digest and sends it as Slack `client_msg_id`; reusing it for different content or a different target is rejected, while distinct durable operation IDs remain distinct intended messages even when every other field matches. The operation moves through explicit `pending`, `provider_started`, `outcome_unknown`, and `completed` states. `provider_started` is persisted immediately before `chat.postMessage`. An explicit provider rejection or failure before that boundary may return to `pending`; a lost or ambiguous response becomes `outcome_unknown` and never permits a blind repost.

An outcome-unknown retry performs a bounded read of the exact channel or DM and, for a reply, the exact parent thread. It completes only when one message has the exact durable `client_msg_id`, exact text, and exact thread placement. Paging and eventual visibility are bounded; a mismatch, duplicate exact identity, exhausted bound, or response that omits a trustworthy `client_msg_id` remains outcome-unknown and fails closed. Legacy released `provider_started` rows receive the same conservative treatment.

Rolling migration `0224_slack_post_outcome_reconciliation.sql` installs the post-operation claim modes, validated state/identity constraints, old-writer trigger fence, and conservative backfill required by this reconciliation path. It follows the independently reserved tenancy, runtime, and session-channel migrations at `0222` and `0223`; do not reuse those ordinals or rename a published ledger.

Each deletion also requires an `operationId` UUID. OpenGeni durably binds it to the tenant, initiating subject or scheduler principal, exact connection, `slack_bot_delete_message` tool, channel, timestamp, and protected request digest before `chat.delete`. Completed retries replay the stored result. Concurrent retries observe the live claim. If the process or response is lost after provider admission, the row becomes outcome-unknown and the retry first reconciles the exact Slack message through `chat.getPermalink`: an absent message completes as already deleted, while a still-present message permits one new delete attempt. OpenGeni never blindly sends `chat.delete` twice.

## Scheduled tasks

A scheduled task can post to **one** Slack channel as the OpenGeni workspace bot. A person chooses that channel when setting up the task; the agent can never choose or change it. Without a chosen channel, scheduled Slack posts use the personal Slack Web API bridge and user grant, which reaches a scheduled occurrence only through the task's immutable frozen personal delegation snapshot; it is never inherited as a workspace capability and never inferred from the task's service initiator.

### Choosing the channel

In the schedule editor, **Post to Slack** (under **Advanced**) lists the active channels the installed bot already belongs to that are not shared with another organization. Invite the bot to a channel in Slack to make it appear. The task stores the bot's exact connection UUID in `agentConfig.slackBotConnectionId` and the channel ID in `agentConfig.slackBotChannelId`. A task can use only a bot installed in its own OpenGeni workspace, so tasks in other workspaces of the organization (including routed and Personal workspaces) cannot post through the installation workspace's bot.

Choosing or changing the channel, or moving it to another bot connection, requires:

- a signed-in person (`human_session` with verified context). An agent attempt, a service, an API key, or a request carrying service provenance gets 403, so `scheduled_tasks_create` and `scheduled_tasks_update` cannot set or change it;
- `connections:write` in the workspace, besides `scheduled_tasks:manage`;
- a live check with the bot's token that the bot is a member and the channel is active and unshared (`GET /v1/workspaces/:workspaceId/scheduled-task-slack-channels` lists the eligible channels).

Keeping the saved channel while editing other task fields needs no new proof, and anyone who can edit the task can clear it, including a task that continues the same chat. The channel requires a bot connection and a task that starts its own chats: a task that continues an existing chat cannot post. A chat's tools are fixed when it is created, so a task that continues the same chat can choose a channel after that chat exists only if the chat was created with the posting tools; otherwise recreate the task.

### How a run posts

A generated run of a task with a chosen channel gets exactly two extra tools, still under the deployment's allowed tool ceiling. Neither takes a channel, user, or connection:

1. `slack_bot_prepare_message` saves the text (and optionally a `threadTimestamp` for a reply in that channel) as an immutable prepared message and returns its server-generated `messageId`. Nothing is sent.
2. `slack_bot_send_prepared_message` sends that saved message, exactly as saved. The `messageId` is also the Slack post operation ID and `client_msg_id`, so a retry after an interrupted or unclear send reconciles the original post through the normal post ledger instead of posting twice.

Both tools re-read the task on every call and refuse unless the session is the scheduler-created run of that task, the task still names the run's bot connection, and a channel is chosen. A prepared message is sent only if the task still names the same channel and the bot connection version is unchanged. So a person clearing or changing the channel stops or redirects future posts immediately, and never redirects an already prepared message. Replaying a send that Slack already confirmed still returns the original result, and a send whose earlier attempt was interrupted is reported as possibly posted rather than as unsent. Posts also require an active, unshared, bot-member channel at send time. Child sessions and ordinary chats never qualify, even if they select the tools.

Prepared messages live in the FORCE-RLS `opengeni_private.scheduled_slack_bot_messages` table. The runtime role has no table access; it reaches the rows only through `prepare_scheduled_slack_bot_message`, which re-proves the session, task, channel, and connection version in one snapshot, and `read_scheduled_slack_bot_message`, which returns only the preparing session's own messages. Rolling migration `0530_scheduled_slack_bot_messages.sql` adds them.

### Bot connection binding

The task stores its exact bot connection UUID. At each fire, the worker revalidates that the row is active, workspace-shared, belongs to the task workspace, has the verified OpenGeni bot role, and retains the exact required scopes before starting model work.

Installing a different Slack team creates a separate connection and does not rebind existing scheduled tasks. Reinstalling the exact same Slack team, bot ID, and bot-user principal updates the existing connection in place so explicit task references remain stable. The same Slack team cannot be installed with a different bot principal or into another OpenGeni workspace; that conflict fails closed and requires an administrator-led forward fix.

Publication configuration remains stricter than ambient routing: an accepted revision freezes one active verified connection plus its exact Slack team and channel. If that connection or binding becomes stale, revoked, quarantined, or mismatched, the stale revision cancels; it never follows a replacement connection or newly resolved workspace route.

## Disconnect, uninstall, revocation, and reconnect

The Plugins Slack panel keeps the team name and connection status visible. **Where work starts** explains channel and DM routing when deployment routing is enabled and opens the existing channel picker. **More options** contains channel access, workspace settings, reconnect/disconnect, and expandable technical connection details. Disconnect confirmation names its effect on the whole installation, including channels routed to other workspaces; historical tasks remain in place.

When the current workspace has no bot connection or installation binding, the web client checks installation metadata in other same-organization workspaces for which the viewer has `connections:read`. Each read uses that workspace's normal protected API; an active binding is shown as connected only when the matching connection's verified identity and version also agree. The result links to the original workspace's Slack settings rather than copying credentials or offering another setup. Discovery does not expose inaccessible workspaces, grant installation management, or create organization-wide bot-tool authority. A failed discovery offers Retry instead of claiming no installation exists. Full organization-level visibility without home-workspace access remains separate work.

Slack OAuth outcomes open the Slack panel automatically. A failed callback remains visible across reloads through its bounded URL outcome until dismissed or replaced by a successful callback. Dismissal removes only Slack outcome parameters. These parameters are display hints, never repair authority. Conflicts and lost permissions explain the next owner/admin action instead of inviting repeated installation attempts. Cross-organization moves and quarantined installation recovery still require an administrator-led forward fix; this panel does not advertise an unsupported self-service transfer.

Disconnecting a personal account API MCP bridge connection in OpenGeni disables that exact subject-owned row and does not revoke the grant at Slack. Disconnecting the bot likewise disables only the bot row; it does not uninstall the Slack app or affect user-account OAuth. To remove provider access, an authorized Slack administrator must revoke or uninstall the app in Slack as a separate action.

Slack authentication errors that prove invalid, inactive, expired, or revoked credentials mark the connection for reinstall. Provider transport failures, HTTP 5xx responses, missing channel membership, missing scope, or a missing channel do not falsely poison the credential. Reinstall preserves an existing row only after exact principal validation; otherwise use **Install another Slack workspace/bot** and explicitly review scheduled tasks.

## Audit evidence

Connect, reinstall, disconnect, channel-list, public search, history, thread-reply, user-list, file-list, file-info, file-content, App Home publication, post, and deletion operations write connection-targeted audit events. A search denied for missing search scopes is audited as a failed search operation. Receipts identify the non-secret credential role, connection UUID, Slack team ID, operation, outcome, and applicable task/session IDs. Post receipts include the non-secret operation/client-message UUID; deletion receipts include only their operation UUID. They never include tokens, authorization headers, App Home task text, posted text, channel history, file contents, private-file URLs, protected request digests, or raw provider responses.
