---
"@opengeni/runtime": patch
---

When an agent calls `request_human_input` with arguments that don't match its schema (for example `questions` sent as JSON text, or `confirm` on a question without exactly two options), it now gets back which fields are wrong and why, and can correct the call. Before, it only saw "Tool execution failed. Error details are redacted." The tool definition the model sees is unchanged.
