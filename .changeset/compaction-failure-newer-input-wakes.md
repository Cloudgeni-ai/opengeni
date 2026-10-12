---
"@opengeni/db": patch
---

A session whose last turn failed context compaction wakes again for machine input that arrives after the failure, such as an Agent message or a child result, instead of holding every later input until a person writes. The new attempt carries the inputs that were already pending at the failure. Inputs that saw the failed attempt stay held, and the workflow-wake dispatcher no longer re-signals a session that only has held input.
