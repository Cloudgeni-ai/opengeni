---
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
"@opengeni/sdk": minor
---

Make workspace-owned MCP OAuth connections the default, add explicit personal
connection ownership, and preserve exact delegated personal authority across
turns, child sessions, goals, schedules, retries, and recovery with safe
tool-level degradation when a personal connection is unavailable.