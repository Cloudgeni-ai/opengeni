---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Stop deterministic goal retries for terminal or unavailable-model sessions,
preserve frozen connector authority through voice delegation and handoff, and
request advertised OAuth offline access for generic native MCP connections.
Distinguish MCP teardown warnings from connection failures in safe telemetry.
