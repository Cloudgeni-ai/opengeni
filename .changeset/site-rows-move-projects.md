---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": minor
---

Site rows in sidebar projects move like chat rows. Their menu has the same "Move to project" list (Default takes the Site out of every project), and a Site row can be dragged onto a project. The move is shared, like a chat's project: the Site and its conversations in that project go to the new one, and the Site stays published and in Artifacts. New `PUT /v1/workspaces/:workspaceId/published-artifacts/:artifactId/channel` (`updateSiteProject` in the SDK) needs `sessions:control` and control of every conversation that moves.
