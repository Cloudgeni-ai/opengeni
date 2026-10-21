---
"@opengeni/db": patch
---

Database pool connections now stay open for five minutes of idleness instead of 30 seconds, so workers stop paying a fresh connection handshake on roughly one request a second between bursts.
