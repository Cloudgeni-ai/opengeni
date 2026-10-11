---
"@opengeni/artifact-tool": patch
---

Exporting a never-edited spreadsheet to XLSX no longer fails with `source_identity_mismatch`. The materializer now accepts a version pinned at head sequence 0, and a spreadsheet with no sheets exports as a workbook with one blank sheet, because XLSX files without a sheet are rejected by Excel. `SpreadsheetFile.exportXlsx` applies the same rule to an empty workbook.
