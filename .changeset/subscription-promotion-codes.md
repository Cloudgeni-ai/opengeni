---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Plan checkout now takes a promo code. The Subscribe dialog has a Promo code field, and `createSubscriptionCheckout` accepts an optional `promotionCode`. A code works only when its Stripe coupon is restricted to that plan's product, so create plan coupons that way; an unrestricted credit coupon is refused instead of buying a plan worth more than it costs. A discount changes the price, not the plan's monthly credit.
