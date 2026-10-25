---
"@opengeni/db": patch
---

Pipeline independent event-fence reads in their existing transaction order, reducing sequential network waits while retaining separate SQL statements and cursor validation barriers.
