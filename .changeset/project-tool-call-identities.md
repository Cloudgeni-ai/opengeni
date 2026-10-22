---
"@opengeni/db": patch
---

Avoid reading skipped tool arguments and outputs during exact call-ID event filtering. A rolling migration extends the existing tool metadata trigger; historical rows retain the payload fallback, with unchanged authorization, codec handling, and pagination.
