---
"@opengeni/db": patch
---

Read repairable usage-event keys once per missing turn instead of repeatedly scanning event history under row-level security. Let concurrent index migrations finish their safe wait for older snapshots without the ordinary DDL lock timeout.
