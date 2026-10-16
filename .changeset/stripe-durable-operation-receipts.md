---
"@opengeni/db": patch
---

Bind subscription upgrade, downgrade and cancellation requests to durable organization-scoped intent and result receipts before Stripe mutations. Preserve original targets across database rollback, replacement subscriptions and provider idempotency-key expiry. Refund duplicate subscription funding according to payment timestamps rather than invoice creation time.
