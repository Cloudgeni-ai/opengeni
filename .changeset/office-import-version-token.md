---
"@opengeni/storage": patch
"@opengeni/api-router": patch
---

Importing a workspace DOCX, XLSX, or PPTX file as an editable document, spreadsheet, or presentation no longer fails with 409 "The workspace file changed during import." `headFile` now reports the object version token (S3 ETag, Azure Blob etag, GCS generation) that the import's before/after consistency check requires, on every storage backend.
