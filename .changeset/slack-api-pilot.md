---
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/config": patch
---

Run Slack account MCP tools through a reviewed Web API bridge while preserving OAuth, exact account authority, and tool approvals. Add scope-aware discovery and shared app/workspace request quotas for unlisted pilots. Preserve bot reaction and message tasks under throttled optional context, and remove unavailable generic Real-time Search.

Migration 0586 requires stopped application processes and matching role provisioning before starting this release.
