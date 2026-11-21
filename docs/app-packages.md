# App packages

An app (a Site) can be exported as one package file and installed into another
workspace as a new app. The installed app is a working copy: same version,
same data definitions, empty data (or the author's demo data). There are no
upgrades; installing again makes another copy.

Code: `packages/contracts/src/app-package.ts` (format and lenient parser),
`apps/api/src/app-packages/` (export, install and the syncs hook),
`apps/api/src/routes/app-packages.ts`, `apps/api/src/mcp/app-package-tools.ts`,
`packages/react/src/app/components/artifacts/app-package.tsx` (console).

## Format (version 1)

One JSON file, named `<title>.opengeni-app.json`:

| Field | Contents |
| --- | --- |
| `format`, `version` | `"opengeni.app-package"`, `1` |
| `exportedAt` | ISO time of the export |
| `app` | `title`, `description`, `html` of the current version, and its retained editable `source` when it has one |
| `tools` | The tools the version requests ([requested tools](published-sites.md)), as connector-level entries: the author's account routes become their connector (`connectorToolIdentities` in `apps/api/src/site-tool-routing.ts`) |
| `data.collections` | Site Data collection definitions (name, access mode, schema), no records |
| `sql.migrations` | Site SQL migrations in applied order (`name`, `sql`) |
| `sql.queries` | Site SQL named queries (`name`, `sql`, access, parameters) |
| `syncs` | Data sync definitions, as plain objects (see [Syncs](#syncs)) |
| `sidebar` | The app's links in the workspace's default [sidebar](sidebar-layout.md): each link's `path` and `label`, and the `group` label it sits in. Absent when it has none |
| `demoData` | Only when the author asked: `records` of shared collections (`shared`, `shared_read`) and `sqlRows` per table. Per-person (`per_viewer`) and submission (`append_only`) collections belong to the people who wrote them and are listed in `notExported` |

Limits: 24 MiB per package; demo data at most 1,000 records per collection,
5,000 rows per table and 8 MiB in total; 50 syncs; 10 sidebar links. Parts over a limit are left
out and listed in the export's `notExported`, not a failed export. SQL tables
with blob values are left out of demo rows.

Install validates leniently: unknown fields are ignored, a newer `version` is
read as far as version 1 goes, and an invalid collection, migration, query,
sync or record is skipped and reported. Only a file that isn't a package at all
(wrong `format`, or no app HTML) is refused.

## Export

`POST /v1/workspaces/:workspaceId/published-artifacts/:artifactId/package`
(`artifacts:read` and manager of the app, the same check as reading its data
definitions). Body `{ demoData?: true | { collections?, tables? } }`; without
`demoData` the package carries no data. Returns `{ package, filename, notExported }`.

## Install

`POST /v1/workspaces/:workspaceId/app-packages/install` (`artifacts:publish`,
like creating an app). Body `{ package, title?, visibility?, demoData?, idempotencyKey }`.
Returns 201 with `{ app, replayed, installed, notInstalled }`, or 200 with
`replayed: true` when the same key installed it before.

Steps, each reported rather than failing the install:

1. Create the app from the package's version, with the person as owner.
2. Define the collections.
3. If Site SQL is available: enable it, apply the migrations in order (an
   existing migration name is skipped; the first failure stops the rest), then
   define the queries. Otherwise every SQL part is listed in `notInstalled`.
4. Create the syncs, paused, through the syncs hook.
5. Add the sidebar links for the new app: to the workspace default when the
   installer is a workspace admin, otherwise to their own sidebar. A link
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
- `app_install { fileId | package, title?, visibility?, demoData?, idempotencyKey }`
  (`artifacts:publish`; `files:read` to read `fileId`): installs and returns
  the app with an `[Open app](artifact:…)` reference and `notInstalled`.
  An agent can only declare tools its chat has (directly, or through its own
  account for the tool's connector); each other packaged tool is left out and
  reported by name. Installing from the Apps page keeps them all.

## Console

The Sites tab of Artifacts has **Install app** for people who can publish:
choose a package file, optionally include its demo data, Install. The new app
opens. An app's "…" menu has **Export app** (no data) for its managers.

## Self-hosting

- Site SQL needs the Cloudflare Sites gateway. Without it, exports have no SQL
  demo rows and installs skip migrations and queries, reported in `notInstalled`.
- `app_export` needs object storage to hand the file to the agent; stored
  packages are not swept automatically. The HTTP export returns the package
  directly.
- Not packaged anywhere: Site files (`site_files`), records past the demo
  limits, SQL blob values, publication settings, sharing and tool allowances.
- No upgrades of an installed app from a newer package.
