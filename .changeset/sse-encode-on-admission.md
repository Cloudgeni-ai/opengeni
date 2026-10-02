---
"@opengeni/api-router": patch
---

Defer SSE frame encoding until queue capacity is available, avoiding an extra byte buffer for blocked or stopped writes.
