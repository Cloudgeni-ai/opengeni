---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

Only a person's explicit end discards a browser whose controller lost it. Previously any end that removed state did, including the cleanup a failed or expired resume runs, so resuming such a browser could silently throw away its preserved working copy and restart from an older checkpoint. Now that cleanup keeps refusing and preserving it, as before. The end action first asks for a normal end and, only when the machine reports the browser's runtime preserved, asks again with an explicit discard. Machines on agents without the discard option keep their original refusal.
