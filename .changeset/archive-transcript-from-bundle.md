---
"@opengeni/db": patch
"@opengeni/storage": patch
"@opengeni/worker-bundle": patch
---

Archiving a session now writes its readable transcript from the event rows the bundle export already read, instead of reading every kept event from the database a second time. The transcript reads exactly as before. A compressed JSON lines file that fails while its producer is busy elsewhere now fails the producer's next write instead of waiting forever, and no longer leaves an unhandled rejection behind.
