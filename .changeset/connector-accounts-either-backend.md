---
"@opengeni/react": patch
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

An active account on either backend of a connector (its own sign-in or Nango) now counts as that connector's account. Connection health, the connector's account list and `GET /connect/accounts` match a Nango account to the connector it serves, so a working Nango account reads Connected, and removed or replaced native accounts no longer raise "Needs attention". `GET /connect/accounts` also lists Nango accounts and reads native accounts of a Nango-backed connector as needing sign-in, as the account inventory does. Your own account from another workspace that is off here and signed out now reads "Signed out" with Reconnect instead of offering a new sign-in.
