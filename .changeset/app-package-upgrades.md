---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/react": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
---

Upgrade an existing app from a newer package of it: a dry run returns the plan (new version, tools, collections, migrations, queries and syncs), and applying it publishes the package's version as a new version of the same app and runs only what is new. Nothing is deleted; destructive changes need `allowDestructive: true` and conflicts stop the upgrade. Adds `POST /v1/workspaces/:workspaceId/published-artifacts/:appId/package/upgrade`, `upgradeAppPackage` in the SDK, the `app_upgrade` agent tool and Upgrade from package in the app's menu. Package demo data now carries the app's shared files (`demoData.files`) and SQL blob values (`{ "$base64": "…" }`), and package files `app_export` stores are deleted after 24 hours. Older packages stay readable. See docs/app-packages.md.
