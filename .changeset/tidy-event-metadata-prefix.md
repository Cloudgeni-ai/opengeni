---
"@opengeni/db": patch
---

Avoid sizing payloads beyond a full event page's byte/count prefix while preserving page contents, continuation cursors, and separate payload reads.
