---
"@opengeni/interaction": patch
---

Release settled interaction receipt memory after successful durable persistence. Optional journal readers restore exact hash-bound receipts on replay; unavailable or changed records fail closed without repeating input. Controllers without durable readers retain bounded-entry compressed receipts.
