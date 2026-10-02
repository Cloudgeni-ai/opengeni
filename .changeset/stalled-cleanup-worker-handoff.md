---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Let turn cleanup consume exact retained-command terminal proof committed by another worker, including when the original control transport hangs. Drain the worker gracefully when finalization stalls so concurrent turns checkpoint and resume without spending their unexpected-worker-death recovery allowance. Keep standalone host exit as a final backstop; bare activity hosts supply the worker drain edge and embedded services own their termination policy.
