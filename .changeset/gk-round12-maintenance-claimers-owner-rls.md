---
"@opengeni/db": patch
---

Browser state cleanup, Memory Slack delivery, Slack App Home refresh, Slack inbox processing and legacy Modal checkpoint migration now find their work when the database owner does not bypass row security, the posture in docs/deployment.md. Before, their claimers found nothing there. Each call opens its own maintenance claim, which only the routine's owner can use and which ends with the call; results under an owner that bypasses row security are unchanged.
