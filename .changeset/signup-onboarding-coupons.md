---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": patch
---

Redeem a Stripe promotion code at checkout: `createBillingCheckout` accepts `promotionCode`, and a fixed-amount USD code sets the credits by itself, so a $100 code buys exactly $100 of credits. Add `getBillingCheckout` to read whether a checkout's credits reached the balance; it also settles a completed checkout whose webhook is late, under the same ledger idempotency key. Organization setup can store the signup answer to "How do you want to use Opengeni?" once per person and organization.
