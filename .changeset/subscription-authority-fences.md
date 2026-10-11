---
"@opengeni/db": patch
---

Scheduled and inbox work now keeps the subscription authority it was accepted with. An internal turn delivered into an earlier turn's context, and a scheduled occurrence, must carry the accepted subscription authority they copy, and scheduled Claude work is checked like SuperGrok's: admission, occurrences, the generated session and the scheduled turn compare the accepted Claude account choice, and a run whose personal Claude account was disconnected fails at claim. Connecting a personal Claude account no longer fails, and disconnecting a personal SuperGrok or Claude account now revokes its access, on databases whose owner is bound by row security; access left behind by earlier disconnects is revoked.
