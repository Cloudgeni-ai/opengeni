---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Ask an admin on the Enable page now sends a real request: `client.requestSetupConnection(workspaceId, { provider, name, returnPath })` puts a "Connect X" notice in the inbox of the workspace's admins with a link back to the same Enable step, and returns `{ status: "requested", adminsAsked }`, or `{ status: "already_asked" }` while that request is still open. When the server can't send requests yet it returns `{ status: "unavailable" }` and the page falls back to copying the link.
