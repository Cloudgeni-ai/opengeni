# Slack identities and connections

OpenGeni uses one Slack app named **OpenGeni** with two separate OAuth principals. They share provider branding, but not credentials, ownership, routing, or authority.

| Connection | Slack author | OpenGeni ownership | Intended use |
| --- | --- | --- | --- |
| Personal hosted Slack MCP | The Slack human who authenticated, with Slack's exact app attribution `Sent using @OpenGeni` | The exact authenticating OpenGeni subject | Interactive personal Slack tools only |
| OpenGeni workspace bot | The `OpenGeni` bot user | The one OpenGeni workspace that installed it | First-party bot tools and explicitly bound scheduled tasks |

The personal connection must never be substituted with the workspace bot, and the workspace bot must never fall back to a personal connection. Nothing reads or posts by default.

## Provider identity and deployment prerequisites

`JorgeBot` is not configured anywhere in this repository. Slack renders the message author from the OAuth principal and renders `Sent using @…` from Slack app/provider metadata. If Slack currently displays `JorgeBot`, an authorized Slack app administrator must update the existing app rather than adding generated text or changing message payloads:

1. Set the Slack app name to exactly `OpenGeni`.
2. Set the bot user display name to exactly `OpenGeni`.
3. Configure both exact redirect URLs:
   - `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/oauth/callback` for personal hosted MCP OAuth.
   - `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/slack/callback` for workspace-bot installation.
4. Enable direct/public OAuth distribution. A Slack Marketplace listing is not required.
5. Keep the client credential server-side and configure the deployment with:
   - `OPENGENI_SLACK_CLIENT_ID`
   - `OPENGENI_SLACK_CLIENT_SECRET`
   - `OPENGENI_INTEGRATIONS_ENABLED=true`
   - `OPENGENI_INTEGRATIONS_STATE_SECRET`
   - `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`
   - `OPENGENI_PUBLIC_BASE_URL`

The same configured Slack app client is used for the two explicit flows. Users never paste a client ID, client secret, bot token, or user token into OpenGeni. Do not log, expose, rotate, or copy production credentials while applying metadata or deployment configuration.

Changing Slack app metadata is provider administration outside this repository. Reconnect affected personal OAuth grants and reinstall an affected bot through OpenGeni only when the provider requires a fresh grant; do not replace either principal with the other.

## Personal hosted Slack MCP

Personal Slack uses the provider's official hosted MCP resource, exactly `https://mcp.slack.com/mcp`. The normal authenticated MCP OAuth start endpoint performs discovery, uses the deployment-managed Slack client, creates signed single-use state bound to the exact OpenGeni account, workspace, and subject, and uses authorization-code OAuth with PKCE S256. The callback rechecks the subject's live workspace grant before consuming the nonce, exchanging the code, verifying MCP tool discovery, or writing the connection.

The signed-in user's account-linking surface is **Capabilities → Slack connections → Your Slack account**. It is deliberately separate from the adjacent **OpenGeni workspace bot** installation card:

1. **Connect my Slack account** starts the existing hosted-MCP OAuth flow. The browser sends only the official resource/provider target and the return path; Slack client credentials remain deployment-managed.
2. The card shows only non-secret subject-owned metadata: connection health, granted personal scopes, last use, and access-token expiry. It never shows the private connection UUID, token, client credential, or workspace-bot installation details.
3. **Reconnect my Slack account** reuses the current subject's row when it still exists. The callback preserves the generic subject-scoped capability reference and never publishes that row's UUID into workspace capability configuration.
4. **Disconnect** requires an explicit confirmation and revokes local OpenGeni use of that subject-owned row. It does not disconnect the workspace bot or revoke provider-side access in Slack.

Status copy follows the broker's actual lifecycle. An active row whose access token reached its expiry time remains connected with refresh pending because the broker refreshes on use. `needs_reauth` after an expired/rejected refresh and `error` require reconnect. `revoked` is shown as disconnected and remains an eligible in-place reconnect target. Raw provider errors are not rendered in the browser.

The resulting `connections` row has `subjectId` and `createdBySubjectId` set to the authenticating OpenGeni subject. Subject-owned capability configuration stores only a generic `{ providerDomain: "slack.com", kind: "oauth2", subjectScope: "subject" }` reference; it never publishes or persists the private connection UUID in a workspace capability projection.

Enforcement is fail-closed across the full lifecycle:

- Connection list/get/update/delete and OAuth reconnect require the exact subject.
- Tool catalog discovery exposes only the current subject's personal connection readiness, never another subject's UUID or metadata.
- Runtime and Toolspace token resolution use the immutable human initiator captured for the turn.
- A service or scheduled-task initiator has no personal credential subject and cannot resolve, refresh, read through, write through, or reconnect the personal connection.
- Two different OpenGeni users in the same workspace resolve different Slack rows even when both use `slack.com` and `oauth2`.

