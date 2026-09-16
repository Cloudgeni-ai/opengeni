---
"@opengeni/runtime": patch
---

Handle an explicitly disabled MCP approval policy when rebuilding connection-backed agents. Preserve connector authorization and action-policy checks while avoiding a startup TypeError after approval settings change.