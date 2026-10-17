---
"@opengeni/db": patch
---

Maintain hourly model-usage aggregates transactionally and backfill historical hours in independently committed batches. Insights usage reads aggregate complete hours and scan only ragged edges, preserving billing, visibility, filters and response semantics.
