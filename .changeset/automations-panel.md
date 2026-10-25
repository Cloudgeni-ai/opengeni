---
"@opengeni/react": minor
---

`AutomationsPanel` in `@opengeni/react/automations` is a drop-in list, page and form for automations, for hosts that embed chats. Give it the host's `OpenGeniClient` and a workspace, and optionally a chat: in a chat, new automations continue it with its settings; otherwise each run starts a new chat with the workspace's defaults and the owner's access. It turns automations on and off, runs them now, edits and deletes them, and shows recent runs. `eventServers` offers the host's own MCP servers before the person has an event source for them, and `argumentDefaults` fills subscription arguments such as the open project.

Also new: `AutomationForm`, `AutomationWhenField` (a schedule and event triggers, each optional), `EventArgumentsField` (MCP subscription arguments as fields from the event's JSON Schema, with JSON as the fallback), and the pure automation helpers behind them (`automationCreateRequest`, `automationUpdateRequest`, `automationWhenWords`, `automationWhenSentence`, `automationNextRun`, `sortAutomations`, `deriveAutomationName` and others). The trigger editor edits MCP arguments with those fields, and `EventTriggersField` takes `argumentDefaults` and `actions`. The field's "Optional" marker is translated.
