---
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
---

When no sandbox can be created or woken because the sandbox fleet has no free capacity (compute's "no host can take it now", or E2B's typed busy error), the turn no longer reports the chat model or its provider as unavailable. It now records `sandbox_capacity_unavailable`, shows "No sandbox capacity is available right now" while the same turn retries about once a minute, and says so again if the retries run out. Other retryable sandbox control service failures record `sandbox_service_unavailable`; refusals that retrying cannot fix record `sandbox_service_refused` and stop. A capacity failure inside a tool call, which previously stopped the turn with raw error text, now retries the same way, unless an uncertain sandbox action in the same failure forbids a replay. Other sandbox provider SDK failures that read as a model provider outage are relabelled as the sandbox service. The person-facing text for these failures never includes the sandbox service's raw message.
