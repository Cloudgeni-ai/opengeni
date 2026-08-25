# Slack identities and connections

One configured Slack app can serve Slack's hosted MCP and OpenGeni's separate bot integration within one deployment. Every staging, production, preview, or self-hosted deployment must use its own Slack app, client ID, client secret, and signing secret. Hosted MCP always uses a Slack **user token** and is always owned by the exact OpenGeni subject who authenticated. The bot uses its own bot token, routing, and authority and is the only shared Slack identity.

| Connection | Slack author | OpenGeni ownership | Intended use |
| --- | --- | --- | --- |
| Personal hosted Slack MCP | The Slack human who authenticated, with Slack's configured app attribution | The exact authenticating OpenGeni subject | Interactive personal Slack tools only, including private-channel, DM, and MPIM search |
| OpenGeni workspace bot | The deployment's configured bot user (`OpenGeni` in production, `OpenGeni Staging` in managed staging) | The one OpenGeni workspace that installed it | Shared agents, first-party bot tools, bot-token public search, and explicitly bound scheduled tasks |

The two authorities are never substituted for one another. Nothing reads or posts until the capability is enabled or the bot is installed and an agent invokes a tool.

**There is deliberately no workspace-owned hosted Slack MCP connection.** An earlier release let one designated human's hosted-MCP grant be stored with `subjectId = null` and shared as workspace authority. That existed only because Slack's message search accepted user tokens alone, and it made every shared agent and scheduled task act as a named employee. Slack's Real-time Search API (`assistant.search.context`) accepts **bot** tokens carrying `search:read.public`, `search:read.files`, and `search:read.users`, so workspace-wide public search belongs to the bot identity. The bot manifest requests those scopes, and the first-party `slack_bot_search` tool calls `assistant.search.context` under the bot identity with `channel_types` pinned to `public_channel` server-side; an install predating the search scopes fails the tool closed with a reinstall hint instead of proxying through a human. Private-channel, DM, and MPIM search remain user-token only and therefore remain personal. Do not reinstate a workspace proxy identity. For the hosted Slack MCP resource (`https://mcp.slack.com/mcp`), a workspace-owned `oauth2` connection is rejected by OAuth start, by the callback fence (including state minted by an older deployment), by reconnect, and by capability enablement (`validateMcpCapabilityConnectionRef` treats it as personal-only exactly like Gmail); an omitted `ownership` on that resource defaults to personal. A workspace-scoped Slack MCP capability installation enabled by an earlier release is no longer runnable: `listEnabledMcpCapabilityServers` omits it, so no shared human token executes at runtime. Reconnect Slack personally to restore that member's tools. This rule is scoped to the hosted MCP resource; the separate API Integrations provider-OAuth surface for Slack's REST API is a different authority and is unaffected.

## Provider identity and deployment prerequisites

Slack renders the message author from the OAuth principal and renders `Sent using @…` from Slack app/provider metadata. An existing internal app may be reused for hosted MCP and may retain its current name. The first-party workspace-bot flow is stricter: if that surface is used, an authorized Slack app administrator must configure the same app as follows rather than adding generated text or changing message payloads:

1. Set the production Slack app name to `OpenGeni`. Use an environment-qualified app name such as `OpenGeni Staging` for a non-production deployment so administrators can distinguish simultaneous installations.
2. Set the bot user display name to the deployment's exact configured identity: `OpenGeni` in production or `OpenGeni Staging` in managed staging.
3. Configure both exact redirect URLs:
   - `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/oauth/callback` for hosted MCP OAuth.
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

Enable Slack MCP on the app and configure the full hosted-MCP user-scope set emitted by `bun run slack:manifest`. **Apply the manifest's bot scopes to the Slack app before deploying a version that requests them.** The install URL requests every scope in `OPENGENI_SLACK_BOT_REQUESTED_SCOPES`, so a bot scope the app is not configured for fails the whole install with `invalid_scope`, including a repair reinstall; the manifest and the request set are deliberately the same list so they cannot drift. Bot search scopes follow the same rule as `reactions:read`: requested and accepted, not required, so an existing installation stays eligible and gains them on the next reinstall. The same configured Slack app client is used for personal hosted MCP and the bot flow inside one deployment. It must never be shared between staging and production: Slack owns redirect, command, event, and interaction URLs at the app level, so sharing the client causes both OpenGeni environments to install the same provider app and makes one environment's provider settings overwrite the other's. Users never paste a client ID, client secret, bot token, or user token into OpenGeni. Do not log, expose, rotate, or copy production credentials while applying metadata or deployment configuration.

