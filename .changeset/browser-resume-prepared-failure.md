---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

A browser resume that fails before its controller is dispatched (for example because the browser's machine is offline or the task moved to another machine) now returns the browser to suspended. Previously the browser stayed in restoring indefinitely and every later resume was refused.
