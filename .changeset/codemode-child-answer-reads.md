---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

A parent that reads a child's complete answer through Codemode (for example `ogtool call` in a shell command) no longer gets that child's terminal result delivered again after its turn ends. The read is recorded on the turn and counts once the turn's own tool results hold the whole answer, so the result is superseded as `consumed_by_parent_read` instead of starting a turn that repeats the answer. A script that returned only a summary still delivers the result normally.
