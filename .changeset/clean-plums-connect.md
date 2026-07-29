---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Remove Bun-global dependencies from the worker turn path and Docker network attachment so embedded workers run identically in Node and Bun.
