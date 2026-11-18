---
"@opengeni/db": patch
---

Migration 1490 grants the runtime EXECUTE on the unpaid sandbox fleet counts that 1486 created withheld, so the unpaid fleet running cap, the pressure cap and the daily unpaid box-time budget apply at admission. Readiness now requires the grant. It must reach production only in a release after the one that contains 1486: the previous binary rejects an unknown granted definer.
