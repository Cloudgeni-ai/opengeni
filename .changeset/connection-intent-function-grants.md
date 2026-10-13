---
"@opengeni/db": patch
---

Remove PUBLIC's EXECUTE grant on the two routines added for turn connection-account intent; the application role keeps the CHECK validator. Align the creator-policy digest and sender-cutover upgrade tests with the current migrations.
