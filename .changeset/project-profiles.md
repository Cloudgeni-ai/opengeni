---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/runtime": patch
---

Projects get a profile like a chat's: a description and an avatar (an emoji, icon or letters on a colour, or a workspace image). The avatar replaces the folder icon in the sidebar, the new-chat project picker and the Move to project lists, and pointing at a project shows its description. **Edit project…** in the project's menu replaces **Rename project** and opens the same dialog as a chat's **Edit profile…**. `Channel` gains `avatar`, `POST`/`PATCH /v1/workspaces/:workspaceId/channels` accept it, and agents set it with `project_create` and `project_update`. Changing it needs the same permission as a rename, and an image avatar must be shared with the workspace.
