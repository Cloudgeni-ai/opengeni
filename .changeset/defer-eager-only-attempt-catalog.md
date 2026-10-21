---
"@opengeni/runtime": patch
"@opengeni/network": patch
"@opengeni/worker-bundle": patch
"@opengeni/tool-gateway": patch
---

Honor explicit provider-dispatch catalog preparation even when all MCP servers
are already connected. Keep eager schemas available before the first request,
and join the same catalog completion fence before tool execution and cleanup.
Use the shared transport's dispatch notification after admission and transport
setup on both native subscription and generic model routes.
Compile a tool's input and output validators together on its first call, before
authorization or execution, instead of compiling every unused tool at startup.
Malformed schemas now fail that tool's call rather than catalog preparation.
