---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
---

Ready-made content names the team it is for: `AgentTemplate` has an optional `team`, and new `AppTemplate` content (an app package with a name, a line and a team) is listed by `GET /v1/workspaces/:workspaceId/app-templates` (SDK `listAppTemplates`); add one with `installAppPackage` and its `package`.

`ConnectionInstalled` lists what you have in the same rows as the catalog: logo, name and one status line ("Installed · Workspace"), two columns where there is room. `CapabilityCatalogRow` takes an optional `statusLine` that replaces the description and drops the glyph unless the row needs attention. `ConnectionInstalledItem.showStatus` is deprecated: the status line always shows.
