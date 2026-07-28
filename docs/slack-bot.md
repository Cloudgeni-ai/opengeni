# OpenGeni Slack bot connection

OpenGeni supports one deliberately narrow Slack app shape for workspace-shared bot operations. This connection is **not** the hosted Slack MCP personal OAuth connection: personal OAuth remains subject-owned, while the OpenGeni bot connection is workspace-shared and must be selected explicitly by scheduled tasks.

## Slack app manifest

Create a Slack app from this manifest. The app name and bot display name must both be exactly `OpenGeni`.

```yaml
display_information:
  name: OpenGeni
features:
  bot_user:
    display_name: OpenGeni
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:write
      - channels:read
      - channels:history
      - groups:read
      - groups:history
      - users:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Event Subscriptions are disabled by omission. Do not enable Socket Mode, Event Subscriptions, token rotation, or add `channels:join`, `chat:write.public`, or other scopes. OpenGeni rejects an installation whose reported bot scopes do not exactly match the manifest.

## Install and connect

1. In Slack, create the app from the manifest and install it to the intended Slack workspace.
2. In the intended OpenGeni workspace, open **Capabilities → OpenGeni Slack bot**.
3. Enter the Slack **Bot User OAuth Token** in the password field and choose **Validate and connect**. Enter the credential only in this form—never in chat, a task prompt, an issue, or logs.
4. OpenGeni calls Slack server-to-server to verify the bot token, exact scope set, Slack workspace, bot identity, and exact `OpenGeni` display name. It then stores the token only in the existing encrypted connection credential column. API responses, session events, MCP results, and audit events contain only non-secret connection/team/role facts.

The connection is bound to the authenticated OpenGeni account and workspace by the normal RLS-scoped `connections` row. It is workspace-shared (`subjectId = null`) and cannot be fabricated or modified through generic connection metadata APIs. A server-owned verification timestamp and credential-version marker distinguish this dedicated validated install from caller-written legacy connection JSON. Markerless rows fail closed. During a rolling release, any older generic writer that replaces the credential or asserted bot identity automatically clears the marker at the database boundary.

## Channel access

- Channel listing reports whether the bot is a member.
- Reading history or posting in a public channel requires the bot already to be a member.
- A private channel is visible/readable only after a Slack member invites the bot.
- OpenGeni never auto-joins a channel and does not request `channels:join` or `chat:write.public`.
- Direct messages use `im:write` to open a DM, then post as the bot.

The first-party tools are `slack_bot_list_channels`, `slack_bot_channel_history`, `slack_bot_list_users`, and `slack_bot_post_message`. Outside a scheduled session, every call requires an explicit bot connection ID plus `connections:read`. A scheduled session uses only its immutable selected connection ID. Neither path falls back to personal Slack OAuth.

Every `slack_bot_post_message` call also requires an `operationId` UUID. Generate one UUID per intended message and reuse that exact UUID on every timeout, transport-error, or unknown-outcome retry. OpenGeni durably binds it to the connection, target, and protected request digest before posting and sends the same value to Slack as `client_msg_id`. A completed replay returns the stored provider result without posting again; a lost response or audit-commit failure retries the same provider identity and converges to one logical message and one success receipt. Reusing an operation ID for different text or a different target is rejected.

## Scheduled tasks

In **Scheduled tasks → Advanced → OpenGeni Slack bot**, select an active bot connection explicitly. The task stores only the connection UUID. At each fire, the worker revalidates that the row is active, workspace-shared, belongs to the task workspace, has the trusted OpenGeni bot role, and retains the exact required scopes before creating model work. New sessions receive the selected UUID in reserved server-owned metadata. A live reusable session cannot be rebound to another bot connection; recreate the task instead.

## Reinstall

If the Slack app is reinstalled or its credential changes:

1. Reinstall the existing app in the **same Slack workspace**.
2. Return to **Capabilities → OpenGeni Slack bot** and choose **Validate and reinstall** with the newly issued bot token.

OpenGeni updates the existing connection in place so scheduled-task references remain stable, but only when the Slack team ID, bot ID, and bot user ID all match the original verified installation. A different bot principal—even in the same Slack workspace and with the same display name—requires a new OpenGeni connection and explicit scheduled-task rebinding. If the manifest name or scopes changed, restore the exact manifest and reinstall in Slack before retrying.

Disconnecting revokes the OpenGeni connection. It does not uninstall the Slack app or affect any subject-owned hosted Slack MCP OAuth connection.

## Audit evidence

Connect, reinstall, disconnect, list, history, user-list, and post operations write audit events targeted at the connection UUID. Receipts identify the credential role `OpenGeni Slack bot`, connection UUID, Slack team ID, operation, outcome, and applicable scheduled task/session IDs. Post receipts also carry the non-secret operation/client-message UUID; success is committed atomically with the durable operation result, so a replay cannot create another success receipt. They never include the token, authorization headers, posted text, channel history text, protected request digest, or raw provider responses.