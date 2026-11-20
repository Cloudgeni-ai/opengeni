# App data sync

A data sync keeps one collection of an App's (published Site's)
[Site Data](site-data.md) filled from a connected tool, with no model run. On
every run it calls one tool with fixed arguments, reads the records out of the
result, keeps the chosen fields and upserts each record by its key. Prefer it
over a scheduled agent task whenever refreshing data needs no judgment.

## Design

A sync is an ordinary automation (scheduled task) whose action is `app_sync`
(`AppSyncAction` in `packages/contracts/src/app-sync.ts`). Its schedule and
[event triggers](design/automations-and-events.md) start runs like any other
automation, and every run is an ordinary `scheduled_task_runs` row, so it shows
in the automation's run history with its status, error and a `syncSummary`
(`received`, `written`, `skipped`, `truncated`, `people`).

- The worker's scheduled-task dispatch (`apps/worker/src/activities/scheduled-tasks.ts`)
  records the run and enqueues it in `app_sync_queue`, returning
  `handed_off`. It starts no session and no model.
- The API's sync executor (`apps/api/src/app-sync/service.ts`,
  `startAppSyncPump`, every 5 seconds on each replica) claims queued runs with
  a lease, calls the tool through the ordinary workspace tool gateway as the
  person the run is for, and writes through the ordinary Site Data write path.
  The run renews its 5-minute lease after every tool call and every person, so
  a long personal sync is never claimed twice. A run claimed more than three
  times (crashed replicas) settles failed.
- Overlap policy is `skip`, applied by the executor (the worker's hand-off
  finishes at once): claims of one sync are serialized, and a run claimed
  while another run of the same sync holds a live lease settles `skipped`. A
  paused or deleted sync's queued runs settle `skipped`. A manual run
  (`app_sync_run`) works while paused.
- Event-triggered runs need nothing extra: an event occurrence fires the same
  workflow and dispatch. Syncs have no owner column on the task, so only
  workspace event sources can trigger them.

### Shared and personal syncs

- **Shared** (`mode: "shared"`, default) runs as its owner, the person who last
  saved it, on their connection, and writes shared records of a `shared`,
  `shared_read` or `append_only` collection with the principal
  `schedule:<taskId>`. The owner must still manage the App; otherwise the run
  fails and asks a manager to save the sync again. When another manager saves
  it, they become the owner and the sync moves to their own account of the
  same connector.
- **Personal** (`mode: "personal"`) runs once for each person who opted in
  (`app_sync_subscriptions`, at most 200 per run), as that person, on their own
  account of the same connector, never a workspace-shared account (a person
  with only the shared one gets a readable error asking them to connect their
  own), and writes only their own records (`user:<subjectId>`) of a
  `per_viewer` collection. `privateRecords: true` is not required, so an App
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

### Reading records

The result is the tool's `structuredContent`, or the first text part that
parses as JSON. `recordsPath` (dot path) picks the list; without it the result
itself when it is a list, else a common list key (`items`, `results`,
`records`, `data`, …), else its only list. `key` is a dot path to a string or
number key (records without one are skipped); `fields` are dot paths kept
under the same path (omit to keep whole records). The last record with a key
wins. At most 1,000 records per run (`truncated: true` beyond that); writes go
in batches of 100 `put` operations.

### Approvals, access and limits

- Tool approvals apply as for the person: "allow" runs, "block" stays blocked,
  and "ask first" fails the run with a readable error, since nobody can approve
  an unattended run. A tool that needs a connection the person lacks fails
  with "Connect … first".
