---
"@opengeni/runtime": patch
---

Requested Word, Excel and PowerPoint files are made with fewer steps. The documents, spreadsheets and presentations Skills now say that managed sandboxes already include python-docx, openpyxl and python-pptx, so agents use them directly instead of checking first, and that document artifacts are not exported to DOCX or PDF, so agents no longer load artifact tools just to check.
