---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

A person's Only me meetings and files work where they turn them on: in the workspace that stores them and their Personal workspace, plus the other workspaces they pick (`reachWorkspaceIds`, or `null` for all of them). New ones start in those two; meetings and files from before keep working everywhere they did. Meetings change it with `updateRecording`, files with the new `client.updateFileReach` (`PUT /v1/workspaces/:workspaceId/files/:fileId/reach`). The meeting page offers it as **Available in…** when the host passes `reachWorkspaces`, and a file's page offers it in its audience menu while the file is Only me.
