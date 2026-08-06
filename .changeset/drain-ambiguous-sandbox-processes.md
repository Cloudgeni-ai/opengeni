---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Retry transient retained-process promotion transactions and hand ambiguous yielded processes to exact-route turn finalization so they cannot strand sandbox leases.
