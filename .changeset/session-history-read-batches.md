---
"@opengeni/db": patch
---

Reduce database round trips for large session-event history pages by fetching up to 256 rows per internal batch. Preserve the existing full-payload transfer byte budget, exact event content, pagination cursors, and tenant isolation.
