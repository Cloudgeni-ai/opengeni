---
"@opengeni/db": patch
---

Reduce raw Insights query overhead and read the current and comparison windows in separate bounded statements so larger default views can finish within the database timeout.
