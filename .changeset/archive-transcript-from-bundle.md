---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Archiving a session now writes its readable transcript from the event rows the bundle export already read, instead of reading every kept event from the database a second time. The stored transcript is byte for byte the same.
