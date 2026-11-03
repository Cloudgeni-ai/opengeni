---
"@opengeni/db": patch
---

A command running on a session's own sandbox no longer has its output rejected, and its turn failed, when the session switches to another machine while the command runs. Settlement now checks the command against the route epoch it was admitted on instead of the session's current one.
