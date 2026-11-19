---
"@opengeni/contracts": patch
"@opengeni/db": patch
---

Console agents keep secrets with the place they were given for: moving a tool server to another origin drops its shared key (unless the same request sets a new one) and deletes end users' stored logins for it, and moving its OAuth token URL to another origin drops the client secret and the stored OAuth logins. Removing an end user from a workspace deletes their stored tool logins there; offboarding them deletes their logins everywhere and their stored display name and email. Organization keys limited to selected workspaces can no longer write tool servers or publish with `moveRunningChats` (403 `organization_key_workspace_limited`).
