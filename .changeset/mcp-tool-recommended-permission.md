---
"@opengeni/contracts": minor
"@opengeni/runtime": minor
"@opengeni/core": minor
---

An MCP server can recommend Ask for a tool with `_meta: { "opengeni/recommendedPermission": "ask" }` in `tools/list` (`MCP_TOOL_RECOMMENDED_PERMISSION_META_KEY`). It applies on model and Codemode calls from the next attempt of every session, and only when the workspace has saved no choice for the tool. A tool asks when either this or the session's `requireApproval` says so. Connector permission settings show the same recommendation.
