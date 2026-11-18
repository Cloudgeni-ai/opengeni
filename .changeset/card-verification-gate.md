---
"@opengeni/api-router": minor
"@opengeni/db": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

A card verification gate for the Free plan, off until an operator turns it on (`--card-verification-mode enforce`). While it is on, an unpaid organization needs a card its owner verified through Stripe Checkout (a SetupIntent, no charge) before it starts a sandbox box or receives Free monthly credit; chat without a box keeps working. One card and one person get Free credit for one organization, and another organization of the same owner inherits the card for sandboxes only. A refused box start has code `sandbox_card_required`, and the console offers one Add a card action that continues the chat once the card is added. Paid, Enterprise, host-provisioned and credit-buying organizations are unaffected; nothing is deleted and the Free amount is unchanged. New routes: `GET /v1/billing/card-verification`, `POST /v1/billing/card-verification/setup` and `POST /v1/billing/card-verification/confirm`.
