---
"@opengeni/sdk": patch
---

`createEventSource({ kind: "gmail" })` now adds a Gmail event source for the caller's connected mailbox: automations can trigger on new inbox messages (`message.received`) with sender, recipients, subject, labels and a snippet. Opengeni reads the mailbox history about once a minute while an automation listens, so no Pub/Sub setup is needed. The source is private to its owner.
