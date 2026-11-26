---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Ready-made agents and apps can say what they need: `setup` lists their connections (required or optional, with why), whether they need a repository, one agent they work well with, what they won't do without asking (each line backed by one of its Can use rules: `{ text, permission, connector, tools }`), a first message and a first job. `getAgentTemplateReadiness`, `getAgentReadiness` and `listAgentReadiness` (every visible agent in one read) report, for the caller, which connections are already on, which they may connect, and what keeps it off in words. A ready-made agent's triggers can't be turned on until its required connections are (`agent_setup_incomplete`), on every path that creates or turns one on. No ready-made agent requires another agent any more: hand-offs to PR reviewer or Bug fixer happen only when that agent exists.
