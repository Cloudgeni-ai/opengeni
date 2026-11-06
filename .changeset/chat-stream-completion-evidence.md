---
"@opengeni/runtime": patch
---

Reject Chat streams that end without a finish reason before accepting partial answers or executing tool calls. Preserve upstream errors and do not automatically replay an incomplete response.
