---
"@opengeni/react": patch
---

A chat's payment page card now loads only when a conversation shows one, so its card and payment glyphs no longer ship in every session's startup code. Conversations still provide the payment check up front: `PaymentPageActivityProvider` and `PaymentPageActivity` are unchanged and now come from a small module of their own.
