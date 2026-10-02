---
"@opengeni/db": minor
"@opengeni/api-router": patch
---

Batch workspace model catalog provider reads within each request. Reuse authorized connection metadata and combine custom-model queries while preserving tenant isolation, provider limits, credential readiness and model selection.
