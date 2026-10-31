---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/react": patch
"@opengeni/sdk": minor
---

A workspace's own Codex, SuperGrok or Claude subscription can now serve other shared workspaces and stays that workspace's. Its workspace's admins can add workspaces they also administer and remove any, from the account's "Where it can be used" page; an admin of a workspace it serves sees it as "Shared by" its workspace and can remove it there (new `DELETE /v1/workspaces/:scopeId/model-connections/:kind/:connectionId/access`). Organization admins can choose any shared workspaces for it and it keeps its owner; choosing every shared workspace, Personal workspaces or people now needs an explicit `moveToOrganization: true`, which the organization page confirms as "Move and save". Account summaries gain `ownerWorkspaceId`.
