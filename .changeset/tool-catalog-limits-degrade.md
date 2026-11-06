---
"@opengeni/tool-gateway": patch
"@opengeni/codemode": patch
"@opengeni/runtime": patch
---

A connector with too many tools, oversized tools or a clashing tool name no longer stops a turn. When the turn's tools go over the 4,096-tool or 16 MB limit, or one connector's list goes over its own limit, Opengeni keeps the tools that fit and leaves the rest out. Built-in tools, harness control tools and eager tools are kept first, and this now applies to required connectors too. When more than 64 connectors are selected for a turn, required ones are kept first and the rest are skipped for that turn. Repeated listings are removed before the size checks, so repeats no longer count against the limits. When two connectors produce the same model name, the first to list it keeps it and the other connector's tool is left out; calls to that tool are refused, never sent to the other connector. Built-in tools claim their names before any connector. Each case logs a structured `tool_catalog_degraded` warning, and tool search tells the model which tools are unavailable and why.
