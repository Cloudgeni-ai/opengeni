---
"@opengeni/runtime": patch
---

Bind a remembered authorized tool name through one Agents SDK `resolveMissingFunctionTool` hook instead of a fake client `tool_search` inject. Codex/OpenAI native raw calls and generic `tool_invoke` share that path; unknown or revoked names return a typed model error instead of killing the turn.
