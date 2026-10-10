---
"@opengeni/api-router": patch
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Manage each connected account on a connector page. OAuth start accepts `newAccount: true` to sign in a further account instead of re-authorizing the first one. The web connector page now offers a per-account Reconnect (only for accounts that need it), a confirmed Remove that deletes exactly that account, and an Add account action beside the list. Accounts whose sign-in never finished are labelled as such. The header action that only disables the connector now reads "Turn off for this workspace".
