---
"@opengeni/api-router": patch
---

Managed-auth email verification keeps a password only when the address is verified from the browser that chose it. Every email sign-up response now sets an HttpOnly `opengeni.sign_up_browser` cookie (`__Secure-` prefixed over HTTPS), and while the address is unverified a sign-up sent from a trusted browser origin remembers its password for that browser; sign-ups with a missing or foreign `Origin` remember nothing. When a verification link is followed in that browser, that password becomes the account's password. Followed anywhere else (another device, a mail scanner, or after someone else's sign-up for the address), the address is still verified but every stored password is discarded, and the person sets one with a password reset. Sessions are revoked on verification. A repeated sign-up for an unverified address no longer silently drops its password: it is used if verification happens in its browser.
