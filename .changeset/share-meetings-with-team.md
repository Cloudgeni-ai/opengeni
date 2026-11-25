---
"@opengeni/contracts": minor
"@opengeni/react": minor
"@opengeni/api-router": minor
"@opengeni/db": minor
---

A meeting recorded in your Personal workspace can be shared with one of your team workspaces (`PATCH …/recordings/:recordingId` with `{ visibility: "workspace", sharedWorkspaceId }`), from any workspace where you see it. Everyone in that workspace can open it read only, and agents there find it with `meetings_search`; `Recording.sharedWorkspaceId` says where it is shared. The meeting page's Share menu lists "Only me" and your team workspaces.
