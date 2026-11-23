---
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/react": patch
---

Automations that run an agent with Memory are no longer refused when they start. Microsoft Teams chats with an agent now get its Memory, as Slack and app chats do.
An automation whose agent was deleted or is no longer shared now stops with a clear reason instead of retrying.
