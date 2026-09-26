---
"@opengeni/browserd": patch
---

Continue exact-profile browser cleanup when an unrelated Linux process disappears during procfs discovery. Preserve unexpected read failures and the executable/profile ownership checks before signalling a process.
