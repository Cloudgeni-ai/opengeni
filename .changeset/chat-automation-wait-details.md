---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/react": patch
---

A chat that an automation will post into now says what it is waiting for. Sessions and session list entries carry `automationWait` (`nextRunAt`, the `event` with its `source` and `eventTypes`, and how many `automations` wait), and the lineage read carries `sessionAutomationWait`, for readers who may see schedules. Only automations the reader can see count, and a source that is private to someone else stays unnamed. `sessionAutomationWaitWords(t, session, { now })` from `@opengeni/react/automations` turns it into a sentence ("Waiting for deploy.finished from Deploys. Next run: Tomorrow, 09:00") and a chip label ("Waiting on Deploys"), and falls back to the plain "Waiting for an event" or "On a schedule" for servers without the details. The sidebar mark, hover card, command menu and chat header use it.
