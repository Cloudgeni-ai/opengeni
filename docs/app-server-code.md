# App server code

An app (a published Site) can carry server code: JavaScript modules that
ship with an app version and run on Opengeni when the app's page calls
`site.server.fetch`. The code runs **as the app, never as the viewer**:

- tool calls use only the workspace's shared connector accounts, never a
  viewer's (or the publisher's) personal connection;
- outbound `fetch` may carry workspace vault secrets the version lists, in
  request headers, resolved on the server;
- app data calls read and write shared collections as the app.

So a member without their own Linear connection sees the same Linear issues
as everyone else, an app can use an API key without exposing it, and writes
and rules run where the page can't skip them. Scheduled refreshes and inbound
events stay with [data syncs](app-sync.md) and [app webhooks](app-webhooks.md);
server code serves requests from the app's page.

Code: `packages/contracts/src/app-server.ts` (schemas, limits),
`packages/db/src/app-server.ts`, `apps/api/src/app-server/` (service, run
token), `apps/api/src/routes/app-server.ts`, the `server.fetch` operation and
host route in `apps/api/src/routes/site-runtime.ts`,
`apps/api/src/mcp/app-server-tools.ts`, `apps/site-gateway/src/app-server.ts`,
`packages/sdk/src/site-server.ts`, migration `1553_app_server_code.sql`.

## Setup

People set it up only by asking in the app's chat: the agent writes the code,
uploads it with the app and publishes (the bundled sites Skill's
`references/server-code.md`). The console shows managers one line in the app
header when there is something to act on: `Server code: 2 errors today`, or
`Server code: not available here`.

A deployment runs server code when all of these hold:

| Setting | Purpose |
| --- | --- |
| `OPENGENI_SITES_SERVER_CODE_ENABLED=true` | Turns the feature on (off by default). |
| Site gateway with a `LOADER` binding (`[[worker_loaders]]`, Workers Paid) | Runs the code in Cloudflare Dynamic Workers. |
| `SITES_GATEWAY_INTERNAL_ORIGIN`, `SITES_GATEWAY_SECRET`, `SITES_DOMAIN` | The API reaches the gateway's signed internal route, and the gateway calls back. |
| Object storage | Stores the code by content. |

Without them, publishing a version with server code is refused, and an app
that already has code reports `app_server_unavailable`.

## Versions

The uploaded bundle is JSON `{main, files: [{path, content}], tools?,
egress?, secrets?}` (`server` upload from `artifacts_prepare_upload`).
Publishing freezes it into a manifest on the version (`workspace_artifact_versions.
server_manifest`): the main module, each file's path, SHA-256 and size,
the tools, the egress hosts, the listed secrets and a digest over all of them. Files are
stored once per workspace by content
(`workspaces/<workspace>/app-server-files/<sha256>`).

- A publish without a server upload keeps the current version's code; an
  upload of `{"files": []}` removes it.
- Rolling back the app rolls back its code: a run always uses the current
  version's manifest.
- Duplicating an app copies its code.
- `artifacts_get_source` returns the version's files as download URLs, so an
  agent edits and republishes the whole bundle. The code is not secret.
- Listing vault secrets needs a workspace integration admin with
  `secrets:use`, egress hosts, and each secret must resolve for one of them
  when publishing. Publishing refuses code that contains a listed secret's
  value (an agent sandbox fills in unescaped references in files it writes).
  Since a rollback or a duplicate makes its actor the deployer without a
  publish, a run also requires the deployer to be such an admin while the
  version lists secrets (`deployer_cannot_use_secrets`).
- Code that declares `tools` and lists egress hosts could send tool data
  out of the workspace, so it needs the same admin to publish, and its
  deployer must stay one for it to run (`deployer_cannot_send_tool_data_out`).
- Every publish goes live for all viewers; there is no draft run. Managers
  try a version with `app_server_run` and roll back if needed.

App packages don't carry server code yet: installing one drops it, and the
installer publishes the code again.

## Running a request

1. The page calls `site.server.fetch(path, init)` (the `server.fetch` Site
   operation, `POST .../published-artifacts/current/server`) or a member's
   console calls `POST /v1/workspaces/:ws/published-artifacts/:id/server`.
   The caller must be able to open the app (the same check as app data);
   a Site frame may call only its own app.
2. The API starts the run under the rate limits: an `app_server_runs` row
   inserted as `running` (per app 300 a minute, per viewer 60, all guests together 150; a guest's
   runs also count against the guest write limit per visitor and client
   address). It checks the deployer's authority (below), loads the current
   version's manifest and files (checking each SHA-256), mints a run token
   bound to the account, workspace, app, version, run id and deadline (HMAC
   keyed from the gateway secret), and posts the run, code included, to the
   gateway's signed internal route `/_og/internal/app-server/<siteId>/run`.
3. The gateway loads the code with the Worker Loader, keyed by app, version
   and digest. The isolate has `globalOutbound: null` (no network), a CPU
   limit and a wall-clock deadline. Its only binding is `HOST`, a loopback
   entrypoint pinned to that app and version.
4. Inside, a setup module (evaluated before the app's modules) routes
   `console` and the global `fetch` to the request being served; a wrapper
   builds `env` for the request (`viewer`, `app`, `trigger`, `runId`,
   `tools`, `data`, `fetch`) and answers with the logs so far at the
   deadline. These in-isolate limits are advisory, since the app's code runs
   in the same isolate: the gateway and the API read the result bounded.
5. Each call goes through `HOST` to the API's
   `POST /app-server/<siteId>/<versionId>/host` on the sites apex, with the
   run token. The API checks the token matches the app and version, counts
   the call on the live run (refusing it once the run has ended or made 50
   calls), checks the version is still current and the deployer's authority
   (kept for the run on the API process that started it), then runs the call.
6. The API finishes the run's row (status, HTTP status, duration, error,
   logs) and returns the response to the page. `Set-Cookie` and hop-by-hop
   headers are dropped.

