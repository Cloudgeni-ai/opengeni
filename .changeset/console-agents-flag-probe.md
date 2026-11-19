---
"@opengeni/contracts": minor
"@opengeni/react": minor
"opengeni": minor
---

Console reads whether organization agents are on from `GET /v1/organizations/:id/console/access` (`orgAgentsEnabled`), so an organization without them makes no failing agent requests. `Session.orgAgent` carries the agent's `name`, and the chat header shows it. Console test chats no longer count toward an agent's chats, usage and cost, or appear in the Console Sessions list. CLI: `agents deploy --dry-run` reports `would create vN` or `unchanged vN`.
