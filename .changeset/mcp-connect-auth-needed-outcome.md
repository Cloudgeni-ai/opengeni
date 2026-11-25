---
"@opengeni/runtime": patch
---

Count an optional tool connection whose sign-in Opengeni already refused (expired, revoked or not usable for the turn) as its own `auth_needed` lifecycle outcome instead of a connection failure. The person already sees that account needs a reconnect, so the best-effort connection failure alert no longer pages for it on every turn, and those refusals no longer dilute the ratio of real connection failures.
