/**
 * TypeScript artifact models used for API conformance, codec development, and
 * deterministic tests. They are not a production fallback for the Rust
 * native/WASM kernel.
 *
 * Production Node/Bun spreadsheet editing uses the native session facade.
 * Browser editing uses `@opengeni/sdk/editable-artifacts`, which owns a
 * dedicated Worker and the paired WASM kernel.
 */
export * from "./document";
export * from "./kernel";
export * from "./presentation";
export * from "./spreadsheet";
export { SpreadsheetFile } from "./spreadsheet-file";
export { Document as ReferenceDocument } from "./document";
export { Presentation as ReferencePresentation } from "./presentation";
export { Workbook as ReferenceWorkbook } from "./spreadsheet";
