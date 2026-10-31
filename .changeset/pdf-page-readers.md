---
"@opengeni/runtime": patch
---

Managed sandbox images ship `uuidgen` and the poppler PDF readers. The documents Skill lists `pdftotext`/`pdfinfo` among the preinstalled tools, and the document-parsing Skill says how to read a PDF one page at a time when page numbers matter, since AnyDoc's Markdown does not mark pages.
