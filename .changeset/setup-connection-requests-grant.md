---
"@opengeni/db": patch
---

Ask an admin on the Enable page now asks the workspace's admins in their inbox. Migration 1679 grants the runtime the request routine that 1599 created withheld, so the server no longer answers `{ status: "unavailable" }` while there are admins it may ask; the page copies a link only when there's nobody to ask.
