---
"@opengeni/db": patch
---

Use the existing exact ownership index when finding the latest attempt for recovery inventory, avoiding scans of a session's unrelated historical attempts without changing recovery eligibility or polling.
