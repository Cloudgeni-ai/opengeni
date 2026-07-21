---
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

Keep deterministic Codex subscription sharding sticky through 99% usage and
rotate only after actual exhaustion or a definitive provider refusal. Remove the
configurable near-exhaustion cutoff so warning presentation cannot strand usable
subscription allowance.
