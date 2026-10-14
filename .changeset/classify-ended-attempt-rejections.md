---
"@opengeni/api-router": patch
---

A request refused because its agent-attempt credential is no longer valid now carries a detail code (for example `agent_attempt_caller_stale` when a process keeps using the credential after its turn ended), so request telemetry reports why instead of "unclassified".
