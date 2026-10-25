---
"@opengeni/contracts": minor
"@opengeni/react": minor
"@opengeni/api-router": patch
---

Buying credits from a chat now takes one answer. When an agent opens a payment page through the app actions (`createBillingCheckout`, `createSubscriptionCheckout` and the billing portal), the chat shows it as a card with one button that opens the exact page in a new tab, so nobody copies a long link by hand; for credits the card confirms the payment in place, with the new balance, once the person pays, and every balance shown refreshes. Opening such a page charges nothing, so it no longer asks for a confirmation in the chat, and it also runs from an embedded chat when the person may pay. The agent's result for it says the chat shows the page and that test-mode pages are expected on deployments that take test payments. Action search now finds buying credits and the balance in everyday words. A checkout created without return URLs now returns to `/checkout-complete.html`, a small page that sends the person back and needs no sign-in, and the web app's `/billing` return opens organization billing instead of the general settings. New contract exports: `PAYMENT_PAGE_ACTIONS`, `appActionOpensPaymentPage`, `appActionNeedsConfirmation` and `appActionCallNeedsConfirmation`; new React exports: `PaymentPageActivityProvider` and `PaymentPageActivity`.
