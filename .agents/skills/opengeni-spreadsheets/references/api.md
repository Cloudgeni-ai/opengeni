# Spreadsheet API

Preflight the verified installation, then import its absolute bootstrap. This
works on Linux, macOS, and Windows and never consults the current repository's
dependency tree:

```js
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const artifactEntry = process.env.OPENGENI_ARTIFACT_TOOL_ENTRY;
if (!artifactEntry || !isAbsolute(artifactEntry)) {
  throw new Error("OpenGeni artifact runtime is unavailable");
}
const { SpreadsheetFile, Workbook } = await import(pathToFileURL(artifactEntry).href);
```

## Create and export

```js
const workbook = Workbook.create();
const sheet = workbook.worksheets.add("Summary");
sheet.getRange("A1:B3").values = [
  ["Month", "Revenue"],
  ["Jan", 100],
  ["Feb", 120],
];
sheet.getRange("C1").values = [["Growth"]];
sheet.getRange("C3").formulas = [["=B3/B2-1"]];
workbook.recalculate();

const check = await workbook.inspect({
  kind: "table",
  range: "Summary!A1:C3",
  include: "values,formulas",
  tableMaxRows: 20,
  tableMaxCols: 12,
});
const preview = await workbook.render({ sheetName: "Summary", range: "A1:C3", scale: 2 });
await preview.save("summary-preview.png");
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save("summary.xlsx");
```

Use `getRangeByIndexes(row, column, rowCount, columnCount)` and rectangular
`writeValues`/`values`/`formulas` assignments for bulk work. Use
`workbook.batch(draft => { ... })` when many separate ranges or objects must be
mutated; native reconciliation happens once after the callback. Use
`workbook.trace("'Summary'!C3")` for formula provenance and
`workbook.help("feature")` for one targeted API discovery.

## Existing files

```js
const workbook = await SpreadsheetFile.importXlsx(inputBlob);
const issues = SpreadsheetFile.fidelityReport(workbook);
```

Inspect and render before editing. Treat any error-severity fidelity issue as a
blocker unless the user explicitly accepts a documented lossy export.
