# App data sync

A data sync keeps one collection of an app's (published Site's)
[Site Data](site-data.md), or one of its [Site SQL](site-data.md#site-sql-optional-cloudflare-storage) tables,
filled from a connected tool, with no model run. On every run it calls one
tool with fixed arguments (page by page when the tool pages), reads the
records out of the result, keeps the chosen fields and upserts each record by
its key; with `removeMissing` it also removes records it wrote that the tool
no longer returns. Prefer it over a scheduled agent task whenever refreshing
data needs no judgment.

## Design

A sync is an ordinary automation (scheduled task) whose action is `app_sync`
(`AppSyncAction` in `packages/contracts/src/app-sync.ts`). Its schedule and
[event triggers](design/automations-and-events.md) start runs like any other
automation, and every run is an ordinary `scheduled_task_runs` row, so it shows
in the automation's run history with its status, error and a `syncSummary`
(`received`, `written`, `skipped`, `truncated`, `pages`, `removed`, `people`).

- The worker's scheduled-task dispatch (`apps/worker/src/activities/scheduled-tasks.ts`)
  records the run and enqueues it in `app_sync_queue`, returning
  `handed_off`. It starts no session and no model.
- The API's sync executor (`apps/api/src/app-sync/service.ts`,
  `startAppSyncPump`, every 5 seconds on each replica) claims queued runs with
  a lease, calls the tool through the ordinary workspace tool gateway as the
  person the run is for, and writes through the ordinary Site Data write path
  (or the Site SQL service for a table).
- **Leases.** Each claim gets a new `lease_token`. The run renews its
  5-minute lease after every tool call (before writing that page), between
  people and before removals, and only while it still holds its claim's token
  and attempt count, so a long personal sync is never claimed twice. When a
  renewal fails, the run makes no further tool call or write and leaves the
  run to the executor that holds it now, which settles it; settling also
  checks the lease. A run claimed more than three times (crashed replicas)
  settles failed.
- Overlap policy is `skip`, applied by the executor (the worker's hand-off
  finishes at once): claims of one sync are serialized, and a run claimed
  while another run of the same sync holds a live lease settles `skipped`. A
  paused or deleted sync's queued runs settle `skipped`. A manual run
  (`app_sync_run`) works while paused.
- Event-triggered runs need nothing extra: an event occurrence fires the same
  workflow and dispatch. Triggers may use workspace event sources and the
  sync owner's own (private) sources: the task has no owner column, so the
  matcher (`AUTOMATION_HEARS_SOURCE` in `packages/db/src/event-trigger-listening.ts`)
  reads the owner from the action. Saving checks the triggers against the
  saver, who becomes the owner; a manager taking over a sync whose triggers
  use the previous owner's private source must choose other triggers.
- A personal sync's run started only by private sources runs only for those
  sources' owners (who must be opted in); a run any workspace source started
  runs for everyone opted in. Chain limit, storm guard and usage limits apply
  as for any event-triggered automation.

### Shared and personal syncs

- **Shared** (`mode: "shared"`, default) runs as its owner, the person who last
  saved it, on their connection, and writes shared records of a `shared`,
  `shared_read` or `append_only` collection with the principal
  `schedule:<taskId>`. The owner must still manage the app; otherwise the run
  fails and asks a manager to save the sync again. When another manager saves
  it, they become the owner and the sync moves to their own account of the
  same connector.
- **Personal** (`mode: "personal"`) runs once for each person who opted in
  (`app_sync_subscriptions`, at most 200 per run), as that person, on their own
  account of the same connector, never a workspace-shared account (a person
  with only the shared one gets a readable error asking them to connect their
  own), and writes only their own records (`user:<subjectId>`) of a
  `per_viewer` collection. `privateRecords: true` is not required, so an app
  can let its managers see everyone's synced records; set it to hide them from
  managers too. One person's failure doesn't stop the others; the run fails
  with "N of M people failed" and each person's last run is kept on their
  subscription.
- People opt in to one tool, arguments, collection and mode. Changing any of
  them clears every opt-in, so a manager can't make subscribers' accounts run
  something else; people opt in again. Renaming or rescheduling keeps them.
- **Which account.** A sync stores the tool as saved (often the saver's account
  route), its connector-level identity (`connectorTool`) and the pairing in
  `declaredTools`. Each run calls the saved route when it is the running
  person's own account, else that person's own account of the connector
  (`resolveAppSyncTool`, built on `connectorToolIdentity` in
  `site-tool-routing.ts`). A tool without accounts runs as itself.
