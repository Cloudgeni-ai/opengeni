---
"@opengeni/config": patch
"@opengeni/contracts": minor
"@opengeni/db": patch
"@opengeni/sdk": minor
---

Add Heedeo signup scoring, off by default. An operator mode (`heedeoSignupMode`: `off`, `shadow` or `enforce`, through the signup network velocity setter) and the `OPENGENI_HEEDEO_*` keys turn it on. Shadow scores each new account once, just before it is created, and stores the verdict without acting on it; enforce refuses a signup in Heedeo's `block` band. Heedeo failures never block a signup. The client config gains an optional `auth.heedeo` (publishable key and script URL) while scoring is on.