Slack therefore writes personal MCP messages as the authenticating Slack human and supplies the app attribution `Sent using @OpenGeni`. OpenGeni must pass the user's requested message content to the existing Slack MCP tool unchanged: it does not prepend or append author, requester, requested-by, or proxy text.

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
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
    request_url: https://app.opengeni.ai/v1/integrations/slack/events
  interactivity:
    is_enabled: true
    request_url: https://app.opengeni.ai/v1/integrations/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Self-hosted deployments replace `https://app.opengeni.ai` with their stable HTTPS `OPENGENI_PUBLIC_BASE_URL`. Keep bot `user_scope` empty. The manifest requests only the scopes and event types required by the shipped workspace-bot tools and Slack task interaction surface. Do not enable Socket Mode, token rotation, or add canvas/file/reaction mutation, `channels:join`, `chat:write.public`, `chat:write.customize`, `users:read.email`, channel-management, administrative, or enterprise-search scopes. The canonical allowlist accepts the required manifest scopes plus the explicitly safe read-only identity extra `team:read`; every other extra or unknown future scope fails closed across installation verification, core routing, and browser Installed-state projection.

## Install and connect the workspace bot

1. In the intended OpenGeni workspace, open **Capabilities → Slack connections → OpenGeni workspace bot**.
2. Choose the official **Add to Slack** visual. The button calls OpenGeni's authenticated OAuth-start API; it is not a static provider link.
3. OpenGeni creates high-entropy, signed, single-use state bound to the exact account, workspace, subject, and install or reinstall action, then redirects to Slack workspace selection and consent.
4. Slack returns the browser to `/v1/integrations/slack/callback`. OpenGeni consumes the state once and exchanges the temporary code server-side.
5. OpenGeni verifies the exact Slack workspace, bot ID, bot user ID, token type, display name, and scope set before storing the bot token in the encrypted connection credential column.

Slack's bot installation endpoint is protected by the bound one-time state and exact redirect URI. The implementation does not claim or add PKCE to this provider-specific bot flow unless Slack documents support for it.

The bot connection is a workspace-shared `app_install` row (`subjectId = null`) in exactly the OpenGeni workspace that initiated installation. It is not organization-wide and is never implicitly shared to another OpenGeni workspace. API responses, browser URLs, events, tool results, and audit metadata contain only non-secret connection and principal facts.

## Start and continue OpenGeni work from Slack

Authenticated Slack users can start work through three configured entry points:

- mention `@OpenGeni` in a channel or existing thread;
- invoke `/opengeni <task>` in a channel;
- direct-message the OpenGeni bot, or use the **Open in OpenGeni** message shortcut when explicitly sending a human-to-human DM message.

Every top-level bot DM durably reserves a new private OpenGeni session ID for the linked OpenGeni subject before session creation begins. Authorization and listing use that reservation until the same ID is bound as the session root, so a crash or concurrent read before binding cannot expose the session to another workspace subject. A reply in its Slack thread continues that exact session; a separate top-level DM creates a separate session. Installing the bot for a workspace never converts private DM sessions into workspace-visible sessions.

A channel mention, command, or message shortcut creates one workspace-visible session whose authorization follows both the Slack channel and live OpenGeni workspace grants. Mentioning OpenGeni inside an unmapped existing thread adopts that thread as the session surface. Once mapped, linked and authorized OpenGeni workspace participants can continue the same session by replying in that thread. An ordinary unmapped thread reply is ignored rather than creating work implicitly.

The bot acknowledges accepted work and keeps at most three progress posts globally per interaction, plus durable human-input questions, stop/cancellation, failures, blockers, and the final result in the originating thread. Each progress event durably claims one of those three slots and a stable Slack post-operation identity before provider delivery, so pages, retries, restarts, replicas, and duplicate claims cannot exceed the cap. Messages include an **Open in OpenGeni** session link. Reply `stop` in the mapped thread to pause the workstream; start a new top-level DM or invoke OpenGeni again to create a new session.

Slack identities must be explicitly linked to an OpenGeni subject in the same account and workspace. An unmapped identity receives an account-linking URL and no session is created. Invalid signatures or timestamps, replayed/duplicate provider identities, inactive or ambiguous installations, missing bot channel access, revoked OpenGeni access, malformed payloads, and cross-tenant ambiguity fail closed. Slack retries, reconnects, worker restarts, and session resumes converge through the durable inbox, private session reservation, route binding, session idempotency key, delivery cursor, per-event progress ledger, and Slack post-operation ledger.

Slack message and thread text is task-local input only. The interaction path does not automatically write it to Documents, Knowledge, Memory, preferences, Workspace Charter, instructions, or policy. Delivery excludes private reasoning, secrets, credentials, raw logs, raw provider responses, and unbounded output, and bot/self/subtype events are suppressed to prevent notification loops.

