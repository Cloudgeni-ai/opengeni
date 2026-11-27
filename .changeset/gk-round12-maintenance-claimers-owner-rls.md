---
"@opengeni/db": patch
---

Browser state cleanup, Memory Slack delivery, Slack App Home refresh, Slack inbox processing and legacy Modal checkpoint migration now find their work when the database owner does not bypass row security, the posture in docs/deployment.md. Before, their claimers found nothing there. Each call opens its own maintenance claim, which only the routine's owner can use and which ends with the call.

A routine opens that claim only when row security applies to its owner, and the two wake repair inventories now do the same. Under an owner that bypasses row security (production's), these calls write no claim row and assign no transaction id, so an empty poll stays read-only, and their results are unchanged.
