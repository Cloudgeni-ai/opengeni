---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

When a machine already runs its limit of Opengeni browsers or computer sessions, opening another now fails with a clear, non-retryable `capacity_exhausted` error (HTTP 409) telling the agent to end sessions it no longer needs. Previously it was a retryable `resource_unavailable` 503, which agents saw as "Opengeni is temporarily unavailable" and retried. The API gives errors from older agents the same message.
