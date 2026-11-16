---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Documents, spreadsheets and presentations can now be deleted from the Artifacts list. Their ⋯ menu has **Delete…**, which asks first. Deleting archives the artifact: it leaves the Artifacts list and the chat's artifact panel and no longer opens. The new `POST /v1/workspaces/:workspaceId/editable-artifacts/:artifactId/archive` route and `client.archiveEditableArtifact` do the same and need `artifacts:publish`.
