---
"@opengeni/db": patch
"@opengeni/codemode": patch
---

Codemode terminal settlement takes the session lock prefix before updating its journal row, so it no longer deadlocks against the client's re-notify of the same operation (`POST /codemode/calls` 500s with SQLSTATE 40P01). Submit and claim retry deadlock/serialization victims, an exhausted victim returns a typed retryable 503, and the Codemode client resubmits and re-reads the same operation id after a known-outcome transient 5xx.
