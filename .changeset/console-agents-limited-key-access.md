---
"@opengeni/db": patch
---

Console agents: an organization key limited to selected workspaces now sees only its own workspaces in an agent's `workspaceIds`, and a `PATCH` with `workspaceIds` changes only those, keeping the agent's access in other workspaces. Keys for all workspaces and people still replace the whole list.
