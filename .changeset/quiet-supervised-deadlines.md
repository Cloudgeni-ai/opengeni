---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

Add durable native supervision for supported stock Modal non-PTY commands. Retain
the idle invocation before provider dispatch and user-code release, verify native
capability on the exact warm instance, persist descendant-quiescence proof
before supervisor acknowledgment, and fence canonical settlement on provider exit
plus captured output. Deadline cancellation keeps a monotonic stdin fence without
cancelling ordinarily adopted background commands. Unsupported and legacy paths
remain explicit and cannot manufacture supervision proof.