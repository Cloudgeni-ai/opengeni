---
"@opengeni/db": patch
---

Recording model usage no longer slows down as a turn grows. The duplicate-usage check now reads a plain, trigger-filled `usage_source_key` column through a new partial index instead of a payload expression that row-level security prevented from using its index, so each usage append no longer re-reads every earlier usage event of its turn.
