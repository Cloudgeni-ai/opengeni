---
"@opengeni/react": patch
---

Fence retained history-navigation callbacks and pending page reads to their owning
session, workspace, client, and replay lifetime. Stale navigation cannot stop a
replacement session's live feed, replace its history, or leave loading stuck.