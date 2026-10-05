---
"@opengeni/runtime": patch
---

Turn-startup diagnostics: `model_prepare_runner_before_mcp_tools` is recorded only when the MCP tool snapshot happens before the first model request. A lazily prepared catalog snapshotted after that charged the model's own time to the gap (it read 14 s p50 while real first tokens took ~3 s).
