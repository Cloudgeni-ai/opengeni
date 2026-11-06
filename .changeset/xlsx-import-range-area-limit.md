---
"@opengeni/artifact-tool": patch
---

XLSX import now bounds the area of merged-cell (`mergeCell ref`) and data-validation (`dataValidation sqref`) ranges during preflight. ExcelJS expands these ranges one covered address at a time, so a small file with a very large merge or validation range could make the import allocate memory and block for a long time. Merged areas create real cells, so they are summed against the existing worksheet-cell limits per worksheet part (`worksheetCellsPerPart`) and across the package (`worksheetCells`). Data validations only create lighter map entries, so they have their own fixed ceiling of four full Excel columns (4,194,304 covered addresses) per part and across the package; an ordinary whole-column dropdown still imports. A package over any of these limits, or with a malformed range reference, is rejected before ExcelJS loads it.
