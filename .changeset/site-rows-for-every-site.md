---
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Every Site is a sidebar row, not only Sites with conversations. A Site sits in the project of the chat that created it, and new Site conversations are filed there too. Opening a Site counts as activity for its row, so Sites in use rise and untouched ones sort down. Adds `recordSiteOpened` to the SDK (`POST /v1/workspaces/:workspaceId/published-artifacts/:artifactId/opened`), returning `SiteOpenedResponse`.

`siteGroups[].conversations` can now be 0. An older `@opengeni/react` rail shows such a row with a "0" count until it is updated.
