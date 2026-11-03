---
"@opengeni/api-router": patch
---

Slack threads no longer get a pile of identical "Opengeni stopped this task." messages when a chat is archived or cancelled. The notice now posts at most once, only when Opengeni itself stopped the running task, and never when a person stopped it from the app, the API or Slack.
