---
"@opengeni/db": patch
---

A stored model-context snapshot now reads back exactly as written when a stored string is itself JSON, such as a request body short enough to be stored as one chunk. Before, the model-context endpoint could return such a body as `"[object Object]"`.
