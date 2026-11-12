---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Organization > Billing lists the organization's payments (plans, credits and automatic top-ups), newest first, with the date, what each was for, the amount and any refund, and a link to its Stripe invoice PDF or receipt. Automatic top-ups have no invoice, so Stripe's billing portal never listed them. The Stripe portal row is now **Payment details** (Open Stripe), for the card and billing details.

`GET /v1/billing/receipts` (`billing:read`, Stripe billing only) returns one page of `BillingReceipt` with a `nextCursor`; the SDK calls it with `listBillingReceipts({ accountId, cursor, limit })`. It reads the organization's existing Stripe customer and never creates one, so an organization that never paid gets an empty list. Charges are not changed.
