---
"@opengeni/db": patch
---

Subscription authorization costs what one check costs. Policies that let organization administrators manage subscription connections now ask the administrator check once per statement instead of once per row, with the same answers. Turn-scoped subscription capability rows are reclaimed when their backend next grants one, so the capability table no longer grows with every accepted turn; rows left by finished transactions are purged once.
