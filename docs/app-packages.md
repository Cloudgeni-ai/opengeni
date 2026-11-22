# App packages

An app (a Site) can be exported as one package file and installed into another
workspace as a new app. The installed app is a working copy: same version,
same data definitions, empty data (or the author's demo data). Installing
again makes another copy; [upgrading](#upgrade) an app from a newer package
keeps the app and its data and applies only what changed.

Code: `packages/contracts/src/app-package.ts` (format and lenient parser),
`apps/api/src/app-packages/` (export, install, `upgrade.ts`, `exports.ts`
for export file cleanup, and the syncs hook),
`apps/api/src/routes/app-packages.ts`, `apps/api/src/mcp/app-package-tools.ts`,
`packages/react/src/app/components/artifacts/app-package.tsx` (console).

## Format (version 1)

One JSON file, named `<title>.opengeni-app.json`:

| Field | Contents |
| --- | --- |
| `format`, `version` | `"opengeni.app-package"`, `1` |
| `packageId` | The app's id across its packages (see [Provenance](#provenance)) |
| `exportedAt` | ISO time of the export |
| `app` | `title`, `description`, `html` of the current version, its retained editable `source` when it has one, and a [multi-file](published-sites.md) build's `assets` (`{ files: [{ path, base64 }] }`, the same shape as an asset upload) |
| `tools` | The tools the version requests ([requested tools](published-sites.md)), as connector-level entries: the author's account routes become their connector (`connectorToolIdentities` in `apps/api/src/site-tool-routing.ts`) |
| `data.collections` | Site Data collection definitions (name, access mode, schema), no records |
| `sql.migrations` | Site SQL migrations in applied order (`name`, `sql`) |
| `sql.queries` | Site SQL named queries (`name`, `sql`, access, parameters) |
| `syncs` | Data sync definitions, as plain objects (see [Syncs](#syncs)) |
| `sidebar` | The app's links in the workspace's default [sidebar](sidebar-layout.md): each link's `path` and `label`, and the `group` label it sits in. Absent when it has none |
| `demoData` | Only when the author asked: `records` of shared collections (`shared`, `shared_read`), `sqlRows` per table and `files` (the app's shared Site files, see [Files](#files-and-blob-values)). Per-person (`per_viewer`) and submission (`append_only`) collections, and private files, belong to the people who wrote them and are listed in `notExported` |

Limits: 24 MiB per package; demo data at most 1,000 records per collection,
5,000 rows per table, 200 files and 8 MiB in total (files count with their
base64 size); 50 syncs; 10 sidebar links. Parts over a limit are left
out and listed in the export's `notExported`, not a failed export.

Every addition since the first release is optional (`packageId`,
`app.assets`, `demoData.files`, blob values), so older version 1 packages stay readable and the version stays 1.

Install validates leniently: unknown fields are ignored, a newer `version` is
read as far as version 1 goes, and an invalid collection, migration, query,
sync or record is skipped and reported. Only a file that isn't a package at all
(wrong `format`, or no app HTML) is refused, and so is a package whose asset
files are invalid: its HTML loads them, so the copy would be broken. An
invalid `packageId` is ignored.

Asset files count toward the 24 MiB package limit with their base64 size,
before demo data; export checks this from the version's manifest before it
reads any file, and refuses an app whose files don't fit with 413. Install
and upgrade refuse a package over the same 24 MiB, so every installed copy
can be exported again.

## Export

`POST /v1/workspaces/:workspaceId/published-artifacts/:artifactId/package`
(`artifacts:read` and manager of the app, the same check as reading its data
definitions). Body `{ demoData?: true | { collections?, tables?, files? } }`;
without `demoData` the package carries no data, and `true` includes every
shared collection, table and shared file. Returns `{ package, filename, notExported }`.

### Files and blob values

- **Files.** Demo data carries the app's shared Site files (`site.files` with
  `scope: "shared"`), oldest first while they fit the demo budget, as
  `{ id, name, contentType, base64 }`. Private (per-person) files are never
  exported; their count is listed in `notExported`. Install uploads them as
  shared files only into an app with no files yet (so a replay loads nothing
  twice), gives each a new id, and rewrites demo record and row values that
  are exactly an old file id to the new id.
- **Blob values.** A SQL blob in a demo row is the tagged value
  `{ "$base64": "…" }`, the same tag Site SQL JSON exports use. Install loads
  tables with blob values through SQL `INSERT` statements with `X'…'`
  literals, in calls under the import size limit; a row the import refuses is
  reported in `notInstalled`.

## Install

`POST /v1/workspaces/:workspaceId/app-packages/install` (`artifacts:publish`,
like creating an app). Body `{ package, title?, visibility?, demoData?, idempotencyKey }`.
Returns 201 with `{ app, packageId, replayed, installed, notInstalled }`, or 200 with
`replayed: true` when the same key installed it before.

Steps, each reported rather than failing the install:

1. Store the asset files (content-addressed, like an upload; a bad file
   refuses the install before anything exists), then create the app from the
   package's version, with the person as owner. The copy's files get their
   own token. Record the package's `packageId` on the app.
2. Define the collections.
3. If Site SQL is available: enable it, apply the migrations in order (an
   existing migration name is skipped; the first failure stops the rest), then
   define the queries. Otherwise every SQL part is listed in `notInstalled`.
4. Create the syncs, paused, through the syncs hook.
5. Add the sidebar links for the new app: to the workspace default when the
   installer is a workspace admin and the app is shared with the workspace,
   otherwise to their own sidebar. A link
   goes into the group of the same label when there is one, else into a new
   group. Nothing is added when the app already has a link (a replay).
6. Load demo data (default on when the package has some; `demoData: false`
   declines), only into empty collections and tables.

The idempotency key, together with the package's content, makes the app
creation replay: the same key with a different package installs a different
app and never changes the first. The later steps are
idempotent themselves (upserts, skipped existing migrations, demo data only
into empty targets), so a retried install completes a partial one.

The installed app asks each viewer to connect its tools with their own
accounts; nothing from the author's connections is packaged.

## Upgrade

`POST /v1/workspaces/:workspaceId/published-artifacts/:artifactId/package/upgrade`
(`artifacts:publish` and manager of the app). Body
`{ package, dryRun?, allowDestructive?, idempotencyKey? }`. Returns 200 with
`{ app, dryRun, applied, plan, upgraded, notUpgraded }`. Code:
`apps/api/src/app-packages/upgrade.ts`.

A dry run returns only the plan. Applying needs an `idempotencyKey` and
publishes the package's version as a new version of the same app through the
ordinary publish path (the same scans and checks as any publish; the app's
title, sharing and publication stay), and runs only what is new. The plan:

| Part | Lists |
| --- | --- |
| `version` | Whether the HTML, source, tools or asset files differ (`changed` when any does) |
| `package` | `id` (the package's `packageId`) and `current` (the one the app came from), null when unknown |
| `tools` | Tools `added` and `removed`, compared as connector-level entries |
| `collections` | `added`, `changed`, `unchanged`, and `kept`: the app's collections the package doesn't have |
| `migrations` | `applied` (same name and SQL), `new`, `conflicting` (a known name with different SQL) |
| `queries` | `added`, `changed`, `removed` (named queries hold no data), `unchanged` |
| `syncs` | `added`, `changed`, `unchanged`, `kept`, by name |
| `destructive` | Changes that could hide or delete existing data |
| `conflicts` | What stops the upgrade |
| `problems` | Parts that won't apply, and why |

Rules:

- **Another app's package** (its `packageId` differs from the app's) is
  listed in `destructive` and needs `allowDestructive`, like other risky
  changes; the 409 names it. After an applied upgrade the app comes from the
  package.
- **Asset files are checked first.** An invalid file is a conflict in the
  plan (a dry run shows it), so nothing runs.
- **Nothing is deleted.** Collections and syncs missing from the package are
  kept and listed. Records, rows and files stay.
- **Destructive changes need `allowDestructive: true`.** New migrations whose
  SQL could delete, overwrite or rename data (`DROP` of a table or column,
  `ALTER … DROP` or `RENAME`, `DELETE`, `UPDATE`, `REPLACE`, `TRUNCATE`;
  `siteSqlDestructiveChanges` in `packages/contracts/src/site-sql.ts`), and
  changes to what guests of a public app can do. Without it the request is
  refused with 409 and the plan in `error.details.plan`, before anything runs.
- **Conflicts stop it.** A known migration name with different SQL, a change
  of who can read and write a collection that has records (Site Data allows
  that only while it is empty), an archived app, or database changes where
  Site SQL isn't available. The request is refused with 409 and nothing is
  applied, even with `allowDestructive`.
- **Order.** New and changed collections, then the database (turned on if
  needed; new migrations in order, stopping at the first failure, which also
  skips the queries and the new version), new and changed queries, the new
  version, removed queries, then syncs.
- **Retries.** The same key publishes the version once, and every step skips
  what is already done, so retrying completes a partial upgrade. A retry plans
  against the upgraded app, so its `upgraded` lists only what was still left.
- **Syncs** go through the syncs hook (`planUpgrade`, `applyUpgrade`), compared
  by name as stable JSON. New ones are added paused, owned by the upgrader;
  changed ones are saved with only the settings that differ, so each keeps its
  owner, status and event triggers, and the usual rule clears personal
  opt-ins when the tool, arguments, collection or mode change. Saving a sync
  makes the saver its owner, so a changed sync someone else owns stays as it
  is and is listed in `problems`. Both need `scheduled_tasks:manage`.
- **Agents** may only declare tools their chat has: added tools it lacks are
  left out and reported; when it lacks a tool the app already uses, the
  upgrade is refused (upgrade from the console instead).

## Provenance

`workspace_artifacts.package_id` (migration 1548) records the package an app
was installed or last upgraded from. Export writes it as `packageId`; an app
made here exports, and is compared by, a fixed id derived from its own id (a
version 8 UUID), so every export of one app, and of every copy installed from
it, carries the same id. Upgrade compares it (see the rule above); packages
without one aren't checked. The id is a claim the package makes, not a
signature: it guards against mistakes, not a crafted package. A duplicated
app starts without one. A copy installed before migration 1548 has no
recorded id, so its next upgrade asks once to confirm; the upgrade then
records the package's id. The ids are in the install and upgrade responses;
in the console, another app's package shows as a note to confirm.

## Syncs

Packages carry syncs ([App data sync](app-sync.md)) as plain definitions.
`apps/api/src/app-packages/syncs.ts` holds the hook, and
`apps/api/src/app-sync/package-hooks.ts` plugs data sync into it at API
startup:

- Export lists the app's syncs: name, collection, shared or personal, tool,
  fixed arguments, key, kept fields, schedule and event triggers.
- Install needs `scheduled_tasks:manage` (like managing syncs); without it
  each sync is listed in `notInstalled`.
- Install creates each one on the new app **paused**, owned by the installer,
  who confirms the account it runs on by turning it on. Event triggers name
  sources in the exporting workspace, so an installed sync keeps only its
  schedule; add triggers after install. A replayed install finds syncs the
  app already has by name instead of creating them twice. A definition the
  deployment can't read, or one that fails to save, is listed in
  `notInstalled`.

## Agent tools

- `app_export { appId, demoData? }` (`artifacts:read`): stores the package and
  returns a short-lived download link, its filename and a summary of contents.
- `app_upgrade { appId, fileId | package, dryRun?, allowDestructive?, idempotencyKey }`
  (`artifacts:publish`; `files:read` to read `fileId`): plans and applies an
  [upgrade](#upgrade). Agents dry-run first, tell the person the plan, and pass
  `allowDestructive` only with their explicit agreement.
- `app_install { fileId | package, title?, visibility?, demoData?, idempotencyKey }`
  (`artifacts:publish`; `files:read` to read `fileId`): installs and returns
  the app with an `[Open app](artifact:…)` reference and `notInstalled`.
  An agent can only declare tools its chat has (directly, or through its own
  account for the tool's connector); each other packaged tool is left out and
  reported by name. Installing from the Apps page keeps them all.

## Console

The Sites tab of Artifacts has **Install app** for people who can publish:
choose a package file, optionally include its demo data, Install. The new app
opens. An app's "…" menu has **Export app** (no data) and **Upgrade from
package** for its managers: choose a package file, see the plan, Upgrade.
Destructive changes need an explicit confirm; conflicts can't be upgraded.

## Export file cleanup

`app_export` stores each package file in object storage for the agent to
download. Before storing it, the API records it in `app_package_exports`
(migration 1542) with an expiry of 24 hours. An API pump
(`startAppPackageExportSweepPump` in `apps/api/src/app-packages/exports.ts`,
every 60 seconds on each replica) finds expired rows, claims each one under
its workspace's row-level security, deletes the object, then the row. A
failed delete keeps the row with its error and retries later with backoff
(from a minute, doubling, up to a day). Deleting a workspace deletes its
recorded export objects.

## Ready-made apps

`GET /v1/workspaces/:workspaceId/app-templates` (`artifacts:read`; SDK
`listAppTemplates`) lists ready-made apps: content files in
`packages/core/src/app-templates/*.app.json` (schema `AppTemplate`: `key`,
`name`, `description`, `team` and a `package`). A file that isn't a valid
package, or whose package has problems, is skipped. Four ship, in this
order: Issue tracker, Incident log, Feedback board and Decision log. Each
keeps its records in Site Data, so it works right after it is added (Feedback
board's votes are a `per_viewer` collection). Capabilities **Ready-made** and
the Artifacts page (its **Apps** tab, and its empty state) offer them; both add
one by installing its `package` through the ordinary install above, keyed
`ready-made:<key>` so adding it again opens the same app (an archived one is
added fresh), then open the app, which asks to connect any tool it uses.
Ready-made apps built on a connected tool (a Linear or GitHub board) come
later, with app server code.

## Self-hosting

- Site SQL needs the Cloudflare Sites gateway. Without it, exports have no SQL
  demo rows and installs skip migrations and queries, reported in `notInstalled`.
- `app_export` needs object storage to hand the file to the agent; the API
  sweeps those files after 24 hours. The HTTP export returns the package
  directly. Upgrades need object storage to read the app's current version.
- Not packaged anywhere: private files, records and files past the demo
  limits, publication settings, sharing and tool allowances. Upgrades never
  change these.
- Packages carry no stable package id: an app doesn't record which package it
  came from, so any package can be offered as an upgrade of any app, and the
  plan shows what would change.
