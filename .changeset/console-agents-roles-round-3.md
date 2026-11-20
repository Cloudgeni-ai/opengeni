---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Console agents roles: Editors can't save drafts of, publish or roll back an agent that an owner or admin made available in team workspaces (403 `agent_in_team_workspaces`; Console shows it read-only for them). Counting the chats a publish would move needs Editor (or `agents:manage` for keys), and only callers who may publish re-drive a stalled move when listing publish operations; a start error there leaves it pending. Console roles and an agent's team workspaces are written only from the organization's account context.
