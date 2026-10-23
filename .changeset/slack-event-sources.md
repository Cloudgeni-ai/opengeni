---
"@opengeni/sdk": patch
---

`createEventSource({ kind: "slack" })` now adds the workspace's Slack event source: automations can trigger on messages, thread replies, edits, deletions, reactions and channel joins in the channels the Opengeni Slack app is in. Direct messages with the app are never recorded.
