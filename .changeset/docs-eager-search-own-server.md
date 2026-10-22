---
"@opengeni/core": patch
---

New sessions mark Knowledge search as eager on the `docs` server only when that server actually offers `knowledge_search`. A deployment that defines its own `docs` server with other tools no longer gets an eager entry for a tool the server doesn't have.
