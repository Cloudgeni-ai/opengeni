---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Ready-made agents and apps can say what they need: `setup` lists their connections (required or optional, with why), whether they need a repository, one agent they work well with, what they won't do without asking, a first message and a first job. `getAgentTemplateReadiness` and `getAgentReadiness` report, for the caller, which connections are already on, which they may connect, and what keeps it off in words. A ready-made agent's triggers can't be turned on until its required connections are (`agent_setup_incomplete`). No ready-made agent requires another agent any more: hand-offs to PR reviewer or Bug fixer happen only when that agent exists.
