---
"@opengeni/api-router": patch
---

Managed-auth email verification now keeps the newest sign-up's password. While an address is unverified, each email sign-up for it replaces the account's password, and each verification link is bound to the password stored when it was sent, so a newer sign-up makes earlier links answer like any invalid link (the person can request a new email). Following the current link verifies the address with that password from any browser or device and revokes existing sessions. This replaces the sign-up browser cookie: no `opengeni.sign_up_browser` cookie is set, and verifying on another device or after a mail scanner opened the link no longer discards the password. A repeated sign-up's verification link keeps the callback URL that sign-up asked for.
