---
"@opengeni/api-router": minor
---

Organization agents: each turn re-checks that the agent is not archived and still reaches the chat's workspace; otherwise its shared-key tool servers and stored end-user logins are unavailable for that turn. An end user acting through an organization key no longer holds the key's `agents:manage` when changing "Ask first" on the agent's tool servers (403 `agents_manage_required`); the key without an actor still does.
