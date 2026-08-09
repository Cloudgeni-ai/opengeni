# Slack identities and connections

One configured Slack app can serve Slack's hosted MCP and OpenGeni's separate bot integration. Hosted MCP always uses a Slack **user token**, but OpenGeni ownership is explicit: the grant may belong to one OpenGeni subject or to the workspace. The bot uses its own bot token, routing, and authority.

| Connection | Slack author | OpenGeni ownership | Intended use |
| --- | --- | --- | --- |
| Personal hosted Slack MCP | The Slack human who authenticated, with Slack's configured app attribution | The exact authenticating OpenGeni subject | Interactive personal Slack tools only |
| Workspace hosted Slack MCP | The designated Slack human who authenticated | The OpenGeni workspace (`subjectId = null`) | Shared agents and scheduled tasks through the enabled capability |
| OpenGeni workspace bot | The `OpenGeni` bot user | The one OpenGeni workspace that installed it | First-party bot tools and explicitly bound scheduled tasks |

The three authorities are never substituted for one another. A workspace MCP connection is shared OpenGeni authority over one designated Slack user's grant; it is not a Slack bot token and cannot exceed what that Slack user and Slack's hosted MCP tools may access. Nothing reads or posts until the capability is enabled and an agent invokes a tool.

## Provider identity and deployment prerequisites

Slack renders the message author from the OAuth principal and renders `Sent using @…` from Slack app/provider metadata. An existing internal app may be reused for hosted MCP and may retain its current name. The first-party workspace-bot flow is stricter: if that surface is used, an authorized Slack app administrator must configure the same app as follows rather than adding generated text or changing message payloads:

1. Set the Slack app name to exactly `OpenGeni`.
2. Set the bot user display name to exactly `OpenGeni`.
3. Configure both exact redirect URLs:
   - `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/oauth/callback` for hosted MCP OAuth.
   - `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/slack/callback` for workspace-bot installation.
4. Enable direct/public OAuth distribution. A Slack Marketplace listing is not required.
5. Keep the client credential server-side and configure the deployment with:
   - `OPENGENI_SLACK_CLIENT_ID`
   - `OPENGENI_SLACK_CLIENT_SECRET`
   - `OPENGENI_INTEGRATIONS_ENABLED=true`
   - `OPENGENI_INTEGRATIONS_STATE_SECRET`
   - `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`
   - `OPENGENI_PUBLIC_BASE_URL`

Enable Slack MCP on the app and configure the full hosted-MCP user-scope set emitted by `bun run slack:manifest`. The same configured Slack app client is used for personal/workspace hosted MCP and the bot flow. Users never paste a client ID, client secret, bot token, or user token into OpenGeni. Do not log, expose, rotate, or copy production credentials while applying metadata or deployment configuration.

Changing Slack app metadata is provider administration outside this repository. Reconnect affected hosted-MCP OAuth grants and reinstall an affected bot through OpenGeni only when the provider requires a fresh grant; do not replace one authority with another.

## Hosted Slack MCP ownership

Slack uses the provider's official hosted MCP resource, exactly `https://mcp.slack.com/mcp`. The normal authenticated MCP OAuth start endpoint performs discovery, uses the deployment-managed Slack client, creates signed single-use state bound to the exact OpenGeni account, workspace, authenticating subject, and selected ownership, and uses authorization-code OAuth with PKCE S256. The callback rechecks the subject's live workspace grant before consuming the nonce, exchanging the code, verifying MCP tool discovery, or writing the connection.

**Connect for workspace** stores the resulting OAuth row with `subjectId = null`, publishes the exact connection UUID in the capability's workspace-scoped connection reference, and makes the enabled Slack MCP server part of the workspace default tool set. New sessions and scheduled tasks that omit an explicit tool list inherit it. Existing fixed tool selections remain exact. Runtime resolution revalidates the active row, provider, kind, and workspace before every request; it never borrows a personal row or falls back to the bot. Provider actions still appear as the designated Slack user because Slack's hosted MCP issues user tokens only.

**Connect only for me** remains the subject-owned path. The signed-in user's account-linking surface is **Capabilities → Slack connections → Your Slack account**, separate from the generic workspace capability and the adjacent **OpenGeni workspace bot** installation card:

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
- Runtime and Toolspace token resolution use the immutable human initiator captured for the turn.
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

