---
"@opengeni/runtime": patch
---

Send an MCP tool result's payload to the model once. A plain text block that only repeats `structuredContent` as JSON is omitted from the model-facing result; prose, differing text, and non-text blocks are kept, and the durable tool-output event keeps the exact result.
