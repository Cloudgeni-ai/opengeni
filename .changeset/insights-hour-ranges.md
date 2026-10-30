---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/core": patch
"@opengeni/db": patch
---

Insights can show the last hour, the last 3 hours and the last 24 hours, and a custom range now takes a start and end time to the minute. Usage requests accept `range` values `1h`, `3h` and `24h`, and custom `from`/`to` as UTC instants (`YYYY-MM-DDTHH:MMZ`, end exclusive) as well as UTC days (end inclusive). Buckets follow the window length: 5 minutes up to 3 hours, hourly up to 2 days, then daily, so `bucket` can now be `five_minutes`. The prior window is always the same length immediately before. Usage responses list `availableRanges`, the ranges that server serves.
