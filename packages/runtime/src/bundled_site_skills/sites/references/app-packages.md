# Move an app to another workspace

`app_export { appId }` writes one package file of the app's current version:
its HTML and editable source, requested tools, Site Data collection
definitions, Site SQL migrations and named queries, syncs and its sidebar
links. It holds no data
unless you pass `demoData` (`true`, or `{ collections, tables }`), which adds a
bounded sample (`true` also includes the app's shared files; private files are
never included). Use demo data only when the user wants the copy to start with
examples. It returns a download link and what was left out (`notExported`).

`app_install { fileId | package, idempotencyKey }` installs a package file into
the current workspace as a new app: empty data (or the package's demo data
unless `demoData: false`), migrations applied, queries and collections defined,
syncs created paused, sidebar links added (the default sidebar for admins,
otherwise the installer's own). Pass a fresh `idempotencyKey`; repeating it returns the
same app. Give the user the returned `artifactReference` and say what
`notInstalled` lists (for example no database on this deployment, or tools this
chat doesn't have). The installer connects the app's tools with their own
accounts when they open it.

Installing again makes another copy. To update an existing app from a newer
package instead, use `app_upgrade { appId, fileId | package, idempotencyKey }`.
Call it with `dryRun: true` first and tell the user the plan: the new version,
new collections, migrations, query and sync changes. It never deletes data;
collections and syncs the package lacks are kept. Pass `allowDestructive: true`
only after the user explicitly agrees to the changes listed as `destructive`.
`conflicts` stop the upgrade; explain them instead of retrying.
