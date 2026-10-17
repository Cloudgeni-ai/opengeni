---
"@opengeni/db": patch
---

Session list totals and per-root tree stats do less database work per poll. Totals now walk each listed root's descendants through the parent index instead of reading every session in the workspace, and only join the needs-you set when that filter is on. Tree stats read each descendant's personal state once and carry the columns they need through the walk, instead of re-reading the session, its pin row three times and a cycle probe per descendant.
