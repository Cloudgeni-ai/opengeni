---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
---

Ready-made content names the team it is for: `AgentTemplate` has an optional `team`, and new `AppTemplate` content (an app package with a name, a line and a team) is listed by `GET /v1/workspaces/:workspaceId/app-templates` (SDK `listAppTemplates`); add one with `installAppPackage` and its `package`. `GET /v1/workspaces/:workspaceId/skills/library` (SDK `listLibrarySkills`) lists every reviewed library skill to add, `enabled` once added.

`ConnectionInstalled` lists what you have in the same rows as the catalog: logo, name and one status line ("Installed · Workspace"), two columns where there is room. `CapabilityCatalogRow` takes an optional `statusLine` that replaces the description and drops the glyph unless the row needs attention. `ConnectionInstalledItem.showStatus` is deprecated: the status line always shows. The `.og-connection-installed-status` and `.capability-search-section` classes are removed. Embedding products that style these rows see a visible change; the row buttons no longer carry an `aria-label`, so their visible text is their name. Catalog rows carry `data-row-status` for styling; `data-status` is on the row only when it shows no indicator.
