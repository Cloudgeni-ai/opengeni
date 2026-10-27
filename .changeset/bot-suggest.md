---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": minor
---

The agent can suggest a bot. When a chat is used mostly for the same kind of work, with at least three such requests in a row, `bot_suggest` offers to make it a bot (the agent picks the name, description and avatar and drafts a template) or points to a bot chat or template that already does the work. The suggestion is kept on the chat (`Session.botSuggestion`, migration 1219) and shown as a card; nothing changes until a person acts on it.
