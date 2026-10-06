---
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/artifact-tool": minor
"@opengeni/artifact-kernel-wasm-spreadsheet": minor
"@opengeni/artifact-kernel-wasm-document": patch
"@opengeni/artifact-kernel-wasm-presentation": patch
"@opengeni/runtime": patch
---

Add canonical sparse row-height and column-width set/reset commands with live
spreadsheet projections and immediate, frame-coalesced drag and keyboard
resizing. Preserve existing dimension-free artifacts and shared artifact
authority, collaboration, and history.

Preserve sparse dimensions through native workbook reconciliation and verified
XLSX materialization, including empty-sheet geometry. Refresh all modality
kernel distributions together to retain their shared build identity.

Keep spreadsheet input responsive during delayed saves, retain pending cell
drafts when refocused, surface independent failures without unsafe overlapping
retries, and show server sync state separately from local command acceptance.