Changing Slack app metadata is provider administration outside this repository. Reconnect affected hosted-MCP OAuth grants and reinstall an affected bot through OpenGeni only when the provider requires a fresh grant; do not replace one authority with another.

## Personal hosted Slack MCP

Slack uses the provider's official hosted MCP resource, exactly `https://mcp.slack.com/mcp`. The normal authenticated MCP OAuth start endpoint performs discovery, uses the deployment-managed Slack client, creates signed single-use state bound to the exact OpenGeni account, workspace, and authenticating subject with `ownership = "personal"`, and uses authorization-code OAuth with PKCE S256. A start, reconnect, or callback whose ownership is not `personal` fails with 422 before Slack is contacted or any row is written; the generic ownership selector never offers **Connect for workspace** for this resource. The callback rechecks the subject's live workspace grant before consuming the nonce, exchanging the code, verifying MCP tool discovery, or writing the connection.

The signed-in user's account-linking surface is **Capabilities → Slack connections → Your Slack account**, separate from the adjacent **OpenGeni workspace bot** installation card:

1. **Connect my Slack account** starts the existing hosted-MCP OAuth flow. The browser sends only the official resource/provider target and the return path; Slack client credentials remain deployment-managed.
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

Slack writes hosted-MCP messages as the authenticating Slack human and supplies the configured app attribution. OpenGeni must pass the user's requested message content to the existing Slack MCP tool unchanged: it does not prepend or append author, requester, requested-by, or proxy text.

Deleting the OpenGeni personal connection removes local use of that grant; it does not uninstall the Slack app or revoke the grant at Slack. Revoking the grant at Slack causes later verification or refresh to fail and the local connection to require reconnect. Use Slack administration when provider-side revocation is required.

## Workspace bot manifest

The separate workspace-shared principal uses this deliberately narrow bot manifest:

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
      - reactions:read
      - users:read
      - search:read.public
      - search:read.files
      - search:read.users
    user:
      - search:read.public
      - search:read.private
      - search:read.mpim
      - search:read.im
      - search:read.files
      - files:read
      - emoji:read
      - search:read.users
      - chat:write
      - channels:history
      - groups:history
      - mpim:history
      - im:history
      - channels:write
      - groups:write
      - im:write
      - mpim:write
      - reactions:write
      - canvases:read
      - canvases:write
      - users:read
      - users:read.email
      - channels:read
      - groups:read
      - mpim:read
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

Generate the canonical JSON manifest with `bun run slack:manifest`. It defaults to the managed `https://app.opengeni.ai` base URL. Self-hosted deployments set their stable HTTPS `OPENGENI_PUBLIC_BASE_URL` before running the same command; every redirect, command, event, and interaction URL is derived from that value. The bot scopes remain the narrow first-party bot allowlist; the separate user scopes cover the full current Slack-hosted MCP tool catalog and `settings.is_mcp_enabled` enables that provider surface. Bot verification evaluates only the granted bot-token scopes, so hosted-MCP user scopes do not widen the bot principal. `reactions:read` is read-only and exists only for optional reaction summon; `reactions:write` belongs only to the hosted-MCP user principal. `search:read.public`, `search:read.files`, and `search:read.users` are the bot-token scopes Slack's Real-time Search API accepts (`OPENGENI_SLACK_BOT_SEARCH_SCOPES`); `search:read.private`, `search:read.im`, and `search:read.mpim` are user-token only and stay on the personal principal. Do not enable Socket Mode or token rotation, or add bot-side `channels:join`, `chat:write.public`, `chat:write.customize`, administrative, or enterprise-search scopes; Slack's native "Invite Them" prompt handles channels the bot has not joined. The canonical bot allowlist accepts the required manifest scopes plus the explicitly safe extras `team:read`, `reactions:read`, and the three bot search scopes; every other bot extra or unknown future scope fails closed across installation verification, core routing, and browser Installed-state projection. Like `reactions:read`, the search scopes are requested but not required for eligibility: an installation made before they were requested keeps working for mentions, commands, DMs, shortcuts, and tools, and gains bot search only after a reinstall with the canonical manifest (`hasOpenGeniSlackBotSearchScopes`).

## Install and connect the workspace bot

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

### Shared-conversation task policy

