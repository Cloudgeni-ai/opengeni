---
"@opengeni/config": patch
---

An idle sandbox now stops one minute after its last use instead of fifteen. The workspace is still saved before the box stops, and a later turn restores it from that save, so a long warm tail mostly paid for an idle box. Deployments that prefer warm resumes after longer pauses can raise `OPENGENI_SANDBOX_IDLE_GRACE_MS`.
