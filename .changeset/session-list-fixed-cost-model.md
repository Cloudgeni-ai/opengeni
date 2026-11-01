---
"@opengeni/db": patch
---

Full session list pages (`listSessionsForSubject`, behind `GET /v1/workspaces/{id}/sessions` without the compact projection) now name each row's model the way compact pages already do: two fixed index probes per row (its latest started turn and its latest model settings change). Before, they ran the effective-policy walk, which scans back over every turn started since the last settings change. On long sessions with many automated turns that took several seconds in Postgres and slowed every list load. A list row now shows the latest started turn's model unless the settings were changed after it. Opening a single session still reports the exact effective policy.
