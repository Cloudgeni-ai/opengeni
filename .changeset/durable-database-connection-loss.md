---
"@opengeni/db": patch
---

Preserve own-client provenance for database transaction admission and settlement failures so running sessions can recover their exact accepted turn after connection loss.
