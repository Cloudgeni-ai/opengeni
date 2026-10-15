---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Keep old-reader-compatible Site profiles without a locked backfill. Couple non-member session execution to metered spend plus funded reservations, and fund top-ups before further execution. Correct legacy three-window reservation release, revalidate current viewer audience for every Site data-tool call, and retry old member cap removal after transient failures.