- **Shared service connections.** A shared sync can run on a tool connected
  once for the workspace with a shared key from a vault
  ([Shared service connections](secrets.md#shared-service-connections)): it is
  a workspace-shared account, so an owner without an account of their own uses
  it, and the key is read from the vault only for each call. Personal syncs
  still need each person's own account.
- **Choosing the account.** A person may pick which of their accounts of the
  connector a sync uses: the owner when saving a shared sync (`account`,
  stored as `ownerAccount` in the action), each person when opting in to a
  personal one (`account`, stored on their subscription as
  `account_server_id`). Choosing is optional. Without a choice a sync works
  as before: a shared sync runs on the route it was saved with, else the
  owner's first own account (own before workspace-shared); a personal run
  uses the person's first own account. Opting in without a choice keeps an
  earlier choice while it is still theirs and lists the accounts in
  `accounts` when there are several; the opt-in review lists them too. The
  same owner's later saves, package upgrades included, keep their choice. The
  value is the account's route server id, never part of an exported
  definition. Every run checks a chosen account is still the person's and
  fails readably ("isn't connected anymore") instead of falling back to
  another.

### Reading records

The result is the tool's `structuredContent`, or the first text part that
parses as JSON. `recordsPath` (dot path) picks the list; without it the result
itself when it is a list, else a common list key (`items`, `results`,
`records`, `data`, …), else its only list. `key` is a dot path to a string or
number key (records without one are skipped); `fields` are dot paths kept
under the same path (omit to keep whole records). The last record with a key
wins. Writes go in batches of 100 `put` operations.

### Paging

`paging` reads several pages per run, one tool call each:

- `{ mode: "cursor", cursorPath, cursorArgument }`: after each call the value
  at `cursorPath` in the result is passed as the argument `cursorArgument` of
  the next call. No cursor ends the run; a cursor seen before ends it as
  `truncated`.
- `{ mode: "page", pageArgument, firstPage? }`: the argument counts up from
  `firstPage` (default 1); a page with no new keys ends the run.

`maxPages` (default 10, at most 50) and `maxRecords` (per run, default 1,000,
at most 10,000) bound a run; reaching either marks it `truncated`. Each page
is written before the next call, and the lease is renewed after every call.

### Removing records the tool no longer returns

With `removeMissing: true`, the sync records the keys it writes in
`app_sync_keys` (per person for a personal sync). After a **complete** run
(every page read, nothing truncated, no failure) it deletes the records whose
keys that run didn't see, then forgets them; `summary.removed` counts them.
Only records this sync wrote and is still the last writer of are removed
(for a personal sync only that person's own). A record a person, the app or
an [app webhook](app-webhooks.md#writes-and-change-events) changed after the
sync wrote it is kept, and each delete is fenced on the version read, so a
change in between keeps it too. A table row names no writer, so the ledger
stores a fingerprint of the mapped values the sync wrote, and a row is
removed only while those columns still hold them. A truncated or failed run, a
run that skipped any item (no key), and a run that saw no records at all remove
nothing, so an error body or a renamed key field never empties the target.
Changing the target, key or mode clears the ledger, and so does opting out
(for that person). An upgrade that turns `removeMissing` on, or changes the
arguments, key or target of a sync that has it on, counts as destructive.

### Filling a Site SQL table

A shared sync can fill one of the app's SQL tables instead of a collection:
`target: { table, keyColumn, columns }`, where `columns` maps each column to a
dot path in the record and `keyColumn` gets the record's key. Rows are
upserted by `keyColumn` (it must be the table's primary key or unique; the
gateway's `insert` with `onConflict: "update"` runs
`INSERT … ON CONFLICT (key) DO UPDATE` for the mapped columns only, so other
columns keep their values). Objects and lists are stored as JSON text. Writes
go through `apps/api/src/site-sql/service.ts` (`upsertSiteSqlRowsForSync`,
`deleteSiteSqlRowsForSync`) with the app's SQL limits and metering, and paging
and `removeMissing` work the same. A sync fills either a `collection` or a
`target`; personal syncs need a collection. Saving a table sync where Site
SQL isn't available or not turned on for the app is refused readably. Views
show the table name as `collection` and set `table`. The stored action and
exported definitions keep the table name in `collection` too (so
`collection` stays a string everywhere), which is why a sync's table name
must start with a letter and be at most 64 characters. Saving may leave
`collection` out with a `target`.

### Approvals, access and limits

- Tool approvals apply as for the person: "allow" runs, "block" stays blocked,
  and "ask first" fails the run with a readable error, since nobody can approve
  an unattended run. A tool that needs a connection the person lacks fails
  with "Connect … first".
- Writes use the person's live access to the app: a lost audience stops the
  sync, and an archived app fails its runs with a readable error until it is
  restored. They count in the app's manager write window, are metered
  like other Site Data writes (`site_data.write`, `site_data.write_bytes`) and
  record the run's automation chain depth and ids on the caller, so the event
  chain limit applies to changes a sync makes.
- `app_sync_run` from an automation's agent continues that automation's chain:
  the run's depth is the automation run's depth plus one, and an automation
  already at the limit (`OPENGENI_AUTOMATION_MAX_CHAIN_DEPTH`, 3) is refused.
  An automation woken by a sync's changes therefore can't keep re-running the
  sync: the chain stops at depth 3. Tool calls are metered by the tool
  gateway as today. No session usage limit applies because no session runs.
- Interval schedules run at most every 5 minutes.

## Surfaces

HTTP (`apps/api/src/routes/app-sync.ts`), under
`/v1/workspaces/:workspaceId/published-artifacts/:siteId`:

| Route | Purpose | Who |
| --- | --- | --- |
| `GET /data/syncs` | each sync's name, collection, mode, `active`, `lastRun` and, for personal syncs, `optedIn` (the viewer's own last run) | anyone who can see the app, including the app's page |
| `GET /syncs` | full definitions, owners, subscriber counts, last runs | managers (`artifacts:read`) |
| `POST /syncs`, `PATCH /syncs/:syncId`, `DELETE /syncs/:syncId` | create, change, delete | managers with `artifacts:publish` and `scheduled_tasks:manage` |
| `POST /syncs/:syncId/run` | run now and return the result | managers with `artifacts:publish` and `scheduled_tasks:run` |
| `GET /syncs/:syncId/opt-in` | what a person confirms before opting in: name, tool and connector, their accounts of it, the collection, whether they are in, and why they can't join (`blocked`) | anyone who can see the app |
| `PUT\|DELETE /syncs/:syncId/subscription` | opt in (body `{ account? }`) to or out of a personal sync | anyone who can see the app |

Published apps also serve `GET /data/syncs` through the Site runtime. The
management, review and subscription routes refuse requests from inside an app
frame. Errors use the Site Data error envelope.

- **App page:** `await site.data.syncs()` (`OpenGeniAppSyncStatus[]`), and
  `site.data.syncs.optIn(id)` / `optOut(id)`, which resolve
  `{ syncId, optedIn }` (`optedIn: false` when the person cancels).
- **Opting in from the app's page.** The app only asks: the bridge method
  `syncs.optIn` (ready capability `syncs: 1`) reaches the platform host, which
  shows its own confirmation naming the sync, the tool and connector, the
  account (a choice when the person has several) and the collection, and
  posts the opt-in itself after the person confirms. The console host is
  `packages/react/src/app/lib/app-sync-opt-in.tsx`; the published-app shell
  (`apps/site-gateway/src/shell/shell-entry.ts`) uses the shell-only tool
  methods `sync-review` and `sync-opt-in`, which the app's frame can't reach.
  Leaving needs no confirmation. A direct opt-in from the frame is still
  refused.
- **Join card.** Next to the platform's connect card, both hosts list the
  app's active personal syncs the signed-in member hasn't joined (their own
  component, `AppSyncJoinCard` and `#og-syncs`), one Join button each, which
  opens the same confirmation. Closing it hides those syncs on that device.
- **SDK:** `listAppSyncs`, `createAppSync`, `updateAppSync`, `deleteAppSync`,
  `runAppSync`, `setAppSyncOptIn` (with `{ account }`),
  `getAppSyncOptInReview`, `getAppSyncStatus`.
- **Agent tools** (family `artifacts`, session-bound): `app_sync_save`
  (create, or change with `syncId`), `app_sync_list`, `app_sync_delete`,
  `app_sync_run`, `app_sync_opt_in`. An app's own visitor agent can't manage
  syncs.
- The bundled app-building Skill tells agents to prefer a sync over a model-run
  automation for plain data refresh.

## Export and install

[App packages](app-packages.md) use two functions from
`apps/api/src/app-sync/service.ts`:

- `listAppSyncDefinitions(deps, scope, siteId)`: the Site's syncs as plain
  `AppSyncDefinition`s (name, collection or `target`, mode, tool, arguments,
  recordsPath, key, fields, `paging`, `maxRecords`, `removeMissing`, schedule
  and event triggers; no ids, owners or accounts). The new fields appear only
  when a sync uses them, so older definitions compare as the same JSON. The
  tool is the connector-level identity, never the author's account route.
  Trigger `sourceId`s name sources in the exporting workspace, so install
  (`apps/api/src/app-sync/package-hooks.ts`) drops them and keeps the schedule.
- `createAppSyncFromDefinition(deps, grant, siteId, definition)`: creates the
  sync **paused**, owned by the installer and pinned to their own account of
  the connector. The installer confirms the account
  by resuming it (`PATCH … {status: "active"}` or `app_sync_save`).

## Storage

Migration `1520_app_data_sync.sql` (rolling): `app_sync` in both action
checks, `scheduled_task_runs.sync_summary`, and two FORCE RLS tables,
`app_sync_subscriptions` (opt-ins with each person's last run) and
`app_sync_queue` (run ids waiting for the executor; the executor lists due
ids across workspaces, then claims each under its workspace's RLS). The
cross-workspace listing is visible only to a connection with no workspace or
account context set. Each queue row carries the run's chain depth, so a run
started by an automation keeps counting toward the chain limit.

Migration `1537_app_sync_paging_and_leases.sql` (rolling):
`app_sync_queue.lease_token`, `app_sync_subscriptions.account_server_id` and
the FORCE RLS table `app_sync_keys` (the keys each sync wrote, for
`removeMissing`; ids, keys and a table sync's value fingerprints, no record
data). Its claims leave `lease_token` unchanged, so the new release fences on
the attempt count as well.

Rollback and rolling deploys: the previous release parses a sync's action
strictly. A sync saved without the new options (`target`, `paging`,
`maxRecords`, `removeMissing`, an explicit `account`) is stored in exactly
the previous shape, so the previous release keeps running it. A sync that
uses one of them is unreadable to the previous release: its runs fail and it
is left out of that release's lists until the new release is back (nothing
is deleted). Personal account choices live in a column the previous release
ignores, so its runs use the person's first own account.

## Self-hosting

Nothing extra to configure: the executor runs inside every API replica and
the worker's scheduled-task dispatch queues runs. Syncs need the connected
tools they call (MCP servers or integrations configured in the deployment)
and a running worker with Temporal schedules, as other automations do.
Syncs into SQL tables need Site SQL, which needs the Cloudflare site gateway
(see [Site SQL](site-data.md#site-sql-optional-cloudflare-storage)); without it, saving a table sync is refused and
collection syncs work as before.

## Not supported yet

- No sync UI in the automation form; agents, the SDK and the HTTP API manage
  syncs (people join personal syncs from the app's page or the join card).
- Personal syncs into SQL tables (SQL tables have no per-person rows).
- Other subscribers' own event sources as triggers of a personal sync: a task
  has one owner, so only the owner's private sources (and workspace sources)
  start it.
- More than 10,000 records or 50 pages per run, or 200 people per personal
  sync.

## Tests

- `apps/api/test/app-sync-postgres.test.ts`: shared upsert by key with kept
  fields and no session, failures in run history and the app's status,
  approval errors, personal sync isolation and opt-out, the queue executor,
  export and paused install, cursor and page paging with their bounds,
  `removeMissing` (shared and personal; never after a truncated or failed
  run), a run that loses its lease, account choice, the opt-in review and a
  refused framed opt-in, and owner event sources.
- `apps/api/test/app-sync-sql-postgres.test.ts`: a sync filling a Site SQL
  table in the real gateway Durable Object (Miniflare), upsert by key,
  `removeMissing`, and the refusals.
- `apps/api/test/app-sync-records.test.ts`: reading records and fields.
- `packages/sdk/test/site-bridge-host.test.ts` and
  `packages/react/src/app/lib/app-sync-opt-in.test.tsx`: the opt-in bridge and
  the console's confirmation and join card.
- `apps/worker/test/scheduled-app-sync-handoff.test.ts`: the worker queues a
  sync fire and starts no chat.
