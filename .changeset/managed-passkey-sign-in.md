---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/react": minor
---

Managed accounts can sign in with a passkey. Anyone signed in adds passkeys under their sign-in methods and can then sign in with one instead of a password. With `OPENGENI_MANAGED_AUTH_PASSKEY_SIGNUP_ENABLED=true`, a new person can also create an account with only a name and a passkey, with no email address or password, while new sign-ups are open and no email allowlist is set. Passkeys are offered on trusted HTTPS or `localhost` origins in the legacy session-set mode. Rolling migration 0998 adds the passkey store.
