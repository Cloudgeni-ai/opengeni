---
"@opengeni/api-router": patch
---

The `excel_run` tool description now names the Office.js reads that most often fail with PropertyNotLoaded: each `get…()` call returns a new unloaded object, a sheet's `name` must be loaded too, and range properties are plural.