Generate the canonical JSON manifest with `bun run slack:manifest`. It defaults to the managed `https://app.opengeni.ai` base URL. Self-hosted deployments set their stable HTTPS `OPENGENI_PUBLIC_BASE_URL` before running the same command; every redirect, command, event, and interaction URL is derived from that value. The bot scopes remain the narrow first-party bot allowlist; the separate user scopes cover the full current Slack-hosted MCP tool catalog and `settings.is_mcp_enabled` enables that provider surface. Bot verification evaluates only the granted bot-token scopes, so hosted-MCP user scopes do not widen the bot principal. `reactions:read` is read-only and exists only for optional reaction summon; `reactions:write` belongs only to the hosted-MCP user principal. Do not enable Socket Mode or token rotation, or add bot-side `channels:join`, `chat:write.public`, `chat:write.customize`, administrative, or enterprise-search scopes. The canonical bot allowlist accepts the required manifest scopes plus the explicitly safe extras `team:read` and `reactions:read`; every other bot extra or unknown future scope fails closed across installation verification, core routing, and browser Installed-state projection.

## Install and connect the workspace bot

1. In the intended OpenGeni workspace, open **Capabilities → Slack connections → OpenGeni workspace bot**.
2. Choose the official **Add to Slack** visual. The button calls OpenGeni's authenticated OAuth-start API; it is not a static provider link.
3. OpenGeni creates high-entropy, signed, single-use state bound to the exact account, workspace, subject, and install or reinstall action, then redirects to Slack workspace selection and consent.
4. Slack returns the browser to `/v1/integrations/slack/callback`. OpenGeni consumes the state once and exchanges the temporary code server-side.
5. OpenGeni verifies the exact Slack workspace, bot ID, bot user ID, token type, display name, and scope set before storing the bot token in the encrypted connection credential column.

Slack's bot installation endpoint is protected by the bound one-time state and exact redirect URI. The implementation does not claim or add PKCE to this provider-specific bot flow unless Slack documents support for it.

The bot connection is a workspace-shared `app_install` row (`subjectId = null`) in exactly the OpenGeni workspace that initiated installation. It is not organization-wide and is never implicitly shared to another OpenGeni workspace. API responses, browser URLs, events, tool results, and audit metadata contain only non-secret connection and principal facts.

## Start and continue OpenGeni work from Slack

Authenticated Slack users can start work through four configured entry points:

- mention `@OpenGeni` in a channel or existing thread;
- invoke `/opengeni <task>` in a channel;
- direct-message the OpenGeni bot, or use the **Open in OpenGeni** message shortcut when explicitly sending a human-to-human DM message. A human-DM shortcut imports only the selected message into an initiating-user-private session, then moves acknowledgement, progress, results, and continuation into that user's OpenGeni bot-DM thread; the bot never joins, reads, or posts workspace output into the source human DM.
- after a workspace admin enables **Capabilities → Slack connections → Reaction summon**, add the configured exact emoji reaction (default `:genie:`) to one message in an allowed bot-member conversation.

Reaction summon is disabled by default. Only `workspace:admin` can enable it, choose the exact emoji name without colons, and select all bot-member conversations or an explicit allowlist. Existing installations without `reactions:read` remain usable for mentions, commands, DMs, shortcuts, and tools, but the admin UI blocks reaction enablement until the bot is reinstalled with the canonical manifest. Slack Connect/shared conversations fail closed.

On a matching reaction, OpenGeni rechecks the live workspace setting, installation scope, exact linked Slack identity, `sessions:create` plus `sessions:control`, bot channel membership, and channel policy before reading message content. It retrieves only the exact reacted message and a bounded containing-thread projection, marks the reacted message explicitly, and routes the work to the canonical root thread. Distinct authorized reactions that resolve to the same root thread share its canonical session but each contribute one event-ID-keyed task exactly once. If intent is ambiguous, the session asks in that thread before acting. Remove/re-add and Slack retry deliveries converge through the same stable reaction identity, so they cannot create duplicate sessions or task messages.

Every top-level bot DM durably reserves a new private OpenGeni session ID for the linked OpenGeni subject before session creation begins. Authorization and listing use that reservation until the same ID is bound as the session root, so a crash or concurrent read before binding cannot expose the session to another workspace subject. A reply in its Slack thread continues that exact session; a separate top-level DM creates a separate session. Installing the bot for a workspace never converts private DM sessions into workspace-visible sessions.

