---
"@opengeni/browserd": patch
---

A computer helper that crashed is now replaced on the next read instead of failing every later read with an internal error. A helper that cannot be shut down now fails with a clear controller-lost reason, and a helper that cannot restart reports a retryable unavailable error.
