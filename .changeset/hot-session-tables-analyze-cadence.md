---
"@opengeni/db": patch
---

The sessions and session event cursor tables refresh their planner statistics after 50,000 changed rows instead of after a tenth of the table. On a busy deployment they were re-analyzed every few minutes, and each refresh made every connection re-plan its cached session queries. Vacuum cadence is unchanged.
