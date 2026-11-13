---
"@opengeni/db": patch
---

Grant the session storage maintenance pass the session content collector that migration 1359 added, so unreferenced content blobs are deleted automatically instead of staying until the session is archived.
