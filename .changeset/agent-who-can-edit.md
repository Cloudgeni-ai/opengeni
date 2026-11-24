---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Shared agents have a **Who can edit** setting: "Creator and admins" or "Everyone in workspace". New agents default to everyone in the workspace, and existing agents keep today's rule. Agents gain `editAccess` and `viewer.canManage`, and `createAgent`/`updateAgent` accept `editAccess`. The ready-made PR reviewer can now be set to review a pull request in one click when someone on the team mentions it there. When a pull request event's automation run is refused before it starts, Opengeni says why in a comment on that pull request.
