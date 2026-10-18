---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Retry transient database connection admission with bounded jittered backoff and
recover running turns after PostgreSQL refuses connections with SQLSTATE 53300.
Never replay entered callbacks or uncertain commits, and keep permanent data and
authentication errors non-retryable. Existing error messages remain unchanged.
