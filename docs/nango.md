# Nango-backed integrations

Opengeni can serve some catalog integrations through [Nango](https://nango.dev)
instead of its own OAuth apps. This is useful when our own app is waiting on
third-party review (Google restricted scopes need a CASA assessment), or when we
have no native connector (LinkedIn, X). Nango is completely off unless a
deployment configures it, and nothing from Nango is offered unless an operator
allowlists that integration.

Microsoft integrations and plain MCP servers do not use this path. Opengeni
never exposes Nango's whole catalog or Nango's own MCP server.

## Architecture

| Piece                       | Where                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| Shared types, pricing       | `packages/contracts/src/nango.ts`                                                                   |
| Nango HTTP client, webhooks | `packages/capabilities/src/nango.ts`                                                                |
| Switch, usage, export (DB)  | `packages/db/drizzle/1406_nango_integrations.sql`, `packages/db/src/nango-integrations.ts`          |
| Credential resolution       | `packages/db/src/connection-token-resolver.ts`                                                      |
| Catalog and projection      | `packages/core/src/domain/nango-integrations.ts`, `packages/core/src/domain/capabilities.ts`        |
| Proxy transport             | `packages/runtime/src/nango-transport.ts`                                                           |
| Google bridges              | `gmail-rest-mcp.ts`, `google-calendar-rest-mcp.ts`, `drive-mcp.ts`, `drive-nango-read-tools.ts`     |
| Generic tools bridge        | `packages/runtime/src/nango-tools-mcp.ts`                                                           |
| Connect, webhook, usage API | `apps/api/src/integrations/nango-connect.ts`, `apps/api/src/routes/nango.ts`                        |
| Operator CLI                | `scripts/operator/nango.ts` (`bun run integrations:nango`)                                          |

### The switch is the allowlist

`integration_backend_revisions` is a deployment-wide, append-only operator
setting, one revision per change. The newest revision per `integration_key`
is in effect (`integration_backends_effective` view). An integration is
Nango-backed only when that row says `backend = 'nango'`, `enabled = true`, has
a `nango_provider_config_key`, and the deployment has
`OPENGENI_NANGO_SECRET_KEY`. Every other state (no row, `native`, disabled, no
key) means the native connector or nothing.

Keys with a reviewed native bridge: `gmail`, `google-calendar`, `google-drive`.
Any other key (for example `linkedin`, `x`) is config-only and needs a
`definition` whose `tools.source` is `"nango"`.

API and worker processes cache the switch for at most 30 seconds. A flip
applies to new catalog reads and to the next turn or attempt; a tool call in
flight finishes on the credential it already resolved.

### One catalog entry per service

- Gmail, Google Calendar and Google Drive keep their catalog identity, card,
  tool names and tool permission settings. Only the connect method and the
  transport change with the backend.
- A config-only integration appears as one deployment-managed connector named
  by its definition.
- When `x` is Nango-backed, the native X social card and the first-party
  `x_*` tools are hidden, and calls to them are refused at call time.

### Connections

Nango connections are ordinary `connections` rows (kind `oauth2`) with
provider domain `nango:<integration key>`, so native and Nango connections
never satisfy each other's connection reference. The encrypted credential holds
only `{ type: "nango", nangoConnectionId, providerConfigKey }`; the Nango
secret key never leaves the deployment configuration. Every Nango connection
is personal-only: the setter and the definition parser reject any other
`ownership`. The account label comes from a read-only identity call
through the proxy (Gmail profile, Calendar primary calendar, Drive `about`, or
the definition's `accountIdentity`).

Connect flow: the ordinary Connect card starts `startMcpOAuth`; for a
Nango-backed target it returns an Opengeni page
(`GET /v1/integrations/nango/connect?state=…`). That page creates a Nango
connect session for that one integration, tagged with the Opengeni attempt,
and shows Nango Connect. On completion it calls
`POST /v1/integrations/nango/connect/complete`, which finds the connection by
attempt tags and integration through `GET /connections`, verifies the
identity call, and stores it. Reconnecting the same verified account updates
its row; a connection without a verified identity is always stored as a new
account. The recorded grants are the scopes Nango reports for the connection
(`credentials.raw.scope`), falling back to the managed app's fixed scopes when
Nango reports none. The organization integration acquisition policy
and setup permissions apply as for native connectors; in allowlist mode the
policy key is the integration key (`gmail`, `linkedin`, `x`, …).

Disconnect deletes the connection in Nango too, so its billing stops. Rows
removed by SQL cascades (workspace or organization deletion, member removal)
are not deleted in Nango at that moment; `integrations:nango orphans` finds and
deletes them (below).

### Webhook

`POST /v1/integrations/nango/webhook` verifies `X-Nango-Hmac-Sha256` with
`OPENGENI_NANGO_WEBHOOK_SIGNING_KEY` (404 when unconfigured, 401 on a bad
signature).

- `auth` creation/override: backup finalizer for a connect attempt whose page
  was closed early. It reads the connection with `GET /connections/{id}` and
  requires the signed webhook's attempt tags (and the tags Nango reports for
  the connection, when present) to match. `GET /connections/{id}` refreshes the
  token; Nango's 424 (refresh exhausted) means the connection is not stored,
  here or on the page's completion (which also deletes it in Nango).
- `auth` refresh failure: re-reads the connection from the list
  (`GET /connections?connectionId=…`, matched on id and provider config key),
  which reports errors without refreshing, and marks it
  `needs_reauth` only if Nango still reports an auth error; a later successful
  refresh (or a re-check without errors) marks it active again. Replays of an
  old event are therefore harmless.
- `auth` deletion: revokes the Opengeni connection.

### Tool execution

- Google: the reviewed REST bridges keep their tool surface. The resolver
  returns Nango proxy headers (`Connection-Id`, `Provider-Config-Key`) and a
  URL rewrite instead of a token; each bridge validates the Google destination
  exactly as before, then sends the request to `<Nango base>/proxy/<path>`.
  Mutations keep the no-replay rule. A Nango connection records the scopes
  Nango reports (or the managed app's fixed scopes `https://mail.google.com/`,
  `…/auth/calendar`, `…/auth/drive`, or the definition's `scopes`), and requested
  incremental scopes are dropped, so the incremental-consent path never runs;
  a tool needing a scope the app lacks returns the normal not-available error.
- Drive under Nango: Google's hosted Drive MCP server is unreachable through
  Nango, so read tools are served from Drive REST through the proxy:
  `search_files`, `list_recent_files`, `get_file_metadata`,
  `get_file_permissions`, `read_file_content`, `download_file_content`. Text
  export covers Google Docs, Sheets (CSV) and Slides; other files return
  their bytes. `download_file_content` saves the file to the agent's files
  when the chat has them; otherwise it returns base64 only up to 1 MiB.
  `create_file` and `copy_file` are not offered under Nango.
- Config-only integrations (LinkedIn, X, future ones): the in-process Nango
  tools bridge lists the integration's deployed Nango actions (name,
  description, input schema), filtered by `definition.tools.allow`, and runs
  them with `POST /connections/{id}/tools/{name}/calls`. Writes (a non-GET endpoint, or listed in
  `definition.tools.write`) default to Ask first; reads are allowed. Tool
  descriptions are Nango's action metadata. A write is reported as not
  executed only for a clear refusal before it ran (401, 403, 404, 429, or an
  input-validation 400/422); every other failure, including Nango function
  runtime errors and 5xx, is reported as an unknown outcome and never retried.
  Response bodies are read up to 4 MiB.

## Operator runbook

### Configure

| Setting                              | Purpose                                                             |
| ------------------------------------ | ------------------------------------------------------------------- |
| `OPENGENI_NANGO_SECRET_KEY`          | Nango environment secret key. Without it Nango is off. Never log it. |
| `OPENGENI_NANGO_API_BASE_URL`        | Optional, default `https://api.nango.dev`.                          |
| `OPENGENI_NANGO_WEBHOOK_SIGNING_KEY` | Verifies Nango webhooks. Without it the webhook returns 404.        |

In the Nango dashboard, set the webhook URL to
`<OPENGENI_PUBLIC_BASE_URL>/v1/integrations/nango/webhook` and enable auth
creation and refresh-failure webhooks. Create each integration in Nango:
Google uses Nango-managed apps (`google-mail`, `google-calendar`,
`google-drive`); LinkedIn and X need our own developer apps registered in
Nango, plus the deployed Nango actions (for example `create-post`,
`create-tweet`).

All commands below run as the database owner (the migrations role):

```sh
export OPENGENI_MIGRATIONS_DATABASE_URL=…   # or OPENGENI_DATABASE_ADMIN_URL
bun run integrations:nango show
```

### Flip an integration to Nango

Export affected users first (below), then:

```sql
SELECT set_integration_backend('gmail', 'nango', 'google-mail', true, NULL,
  'operator-name', 'CASA review pending; serve Gmail through Nango');
```

or `bun run integrations:nango set --key gmail --backend nango --provider-config-key google-mail --operator <name> --reason "<why>"`.

Native connections of that integration then show as needing reconnection
(connections list, the agent's reconnect notices, connection presentation),
and Reconnect/Connect opens the Nango Connect card. Nothing stored is changed.

### Add a config-only integration (no code)

```sql
SELECT set_integration_backend('linkedin', 'nango', 'linkedin', true,
  '{"displayName":"LinkedIn","description":"Post and comment on LinkedIn.",
    "ownership":"personal",
    "accountIdentity":{"url":"https://api.linkedin.com/v2/userinfo","field":"email"},
    "tools":{"source":"nango","allow":["create-post","create-comment"],"write":["create-post","create-comment"]}}',
  'operator-name', 'Offer LinkedIn through Nango');
```

`x` (provider config key `twitter-v2`) and Facebook Pages (`facebook`) work the
same way, using Nango's pre-built tools. While `x` is on Nango, the native X social connector is hidden. In organizations using
allowlist acquisition, add the integration key to the policy.

### Remove or flip back

```sql
SELECT set_integration_backend('gmail', 'native', NULL, true, NULL,
  'operator-name', 'CASA approved; back to native');
-- or remove a config-only integration:
SELECT set_integration_backend('linkedin', 'native', NULL, false, NULL,
  'operator-name', 'Stop offering LinkedIn');
```

Native connections work again exactly as before. Nango connections are shown
as inactive but are not deleted automatically, and Nango bills them until
deleted. To stop billing, run the orphans command below, or have users
disconnect them while the integration is on Nango.

### Clean up orphaned Nango connections

```sh
bun run integrations:nango orphans [--key gmail] [--out orphans.csv]
bun run integrations:nango orphans --key gmail --delete [--include-untagged] --operator <you> --reason "<why>"
```

It lists every Nango connection (paged `GET /connections`) whose id has no live
Opengeni row (from `nango_affected_connections`), optionally per integration
(by its tag, or by provider config key when untagged), with an `action`
column. `--delete` deletes only connections Opengeni made (they carry the
`opengeni_attempt_id` tag) that are at least two hours old, longer than a
connect attempt lives, so an in-progress connect is never deleted. Untagged
connections (made outside Opengeni) are listed but deleted only with
`--include-untagged`, and never one whose age Nango does not report. Run it
after a flip back, and periodically to catch rows removed by
workspace/organization deletion or member removal.

### Export affected users

```sql
BEGIN;
SELECT * FROM nango_affected_connections('gmail');
COMMIT;
```

or `bun run integrations:nango affected --key gmail --out gmail-affected.csv`.
Columns: organization id/name, workspace id/name, user id/email, connection
id, Nango connection id (empty for native rows), backend (`native`/`nango`),
provider domain, status, account label, created, last used. For `x` the export includes native X social accounts.

### Read usage and cost

`nango_usage_events` records each connection lifecycle event (created,
reconnected, deleted, needs_reauth), proxy request and action run, with
organization, workspace, user, integration, connection ids, tool name, method,
status, bytes and duration. Recording is best effort and never fails a tool
call.

- Organization admins (billing read): `GET /v1/billing/integration-usage?accountId=<org>&since=<ISO>&until=<ISO>`
  (default: current month; at most one year).
- Operators: `bun run integrations:nango usage --since 2026-11-01 --until 2026-12-01 [--account <org>] --out usage.csv`.

Rows are per organization, workspace, integration and user, with connection
days, proxy requests, tool calls, bytes, compute seconds and estimated cost at
the pay-as-you-go prices: $0.29 per connection-month prorated by time
connected, $0.50 per GB transferred (request plus response bytes), and $0.72
per compute-hour with every action run counted as at least one second.

Reconcile against the Nango invoice and the dashboard usage page: compare
total connection-months, GB and compute-hours for the same period. Expected
differences: Nango's own plan credit ($50/month), connections created outside
Opengeni, Nango-side retries and syncs, and transfer Nango measures at its
edge (headers, provider-side traffic) that Opengeni does not see. Connections
not deleted after a flip back keep accruing Nango cost but show as inactive in
Opengeni; use the export to find them.

## Limits

- The connect page embeds Nango Connect UI with its documented handshake: it
  waits for `ready`, posts the session token (never in the URL), and handles
  `connect` and `close`. On `connect` it calls the complete endpoint with a
  short backoff; a slow-backoff poll (5 s up to 30 s) stops when the session
  expires or the UI closes.
- The webhook finalizer can store a connection whose page was closed, but it
  cannot resume a tool call waiting on that attempt; the user retries.
- While Nango serves an integration, a native connection superseded by an
  active Nango connection shows status `needs_reauth` with
  `integrationBackendProjection: "superseded"` and is not listed again as an
  account to reconnect. `GET /connections/:id` uses the same projection as the
  list.
