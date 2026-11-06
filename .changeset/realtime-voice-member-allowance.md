---
"@opengeni/db": patch
---

Live-voice minutes now count against the usage allowance of the member who started the call, as voice input already does. Previously a live-voice debit moved only the workspace counter, so a member allowance never filled from live voice and its heartbeat stop and admission refusal never applied. The usage-event trigger now records an attribution receipt for each live-voice cost event, and the debit trigger reads it for the matching debit (same source, key, amount and debit type); debit metadata alone is still not trusted. Live-voice minutes billed before this release are not recounted.
