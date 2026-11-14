---
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A turn interrupted by a turn worker shutdown, such as a rolling deploy, now resumes on another worker within seconds instead of stalling for about five minutes. This fixes two separate causes.

First, when the shutdown cancelled the turn while a Connected Machine command was still running (for example a generated-file download or a slow `exec_command`), finalization waited for the machine to prove the command had exited. A slow or silent machine could not do that before the worker's force stop. The worker then died without settling the activity, writing its quiescence receipt or releasing its subscription lease, and recovery waited for the two-minute heartbeat timeout. Now, when the turn ends because its worker is shutting down, each still-running machine command goes to the session's command ledger with a stop request (the custody already used for machines that stop answering), and finalization continues without waiting. Pause, Steer and normal completion still wait for exact exit proof.

Second, a dead attempt's subscription turn lease was held until its five-minute TTL expired, so the next generation was refused with `subscription_lease_busy`. A newer generation of the same turn can now take over the lease once the holder's attempt has written its quiescence receipt, which proves it can no longer use the account. Renewal, current-lease checks and usage finalization still use the lease's own expiry.
