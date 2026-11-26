---
"@opengeni/db": patch
"@opengeni/core": patch
---

Faster reads for long-running chats, schedule lists and Insights calls. A chat's effective model after a settings change no longer reads every automated run a schedule made in it; listing schedules reads their target chats in one batch instead of once per schedule; and pricing a page of Insights calls looks up each call's ledger debits by source instead of scanning the account's ledger per row. Two indexes are added concurrently.
