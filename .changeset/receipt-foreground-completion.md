---
"@opengeni/api-router": patch
---

Acknowledge command-completion notifications when their exact operation has no adopted background-command row, so retained foreground results do not repeat the same database lookup every heartbeat. This is a notification receipt only: output retention, verified settlement and output release are unchanged. Exits racing adoption normally settle through the adopter's attached stream; if that path fails, the existing periodic reconciliation and inventory paths recover the result.
