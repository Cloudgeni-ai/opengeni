---
"@opengeni/api-router": patch
"@opengeni/core": patch
---

Authorize first-party MCP Pause, Resume, and Agent Steer commands exactly once at the canonical command boundary instead of repeating the embedding host authorization call before persistence.