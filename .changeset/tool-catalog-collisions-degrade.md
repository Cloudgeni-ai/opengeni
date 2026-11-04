---
"@opengeni/tool-gateway": patch
"@opengeni/codemode": patch
"@opengeni/runtime": patch
"@opengeni/capabilities": patch
---

One connector's bad tool no longer stops a turn. When a connector lists the same tool more than once (as the ElevenLabs hosted MCP did while its tool list changed), Opengeni keeps one copy. Two different tools that would share a Codemode path now get distinct paths, and a tool that still cannot be added, or whose definition is invalid, is left out for that turn. Each case is logged as a structured warning. A call always runs the tool the model was shown: when two different tools claim one model name, the catalog keeps one, and a call meant for the other is refused rather than sent to the wrong tool. OpenAPI connectors whose operation names differ only by a number suffix keep a separate tool for each operation.