Slack Connect, pending-external conversations, and MPIMs use an immutable workspace policy authority exposed at `GET`/`PUT /v1/workspaces/:workspaceId/slack-task-policy`. No active policy means deny. A workspace admin may activate a CAS-fenced revision containing exact Slack team and conversation allowlists, guest/external-initiator flags, an MPIM flag, `sharedConversationMode`, and `resultPublicationMode`.

An allowed shared invocation is never delivered back into the shared conversation. After rechecking the exact installation, bot membership, conversation/user facts, and active policy immediately before reading Slack content, OpenGeni marks the interaction private and delivers progress and results in the initiating user's bot DM. As above, the session row itself remains `workspace_shared`; the privacy rides `slack_interactions.visibility`, which is enforced on both surfaces. The immutable origin row retains the source team/conversation/thread plus the exact policy revision and version, but not the source message text.

Results return to the source thread only after the initiating user clicks the requester-bound publication action. The click rechecks the installation, live identity link and grants, exact active policy revision/version, conversation membership and shared facts, and terminal result immediately before the provider post. Policy drift, lost membership, installation drift, duplicate delivery, or an ambiguous provider outcome cannot produce a new post. `approval_required` and `allow` both require this deliberate click; the former records that workspace policy requires per-result approval, while the latter permits requester-initiated publication without a separate administrator decision. `never` exposes no publication action.

On a matching reaction, OpenGeni rechecks the live workspace setting, installation scope, exact linked Slack identity, `sessions:create` plus `sessions:control`, bot channel membership, and channel policy before reading message content. It retrieves only the exact reacted message and a bounded containing-thread projection, marks the reacted message explicitly, and routes the work to the canonical root thread. Direct, safe, sufficiently specified requests begin immediately; the session asks one concise question only when information is materially missing or the requested action is risky, irreversible, or authorization-sensitive. Distinct authorized reactions that resolve to the same root thread share its canonical session but each contribute one event-ID-keyed task exactly once. Remove/re-add and Slack retry deliveries converge through the same stable reaction identity, so they cannot create duplicate sessions or task messages.

The reaction path may import only image files attached to the exact reacted message—never parent, sibling, thread, preview, or link-unfurl files. Explicit app mentions, bot DMs, and replies in an existing OpenGeni task thread use the same authority for images attached to the exact invocation, including file-only messages; nearby context attachments are never imported. The signed event stores only a bounded file-presence fact, so text-only DMs and replies do not trigger an extra provider read. Before downloading anything, OpenGeni re-fetches each selected Slack file through the verified workspace bot, rechecks exact non-shared channel membership and file sharing, and caps the selection at four files, 4 MiB each, and 16 MiB total. Only complete PNG, JPEG, and WebP bytes whose Slack declaration, HTTP content type, structural signature, size, and digest agree are accepted. Private downloads allow only bounded HTTPS Slack file hosts and one validated redirect; interactive Slack pages, markup, truncation, polyglots, unsupported types, and credential or authority ambiguity fail closed. Supported bytes are imported into deterministic tenant/source-bound workspace files, while the session and event history retain only file references, safe mount paths, MIME, and size—not Slack URLs, object keys, credentials, or inline data. Unsupported or invalid individual files produce bounded omission notices and do not prevent other valid images or the text-only task from continuing.

Every top-level bot DM durably reserves a new private OpenGeni session ID for the linked OpenGeni subject before session creation begins. Authorization and listing use that reservation until the same ID is bound as the session root, so a crash or concurrent read before binding cannot expose the session to another workspace subject. A reply in its Slack thread continues that exact session; a separate top-level DM creates a separate session. Installing the bot for a workspace never converts private DM sessions into workspace-visible sessions.

A channel mention, command, or message shortcut creates one workspace-visible session whose authorization follows both the Slack channel and live OpenGeni workspace grants. Channel shortcuts retain the same bot-membership requirement as mentions and commands. A message shortcut from a one-to-one human DM is the deliberate exception to membership lookup: Slack's signed interaction supplies only the selected message, OpenGeni marks the interaction private to the invoking linked subject, and the durable route is rekeyed to a new thread in that subject's OpenGeni bot DM before any progress or result is delivered. Two linked users invoking the shortcut on the same human-DM message receive separate interactions and bot-DM routes. Mentioning OpenGeni inside an unmapped existing thread adopts that thread as the session surface, including when Slack delivers the threaded mention as a generic message event. The exact accepted invocation remains the visible session message and title. Bounded containing-thread or channel context, plus any safe imported-attachment manifest, is attached to that same message as `modelContext`: the model receives it, but ordinary timeline and session UI projections omit it. A top-level mention receives only bounded channel history ending at that invocation, so references such as "this" or "the previous message" can be resolved without unbounded channel ingestion. Once mapped, linked and authorized OpenGeni workspace participants can continue the same session by replying in that thread. An ordinary unmapped thread reply is ignored rather than creating work implicitly.

