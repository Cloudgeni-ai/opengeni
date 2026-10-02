---
"@opengeni/db": patch
---

Encode and decode tagged JSON strings with native UTF-16LE buffers to reduce CPU and temporary string allocations. Preserve the storage format, all code units, version checks and literal legacy content.
