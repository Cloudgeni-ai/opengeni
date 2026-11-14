---
"@opengeni/db": patch
---

Microsoft Teams (with workspace routing): addressing an agent by name (`Name: …`, `Name, …` or `+name`) or the main assistant (`<App name>: …`) now sends that one message, like `in <Workspace>: …`, and no longer changes the chat's stored choice; only **switch** does. A one-off to an agent continues the person's chat with that agent and keeps its "**Agent** · Workspace" header; an app-name one-off's replies carry the "**Workspace**" header. A name on its own no longer switches the chat: it replies how to ask once, or to send **switch <name>** (or **switch** and pick it when a workspace has the same name). An app-name message with no default workspace to go to keeps only the message on the switch card. Feedback on an organization agent's reply, recorded as the agent, now keeps the person who rated it in the report's server-only diagnostics (`onBehalfOf.subjectId`; `createFeedback` accepts `onBehalfOf`).
