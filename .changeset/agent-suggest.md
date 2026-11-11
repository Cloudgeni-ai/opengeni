---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": minor
---

The agent can suggest an agent. When a chat is used mostly for the same kind of work, with at least three such requests in a row, `agent_suggest` offers to make an agent from it (the agent picks the name, description and icon and drafts its Instructions) or points to an agent that already does the work. The suggestion is kept on the chat (`Session.agentSuggestion`, migration 1361) and shown as a card; **Make this an agent…** opens the usual form filled in from the draft. Nothing changes until a person acts on it.
