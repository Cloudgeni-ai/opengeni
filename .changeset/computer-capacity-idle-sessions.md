---
"@opengeni/browserd": patch
---

A machine at its limit of computer sessions now makes room for a new one by ending its least recently used session on the machine's own screen that has been unused for at least three minutes and has no action running. Such a session holds no state of its own, and the server opens it again on its next request. Before, sessions from chats that had finished were never ended, so after enough chats the machine refused every new computer session with `capacity_exhausted` until the machine agent restarted. Isolated virtual seats, which own their display and apps, are never ended this way.