A channel mention, command, or message shortcut creates one workspace-visible session whose authorization follows both the Slack channel and live OpenGeni workspace grants. Channel shortcuts retain the same bot-membership requirement as mentions and commands. A message shortcut from a one-to-one human DM is the deliberate exception to membership lookup: Slack's signed interaction supplies only the selected message, OpenGeni creates a private session for the invoking linked subject, and the durable route is rekeyed to a new thread in that subject's OpenGeni bot DM before any progress or result is delivered. Two linked users invoking the shortcut on the same human-DM message receive separate private sessions and bot-DM routes. Mentioning OpenGeni inside an unmapped existing thread adopts that thread as the session surface, including when Slack delivers the threaded mention as a generic message event. The new task receives bounded containing-thread context. A top-level mention receives only bounded channel history ending at that invocation, so references such as "this" or "the previous message" can be resolved without unbounded channel ingestion. Once mapped, linked and authorized OpenGeni workspace participants can continue the same session by replying in that thread. An ordinary unmapped thread reply is ignored rather than creating work implicitly.

Top-level group-DM/MPIM messages do not start tasks in V1. In an MPIM, a message shortcut may be used only where the installed bot already has conversation access; otherwise it fails closed and the user should use a one-to-one bot DM or an authorized channel. Slack Connect and administratively restricted conversations remain unsupported unless the installation, bot membership, and workspace authority all pass the same checks.

The bot acknowledges accepted work with an **Open in OpenGeni** session link, then keeps at most three progress posts globally per interaction, plus durable human-input questions, stop/cancellation, failures, blockers, and one final result in the originating thread. Follow-up messages do not repeat the session link. When the terminal assistant message and turn result carry the same output, only the final result is posted. Each progress event durably claims one of those three slots and a stable Slack post-operation identity before provider delivery, so pages, retries, restarts, replicas, and duplicate claims cannot exceed the cap. Reply `stop` in the mapped thread to pause the workstream; start a new top-level DM or invoke OpenGeni again to create a new session.

Slack identities must be explicitly linked to an OpenGeni subject in the same account and workspace. An unmapped identity receives a private bot DM containing a signed, 15-minute, workspace/connection/team/user-bound link token and no session is created. The authenticated link endpoint requires `sessions:create`, verifies the token and live installation route, binds only the logged-in subject, and removes the bearer from the browser URL before posting it. Invalid signatures or timestamps, replayed/duplicate provider identities, inactive or ambiguous installations, missing bot channel access, revoked OpenGeni access, malformed payloads, and cross-tenant ambiguity fail closed. Slack retries, reconnects, worker restarts, and session resumes converge through the durable inbox, private session reservation, route binding, session idempotency key, delivery cursor, per-event progress ledger, and Slack post-operation ledger. Inbox and delivery retries honor durable `retry_at` fences; Slack HTTP 429 responses honor bounded `Retry-After`, transient failures use bounded exponential backoff, and a delivery closes after eight failed claims or an explicitly permanent provider error.

Slack message and thread text is task-local input only. The interaction path does not automatically write it to Documents, Knowledge, Memory, preferences, Workspace Charter, instructions, or policy. A reaction-started session receives only the bounded projected context and the default first-party tools, not general Slack history tools. Delivery excludes private reasoning, secrets, credentials, raw logs, raw provider responses, and unbounded output, and bot/self/subtype events are suppressed to prevent notification loops.

## Channel access and tools

- Channel listing can discover public channels and reports whether the bot is a member.
- Reading history or posting in a public channel requires existing bot membership.
- A private channel is visible and usable only after a Slack member invites the bot.
- OpenGeni never auto-joins a channel and does not request `channels:join` or `chat:write.public`.
- Direct messages use `im:write` to open a DM, then post as the bot.
- Thread replies are read through their top-level message timestamp and may be posted by supplying that same timestamp.
- File and canvas reads are limited to channels where the bot is already a member. Results expose bounded file metadata and text content, never Slack private-file URLs or credentials.