## Channel access and tools

- Channel listing can discover public channels and reports whether the bot is a member.
- Reading history or posting in a public channel requires existing bot membership.
- A private channel is visible and usable only after a Slack member invites the bot.
- OpenGeni never auto-joins a channel and does not request `channels:join` or `chat:write.public`.
- Direct messages use `im:write` to open a DM, then post as the bot.
- Thread replies are read through their top-level message timestamp and may be posted by supplying that same timestamp.
- File and canvas reads are limited to channels where the bot is already a member. Results expose bounded file metadata and text content, never Slack private-file URLs or credentials.

The first-party tools are `slack_bot_list_channels`, `slack_bot_channel_history`, `slack_bot_thread_replies`, `slack_bot_list_users`, `slack_bot_list_files`, `slack_bot_file_info`, `slack_bot_file_content`, `slack_bot_post_message`, and `slack_bot_delete_message`. Threaded posts pass the parent message timestamp as `threadTimestamp` and return it in the result so placement can be verified. Message deletion accepts an operation UUID, the exact channel ID, and the exact message timestamp; Slack permits the bot token to delete only messages authored by that bot. Outside a scheduled session, calls require `connections:read`; the connection ID is optional when exactly one eligible active OpenGeni bot is installed, and required when multiple eligible bots exist. Legacy duplicate rows for one workspace/team/bot/bot-user principal collapse deterministically by `createdAt DESC, id DESC`; a different principal still requires an explicit connection ID, and no row crosses a workspace boundary. A scheduled session can use only its immutable selected bot connection ID.

Slack AI huddle notes are canvases. Sharing that canvas into a channel where the bot is a member lets OpenGeni read the notes and exposes the associated `huddleTranscriptFileId`. For transcript content, OpenGeni requests the expanded `files.info` projection with `include_transcription=true` and reads the returned `huddle_transcription` object from the transcript or parent canvas. If Slack omits that projection and redirects the private download to an interactive user page, OpenGeni reports `huddle_transcript_requires_participant_access` and never treats Slack web-client HTML as transcript content.

Each post requires an `operationId` UUID. Generate one per intended message and reuse the same UUID for every timeout or unknown-outcome retry. OpenGeni binds it to the connection, target, and protected request digest and sends it as Slack `client_msg_id`; reusing it for different content or a different target is rejected.

Each deletion also requires an `operationId` UUID. OpenGeni durably binds it to the tenant, initiating subject or scheduler principal, exact connection, `slack_bot_delete_message` tool, channel, timestamp, and protected request digest before `chat.delete`. Completed retries replay the stored result. Concurrent retries observe the live claim. If the process or response is lost after provider admission, the row becomes outcome-unknown and the retry first reconciles the exact Slack message through `chat.getPermalink`: an absent message completes as already deleted, while a still-present message permits one new delete attempt. OpenGeni never blindly sends `chat.delete` twice.

## Scheduled tasks

In **Scheduled tasks → Advanced → OpenGeni Slack bot**, explicitly select an active bot connection. The task stores its exact connection UUID. At each fire, the worker revalidates that the row is active, workspace-shared, belongs to the task workspace, has the verified OpenGeni bot role, and retains the exact required scopes before starting model work.

Installing a new Slack workspace or bot creates a separate connection and does not rebind existing scheduled tasks. Reinstalling the exact same Slack team, bot ID, and bot-user principal updates the existing connection in place so explicit task references remain stable. A different principal must be installed as a new connection and selected manually on each intended task.

## Disconnect, uninstall, revocation, and reconnect

Disconnecting in OpenGeni disables local use of the bot connection. It does not uninstall the Slack app, revoke the installation at Slack, affect personal hosted MCP OAuth, or silently rebind schedules. To remove provider access, an authorized Slack administrator must uninstall or revoke the app in Slack as a separate action.

Slack authentication errors that prove invalid, inactive, expired, or revoked credentials mark the connection for reinstall. Provider transport failures, HTTP 5xx responses, missing channel membership, missing scope, or a missing channel do not falsely poison the credential. Reinstall preserves an existing row only after exact principal validation; otherwise use **Install another Slack workspace/bot** and explicitly review scheduled tasks.

## Audit evidence

Connect, reinstall, disconnect, channel-list, history, thread-reply, user-list, file-list, file-info, file-content, post, and deletion operations write connection-targeted audit events. Receipts identify the non-secret credential role, connection UUID, Slack team ID, operation, outcome, and applicable task/session IDs. Post receipts include the non-secret operation/client-message UUID; deletion receipts include only their operation UUID. They never include tokens, authorization headers, posted text, channel history, file contents, private-file URLs, protected request digests, or raw provider responses.