- Writes use the person's live access to the App: a lost audience stops the
  sync, and an archived App fails its runs with a readable error until it is
  restored. They count in the App's manager write window, are metered
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
| `GET /data/syncs` | each sync's name, collection, mode, `active`, `lastRun` and, for personal syncs, `optedIn` (the viewer's own last run) | anyone who can see the App, including the App's page |
| `GET /syncs` | full definitions, owners, subscriber counts, last runs | managers (`artifacts:read`) |
| `POST /syncs`, `PATCH /syncs/:syncId`, `DELETE /syncs/:syncId` | create, change, delete | managers with `artifacts:publish` and `scheduled_tasks:manage` |
| `POST /syncs/:syncId/run` | run now and return the result | managers with `artifacts:publish` and `scheduled_tasks:run` |
| `PUT\|DELETE /syncs/:syncId/subscription` | opt in to or out of a personal sync | anyone who can see the App |

Published Apps also serve `GET /data/syncs` through the Site runtime. The
management and subscription routes refuse requests from inside an App frame.
Errors use the Site Data error envelope.

- **App page:** `await site.data.syncs()` (`OpenGeniAppSyncStatus[]`).
- **SDK:** `listAppSyncs`, `createAppSync`, `updateAppSync`, `deleteAppSync`,
  `runAppSync`, `setAppSyncOptIn`, `getAppSyncStatus`.
- **Agent tools** (family `artifacts`, session-bound): `app_sync_save`
  (create, or change with `syncId`), `app_sync_list`, `app_sync_delete`,
  `app_sync_run`, `app_sync_opt_in`. An App's own visitor agent can't manage
  syncs.
- The bundled App-building Skill tells agents to prefer a sync over a model-run
  automation for plain data refresh.

## Export and install

[App packages](app-packages.md) use two functions from
`apps/api/src/app-sync/service.ts`:

- `listAppSyncDefinitions(deps, scope, siteId)`: the Site's syncs as plain
  `AppSyncDefinition`s (name, collection, mode, tool, arguments, recordsPath,
  key, fields, schedule and event triggers; no ids, owners or accounts). The
  tool is the connector-level identity, never the author's account route.
  Trigger `sourceId`s name sources in the exporting workspace, so install
  (`apps/api/src/app-sync/package-hooks.ts`) drops them and keeps the schedule.
- `createAppSyncFromDefinition(deps, grant, siteId, definition)`: creates the
  sync **paused**, owned by the installer and pinned to their own account of
  the connector. The installer confirms the account
  by resuming it (`PATCH … {status: "active"}` or `app_sync_save`).

## Storage

Migration `1517_app_data_sync.sql` (rolling): `app_sync` in both action
checks, `scheduled_task_runs.sync_summary`, and two FORCE RLS tables,
`app_sync_subscriptions` (opt-ins with each person's last run) and
`app_sync_queue` (run ids waiting for the executor; the executor lists due
ids across workspaces, then claims each under its workspace's RLS). The
cross-workspace listing is visible only to a connection with no workspace or
account context set. Each queue row carries the run's chain depth, so a run
started by an automation keeps counting toward the chain limit.

## Self-hosting

Nothing extra to configure: the executor runs inside every API replica and
the worker's scheduled-task dispatch queues runs. Syncs need the connected
tools they call (MCP servers or integrations configured in the deployment)
and a running worker with Temporal schedules, as other automations do.

## Not supported yet

- No sync UI on the App page or in the automation form; agents, the SDK and
  the HTTP API manage syncs.
- Site SQL tables as a target; only Site Data collections.
- Removing records the tool no longer returns.
- Opting in from inside the App's page (people opt in in Opengeni or through
  their agent).
- Personal event sources as triggers.
- More than 1,000 records per run or 200 people per personal sync.
- Paging through a tool's results across several calls.

## Tests

- `apps/api/test/app-sync-postgres.test.ts`: shared upsert by key with kept
  fields and no session, failures in run history and the App's status,
  approval errors, personal sync isolation and opt-out, the queue executor,
  export and paused install.
- `apps/api/test/app-sync-records.test.ts`: reading records and fields.
- `apps/worker/test/scheduled-app-sync-handoff.test.ts`: the worker queues a
  sync fire and starts no chat.