The first-party tools are `slack_bot_list_channels`, `slack_bot_channel_history`, `slack_bot_thread_replies`, `slack_bot_list_users`, `slack_bot_list_files`, `slack_bot_file_info`, `slack_bot_file_content`, `slack_bot_post_message`, and `slack_bot_delete_message`. Connector-wide tools are explicit-only for ordinary sessions. A Slack-originated session explicitly freezes the seven read-only list/history/thread/user/file tools so it can retrieve bounded context on demand; it does not expose `slack_bot_post_message` or `slack_bot_delete_message`, because the durable interaction pump owns replies to the originating thread. Threaded posts pass the parent message timestamp as `threadTimestamp` and return it in the result so placement can be verified. Message deletion accepts an operation UUID, the exact channel ID, and the exact message timestamp; Slack permits the bot token to delete only messages authored by that bot. Outside a scheduled session, calls require `connections:read`; the connection ID is optional when exactly one eligible active OpenGeni bot is installed, and required when multiple eligible bots exist. Legacy duplicate rows for one workspace/team/bot/bot-user principal collapse deterministically by `createdAt DESC, id DESC`; a different principal still requires an explicit connection ID, and no row crosses a workspace boundary. A scheduled session can use only its immutable selected bot connection ID.

Slack AI huddle notes are canvases. Sharing that canvas into a channel where the bot is a member lets OpenGeni read the notes and exposes the associated `huddleTranscriptFileId`. For transcript content, OpenGeni requests the expanded `files.info` projection with `include_transcription=true` and reads the returned `huddle_transcription` object from the transcript or parent canvas. If Slack omits that projection and redirects the private download to an interactive user page, OpenGeni reports `huddle_transcript_requires_participant_access` and never treats Slack web-client HTML as transcript content.

Each post requires an `operationId` UUID. Generate one per intended message and reuse the same UUID for every timeout or unknown-outcome retry. OpenGeni binds it to the connection, target, and protected request digest and sends it as Slack `client_msg_id`; reusing it for different content or a different target is rejected.

Each deletion also requires an `operationId` UUID. OpenGeni durably binds it to the tenant, initiating subject or scheduler principal, exact connection, `slack_bot_delete_message` tool, channel, timestamp, and protected request digest before `chat.delete`. Completed retries replay the stored result. Concurrent retries observe the live claim. If the process or response is lost after provider admission, the row becomes outcome-unknown and the retry first reconciles the exact Slack message through `chat.getPermalink`: an absent message completes as already deleted, while a still-present message permits one new delete attempt. OpenGeni never blindly sends `chat.delete` twice.

## Scheduled tasks

An enabled workspace-owned hosted Slack MCP connection is an ordinary workspace capability. Scheduled tasks created without an explicit tool list inherit it automatically; tasks with an explicit tool list must select that MCP server. The run resolves the exact workspace connection reference and never substitutes a personal Slack row or the bot. This is the path for shared scheduled search, read, message, reaction, canvas, and conversation tools that should act as the designated Slack user.

In **Scheduled tasks → Advanced → OpenGeni Slack bot**, explicitly select an active bot connection. The task stores its exact connection UUID. At each fire, the worker revalidates that the row is active, workspace-shared, belongs to the task workspace, has the verified OpenGeni bot role, and retains the exact required scopes before starting model work.

Installing a new Slack workspace or bot creates a separate connection and does not rebind existing scheduled tasks. Reinstalling the exact same Slack team, bot ID, and bot-user principal updates the existing connection in place so explicit task references remain stable. A different principal must be installed as a new connection and selected manually on each intended task.

## Disconnect, uninstall, revocation, and reconnect

Disconnecting a hosted-MCP connection in OpenGeni disables that exact personal or workspace row and does not revoke the grant at Slack. Disconnecting the workspace-owned row leaves schedules bound to it unavailable rather than silently rebinding them. Disconnecting the bot likewise disables only the bot row; it does not uninstall the Slack app or affect hosted-MCP OAuth. To remove provider access, an authorized Slack administrator must revoke or uninstall the app in Slack as a separate action.

Slack authentication errors that prove invalid, inactive, expired, or revoked credentials mark the connection for reinstall. Provider transport failures, HTTP 5xx responses, missing channel membership, missing scope, or a missing channel do not falsely poison the credential. Reinstall preserves an existing row only after exact principal validation; otherwise use **Install another Slack workspace/bot** and explicitly review scheduled tasks.

## Audit evidence

Connect, reinstall, disconnect, channel-list, history, thread-reply, user-list, file-list, file-info, file-content, post, and deletion operations write connection-targeted audit events. Receipts identify the non-secret credential role, connection UUID, Slack team ID, operation, outcome, and applicable task/session IDs. Post receipts include the non-secret operation/client-message UUID; deletion receipts include only their operation UUID. They never include tokens, authorization headers, posted text, channel history, file contents, private-file URLs, protected request digests, or raw provider responses.
