---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Sites can be duplicated: `POST /v1/workspaces/:workspaceId/published-artifacts/:artifactId/duplicate` (SDK `duplicateWorkspaceArtifact`) copies a Site's current version (HTML, source and requested tools) into a new Site owned by the caller, with the original's visibility. The copy is titled "… (copy)" unless a title is given; its publication, Site Data and history stay with the original. The copy references the original's immutable stored content instead of copying bytes, and a retry with the same key replays only a copy of the same Site.
