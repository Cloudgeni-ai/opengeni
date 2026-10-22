// The Excel add-in kit: the pieces an Office task pane needs to connect the
// open workbook to Opengeni, so agents can work in it live with `excel_run`.
// Opengeni's own add-in is built from these; a product that embeds Opengeni
// builds its own branded add-in the same way (see docs/excel-addin.md).
//
// Browser-only except `officeAddinManifest` and `officeAddinId`, which also
// run on a server. The pane page must load office.js from Microsoft's CDN.
export { openOfficeDialog } from "./dialog";
export {
  explainOfficeError,
  jsonSafe,
  runOfficeCode,
  serialQueue,
  type RunResult,
} from "./executor";
export { excel, office, type ExcelHost, type OfficeHost } from "./host";
export {
  OFFICE_MANIFEST_PATH,
  officeAddinId,
  officeAddinManifest,
  type OfficeAddinManifestOptions,
} from "./manifest";
export {
  rangePart,
  readSelection,
  SAMPLE_COLUMNS,
  SAMPLE_ROWS,
  selectionContextItem,
  type OfficeContextItem,
  type SelectionRequestContext,
  type SelectionSnapshot,
} from "./selection";
export { officeTheme, watchOfficeTheme, watchSelection } from "./watch";
export { describeWorkbook, workbookContextItem, type OfficeWorkbookInfo } from "./workbook";
export {
  WorkbookLink,
  websocketUrl,
  type OfficeWorkbookTicket,
  type WorkbookLinkOptions,
  type WorkbookLinkState,
} from "./workbook-link";
