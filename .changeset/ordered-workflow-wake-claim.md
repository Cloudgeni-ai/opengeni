---
"@opengeni/db": patch
---

Lock sessions before workflow-wake failure updates and global wake claims, avoiding archive-guard deadlocks with turn settlement while preserving revision-scoped delivery and nonblocking dispatcher leases.