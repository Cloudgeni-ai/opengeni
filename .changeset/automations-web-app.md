---
"@opengeni/react": minor
"@opengeni/sdk": minor
"opengeni-web": minor
---

Schedules become Automations. An automation runs on a schedule, when matching events arrive, or both. In the web app, the Automations page (formerly Schedules, with the old links redirecting) adds event triggers with only-when conditions, run-once automations, the event runs per hour limit, and Event sources pages to connect GitHub, Slack, Gmail, Linear, Sentry, MCP servers and signed webhooks, with each source's delivery log, replay and test event. Chats that wait for an event show it in the rail and the chat header.

`@opengeni/react/automations` exports the reusable parts: the event trigger editor and summary, the event source tile, delivery and event rows, and the pure models behind them, for hosts that build their own automation pages.

Linear and Sentry event sources can be created before their signing secret is pasted: the source shows `awaitingSigningSecret` and refuses deliveries until the secret is set with `updateEventSource`. REST reads of a source include `viewerAccess` (`manage` or `use`), so a UI can show only the actions the caller may take. Sessions carry `waitingForEvents` when an active automation would continue them on an event.
