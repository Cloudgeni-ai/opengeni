---
"@opengeni/core": patch
---

Avoid repeating attachment ownership reads when creating a session with no file resources. Agent child creation retains its outer live authority checks and file-bearing requests retain attachment validation.