Top-level group-DM/MPIM messages do not start tasks unless an exact active shared-task policy enables MPIM private handoff. Slack Connect, MPIM, and administratively restricted conversation invocations otherwise fail closed before content is read or retained. The one-to-one human-DM shortcut remains a separate initiating-user-private path: it imports only Slack's signed selected message and never opens or posts into the source DM.

The bot acknowledges accepted work with exactly one Slack-mrkdwn **Open in OpenGeni** absolute session link plus the **Status**/**Stop** buttons, then keeps at most three progress posts globally per interaction, plus durable human-input questions, approvals, stop/cancellation, failures, blockers, and one final result in the originating thread. Follow-up, progress, question, approval, blocker, failure, and final messages do not repeat the session link.

Acknowledgements and results carry no standing how-to prose: the buttons already say **Status** and **Stop**, and a daily user does not need the same instructions on every interaction. The how-to sentence appears exactly once per Slack identity per installation, inside that identity's first acknowledged task, and never again.

Because `slack_bot_post_operations` binds one operation id to one request digest that covers the message text, and an acknowledgement is re-rendered whenever it is repaired, that decision is a frozen fact rather than a live question. `resolveSlackInteractionFirstTaskHint` resolves it once and writes it to `slack_interactions.first_task_hint` in the same transaction that claims `slack_bot_user_links.first_task_hint_interaction_id` (migration 0327). Every later render replays the frozen boolean, so a repair after a crash, a lost provider response, or a replica race reproduces identical bytes, and unlinking plus relinking the Slack identity cannot flip an acknowledgement that already rendered. Resolution happens before the provider post and raises on failure into the ordinary retryable inbox path, so no post operation is ever bound to text that depended on an unresolved answer. The private-handoff and human-DM acknowledgements keep their distinct privacy sentence, and the reaction-summon acknowledgement keeps its own wording and never consumes the hint.

A control click replaces the message it was pressed on. When that message is the acknowledgement of the interaction that won the hint, the update re-appends the hint, so pressing **Status** cannot destroy the only copy a Slack identity is ever shown; later control cards are not the acknowledgement and carry no hint. Completed results carry the result text plus the ordinary requester mention, and, in the shared-conversation flow, the publication action block; no continuation prose and no recurring action. Server-owned interaction delivery resolves the verified workspace bot under the dedicated `service:slack-interaction` principal; the initiating human's grants authorize session creation and control but are never substituted as the provider credential principal. Every bot post disables Slack link and media unfurling. When terminal assistant/result text is exactly equal or one is a safe boundary-aligned prefix of the other, only the contiguous terminal-shaped suffix is coalesced; earlier distinct progress and non-prefix outputs remain separate. The same durable turn and delivery evidence applies across pages, retries, restarts, and replica claims rather than content hashes or cross-task similarity. Each progress event durably claims one of its three slots and a stable Slack post-operation identity before provider delivery, so duplicate claims cannot exceed the cap.

Approval requests are projected as bounded Block Kit cards containing only the action name and opaque action handles—never raw tool arguments, credentials, or provider request data. **Approve once** and **Reject** invoke the existing exact `user.approvalDecision` boundary. A single-select human question may expose up to five option buttons plus Skip; more complex questions retain the ordinary thread-reply fallback. The acknowledgement and later control cards expose **Status** and **Stop** or **Resume**. Every click is signed, acknowledged into the durable inbox before processing, and bound to the exact installation, originating Slack user, linked OpenGeni subject, interaction, session, message operation, target, and expiry. The processor rechecks all of those facts plus live workspace access immediately before calling the canonical session lifecycle. Duplicate or stale clicks converge on one decision and the original card is updated through a separate durable `chat.update` operation ledger. Approving one call never changes future connector policy.

### Blocked workers and paused goals

**Both notices are off by default and are switched on per workspace.** The workspace setting `slackOrchestrationNotices` carries one boolean per notice (`childRequiresAction`, `goalPaused`); absent, malformed, or partially invalid settings resolve to both disabled through `resolveWorkspaceSlackOrchestrationNoticeSettings`, so only an explicit opt-in ever posts. An unsolicited Slack post is worse than a missed one, and the in-app rail and priority feed already surface a blocked child worker and a paused goal. The two checkboxes live beside the reaction shortcut in the Slack integration settings and persist through the ordinary workspace-settings patch. A disabled notice takes the same "nothing to post for this event" path as an undeliverable one: no Slack post, no post-operation ledger row, and the delivery cursor advances past the event exactly as it would have. Every pre-existing Slack card type is unaffected by the switch. Turning a notice on applies to events appended afterwards: the delivery cursor has already advanced past everything that arrived while it was off, and OpenGeni deliberately does not replay that history into the thread.

A Slack-originated session can spawn child workers, and those children are never themselves mapped to a Slack thread. When a child blocks on human input or a tool approval, its parent receives the bounded `child_requires_action` notice, and the delivery pump turns that one notice into a single pointer card: `A worker you started needs input.`, one bounded single-line preview of the first question (or the count of waiting tool approvals), and an **Open in OpenGeni** link to the child session. The card is a pointer, not a second question card - the human answers on the child's own OpenGeni card, and no subject id, credential, or raw tool argument crosses into Slack. A notice whose exact `(child, turn, generation)` boundary already carries a `child_requires_action_resolved` row on the parent, or whose own row is `superseded` or `cancelled`, posts nothing: Slack delivery runs behind the session, and a card announcing a worker that is no longer blocked is worse than no card. That check reads only the parent's own rows. The deferred child lifecycle notices (`child_progress`, `child_waiting_capacity`, `child_requires_action_resolved`, `child_paused`) post nothing, so the thread stays quiet.

A goal that pauses because it ran out of budget (`limits`) or hit the continuation cap (`max_auto_continuations`) posts one bounded line - `Goal paused (budget).` or `Goal paused (continuation cap).` - plus the session link. A `user_pause`, `api`, or `agent` pause is a decision the human or their agent already made, `no_progress` is not a stop the human must act on, and `goal.resumed` is never announced.

Both use the same durable per-event post-operation ledger as every other delivery, keyed on the parent session event, so reaper retries, replica claims, and a replayed delivery page converge on one message. Both also draw on the same durable per-interaction slot budget as assistant progress (three posts per Slack task), so an orchestration that fans out to many blocked children cannot turn one thread into a feed; past the cap a notice goes silent exactly like a fourth progress message. The budget is shared rather than per-category because the ceiling worth enforcing is the total number of posts the human did not ask for. A slot is claimed only when a card is actually going to be posted, so a skipped, stale, or already-resolved notice never consumes one, and the claimed row never becomes terminal-coalescing evidence. Rolling migration `0329_slack_orchestration_delivery_events.sql` adds `system.update.pending` and `goal.paused` to the delivery claim's event types; an older API image simply drains the extra claim without posting.

Completion, failure, cancellation, and action-required posts mention only the exact Slack user who initiated the mapped task and only while its durable requester binding remains valid. Channel participants may still continue a workspace-visible thread, but they cannot operate another user's approval/control buttons. Reply `stop` in the mapped thread remains a compatible pause path and start a new top-level DM or invoke OpenGeni again to create a new session; neither is advertised on every post any more, and both are named by the one-time first-task hint and by `<command> info`.

**Make recurring** is exposed on the **Status** card rather than on every completed result. When the requester who pressed Status still holds `sessions:read` plus `scheduled_tasks:manage` in that workspace, the card's updated text carries the action. It opens the authenticated Schedules editor with the exact source session selected, a conservative one-hour/skip-overlap draft, and an explicit prompt field. The link carries only the session UUID: Slack text is not copied into the URL, and no task or monitoring exists until the user reviews and submits the canonical schedule form. Session visibility/control and schedule authority are rechecked by the ordinary browser/API path. `<command> info` names the same capability for a caller who holds that grant, and a deployment without an absolute web base URL omits the action instead of failing the card.

### The `<command> info` card

`/opengeni info` (the configured command plus the single argument `info`) answers with an ephemeral Block Kit card and nothing else. It never reaches the durable inbox, never verifies channel membership, never posts through the bot, and never creates a session, so it is safe in any conversation where the command is available. Before any workspace-identifying text is echoed it re-proves the exact Slack identity link and the live workspace grant for that identity's OpenGeni subject, in the same account, with `sessions:read`; an unlinked identity receives the ordinary signed connect view and an identity whose subject holds no live grant is told to request access. Every line is gated on the grant that authorizes it: continuing and stopping a task require `sessions:control`, starting a new task requires `sessions:create`, and making a result recurring requires `scheduled_tasks:manage`. Only the destination line (which OpenGeni workspace the work lands in, with an absolute workspace link) is unconditional, and reaching the card at all already required `sessions:read`. It is a projection of what the caller can already do, never an action.

Slack identities must be explicitly linked to an OpenGeni subject in the same account and workspace. An unmapped identity receives a private bot DM containing a signed, 15-minute, workspace/connection/team/user-bound link token and no session is created. The managed human continuation verifies the token and live installation route before revealing the proven workspace name or creating token-free state; an existing `sessions:create` grant completes linking immediately, while an unavailable subject may create a reviewable access request without being granted the workspace first. Invalid signatures or timestamps, replayed/duplicate provider identities, inactive or ambiguous installations, missing bot channel access, revoked OpenGeni access, malformed payloads, and cross-tenant ambiguity fail closed. Slack retries, reconnects, worker restarts, and session resumes converge through the durable inbox, private session reservation, route binding, session idempotency key, delivery cursor, per-event progress ledger, and Slack post-operation ledger. Inbox and delivery retries honor durable `retry_at` fences; Slack HTTP 429 responses honor bounded `Retry-After`, transient failures use bounded exponential backoff, and a delivery closes after eight failed claims or an explicitly permanent provider error.

The link stays inside `/workspaces/:workspaceId/capabilities`. New bot messages put the signed bearer in the URL fragment so it is not sent in HTTP request lines, reverse-proxy logs, referrers, or managed-auth callback URLs. Legacy query-form values are scrubbed from the browser location but deliberately rejected rather than exchanged because a query bearer may already have reached an HTTP access log; the bearer is never written to browser storage. After managed sign-in, OpenGeni exchanges the fragment bearer for durable token-free state bound to its exact digest and claims, the authenticated subject, account/workspace, Slack installation/team/user, expiry, and monotonic version. If the subject already has `sessions:create`, linking completes once. Otherwise the unavailable-workspace shell shows `You need access to **[workspace]** to connect your Slack account.` only when the signed proof safely establishes the workspace name, with a non-enumerating fallback, and replaces the ordinary default-workspace action with **Request access** and **Cancel**.

A requested continuation is visible only to workspace member administrators. Approval uses the canonical workspace-membership grant, then completes the exact Slack identity link in the same transaction; denial, requester cancellation, expiry, tamper, replay, cross-subject reuse, and cross-workspace reuse never grant access or reassign an existing Slack identity. Every mutation is CAS- and idempotency-fenced, the request and operation rows use FORCE RLS, and audit metadata excludes the bearer and its digest. Approval can also complete after a separate canonical member grant is observed, but never before that live grant exists. Terminal failures tell the user to request a fresh link from Slack.

Slack message, thread text, and reaction-imported image references are task-local input only. The interaction path does not automatically write them to Documents, Knowledge, Memory, preferences, Workspace Charter, instructions, or policy. A reaction-started session receives only the bounded projected context, exact imported file resources, and the default first-party tools, not general Slack history or mutation tools. Delivery excludes private reasoning, secrets, credentials, raw logs, raw provider responses, and unbounded output, and bot/self/subtype events are suppressed to prevent notification loops.

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
5. **A sole candidate**, because one workspace is not a choice. This is what keeps an ordinary installation quiet after the flag is turned on.
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
| | no candidate workspace at all, and nothing else to route on - no mapped thread, no prefix, no channel route, and no DM route or personal workspace | the generic "ask an OpenGeni administrator" DM. No link, same reason |
| | a mapped `thread` route they have lost - where every thread reply lands - or the installation's own workspace, which is every route while the flag is off | nothing. The pre-routing permanent `identity_access_revoked` failure |
| | any resolved route whose grant is live but lacks `sessions:create` | nothing. The permanent `sessions_create_denied` failure. Reachable for a `channel`, `dm_route` or `thread` target, and for `installation` while the flag is off; a candidate-derived route cannot reach it, because the candidate filter already required that permission and a personal-workspace grant is minted with it |
| **the picker** | the workspace they clicked refuses authority or `sessions:create` | a DM naming that workspace, no link, and the card is left intact so they can pick another |
| **a reaction summon** | no candidate workspace at all | the same generic administrator DM |
| | a route resolved, then authority or `sessions:create`/`sessions:control` refused | nothing. A summon has no conversation of its own to answer into, so every authority failure here is the silent permanent one |

Three details in the first two rows are easy to over-promise. The DM can only *name* the workspace when its name is already in front of it: labels are looked up in the candidate list, so a prefix, a personal workspace, and a sole candidate always carry one, while a channel or DM route usually does not and the DM says "another workspace" instead. Usually, not always - a stale `workspace_memberships` row whose organization membership was suspended is still a candidate, so that refusal does name the workspace. The link belongs to the first row alone: the picker and the reaction path never offer one, and a deployment with neither a web nor a public base URL, or with no Slack signing secret, degrades it to the plain breadcrumb "OpenGeni Settings → Integrations → Slack".

Turning the flag on does change what a lost-access person sees, and that is worth stating rather than eliding. With routing off the resolver short-circuits to the installation's workspace, so an authority failure was always one of the two silent paths. With it on, a single-workspace installation resolves a sole candidate instead - before any question is asked - and posts a refusal where the old code said nothing. The candidate list's membership half is a `workspace_memberships` join fenced on the account and filtered on `sessions:create` or `workspace:admin`, but with no organization-membership check, while the grant re-checks live organization authority - so those two legitimately disagree, and this is exactly where. Its personal-workspace half is derived from an active organization membership and so does not diverge the same way. Two further changes land with the flag: a channel message with two or more candidates now gets the picker rather than the installation's workspace, though a reaction summon never asks and keeps the old fallback, and a bot DM goes to the sender's own personal workspace when they have one, without asking.

The identity link itself stays in the installation's workspace even when the request is for a routed one, because that is where the Slack pump reads it.

Routing never bypasses identity: an unlinked Slack user is still asked to link first.

### Saying where the work went

Every acknowledgement and delivery for a routed task carries a quiet `-> Workspace` line, so work never lands somewhere surprising. It appears only when routing made a genuine choice - a prefix, a channel route, a DM route, or a personal workspace. A sole candidate, an installation whose people have one workspace, and a reaction that fell back to the installation all made no choice, and a constant footer would be noise. A mapped thread inherits the label frozen on the interaction it reuses. The name is frozen on the interaction when it binds, read after authorization, because a rename between the original post and a reconciliation would make the post ledger's byte comparison raise.

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

The generic first-party MCP exposes `slack_bot_list_channels`, `slack_bot_search` (workspace-wide public search over `assistant.search.context`: messages by default, files and channels via `contentTypes`; `channel_types` is pinned to `public_channel` server-side and never caller-controlled, and an install without the search scopes fails closed with a reinstall hint), `slack_bot_channel_history`, `slack_bot_thread_replies`, `slack_bot_list_users`, `slack_bot_list_files`, `slack_bot_file_info`, `slack_bot_file_content`, and `slack_bot_delete_message`. Connector-wide tools are explicit-only for ordinary sessions. `slack_bot_post_message` remains an accepted stored tool-name value for backward-compatible session and delegated-token parsing, but it is deliberately not registered on the generic model-facing MCP: a caller UUID, tool-call ID, turn ID, attempt ID, generation, request content, or JSON-RPC ID does not prove one durable logical delivery across model operations. A Slack-originated session explicitly freezes the seven read-only list/history/thread/user/file tools so it can retrieve bounded context on demand; it does not expose deletion, because the durable interaction pump owns replies to the originating thread. Internal interaction delivery and governed Memory publication call the server-owned Slack client directly with operation IDs reserved in their durable ledgers. Threaded internal posts bind the parent message timestamp and return it in the result so placement can be verified. Message deletion accepts an operation UUID, the exact channel ID, and the exact message timestamp; Slack permits the bot token to delete only messages authored by that bot. Outside a scheduled session, calls require `connections:read`; the connection ID is optional when exactly one eligible active bot is installed. That selection reads workspace connection metadata and collapses exact-principal duplicates, it does NOT consult the installation binding ledger: the ledger is the team-to-installation authority used by the inbound event edge, not the outbound tool selector. Legacy exact-principal duplicate connection rows are non-authoritative. A scheduled session can use only its immutable selected bot connection ID.

Slack AI huddle notes are canvases. Sharing that canvas into a channel where the bot is a member lets OpenGeni read the notes and exposes the associated `huddleTranscriptFileId`. For transcript content, OpenGeni requests the expanded `files.info` projection with `include_transcription=true` and reads the returned `huddle_transcription` object from the transcript or parent canvas. If Slack omits that projection and redirects the private download to an interactive user page, OpenGeni reports `huddle_transcript_requires_participant_access` and never treats Slack web-client HTML as transcript content.

Each internal server-owned post requires one durable `operationId` UUID reserved by the owning interaction or publication ledger. OpenGeni binds it to the connection, target, thread, and protected text digest and sends it as Slack `client_msg_id`; reusing it for different content or a different target is rejected, while distinct durable operation IDs remain distinct intended messages even when every other field matches. The operation moves through explicit `pending`, `provider_started`, `outcome_unknown`, and `completed` states. `provider_started` is persisted immediately before `chat.postMessage`. An explicit provider rejection or failure before that boundary may return to `pending`; a lost or ambiguous response becomes `outcome_unknown` and never permits a blind repost.

An outcome-unknown retry performs a bounded read of the exact channel or DM and, for a reply, the exact parent thread. It completes only when one message has the exact durable `client_msg_id`, exact text, and exact thread placement. Paging and eventual visibility are bounded; a mismatch, duplicate exact identity, exhausted bound, or response that omits a trustworthy `client_msg_id` remains outcome-unknown and fails closed. Legacy released `provider_started` rows receive the same conservative treatment.

Rolling migration `0224_slack_post_outcome_reconciliation.sql` installs the post-operation claim modes, validated state/identity constraints, old-writer trigger fence, and conservative backfill required by this reconciliation path. It follows the independently reserved tenancy, runtime, and session-channel migrations at `0222` and `0223`; do not reuse those ordinals or rename a published ledger.

Each deletion also requires an `operationId` UUID. OpenGeni durably binds it to the tenant, initiating subject or scheduler principal, exact connection, `slack_bot_delete_message` tool, channel, timestamp, and protected request digest before `chat.delete`. Completed retries replay the stored result. Concurrent retries observe the live claim. If the process or response is lost after provider admission, the row becomes outcome-unknown and the retry first reconciles the exact Slack message through `chat.getPermalink`: an absent message completes as already deleted, while a still-present message permits one new delete attempt. OpenGeni never blindly sends `chat.delete` twice.

## Scheduled tasks

Shared scheduled Slack work uses the workspace bot. A personal hosted-MCP grant reaches a scheduled occurrence only through the task's immutable frozen personal delegation snapshot; it is never inherited as a workspace capability and never inferred from the task's service initiator.

In **Scheduled tasks → Advanced → OpenGeni Slack bot**, explicitly select an active bot connection. The task stores its exact connection UUID. At each fire, the worker revalidates that the row is active, workspace-shared, belongs to the task workspace, has the verified OpenGeni bot role, and retains the exact required scopes before starting model work.

Installing a different Slack team creates a separate connection and does not rebind existing scheduled tasks. Reinstalling the exact same Slack team, bot ID, and bot-user principal updates the existing connection in place so explicit task references remain stable. The same Slack team cannot be installed with a different bot principal or into another OpenGeni workspace; that conflict fails closed and requires an administrator-led forward fix.

Publication configuration remains stricter than ambient routing: an accepted revision freezes one active verified connection plus its exact Slack team and channel. If that connection or binding becomes stale, revoked, quarantined, or mismatched, the stale revision cancels; it never follows a replacement connection or newly resolved workspace route.

## Disconnect, uninstall, revocation, and reconnect

Disconnecting a personal hosted-MCP connection in OpenGeni disables that exact subject-owned row and does not revoke the grant at Slack. Disconnecting the bot likewise disables only the bot row; it does not uninstall the Slack app or affect hosted-MCP OAuth. To remove provider access, an authorized Slack administrator must revoke or uninstall the app in Slack as a separate action.

Slack authentication errors that prove invalid, inactive, expired, or revoked credentials mark the connection for reinstall. Provider transport failures, HTTP 5xx responses, missing channel membership, missing scope, or a missing channel do not falsely poison the credential. Reinstall preserves an existing row only after exact principal validation; otherwise use **Install another Slack workspace/bot** and explicitly review scheduled tasks.

## Audit evidence

Connect, reinstall, disconnect, channel-list, public search, history, thread-reply, user-list, file-list, file-info, file-content, App Home publication, post, and deletion operations write connection-targeted audit events. A search denied for missing search scopes is audited as a failed search operation. Receipts identify the non-secret credential role, connection UUID, Slack team ID, operation, outcome, and applicable task/session IDs. Post receipts include the non-secret operation/client-message UUID; deletion receipts include only their operation UUID. They never include tokens, authorization headers, App Home task text, posted text, channel history, file contents, private-file URLs, protected request digests, or raw provider responses.
