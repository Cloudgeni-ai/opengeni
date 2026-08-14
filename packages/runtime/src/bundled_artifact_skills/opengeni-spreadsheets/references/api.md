# Durable spreadsheet API

## Direct tools and CodeMode

The model-facing direct tool family is `opengeni__editable_artifact_list`,
`opengeni__editable_artifact_create`, `opengeni__editable_artifact_import`,
`opengeni__editable_artifact_get`, `opengeni__editable_artifact_inspect`,
`opengeni__editable_artifact_apply`, `opengeni__editable_artifact_export`, and
`opengeni__editable_artifact_export_status`. Complex work uses the authored
facade over those same calls:

Direct `opengeni__editable_artifact_apply` calls require `expectedHeadSequence` and
`expectedStateHash` from the inspection that informed the edit. A mismatch is a
conflict: inspect again and recompute. The CodeMode facade carries this fence
automatically.

For a direct `opengeni__editable_artifact_inspect` call, pass the query below as
`request`, alongside `artifactId` and `modality: "spreadsheet"`. Keep the shown
nested `query` object; it is part of the spreadsheet kernel envelope.

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

To continue an existing session workbook, bind the current list result instead
of creating a file or guessing an id:

```js
const candidates = (await openGeni.artifacts.list()).filter(
  (artifact) => artifact.modality === "spreadsheet",
);
if (candidates.length !== 1) throw new Error("Select the intended workbook first");
const workbook = openGeni.artifacts.use(candidates[0]);
await workbook.inspect({
  kind: "workbook-metadata",
  query: { maxSheets: 1000, maxBytes: 1048576 },
});
```

Rows and columns are zero-based. `cells` is row-major and its length must equal
`rows * columns`.

## Queries

List sheets and their ids/generations:

```js
const metadataResult = await workbook.inspect({
  kind: "workbook-metadata",
  query: { maxSheets: 1000, maxBytes: 1048576 },
});
if (metadataResult.projection.kind !== "workbook-metadata") {
  throw new Error("Workbook metadata is unavailable");
}
```

Read a bounded rectangle:

```js
const sheet = metadataResult.projection.projection.sheets[0];
if (!sheet) throw new Error("Workbook has no sheet");
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
const deadline = Date.now() + 300_000;
let status = await job.status();
while (status.state === "pending" || status.state === "running") {
  if (Date.now() >= deadline) throw new Error("spreadsheet export timed out");
  await Bun.sleep(500);
  status = await job.status();
}
if (status.state !== "succeeded" || !status.file) throw new Error(status.errorCode ?? "export failed");
console.log(status.file.fileId, status.file.sourceHeadSequence, status.file.sourceStateHash);
```

Do not export and re-import to continue editing.

## Explicit standalone XLSX/CSV work

Only when the user explicitly needs sandbox-local bytes and
`$OPENGENI_ARTIFACT_TOOL_ENTRY` is present, import that absolute pinned entry
and use `Workbook`/`SpreadsheetFile`. Never guess, install, or substitute
another runtime. If the entry is absent, stay on the durable artifact surface
and use workspace import/export boundaries. A standalone result becomes shared
work only after upload and `opengeni__editable_artifact_import`.
