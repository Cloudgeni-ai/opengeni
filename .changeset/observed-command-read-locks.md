---
"@opengeni/db": patch
---

Reuse persisted command-completion observations when reading retained output. Subsequent reads no longer reacquire session/event write locks; the first acknowledgement, scoped reads and notification semantics remain unchanged.