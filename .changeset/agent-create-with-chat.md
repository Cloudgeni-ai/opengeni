---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Agents are easier to set up. **Add agent ▾ → Create with chat** opens a chat that drafts the agent from a plain description and creates it once the person confirms, using the new bundled `agents` Skill (`builtin:agents`); `bot_template_save` also accepts `toolPermissions` and `skills`. New agents in the form start with short Instructions and ask before merging pull requests. The form and the agent's page offer common triggers as switches: when a pull request opens, when mentioned on a PR, and every weekday morning (`commonAgentTriggers()`).
