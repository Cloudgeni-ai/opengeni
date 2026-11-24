---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Custom credit offers: `client.listCreditOffers({ accountId })` returns an organization's sponsored credit offers (a configurable amount for a fixed list of models, valid a set number of days after activation) and whether billing managers can activate them; `client.activateCreditOffer(offerId, { accountId })` activates one. Promotional credit balances now include `expiresAt`.
