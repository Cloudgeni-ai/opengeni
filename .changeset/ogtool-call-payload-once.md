---
"@opengeni/contracts": minor
"@opengeni/ogtool": minor
"@opengeni/runtime": patch
---

`ogtool call` prints a tool result's payload once: a text block that only repeats `structuredContent` as JSON is omitted, and `--full` prints the exact result. The rule is exported from `@opengeni/contracts` as `omitStructuredContentTextDuplicates` and is shared with the runtime's model-facing MCP projection and the native Connected Machine client.
