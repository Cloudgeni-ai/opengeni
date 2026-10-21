---
"@opengeni/react": patch
---

A message that waited in the queue behind running work no longer shows that waiting time as "Worked for". When several queued messages were steered in quickly one after another, each turn showed minutes of work even though it ran for about a second. A turn's queue phase now starts when the work ahead of it ended, not when the message was queued.
