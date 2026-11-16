---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Documents, spreadsheets and presentations can now be archived from the Artifacts list. Their ⋯ menu has **Archive…**, which asks first. The archived artifact leaves the list, still opens under the Archived filter, and can no longer be edited. The new `POST /v1/workspaces/:workspaceId/editable-artifacts/:artifactId/archive` route and `client.archiveEditableArtifact` do the same and need `artifacts:publish`.
