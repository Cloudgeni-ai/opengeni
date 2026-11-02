---
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

When no sandbox can be created or woken because the sandbox fleet has no free capacity (compute's "no host can take it now"), the turn no longer reports the chat model or its provider as unavailable. It now records `sandbox_capacity_unavailable`, shows "No sandbox capacity is available right now" while the same turn retries about once a minute, and says so again if the retries run out. Other sandbox control service failures record `sandbox_service_unavailable` and retry only when the service marks them retryable. A capacity failure inside a tool call, which previously stopped the turn with raw error text, now retries the same way.
