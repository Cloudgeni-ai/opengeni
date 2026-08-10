# Durable spreadsheet API

## Direct tools and CodeMode

The direct tool family is `editable_artifact_list`, `editable_artifact_create`,
`editable_artifact_import`, `editable_artifact_get`, `editable_artifact_inspect`,
`editable_artifact_apply`, `editable_artifact_export`, and
`editable_artifact_export_status`. Complex work uses the authored facade over those same
calls:

Direct `editable_artifact_apply` calls require `expectedHeadSequence` and
`expectedStateHash` from the inspection that informed the edit. A mismatch is a
conflict: inspect again and recompute. The CodeMode facade carries this fence
automatically.

```js
import { openGeni } from "@opengeni/codemode";

const workbook = await openGeni.artifacts.create("spreadsheet", "Forecast");
const sheetId = openGeni.artifacts.ids.stable();
await workbook.apply([
  { kind: "sheet.create", sheetId, name: "Summary", after: null },
  {
    kind: "cells.set",
    sheet: { kind: "created-in-batch", sheetId, createCommandIndex: 0 },
    anchor: { row: 0, column: 0 },
    rows: 3,
    columns: 3,
    cells: [
      "Month", "Revenue", "Growth",
      "Jan", 100, null,
      "Feb", 120, { formula: "=B3/B2-1", cached: null },
    ],
  },
]);
```

Rows and columns are zero-based. `cells` is row-major and its length must equal
`rows * columns`.

## Queries

List sheets and their ids/generations:

```js
const { projection } = await workbook.inspect({
  kind: "workbook-metadata",
  query: { maxSheets: 1000, maxBytes: 1048576 },
});
```

Read a bounded rectangle:

```js
const sheet = projection.projection.sheets[0];
const viewport = await workbook.inspect({
  kind: "viewport",
  query: {
    sheetId: sheet.sheetId,
    startRow: 0,
    startColumn: 0,
    rowCount: 100,
    columnCount: 20,
    maxCells: 2000,
    maxBytes: 1048576,
  },
});
```

JSON output normalizes revisions to decimal strings. Cells return zero-based
coordinates, formula text, and a tagged value (`empty`, `boolean`, `number`,
`date`, `text`, or `error`).

## Commands

For an existing sheet, construct its exact precondition from metadata:

```js
if (!sheet.generationId) throw new Error("Sheet has no active generation");
const existingSheet = {
  kind: "generation",
  sheetId: sheet.sheetId,
  creationOperationId: sheet.generationId,
};
```

One apply accepts an ordered atomic array of:

- `sheet.create`: new `sheetId`, `name`, and `after`
- `sheet.rename`: exact sheet precondition and new `name`
- `sheet.delete`: exact sheet precondition
- `cells.set`: sheet precondition, zero-based `anchor`, `rows`, `columns`, and
  row-major `cells`
- `range.clear`: sheet precondition and inclusive zero-based `start`/`end`

A sheet created earlier in the same batch uses:

```js
{ kind: "created-in-batch", sheetId, createCommandIndex: 0 }
```

Cell inputs are `null`, boolean, finite number, string, `{ date: ISO_STRING }`,
`{ error: TEXT }`, or `{ formula: "=...", cached: CELL_INPUT }`.

## Import and export boundaries

```js
const workbook = await openGeni.artifacts.import(fileId, "spreadsheet", "Imported model");
const job = await workbook.export("xlsx");
let status;
do {
  await Bun.sleep(500);
  status = await job.status();
} while (status.state === "pending" || status.state === "running");
if (status.state !== "succeeded" || !status.file) throw new Error(status.errorCode ?? "export failed");
console.log(status.file.fileId, status.file.sourceHeadSequence, status.file.sourceStateHash);
```

Do not export and re-import to continue editing.

## Explicit standalone XLSX/CSV work

Only for an explicitly local file boundary, locate the deployment-pinned
runtime, import its absolute `$OPENGENI_ARTIFACT_TOOL_ENTRY`, and use
`Workbook`/`SpreadsheetFile`. Import only through that pinned entry. A
standalone result becomes shared work only after it is uploaded as a workspace
file and passed to `editable_artifact_import`.