The viewer the code sees (`env.viewer`) is who called: `user:<subject>` for a
signed-in person or `guest:<visitor>` for a public visitor, with their kind
(`member`, `invited`, `user`, `guest`). Only their identity reaches the code;
their credentials never do.

## Authority

Calls run on the app's own principal `server:<appId>` at manager level on
shared data, as long as the person who published the current version is
still a live member who manages the app. If they lose that, the code pauses
with `deployer_cannot_manage` until a manager publishes again; runs stop
before the code starts, and the status line says so.

### Who may run it

Code that calls tools or uses vault secrets reaches the workspace's shared
accounts, so Opengeni enforces, from the verified viewer and whatever the
app's sharing setting:

- **At run start**, the viewer must be a signed-in, live member of the app's
  workspace. Guests, invited people, other signed-in users and API keys get
  `not_permitted` and the code doesn't start (no run is recorded).
- **On each tool call**, the shared account route the call uses must be in
  the viewer's own tool inventory (the connection reaches them as it would in
  their chats), or the account-less server must be configured for them.
- **On each fetch that carries a vault secret**, the viewer must hold
  `secrets:use`.

The run's viewer is recorded on its row at start, and calls back read it
from there, never from the code. Code without tools or secrets keeps the
app's usual access rules.

### Stored tool data

The same rule holds for what is stored. Before a shared app sync run, or a
run of code with tools or secrets, writes a collection (or, for a sync, the
app's SQL database), the API marks the target in `site_tool_data_sources`
with the connector and account route the data came from (`vault` for
secrets). Marks only grow, and apps can't change them. A live (or deleted)
shared sync also counts from its definition, so syncs saved by
earlier releases are covered before their next run, with no backfill.

Every read of a marked target needs a signed-in, live member of the
workspace. A route that is a workspace-shared account needs that same route
in the member's own tool inventory; any other route needs an account of the
same connector (or the account-less server); `vault` needs `secrets:use`.
This covers Site Data query, get and export, Site SQL queries, statements
and export (the whole database: SQL can join any table), the published app's
agent tools, and server code's own data reads, which are checked against the
run's viewer. Writes need the same reader, since they answer with the stored
records. App packages leave marked collections and a marked database out of
their demo data. Guests, invited people and other users get a refusal naming
the connector, whatever the collection's guest access or the app's sharing
setting says. A member's inventory is kept for 30 seconds per API process.
App webhooks store payloads that outside services push in, not
shared-account data, so they don't mark. The publication readiness check
shows managers one line per affected collection or database.

- **Tools** (`env.tools.call`): only tools the server bundle lists in
  `tools` (separate from the page's `requestedTools`, which run as the
  viewer), routed to a connector account shared with the workspace. A
  personal account route is redirected to the shared one; without a shared
  account the call fails with `shared_account_required`. A server without
  accounts is allowed only when the workspace configures it with no
  connection at all: first-party servers (Opengeni, files, docs),
  host-authority connections and servers enabled from the capability
  catalog (which may carry a person's credentials) are refused. Tool
  arguments may not contain vault references. The tool gateway call itself
  uses the deployer's workspace grant, as a shared app sync does.
- **Data** (`env.data`): shared, shared_read and append_only collections;
  `per_viewer` collections are refused, since the code isn't a viewer.
- **Fetch**: HTTPS on the default port to hosts in the version's `egress`,
  public addresses only (private networks are refused whatever integrations
  allow), no redirects followed. Vault references may appear only in header
  values and only for secrets the version lists; they resolve with the
  workspace's own reach, never a person's, and the vault's use record names
  the app and version.

## Limits

| Limit | Value |
| --- | --- |
| Run time (wall clock) | 30 s |
| CPU per run | 5 s |
| Calls to tools, data and fetch per run | 50 |
| Request body / response body | 1 MB / 4 MB |
| Outbound response body / timeout | 4 MB / 15 s |
| Code | 1 MB in at most 50 files |
| Egress hosts / secrets per version | 20 / 20 |
| Runs per app / per viewer per minute | 300 / 60; all guests together 150 (guests also meet the guest write limit) |
| Logs kept per run | 8,000 characters |
| Runs kept | 14 days |

## Managing

- `GET .../published-artifacts/:id/server/status`: has code, available,
  paused (and why), today's runs and errors, whether the newest run failed,
  last error, tools, egress and secrets (managers, not from inside the
  app's frame). The console's one line shows while the newest run fails, the
  code is paused or the deployment can't run it, and opens the app's chat.
- `GET .../published-artifacts/:id/server/runs?limit=&status=&before=`:
  recent runs with logs and errors. For a version whose code uses tools or
  secrets, a manager who can't use each of them (the stored tool data rule)
  gets the runs without logs, errors or the request's path and query.
- Agent tools: `app_server_runs` (status and runs) and `app_server_run`
  (one manual request as the calling manager, with its logs).
- SDK: `getAppServerStatus`, `listAppServerRuns`; in the page,
  `site.server.fetch`.

## Self-hosting

Server code needs Cloudflare Dynamic Workers. A deployment without the
gateway's `LOADER` binding keeps every other app feature; publishing server
code is refused while the setting is off.
