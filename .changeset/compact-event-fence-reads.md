---
"@opengeni/db": patch
---

Read only admission and projection fields when fencing event-only appends, avoiding repeated transfer of frozen prompts and configuration. Preserve the full-row mutation callback contract, transaction-scoped control checks, and raw-lane cursor reread.
