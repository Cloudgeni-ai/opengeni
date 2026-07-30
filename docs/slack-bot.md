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
oauth_config:
  redirect_urls:
    - https://app.opengeni.ai/v1/integrations/oauth/callback
    - https://app.opengeni.ai/v1/integrations/slack/callback
  scopes:
    bot:
      - chat:write
      - im:write
      - channels:read
      - channels:history
      - groups:read
      - groups:history
      - users:read
      - files:read
      - canvases:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Self-hosted deployments replace `https://app.opengeni.ai` with their stable HTTPS `OPENGENI_PUBLIC_BASE_URL`. Keep bot `user_scope` empty. Event Subscriptions are disabled by omission. Do not enable Socket Mode, Event Subscriptions, token rotation, or add `channels:join`, `chat:write.public`, or other scopes. OpenGeni rejects an installation whose reported bot scopes do not exactly match the manifest.

## Install and connect the workspace bot

1. In the intended OpenGeni workspace, open **Capabilities → OpenGeni Slack bot**.
2. Choose the official **Add to Slack** visual. The button calls OpenGeni's authenticated OAuth-start API; it is not a static provider link.
3. OpenGeni creates high-entropy, signed, single-use state bound to the exact account, workspace, subject, and install or reinstall action, then redirects to Slack workspace selection and consent.
4. Slack returns the browser to `/v1/integrations/slack/callback`. OpenGeni consumes the state once and exchanges the temporary code server-side.
5. OpenGeni verifies the exact Slack workspace, bot ID, bot user ID, token type, display name, and scope set before storing the bot token in the encrypted connection credential column.

Slack's bot installation endpoint is protected by the bound one-time state and exact redirect URI. The implementation does not claim or add PKCE to this provider-specific bot flow unless Slack documents support for it.

The bot connection is a workspace-shared `app_install` row (`subjectId = null`) in exactly the OpenGeni workspace that initiated installation. It is not organization-wide and is never implicitly shared to another OpenGeni workspace. API responses, browser URLs, events, tool results, and audit metadata contain only non-secret connection and principal facts.

## Channel access and tools

- Channel listing can discover public channels and reports whether the bot is a member.
- Reading history or posting in a public channel requires existing bot membership.
- A private channel is visible and usable only after a Slack member invites the bot.
- OpenGeni never auto-joins a channel and does not request `channels:join` or `chat:write.public`.
- Direct messages use `im:write` to open a DM, then post as the bot.
- Thread replies are read through their top-level message timestamp and may be posted by supplying that same timestamp.
- File and canvas reads are limited to channels where the bot is already a member. Results expose bounded file metadata and text content, never Slack private-file URLs or credentials.

The first-party tools are `slack_bot_list_channels`, `slack_bot_channel_history`, `slack_bot_thread_replies`, `slack_bot_list_users`, `slack_bot_list_files`, `slack_bot_file_info`, `slack_bot_file_content`, and `slack_bot_post_message`. Outside a scheduled session, calls require `connections:read`; the connection ID is optional when exactly one eligible active OpenGeni bot is installed, and required when multiple eligible bots exist. A scheduled session can use only its immutable selected bot connection ID.

Slack AI huddle notes are canvases. Sharing that canvas into a channel where the bot is a member lets OpenGeni read the notes and exposes the associated `huddleTranscriptFileId`. It does not necessarily grant the bot the transcript body. Slack can return transcript metadata to the bot while redirecting the content download to an interactive participant-only page. OpenGeni reports `huddle_transcript_requires_participant_access` in that case and never treats the Slack web-client HTML as transcript content. A participant-owned personal Slack connection is a separate principal and must not be substituted automatically.

Each post requires an `operationId` UUID. Generate one per intended message and reuse the same UUID for every timeout or unknown-outcome retry. OpenGeni binds it to the connection, target, and protected request digest and sends it as Slack `client_msg_id`; reusing it for different content or a different target is rejected.

## Scheduled tasks

In **Scheduled tasks → Advanced → OpenGeni Slack bot**, explicitly select an active bot connection. The task stores its exact connection UUID. At each fire, the worker revalidates that the row is active, workspace-shared, belongs to the task workspace, has the verified OpenGeni bot role, and retains the exact required scopes before starting model work.

Installing a new Slack workspace or bot creates a separate connection and does not rebind existing scheduled tasks. Reinstalling the exact same Slack team, bot ID, and bot-user principal updates the existing connection in place so explicit task references remain stable. A different principal must be installed as a new connection and selected manually on each intended task.

## Disconnect, uninstall, revocation, and reconnect

Disconnecting in OpenGeni disables local use of the bot connection. It does not uninstall the Slack app, revoke the installation at Slack, affect personal hosted MCP OAuth, or silently rebind schedules. To remove provider access, an authorized Slack administrator must uninstall or revoke the app in Slack as a separate action.

Slack authentication errors that prove invalid, inactive, expired, or revoked credentials mark the connection for reinstall. Provider transport failures, HTTP 5xx responses, missing channel membership, missing scope, or a missing channel do not falsely poison the credential. Reinstall preserves an existing row only after exact principal validation; otherwise use **Install another Slack workspace/bot** and explicitly review scheduled tasks.

## Audit evidence

Connect, reinstall, disconnect, channel-list, history, thread-reply, user-list, file-list, file-info, file-content, and post operations write connection-targeted audit events. Receipts identify the non-secret credential role, connection UUID, Slack team ID, operation, outcome, and applicable task/session IDs. Post receipts include the non-secret operation/client-message UUID. They never include tokens, authorization headers, posted text, channel history, file contents, private-file URLs, protected request digests, or raw provider responses.
