import type { FileBlob } from "./file-blob";
import type { Workbook } from "./spreadsheet";
import {
  SpreadsheetFidelityError,
  SpreadsheetSecurityError,
  type SpreadsheetFidelityIssue,
  type SpreadsheetLossPreservationEnvelope,
  type SpreadsheetXlsxExportOptions,
  type SpreadsheetXlsxImportLimits,
  type SpreadsheetXlsxImportOptions,
} from "./spreadsheet-xlsx-api";
import {
  spreadsheetFidelityReport,
  spreadsheetLossPreservationEnvelope,
} from "./spreadsheet-xlsx-state";

export {
  SpreadsheetFidelityError,
  SpreadsheetSecurityError,
  type SpreadsheetFidelityIssue,
  type SpreadsheetLossPreservationEnvelope,
  type SpreadsheetXlsxExportOptions,
  type SpreadsheetXlsxImportLimits,
  type SpreadsheetXlsxImportOptions,
};

/** Lazily loaded XLSX codec around the canonical Workbook model. */
// eslint-disable-next-line typescript/no-extraneous-class -- Skill-compatible static facade.
export class SpreadsheetFile {
  static async importXlsx(
    input: FileBlob | Blob | ArrayBuffer | Uint8Array,
    options: SpreadsheetXlsxImportOptions = {},
  ): Promise<Workbook> {
    const { SpreadsheetXlsxCodec } = await loadSpreadsheetXlsxCodec();
    return SpreadsheetXlsxCodec.importXlsx(input, options);
  }

  static async exportXlsx(
    workbook: Workbook,
    options: SpreadsheetXlsxExportOptions = {},
  ): Promise<FileBlob> {
    const { SpreadsheetXlsxCodec } = await loadSpreadsheetXlsxCodec();
    return SpreadsheetXlsxCodec.exportXlsx(workbook, options);
  }

  static fidelityReport(workbook: Workbook): readonly SpreadsheetFidelityIssue[] {
    return spreadsheetFidelityReport(workbook);
  }

  /**
   * Returns a portable copy of the opaque original-package envelope.
   * Persist it beside Workbook.toJSON(); the Workbook JSON intentionally does not contain Office bytes.
   */
  static lossPreservationEnvelope(workbook: Workbook): SpreadsheetLossPreservationEnvelope | null {
    return spreadsheetLossPreservationEnvelope(workbook);
  }

  /** Reattaches a separately persisted envelope to a restored canonical workbook snapshot. */
  static async attachLossPreservationEnvelope(
    workbook: Workbook,
    envelope: SpreadsheetLossPreservationEnvelope,
    options: Pick<SpreadsheetXlsxImportOptions, "limits"> = {},
  ): Promise<void> {
    const { SpreadsheetXlsxCodec } = await loadSpreadsheetXlsxCodec();
    return SpreadsheetXlsxCodec.attachLossPreservationEnvelope(workbook, envelope, options);
  }
}

function loadSpreadsheetXlsxCodec() {
  return import("@opengeni/artifact-tool/spreadsheet/xlsx");
}
