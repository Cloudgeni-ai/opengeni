---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Connect a machine just for yourself. `mintEnrollToken(workspaceId, { scope: "user" })` mints a one-machine command whose machine only the signed-in person can use, in every workspace they can open; `scope: "workspace"` (the default) shares it with the workspace as before. Only an authenticated person can mint a personal command (API keys, services and agents get `422`), the owner is always the caller, and the machine is created only if that person is still a member when the command runs. The response now says which `scope` and `allowScreenControl` it granted; an older server omits `scope` and mints a workspace command, so check it before showing a personal command. Machine cards label access as "Only me", "Workspace" or "Organization" (`machineScopeLabel`). In the web app, the Machines page and the chat's machine card share one Connect a machine dialog: choose who can use it (Only me by default), screen control (off by default) and Mac, Linux or Windows, copy one command, and the same dialog confirms the connected machine, with Use in this chat from a conversation.
