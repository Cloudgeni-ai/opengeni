# App webhooks and app notifications

Two ways data and attention move into an app (a published Site) from
outside a model run:

- **App webhooks**: another service posts JSON to an address, and the
  records land in one collection of the app's [Site Data](site-data.md).
- **`site.notify`**: the app's page sends a notification to the viewer,
  another member or everyone who can open the app.

Code: `packages/contracts/src/app-webhook.ts` (schemas and limits),
`packages/db/src/app-webhooks.ts`, `apps/api/src/app-webhooks/service.ts`,
`apps/api/src/app-notify/service.ts`, `apps/api/src/routes/app-webhooks.ts`,
`apps/api/src/mcp/app-webhook-tools.ts`, migration
`1524_app_webhooks_and_notifications.sql`.

## App webhooks

### Settings and storage

`app_webhooks` (FORCE RLS, workspace-scoped, deleted with the app) keeps per
webhook: the app, `name`, target `collection`, the mapping (`recordsPath`,
`key`, `fields`, read the same way as a [data sync](app-sync.md#reading-records)),
`status` (`active` or `paused`), who created it, the last delivery's time,
status and error, and the secret. An app has at most 20 webhooks.

The secret (`ogwh_…`) is shown once, on create and on rotate. It is stored
as a SHA-256 hash (bearer checks) and encrypted with the environments
encryption key (signature checks need the secret itself), so creating one
needs `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`.

The target must be a shared collection (`shared`, `shared_read` or
`append_only`); `per_viewer` collections are refused, since a delivery
belongs to no viewer.

### Delivery

`POST /v1/webhooks/apps/<workspaceId>/<webhookId>` (the `url` on the
webhook). It needs no Opengeni credentials; the secret authenticates the
sender, either way:

- `Authorization: Bearer <secret>`, or
- `X-Opengeni-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`,
  keyed with the secret, within 5 minutes of now (the same scheme as
  `verifyTimestampedHmac` for event sources).

Nothing is parsed before the secret is checked over the raw body. Then:

| Answer | When |
| --- | --- |
| 200 `{ written, skipped, records: [{ id, key }] }` | Written |
| 400 | Not valid JSON, or more than 100 records |
| 401 | Missing, wrong or stale secret or signature |
| 403 | The app is archived, or the target isn't allowed |
| 404 | Unknown address (or a deleted webhook) |
| 409 | The webhook is paused |
| 413 | Body over 256 KiB |
| 415 | Content type isn't JSON |
| 429 | Over 120 deliveries a minute for this webhook |

With a `key`, records are put (upserted) by key, keeping `fields`; records
without a key are skipped. Without a `key`, the body (or each record of the
list at `recordsPath`, or the body itself when it is a list) is inserted.
A delivery id from `Idempotency-Key`, `Webhook-Id` or `X-Delivery-Id` makes
the insert idempotent (`<id>:<index>` per record of a list), so retries
don't duplicate records. A signed delivery's id is derived from its
signature instead (those headers aren't signed), so replaying it inside the
signature window inserts nothing new. Requests that fail authentication
write nothing, not even the webhook's last-delivery status.

### Writes and change events

Deliveries write through the ordinary Site Data write path as the webhook's
own principal `webhook:<id>`, a trusted manager-level writer (writer kind
`service`). Quotas, validation and metering are those of every other Site
Data write. The app's normal change events fire: live updates for open
pages, and `app.record.*` facts for "This workspace" automations and
workspace webhooks ([site-data.md](site-data.md#app-change-events-for-automations-and-webhooks)),
with chain depth 1, so automations they start keep the chain limit and the
storm guard. The app is read as the webhook's creator sees it: an Only me
app keeps accepting only while it is still theirs. Otherwise a webhook
belongs to the app, not to the person who created it: it keeps accepting
after they leave, and the app's managers pause, rotate or delete it.

### Management

Managers of the app (`artifacts:publish`), never from inside the app's frame:

| Route | Tool | SDK |
| --- | --- | --- |
| `GET …/published-artifacts/:siteId/webhooks` | `app_webhook_list` | `listAppWebhooks` |
| `POST …/webhooks` | `app_webhook_save` | `createAppWebhook` |
| `PATCH …/webhooks/:webhookId` (`rotateSecret`, `status`, mapping) | `app_webhook_save` with `webhookId` | `updateAppWebhook` |
| `DELETE …/webhooks/:webhookId` | `app_webhook_delete` | `deleteAppWebhook` |

## Notifications from apps

`site.notify({ title, body?, to?, path?, key? })` in `@opengeni/sdk/site`
(operation `site.notify`, `POST …/published-artifacts/current/notify`; SDK
`notifyFromApp` from a server). Answers `{ key, delivered, skipped }`.

- **Who sends.** Signed-in workspace members only, with live membership:
  guests and invited viewers who aren't members get 403 with `details.reason`
  `members_only`.
- **`to`.** Omitted: the sender. A member's email, subject id or name: only
  if they can open the app (a shared app, or their own) and allow other
  members to notify them (the same setting as agent notifications). Yourself
  always. `"workspace"`: the app's managers only; reaches every other member
  who can open the app and allows it, at most 200; the rest count as
  `skipped`.
- **Limits.** 30 sends per sender and app in 10 minutes, of which at most 3
  to `"workspace"`; then 429 `rate_limited`.
- **`key`.** The same key updates the person's existing notification in
  place (a dismissed one stays dismissed); omitted, every send is new.
- **Delivery.** The API inserts one `app_notifications` row (FORCE RLS; the
  runtime role only inserts and reads). Its trigger calls the owner's
  SECURITY DEFINER `opengeni_private.deliver_app_notification_v1(id)`, which
  delivers only a send made in the same transaction: each recipient's
  chat-less inbox item (`session_id` NULL, the app's title as subtitle, the
  sender when it isn't the recipient, a link that opens the app at `path` in
  the console) and native push for new or reopened items under each device's
  `agent` rule. Rows older than a day are removed.
- **Rollout.** The runtime role's EXECUTE on that routine is withheld for one
  release (`DEFERRED_RUNTIME_PRIVATE_ROUTINES`, as for migration 1503),
  because the previous release refuses an unknown trigger definer or a
  runtime grant on an unknown definer. Until a later migration grants it,
  `site.notify` answers 403 with `details.reason` `notify_not_available` and
  stores nothing.

## Self-hosting

- Webhooks need an API address senders can reach:
  `OPENGENI_WEBHOOK_BASE_URL` or the public base URL (otherwise the request's
  own origin is used), and `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`.
- `site.notify` from published app hosts needs the Sites gateway; in the
  console it works on every deployment. Native push needs push configured;
  without it notifications still reach the inbox.
- Not supported: per-viewer (personal) webhook targets, Site SQL targets,
  outbound retries (senders retry on non-2xx), and notifications to people
  outside the workspace.
