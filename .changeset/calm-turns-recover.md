---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Reset provider recovery backoff after a fenced successful model request so intermittent outages cannot exhaust a long-running turn's consecutive retry budget.
