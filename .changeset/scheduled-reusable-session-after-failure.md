---
"@opengeni/db": patch
---

A schedule that reuses one session with skip-overlap now runs again after an occurrence fails. Before, the failed session never counted as idle, so every later occurrence was skipped as overlapping. Occurrences still skip while the session is running, queued, waiting or awaiting a person.
