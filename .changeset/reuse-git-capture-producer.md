---
"@opengeni/runtime": patch
---

Read large Git review results from one verified temporary capture instead of rerunning the complete Git command for every transport chunk. Preserve bounded output transport, complete branch diffs, and checksum verification, and clean up each capture after reading.
