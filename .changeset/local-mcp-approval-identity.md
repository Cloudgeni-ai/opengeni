---
"@opengeni/runtime": patch
---

An approval-gated tool on an in-process (local) MCP server that the host registered with its own connection identity now pauses for approval instead of failing the turn. Servers without a connector connection are always approved under their synthetic `session-mcp:` identity, the same one the attempt gateway and saved tool permission rules use; the host's identity stays with its adapter. Reported by Ali Ozaltin (Botel AI) in #2537.
