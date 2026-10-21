---
"@opengeni/runtime": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Remote MCP servers that answer the 2026-07-28 `server/discover` probe but send 2025-era results (no `resultType`) are reconnected over the 2025 handshake instead of losing every tool. This covers agent turns, connector tool permissions, capability probes and OAuth connection checks. A best-effort server's failed `tools/list` warning now names its structural cause (error class, SDK or numeric code, validation violation) without message text.
