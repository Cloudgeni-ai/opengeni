---
"@opengeni/api-router": patch
---

Restore disputed credits correctly when Stripe delivers the resolution before
the hold. Record the matching hold and release atomically and idempotently so
late or repeated webhooks cannot withhold restored credits.
