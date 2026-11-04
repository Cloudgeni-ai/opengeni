---
"@opengeni/db": patch
"@opengeni/observability": patch
"@opengeni/api-router": patch
---

Insights usage no longer fails for every request after a chat's usage rows are deleted out of order. Deleting model call facts whose hourly rollup row was already gone used to store their amounts as a negative rollup row, which made every Insights usage read covering that hour return 500. A delete now subtracts only amounts the group holds; otherwise the group is rebuilt from its facts at commit. Migration 1252 rebuilds every hour that already holds a negative rollup row.

An unexpected API 500 now logs its cause's message (scrubbed of credentials and bounded to 1 KiB) as `causeMessage` in the server log, so the log says why it failed. Responses are unchanged.
