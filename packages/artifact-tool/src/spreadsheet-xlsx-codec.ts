import type ExcelJS from "exceljs";
import { SaxesParser, type SaxesTagNS } from "saxes";

import {
  inflateBoundedZipEntry,
  parseBoundedZip,
  verifyBoundedZipEntry,
  type BoundedZipEntry,
  type BoundedZipFailure,
} from "./bounded-zip";
import { FileBlob } from "./file-blob";
import {
  formatCellAddress,
  formatRangeAddress,
  parseRangeAddress,
  type RangeAddress,
} from "./spreadsheet-address";
import { normalizeSpreadsheetImageConfig } from "./spreadsheet-image";
import { validateSupportedFormula } from "./spreadsheet-formula";
import { boundedUtf8ByteLength, inspectRasterImage } from "./raster-image";
import { Workbook, type Worksheet } from "./spreadsheet";
import {
  XLSX_MEDIA_TYPE,
  SpreadsheetFidelityError,
  SpreadsheetSecurityError,
  type SpreadsheetFidelityIssue,
  type SpreadsheetLossPreservationEnvelope,
  type SpreadsheetOpaqueContent,
  type SpreadsheetOpaqueContentType,
  type SpreadsheetOpaqueRelationship,
  type SpreadsheetXlsxExportOptions,
  type SpreadsheetXlsxImportLimits,
  type SpreadsheetXlsxImportOptions,
} from "./spreadsheet-xlsx-api";
import {
  LOSS_PRESERVATION,
  cloneOpaqueContent,
  hasOpaqueContent,
  opaqueContentIssues,
  spreadsheetFidelityReport,
  spreadsheetLossPreservationEnvelope,
} from "./spreadsheet-xlsx-state";
import type {
  BorderConfig,
  CellFormat,
  CellValue,
  FormulaErrorValue,
  FormulaResult,
  SpreadsheetImageConfig,
} from "./spreadsheet-types";

const DEFAULT_XLSX_IMPORT_LIMITS: SpreadsheetXlsxImportLimits = Object.freeze({
  compressedBytes: 64 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  entryBytes: 128 * 1024 * 1024,
  entries: 20_000,
  compressionRatio: 100,
  inspectedXmlBytes: 64 * 1024 * 1024,
  xmlDepth: 128,
  xmlAttributesPerElement: 256,
  xmlAttributesPerPart: 100_000,
  xmlAttributes: 500_000,
  xmlElementsPerPart: 1_000_000,
  xmlElements: 2_000_000,
  xmlTextCharactersPerPart: 16 * 1024 * 1024,
  xmlTextCharacters: 64 * 1024 * 1024,
  worksheetCellsPerPart: 1_000_000,
  worksheetCells: 1_000_000,
  formulasPerPart: 250_000,
  formulas: 1_000_000,
  formulaBytesPerPart: 16 * 1024 * 1024,
  formulaBytes: 64 * 1024 * 1024,
  sharedStrings: 1_000_000,
  cellStyles: 100_000,
  styleRecords: 250_000,
  commentsPerPart: 100_000,
  comments: 100_000,
  relationshipsPerPart: 4_096,
  relationships: 20_000,
  mediaEntries: 1_024,
  mediaEntryBytes: 32 * 1024 * 1024,
  mediaBytes: 128 * 1024 * 1024,
  imagePixels: 67_108_864,
});

/** XLSX codec around the canonical Workbook model. */
// eslint-disable-next-line typescript/no-extraneous-class -- Skill-compatible static facade.
export class SpreadsheetXlsxCodec {
  static async importXlsx(
    input: FileBlob | Blob | ArrayBuffer | Uint8Array,
    options: SpreadsheetXlsxImportOptions = {},
  ): Promise<Workbook> {
    validateImportOptions(options);
    const limits = resolveImportLimits(options.limits);
    const sourceBytes = await toBytes(input, limits.compressedBytes);
    const preflight = await preflightXlsx(sourceBytes, limits);
    if (hasOpaqueContent(preflight.opaqueContent) && options.unsupportedContent === "error") {
      throw new SpreadsheetFidelityError(
        "The XLSX contains bounded inert OOXML outside the editable spreadsheet model",
        opaqueContentIssues(preflight.opaqueContent, "error"),
      );
    }

    const excelWorkbook = await createExcelWorkbook();
    // toBytes always returns an owned, full-span Uint8Array. Hand that buffer to ExcelJS directly;
    // retaining unsupported OOXML then needs only this one canonical package copy.
    await excelWorkbook.xlsx.load(
      sourceBytes.buffer as Parameters<typeof excelWorkbook.xlsx.load>[0],
    );
    const workbook = importWorkbook(excelWorkbook, preflight.comments);
    LOSS_PRESERVATION.set(workbook, {
      sourceBytes,
      sourceDigest: await sha256Hex(sourceBytes),
      importedRevision: workbook.revision,
      opaqueContent: cloneOpaqueContent(preflight.opaqueContent),
      modelDigest: await workbookModelDigest(workbook),
    });
    return workbook;
  }

  static async exportXlsx(
    workbook: Workbook,
    options: SpreadsheetXlsxExportOptions = {},
  ): Promise<FileBlob> {
    validateExportOptions(options);
    // Validation also catches hostile state injected through reflection before any source bytes
    // are returned or ExcelJS is allocated.
    workbook.toJSON();
    const envelope = LOSS_PRESERVATION.get(workbook);
    if (envelope && (await workbookModelDigest(workbook)) === envelope.modelDigest) {
      return FileBlob.fromBytes(envelope.sourceBytes.slice(), {
        type: XLSX_MEDIA_TYPE,
        name: options.fileName ?? "workbook.xlsx",
      });
    }

    const issues = this.fidelityReport(workbook).filter((issue) => issue.severity === "error");
    if (issues.length > 0 && options.unsupportedContent !== "discard") {
      throw new SpreadsheetFidelityError(
        'XLSX export would discard unsupported editable content; remove it or explicitly export with unsupportedContent: "discard"',
        issues,
      );
    }

    const excelWorkbook = await exportWorkbook(workbook);
    const output = await excelWorkbook.xlsx.writeBuffer({
      zip: { compression: "DEFLATE", compressionOptions: { level: 6 } },
    });
    return FileBlob.fromBytes(normalizeGeneratedZip(new Uint8Array(output)), {
      type: XLSX_MEDIA_TYPE,
      name: options.fileName ?? "workbook.xlsx",
    });
  }

  static fidelityReport(workbook: Workbook): readonly SpreadsheetFidelityIssue[] {
    workbook.toJSON();
    return spreadsheetFidelityReport(workbook);
  }

  /**
   * Returns a portable copy of the opaque original-package envelope.
   * Persist it beside Workbook.toJSON(); the Workbook JSON intentionally does not contain Office bytes.
   */
  static lossPreservationEnvelope(workbook: Workbook): SpreadsheetLossPreservationEnvelope | null {
    workbook.toJSON();
    return spreadsheetLossPreservationEnvelope(workbook);
  }

  /** Reattaches a separately persisted envelope to a restored canonical workbook snapshot. */
  static async attachLossPreservationEnvelope(
    workbook: Workbook,
    envelope: SpreadsheetLossPreservationEnvelope,
    options: Pick<SpreadsheetXlsxImportOptions, "limits"> = {},
  ): Promise<void> {
    workbook.toJSON();
    validateAttachOptions(options);
    const normalizedEnvelope = normalizeLossPreservationEnvelope(envelope);
    const sourceBytes = normalizedEnvelope.sourceBytes;
    if (normalizedEnvelope.sourceDigest !== (await sha256Hex(sourceBytes))) {
      throw new SpreadsheetSecurityError(
        "Spreadsheet loss-preservation source digest does not match its bytes",
        "invalid-package",
      );
    }
    const preflight = await preflightXlsx(sourceBytes, resolveImportLimits(options.limits));
    if (!sameOpaqueContent(preflight.opaqueContent, normalizedEnvelope.opaqueContent)) {
      throw new SpreadsheetSecurityError(
        "Spreadsheet loss-preservation envelope metadata does not match its XLSX bytes",
        "invalid-package",
      );
    }
    const projectedSource = await createExcelWorkbook();
    await projectedSource.xlsx.load(
      sourceBytes.buffer as Parameters<typeof projectedSource.xlsx.load>[0],
    );
    const projectedDigest = await workbookModelDigest(
      importWorkbook(projectedSource, preflight.comments),
    );
    const targetDigest = await workbookModelDigest(workbook);
    if (
      projectedDigest !== normalizedEnvelope.modelDigest ||
      targetDigest !== normalizedEnvelope.modelDigest
    ) {
      throw new SpreadsheetSecurityError(
        "Spreadsheet loss-preservation envelope belongs to a different workbook snapshot",
        "invalid-package",
      );
    }
    LOSS_PRESERVATION.set(workbook, {
      sourceBytes,
      sourceDigest: normalizedEnvelope.sourceDigest,
      importedRevision: workbook.revision,
      opaqueContent: cloneOpaqueContent(preflight.opaqueContent),
      modelDigest: normalizedEnvelope.modelDigest,
    });
  }
}

function normalizeLossPreservationEnvelope(input: unknown): {
  sourceBytes: Uint8Array;
  sourceDigest: string;
  opaqueContent: SpreadsheetOpaqueContent;
  modelDigest: string;
} {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError("Spreadsheet loss-preservation envelope must be a plain object");
  }
  const record = input as Record<string, unknown>;
  const required = new Set([
    "version",
    "mediaType",
    "sourceBytes",
    "sourceDigest",
    "opaqueContent",
    "modelDigest",
  ]);
  const allowed = required;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError("Spreadsheet loss-preservation envelope contains an unknown property");
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`Spreadsheet loss-preservation envelope ${key} must be plain data`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`Spreadsheet loss-preservation envelope ${key} is required`);
    }
  }
  if (record.version !== 1 || record.mediaType !== XLSX_MEDIA_TYPE) {
    throw new TypeError("Unsupported spreadsheet loss-preservation envelope");
  }
  const source = record.sourceBytes;
  if (
    !(source instanceof Uint8Array) ||
    Object.getPrototypeOf(source) !== Uint8Array.prototype ||
    source.byteLength > DEFAULT_XLSX_IMPORT_LIMITS.compressedBytes
  ) {
    throw new TypeError("Spreadsheet loss-preservation sourceBytes must be a bounded Uint8Array");
  }
  if (typeof record.sourceDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.sourceDigest)) {
    throw new TypeError("Spreadsheet loss-preservation sourceDigest must be canonical SHA-256");
  }
  const opaqueContent = normalizeOpaqueContent(record.opaqueContent);
  if (typeof record.modelDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.modelDigest)) {
    throw new TypeError("Spreadsheet loss-preservation modelDigest must be canonical SHA-256");
  }
  return {
    sourceBytes: Uint8Array.prototype.slice.call(source) as Uint8Array,
    sourceDigest: record.sourceDigest,
    opaqueContent,
    modelDigest: record.modelDigest,
  };
}

function normalizeOpaqueContent(input: unknown): SpreadsheetOpaqueContent {
  assertPlainDataRecord(
    input,
    new Set(["parts", "relationships", "contentTypes", "features"]),
    "Spreadsheet opaque-content metadata",
  );
  const parts = denseDataArray(
    input.parts,
    DEFAULT_XLSX_IMPORT_LIMITS.entries,
    "Spreadsheet opaque part list",
  ).map((part) => {
    if (typeof part !== "string" || !isCanonicalPartName(part)) {
      throw new TypeError("Spreadsheet opaque part name is invalid");
    }
    return part;
  });
  const relationships = denseDataArray(
    input.relationships,
    DEFAULT_XLSX_IMPORT_LIMITS.relationships,
    "Spreadsheet opaque relationship list",
  ).map((relationship) => {
    assertPlainDataRecord(
      relationship,
      new Set(["sourcePart", "type", "targetPart"]),
      "Spreadsheet opaque relationship",
    );
    const { sourcePart, type, targetPart } = relationship;
    if (
      typeof sourcePart !== "string" ||
      (sourcePart !== "" && !isCanonicalPartName(sourcePart)) ||
      typeof type !== "string" ||
      type.length === 0 ||
      type.length > 2_048 ||
      !/^[\x21-\x7e]+$/.test(type) ||
      typeof targetPart !== "string" ||
      !isCanonicalPartName(targetPart)
    ) {
      throw new TypeError("Spreadsheet opaque relationship metadata is invalid");
    }
    return { sourcePart, type, targetPart };
  });
  const contentTypes = denseDataArray(
    input.contentTypes,
    DEFAULT_XLSX_IMPORT_LIMITS.entries,
    "Spreadsheet opaque content-type list",
  ).map((contentType) => {
    assertPlainDataRecord(
      contentType,
      new Set(["partName", "contentType"]),
      "Spreadsheet opaque content type",
    );
    if (
      typeof contentType.partName !== "string" ||
      !isCanonicalPartName(contentType.partName) ||
      typeof contentType.contentType !== "string" ||
      contentType.contentType.length === 0 ||
      contentType.contentType.length > 2_048 ||
      !/^[\x21-\x7e]+$/.test(contentType.contentType)
    ) {
      throw new TypeError("Spreadsheet opaque content-type metadata is invalid");
    }
    return {
      partName: contentType.partName,
      contentType: contentType.contentType,
    };
  });
  const features = denseDataArray(input.features, 4_096, "Spreadsheet opaque feature list").map(
    (feature) => {
      if (typeof feature !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(feature)) {
        throw new TypeError("Spreadsheet opaque feature name is invalid");
      }
      return feature;
    },
  );
  return {
    parts: canonicalUnique(parts, compareStrings, "Spreadsheet opaque part list"),
    relationships: canonicalUnique(
      relationships,
      compareOpaqueRelationships,
      "Spreadsheet opaque relationship list",
    ),
    contentTypes: canonicalUnique(
      contentTypes,
      compareOpaqueContentTypes,
      "Spreadsheet opaque content-type list",
    ),
    features: canonicalUnique(features, compareStrings, "Spreadsheet opaque feature list"),
  };
}

function canonicalUnique<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  label: string,
): T[] {
  const sorted = [...values].sort(compare);
  for (let index = 1; index < sorted.length; index += 1) {
    if (compare(sorted[index - 1]!, sorted[index]!) === 0) {
      throw new TypeError(`${label} contains duplicate metadata`);
    }
  }
  return sorted;
}

function denseDataArray(value: unknown, maximum: number, label: string): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must be a bounded ordinary array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only dense data elements`);
    }
  }
  for (const key of Object.keys(descriptors)) {
    if (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)) {
      throw new TypeError(`${label} contains an unknown property`);
    }
  }
  return Array.prototype.slice.call(value) as unknown[];
}

function assertPlainDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only enumerable data properties`);
    }
    if (!allowedKeys.has(key)) throw new TypeError(`${label} contains unknown property ${key}`);
  }
}

function sameOpaqueContent(
  left: SpreadsheetOpaqueContent,
  right: SpreadsheetOpaqueContent,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateImportOptions(options: SpreadsheetXlsxImportOptions): void {
  assertPlainDataRecord(options, new Set(["unsupportedContent", "limits"]), "XLSX import options");
  if (
    options.unsupportedContent !== undefined &&
    options.unsupportedContent !== "preserve" &&
    options.unsupportedContent !== "error"
  ) {
    throw new TypeError("XLSX unsupportedContent import policy is invalid");
  }
  if (options.limits !== undefined) {
    assertPlainDataRecord(
      options.limits,
      new Set(Object.keys(DEFAULT_XLSX_IMPORT_LIMITS)),
      "XLSX import limits",
    );
  }
}

function validateExportOptions(options: SpreadsheetXlsxExportOptions): void {
  assertPlainDataRecord(
    options,
    new Set(["fileName", "unsupportedContent"]),
    "XLSX export options",
  );
  if (
    options.unsupportedContent !== undefined &&
    options.unsupportedContent !== "error" &&
    options.unsupportedContent !== "discard"
  ) {
    throw new TypeError("XLSX unsupportedContent export policy is invalid");
  }
  if (
    options.fileName !== undefined &&
    (typeof options.fileName !== "string" ||
      options.fileName.length === 0 ||
      options.fileName.length > 255 ||
      /[\u0000-\u001f\u007f]/.test(options.fileName))
  ) {
    throw new TypeError("XLSX export fileName must contain 1 through 255 safe characters");
  }
}

function validateAttachOptions(options: Pick<SpreadsheetXlsxImportOptions, "limits">): void {
  assertPlainDataRecord(options, new Set(["limits"]), "XLSX envelope attach options");
  if (options.limits !== undefined) {
    assertPlainDataRecord(
      options.limits,
      new Set(Object.keys(DEFAULT_XLSX_IMPORT_LIMITS)),
      "XLSX import limits",
    );
  }
}

async function createExcelWorkbook(): Promise<ExcelJS.Workbook> {
  const module = await import("exceljs");
  const runtime = (module.default ?? module) as unknown as {
    Workbook: new () => ExcelJS.Workbook;
  };
  return new runtime.Workbook();
}

type ImportedLegacyComment = {
  sheetName: string;
  cell: string;
  text: string;
};

function importWorkbook(
  source: ExcelJS.Workbook,
  legacyComments: readonly ImportedLegacyComment[] = [],
): Workbook {
  const workbook = Workbook.create();
  workbook.transact(() => {
    for (const sourceSheet of source.worksheets) {
      const worksheet = workbook.worksheets.add(sourceSheet.name);
      const view = sourceSheet.views[0];
      worksheet.showGridLines = view?.showGridLines ?? true;
      if (view?.state === "frozen") {
        if (view.ySplit) worksheet.freezePanes.freezeRows(view.ySplit);
        if (view.xSplit) worksheet.freezePanes.freezeColumns(view.xSplit);
      }

      sourceSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (row.height && row.height > 0)
          worksheet.setRowHeight(rowNumber - 1, pointsToPixels(row.height));
        row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
          const value = importCellValue(cell.value);
          const formula = formulaOf(cell.value);
          worksheet.setCell(
            rowNumber - 1,
            columnNumber - 1,
            {
              value: formula ? null : value,
              formula,
              format: importCellFormat(cell),
            },
            "content",
          );
          importDataValidation(worksheet, rowNumber - 1, columnNumber - 1, cell.dataValidation);
        });
      });

      for (let columnNumber = 1; columnNumber <= sourceSheet.columnCount; columnNumber += 1) {
        const width = sourceSheet.getColumn(columnNumber).width;
        if (width && width > 0)
          worksheet.setColumnWidth(columnNumber - 1, excelWidthToPixels(width));
      }
      for (const merge of sourceSheet.model.merges ?? []) worksheet.mergeCells(merge);
      importTables(worksheet, sourceSheet);
      importImages(source, worksheet, sourceSheet);
      importConditionalFormattings(worksheet, sourceSheet);
    }
    for (const comment of legacyComments) {
      const worksheet = workbook.worksheets.getItem(comment.sheetName);
      workbook.comments.addThread({ cell: worksheet.getRange(comment.cell) }, comment.text);
    }
  });
  return workbook;
}

async function exportWorkbook(workbook: Workbook): Promise<ExcelJS.Workbook> {
  const output = await createExcelWorkbook();
  output.creator = "OpenGeni";
  output.lastModifiedBy = "OpenGeni";
  output.created = new Date(0);
  output.modified = new Date(0);
  output.calcProperties.fullCalcOnLoad = true;

  for (const worksheet of workbook.worksheets.items) {
    const sourceFreeze = worksheet.freezePanes.snapshot();
    const views: Array<Partial<ExcelJS.WorksheetView>> =
      sourceFreeze.rows || sourceFreeze.columns
        ? [
            {
              state: "frozen",
              xSplit: sourceFreeze.columns,
              ySplit: sourceFreeze.rows,
              showGridLines: worksheet.showGridLines,
            },
          ]
        : [{ state: "normal", showGridLines: worksheet.showGridLines }];
    const sheet = output.addWorksheet(worksheet.name, { views });

    for (const { row, col, data } of worksheet.cellEntries()) {
      const cell = sheet.getCell(row + 1, col + 1);
      if (data.formula) {
        assertSafeFormula(data.formula, `${worksheet.name}!${formatCellAddress({ row, col })}`);
        const result = workbook.valueAt(worksheet, { row, col });
        cell.value = {
          formula: data.formula.startsWith("=") ? data.formula.slice(1) : data.formula,
          ...(formulaResultForExcel(result) === undefined
            ? {}
            : { result: formulaResultForExcel(result) }),
        } as ExcelJS.CellFormulaValue;
      } else {
        cell.value = exportCellValue(data.value);
      }
      applyCellFormat(cell, data.format);
    }

    const used = worksheet.usedRangeAddress();
    if (used) {
      for (let col = used.col; col < used.col + used.colCount; col += 1) {
        sheet.getColumn(col + 1).width = pixelsToExcelWidth(worksheet.columnWidth(col));
      }
      for (let row = used.row; row < used.row + used.rowCount; row += 1) {
        sheet.getRow(row + 1).height = pixelsToPoints(worksheet.rowHeight(row));
      }
    }
    for (const merge of worksheet.mergeRegions()) sheet.mergeCells(formatRangeAddress(merge));
    exportDataValidations(worksheet, sheet);
    exportConditionalFormattings(worksheet, sheet);
    exportTables(worksheet, sheet);
    exportImages(output, worksheet, sheet);
    exportComments(workbook, worksheet, sheet);
  }
  return output;
}

function importCellValue(value: ExcelJS.CellValue): CellValue {
  if (value === undefined || value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date
  )
    return value;
  if ("formula" in value || "sharedFormula" in value) {
    const result = value.result;
    if (result === undefined) return null;
    if (
      typeof result === "string" ||
      typeof result === "number" ||
      typeof result === "boolean" ||
      result instanceof Date
    )
      return result;
    if ("error" in result) return result.error;
    return null;
  }
  if ("error" in value) return value.error;
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("text" in value) return value.text;
  return null;
}

function formulaOf(value: ExcelJS.CellValue): string | null {
  if (!value || typeof value !== "object") return null;
  if ("formula" in value && value.formula) return normalizeFormula(value.formula);
  if ("sharedFormula" in value && value.formula) return normalizeFormula(value.formula);
  return null;
}

function importCellFormat(cell: ExcelJS.Cell): CellFormat {
  const fill = cell.fill?.type === "pattern" ? colorFromExcel(cell.fill.fgColor) : undefined;
  const fontColor = colorFromExcel(cell.font?.color);
  const border = importBorders(cell.border);
  const format: CellFormat = {};
  if (fill) format.fill = fill;
  const font: NonNullable<CellFormat["font"]> = {};
  if (cell.font?.name) font.name = cell.font.name;
  if (cell.font?.size !== undefined) font.size = cell.font.size;
  if (cell.font?.bold !== undefined) font.bold = cell.font.bold;
  if (cell.font?.italic !== undefined) font.italic = cell.font.italic;
  if (cell.font?.underline !== undefined)
    font.underline = Boolean(cell.font.underline && cell.font.underline !== "none");
  if (fontColor) font.color = fontColor;
  if (Object.keys(font).length > 0) format.font = font;
  if (cell.numFmt) format.numberFormat = cell.numFmt;
  if (border) format.borders = border;
  const horizontal = importHorizontalAlignment(cell.alignment?.horizontal);
  if (horizontal) format.horizontalAlignment = horizontal;
  const vertical = importVerticalAlignment(cell.alignment?.vertical);
  if (vertical) format.verticalAlignment = vertical;
  if (cell.alignment?.wrapText !== undefined) format.wrapText = cell.alignment.wrapText;
  return format;
}

function applyCellFormat(cell: ExcelJS.Cell, format: CellFormat): void {
  if (format.fill) {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: colorToArgb(format.fill) },
    };
  }
  if (format.font) {
    const font: Partial<ExcelJS.Font> = {};
    if (format.font.name !== undefined) font.name = format.font.name;
    if (format.font.size !== undefined) font.size = format.font.size;
    if (format.font.bold !== undefined) font.bold = format.font.bold;
    if (format.font.italic !== undefined) font.italic = format.font.italic;
    if (format.font.underline !== undefined) font.underline = format.font.underline;
    if (format.font.color) font.color = { argb: colorToArgb(format.font.color) };
    cell.font = font;
  }
  if (format.numberFormat) cell.numFmt = format.numberFormat;
  if (format.borders) cell.border = exportBorders(format.borders);
  const alignment: Partial<ExcelJS.Alignment> = {};
  if (format.horizontalAlignment) alignment.horizontal = format.horizontalAlignment;
  if (format.verticalAlignment)
    alignment.vertical =
      format.verticalAlignment === "center" ? "middle" : format.verticalAlignment;
  if (format.wrapText !== undefined) alignment.wrapText = format.wrapText;
  if (Object.keys(alignment).length > 0) cell.alignment = alignment;
}

function importBorders(borders: Partial<ExcelJS.Borders> | undefined): CellFormat["borders"] {
  if (!borders) return undefined;
  const imported: NonNullable<CellFormat["borders"]> = {};
  const top = importBorder(borders.top);
  const right = importBorder(borders.right);
  const bottom = importBorder(borders.bottom);
  const left = importBorder(borders.left);
  if (top) imported.top = top;
  if (right) imported.right = right;
  if (bottom) imported.bottom = bottom;
  if (left) imported.left = left;
  return Object.keys(imported).length > 0 ? imported : undefined;
}

function importBorder(border: Partial<ExcelJS.Border> | undefined): BorderConfig | undefined {
  if (!border?.style) return undefined;
  const imported: BorderConfig = { style: border.style };
  const color = colorFromExcel(border.color);
  if (color) imported.color = color;
  return imported;
}

function exportBorders(borders: NonNullable<CellFormat["borders"]>): Partial<ExcelJS.Borders> {
  const fallback: BorderConfig | undefined =
    borders.style || borders.color
      ? {
          style: borders.style ?? "thin",
          ...(borders.color ? { color: borders.color } : {}),
        }
      : undefined;
  const useFallback = borders.preset === "all" || borders.preset === "outside";
  const exported: Partial<ExcelJS.Borders> = {};
  const top = exportBorder(borders.top ?? (useFallback ? fallback : undefined));
  const right = exportBorder(borders.right ?? (useFallback ? fallback : undefined));
  const doubleBottom: BorderConfig = {
    style: "double",
    ...(borders.color ? { color: borders.color } : {}),
  };
  const bottom = exportBorder(
    borders.bottom ??
      (borders.preset === "doubleBottom" ? doubleBottom : useFallback ? fallback : undefined),
  );
  const left = exportBorder(borders.left ?? (useFallback ? fallback : undefined));
  if (top) exported.top = top;
  if (right) exported.right = right;
  if (bottom) exported.bottom = bottom;
  if (left) exported.left = left;
  return exported;
}

function exportBorder(border: BorderConfig | undefined): Partial<ExcelJS.Border> | undefined {
  if (!border) return undefined;
  const exported: Partial<ExcelJS.Border> = {
    style: excelBorderStyle(border.style),
  };
  if (border.color) exported.color = { argb: colorToArgb(border.color) };
  return exported;
}

function importDataValidation(
  worksheet: Worksheet,
  row: number,
  col: number,
  validation: ExcelJS.DataValidation,
): void {
  if (!validation?.type) return;
  worksheet.dataValidations.add({
    range: formatCellAddress({ row, col }),
    rule: importDataValidationRule(validation),
  });
}

function exportDataValidations(worksheet: Worksheet, target: ExcelJS.Worksheet): void {
  for (const entry of worksheet.dataValidations.all()) {
    const validation = exportDataValidationRule(entry.config.rule);
    forEachCell(entry.range, (row, col) => {
      target.getCell(row + 1, col + 1).dataValidation = structuredClone(validation);
    });
  }
}

function importDataValidationRule(validation: ExcelJS.DataValidation): Record<string, unknown> {
  const source = structuredClone(validation as unknown as Record<string, unknown>);
  const formulae = source.formulae;
  if (source.type === "list" && Array.isArray(formulae) && formulae.length === 1) {
    const values = inlineValidationValues(formulae[0]);
    if (values) {
      delete source.formulae;
      source.values = values;
    }
  }
  return source;
}

function exportDataValidationRule(rule: Record<string, unknown>): ExcelJS.DataValidation {
  const output = structuredClone(rule);
  if (Array.isArray(output.values)) {
    if (output.type !== "list" || output.values.some((value) => typeof value !== "string")) {
      throw new TypeError("Data validation values require a list of strings");
    }
    const literal = `"${output.values
      .map((value) => (value as string).replaceAll('"', '""'))
      .join(",")}"`;
    if (literal.length > 255) {
      throw new TypeError("Inline data validation values exceed Excel's 255-character limit");
    }
    output.formulae = [literal];
    delete output.values;
  } else if (!Array.isArray(output.formulae)) {
    const formulae = [];
    if (output.formula1 !== undefined) formulae.push(output.formula1);
    if (output.formula2 !== undefined) formulae.push(output.formula2);
    if (formulae.length > 0) output.formulae = formulae;
    delete output.formula1;
    delete output.formula2;
  }
  return output as unknown as ExcelJS.DataValidation;
}

function inlineValidationValues(value: unknown): string[] | null {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    !value.startsWith('"') ||
    !value.endsWith('"')
  ) {
    return null;
  }
  const input = value.slice(1, -1);
  const values: string[] = [];
  let current = "";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"' && input[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (character === ",") {
      values.push(current);
      current = "";
    } else current += character;
  }
  values.push(current);
  return values;
}

type ExcelConditionalFormatting = {
  ref: string;
  rules: Array<Record<string, unknown>>;
};

function importConditionalFormattings(worksheet: Worksheet, source: ExcelJS.Worksheet): void {
  const entries =
    (
      source as unknown as {
        conditionalFormattings?: ExcelConditionalFormatting[];
      }
    ).conditionalFormattings ?? [];
  for (const entry of entries) {
    const range = parseRangeAddress(entry.ref);
    for (const sourceRule of entry.rules ?? []) {
      const rule = stripUndefinedProperties(structuredClone(sourceRule));
      const type = rule.type;
      if (typeof type !== "string") throw new TypeError("XLSX conditional format type is missing");
      // Strict preflight records safe, unsupported rule kinds as source-only fidelity. Do not
      // coerce them into a different editable rule.
      if (!SUPPORTED_CONDITIONAL_FORMAT_RULE_TYPES.has(type.toLowerCase())) continue;
      delete rule.type;
      delete rule.priority;
      const formulae = rule.formulae;
      if (Array.isArray(formulae)) {
        const normalizedFormulae = formulae.map(importConditionalFormula);
        rule.formula = normalizedFormulae.length === 1 ? normalizedFormulae[0] : normalizedFormulae;
        delete rule.formulae;
      }
      if (rule.style && typeof rule.style === "object") {
        rule.format = importConditionalStyle(rule.style as Record<string, unknown>);
        delete rule.style;
      }
      worksheet.conditionalFormattings.add(range, type, rule);
    }
  }
}

function stripUndefinedProperties<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedProperties(item)) as T;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) output[key] = stripUndefinedProperties(item);
    }
    return output as T;
  }
  return value;
}

function exportConditionalFormattings(worksheet: Worksheet, target: ExcelJS.Worksheet): void {
  const add = (
    target as unknown as {
      addConditionalFormatting: (input: ExcelConditionalFormatting) => void;
    }
  ).addConditionalFormatting.bind(target);
  for (const entry of worksheet.conditionalFormattings.all()) {
    const config = structuredClone(entry.config);
    const formula = config.formula;
    if (formula !== undefined) {
      config.formulae = Array.isArray(formula) ? formula : [formula];
      delete config.formula;
    }
    if (config.format && typeof config.format === "object") {
      config.style = exportConditionalStyle(config.format as Record<string, unknown>);
      delete config.format;
    }
    add({
      ref: formatRangeAddress(entry.range),
      rules: [{ type: entry.ruleType, ...config }],
    });
  }
}

function importConditionalStyle(style: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const fill = style.fill as
    | { fgColor?: Partial<ExcelJS.Color>; bgColor?: Partial<ExcelJS.Color> }
    | undefined;
  const fillColor = colorFromExcel(fill?.fgColor ?? fill?.bgColor);
  if (fillColor) output.fill = fillColor;
  const font = style.font as
    | (Partial<ExcelJS.Font> & { color?: Partial<ExcelJS.Color> })
    | undefined;
  const fontColor = colorFromExcel(font?.color);
  if (font) {
    const normalizedFont: Record<string, unknown> = {};
    for (const key of ["name", "size", "bold", "italic", "underline"] as const) {
      if (font[key] !== null && font[key] !== undefined) normalizedFont[key] = font[key];
    }
    if (fontColor) normalizedFont.color = fontColor;
    if (Object.keys(normalizedFont).length > 0) output.font = normalizedFont;
  }
  if (style.border && typeof style.border === "object") output.border = style.border;
  if (typeof style.numFmt === "string") output.numberFormat = style.numFmt;
  return output;
}

function importConditionalFormula(value: unknown): unknown {
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function exportConditionalStyle(format: Record<string, unknown>): Record<string, unknown> {
  const output = structuredClone(format);
  if (typeof output.fill === "string") {
    output.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: colorToArgb(output.fill) },
    };
  }
  const font = output.font as { color?: unknown } | undefined;
  if (font && typeof font.color === "string") {
    output.font = { ...font, color: { argb: colorToArgb(font.color) } };
  }
  if (output.numberFormat !== undefined && output.numFmt === undefined) {
    output.numFmt = output.numberFormat;
    delete output.numberFormat;
  }
  return output;
}

function exportComments(workbook: Workbook, worksheet: Worksheet, target: ExcelJS.Worksheet): void {
  for (const comment of workbook.toJSON().comments) {
    if (comment.sheetId !== worksheet.id || comment.comments.length === 0) continue;
    target.getCell(comment.cell.row + 1, comment.cell.col + 1).note = comment.comments
      .map((item) => item.text)
      .join("\n\n");
  }
}

type ExcelTableModel = {
  table: {
    name: string;
    tableRef: string;
    headerRow: boolean;
    totalsRow: boolean;
    style?: {
      theme?: string;
      showColumnStripes?: boolean;
    };
  };
};

function importTables(worksheet: Worksheet, source: ExcelJS.Worksheet): void {
  const tables = source.getTables() as unknown as ExcelTableModel[];
  for (const sourceTable of tables) {
    const model = sourceTable.table;
    if (!model?.name || !model.tableRef) continue;
    const table = worksheet.tables.add(model.tableRef, model.headerRow !== false, model.name);
    table.showTotals = model.totalsRow === true;
    table.style = model.style?.theme ?? "TableStyleMedium2";
    table.showBandedColumns = model.style?.showColumnStripes ?? false;
  }
}

function exportTables(worksheet: Worksheet, target: ExcelJS.Worksheet): void {
  for (const table of worksheet.tables.items) {
    const values = table.range.values;
    const firstRow = values[0] ?? [];
    const columns = firstRow.map((value, index) => ({
      name: String(value ?? `Column${index + 1}`),
      filterButton: table.showFilterButton,
    }));
    if (columns.length === 0) continue;
    target.addTable({
      name: table.name,
      ref: formatCellAddress(table.range.address),
      headerRow: table.hasHeaders && table.showHeaders,
      totalsRow: table.showTotals,
      style: {
        theme: excelTableTheme(table.style),
        showColumnStripes: table.showBandedColumns,
        showRowStripes: !table.showBandedColumns,
      },
      columns,
      rows: exportTableRows(
        worksheet,
        table.range.address,
        table.hasHeaders ? 1 : 0,
        table.showTotals ? 1 : 0,
      ),
    });
  }
}

function exportTableRows(
  worksheet: Worksheet,
  address: RangeAddress,
  headerRows: number,
  totalRows: number,
): ExcelJS.CellValue[][] {
  const rows: ExcelJS.CellValue[][] = [];
  const end = address.row + address.rowCount - totalRows;
  for (let row = address.row + headerRows; row < end; row += 1) {
    const values: ExcelJS.CellValue[] = [];
    for (let col = address.col; col < address.col + address.colCount; col += 1) {
      const data = worksheet.cellData(row, col);
      if (data.formula) {
        assertSafeFormula(data.formula, `${worksheet.name}!${formatCellAddress({ row, col })}`);
        const result = formulaResultForExcel(worksheet.workbook.valueAt(worksheet, { row, col }));
        values.push({
          formula: data.formula.startsWith("=") ? data.formula.slice(1) : data.formula,
          ...(result === undefined ? {} : { result }),
        });
      } else {
        values.push(exportCellValue(data.value));
      }
    }
    rows.push(values);
  }
  return rows;
}

function importImages(
  source: ExcelJS.Workbook,
  worksheet: Worksheet,
  sourceSheet: ExcelJS.Worksheet,
): void {
  for (const image of sourceSheet.getImages()) {
    const media = source.getImage(Number(image.imageId));
    if (!media?.buffer || !["png", "jpeg", "gif"].includes(media.extension)) continue;
    const range = image.range as unknown as {
      tl: { row: number; col: number };
      br?: { row: number; col: number };
      ext?: { width: number; height: number };
    };
    const fromRow = Math.max(0, Math.floor(range.tl.row));
    const fromCol = Math.max(0, Math.floor(range.tl.col));
    const rowOffsetPx = Math.max(0, (range.tl.row - fromRow) * worksheet.rowHeight(fromRow));
    const colOffsetPx = Math.max(0, (range.tl.col - fromCol) * worksheet.columnWidth(fromCol));
    const width = Math.max(
      1,
      range.ext?.width ??
        ((range.br?.col ?? range.tl.col + 1) - range.tl.col) * worksheet.columnWidth(fromCol),
    );
    const height = Math.max(
      1,
      range.ext?.height ??
        ((range.br?.row ?? range.tl.row + 1) - range.tl.row) * worksheet.rowHeight(fromRow),
    );
    worksheet.images.add({
      blob: copyArrayBuffer(media.buffer),
      contentType: media.extension === "jpeg" ? "image/jpeg" : `image/${media.extension}`,
      anchor: {
        from: {
          row: fromRow,
          col: fromCol,
          ...(rowOffsetPx > 0 ? { rowOffsetPx } : {}),
          ...(colOffsetPx > 0 ? { colOffsetPx } : {}),
        },
        extent: { widthPx: width, heightPx: height },
      },
    });
  }
}

function exportImages(
  source: ExcelJS.Workbook,
  worksheet: Worksheet,
  target: ExcelJS.Worksheet,
): void {
  for (const image of worksheet.images.items) {
    const data = safeExportImage(image.config);
    const extension = imageExtension(data);
    const imageId = data.dataUrl
      ? source.addImage({ base64: data.dataUrl, extension })
      : data.blob
        ? source.addImage({
            buffer: data.blob as NonNullable<ExcelJS.Image["buffer"]>,
            extension,
          })
        : null;
    if (imageId === null) continue;
    const rowOffset =
      (data.anchor.from.rowOffsetPx ?? 0) / worksheet.rowHeight(data.anchor.from.row);
    const colOffset =
      (data.anchor.from.colOffsetPx ?? 0) / worksheet.columnWidth(data.anchor.from.col);
    target.addImage(imageId, {
      tl: {
        col: data.anchor.from.col + colOffset,
        row: data.anchor.from.row + rowOffset,
      },
      ext: {
        width: data.anchor.extent.widthPx,
        height: data.anchor.extent.heightPx,
      },
      editAs: "oneCell",
    });
  }
}

function imageExtension(image: SpreadsheetImageConfig): "png" | "jpeg" | "gif" {
  const contentType = image.contentType ?? image.dataUrl?.slice(5, image.dataUrl.indexOf(";"));
  if (contentType === "image/jpeg" || contentType === "image/jpg") return "jpeg";
  if (contentType === "image/gif") return "gif";
  return "png";
}

function formulaResultForExcel(
  value: FormulaResult,
): number | string | boolean | Date | ExcelJS.CellErrorValue | undefined {
  if (value === null) return undefined;
  if (typeof value === "string" && isFormulaError(value)) {
    if (value === "#CYCLE!") return { error: "#VALUE!" };
    return { error: value };
  }
  return value;
}

function exportCellValue(value: CellValue): ExcelJS.CellValue {
  return value;
}

function normalizeFormula(formula: string): string {
  return formula.startsWith("=") ? formula : `=${formula}`;
}

function importHorizontalAlignment(
  value: ExcelJS.Alignment["horizontal"] | undefined,
): CellFormat["horizontalAlignment"] {
  if (value === "left" || value === "center" || value === "right" || value === "justify")
    return value;
  return undefined;
}

function importVerticalAlignment(
  value: ExcelJS.Alignment["vertical"] | undefined,
): CellFormat["verticalAlignment"] {
  if (value === "middle") return "center";
  if (value === "top" || value === "bottom") return value;
  return undefined;
}

function colorFromExcel(color: Partial<ExcelJS.Color> | undefined): string | undefined {
  const argb = color?.argb;
  if (!argb) return undefined;
  const normalized = argb.replace(/^#/, "");
  if (/^[0-9a-f]{8}$/i.test(normalized)) return `#${normalized.slice(2)}`;
  if (/^[0-9a-f]{6}$/i.test(normalized)) return `#${normalized}`;
  return undefined;
}

function colorToArgb(color: string): string {
  const normalized = color.trim().replace(/^#/, "");
  if (/^[0-9a-f]{8}$/i.test(normalized)) return normalized.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(normalized)) return `FF${normalized.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/i.test(normalized)) {
    return `FF${normalized
      .split("")
      .map((character) => character.repeat(2))
      .join("")}`.toUpperCase();
  }
  return "FF000000";
}

function excelBorderStyle(value: string | undefined): ExcelJS.BorderStyle {
  const supported: readonly ExcelJS.BorderStyle[] = [
    "thin",
    "dotted",
    "hair",
    "medium",
    "double",
    "thick",
    "dashed",
    "dashDot",
    "dashDotDot",
    "slantDashDot",
    "mediumDashed",
    "mediumDashDotDot",
    "mediumDashDot",
  ];
  return supported.includes(value as ExcelJS.BorderStyle) ? (value as ExcelJS.BorderStyle) : "thin";
}

function excelTableTheme(value: string): NonNullable<ExcelJS.TableStyleProperties["theme"]> {
  return /^TableStyle(?:Dark|Light|Medium)\d+$/.test(value)
    ? (value as NonNullable<ExcelJS.TableStyleProperties["theme"]>)
    : "TableStyleMedium2";
}

function excelWidthToPixels(width: number): number {
  return Math.max(1, Math.round(width * 7 + 5));
}

function pixelsToExcelWidth(pixels: number): number {
  return Math.max(0.1, Number(((pixels - 5) / 7).toFixed(2)));
}

function pointsToPixels(points: number): number {
  return points * (96 / 72);
}

function pixelsToPoints(pixels: number): number {
  return Number((pixels * (72 / 96)).toFixed(2));
}

function copyArrayBuffer(value: ArrayBuffer): ArrayBuffer {
  return new Uint8Array(value).slice().buffer;
}

function isFormulaError(value: string): value is FormulaErrorValue {
  return ["#DIV/0!", "#N/A", "#NAME?", "#NUM!", "#REF!", "#VALUE!", "#CYCLE!"].includes(value);
}

function forEachCell(address: RangeAddress, callback: (row: number, col: number) => void): void {
  for (let row = address.row; row < address.row + address.rowCount; row += 1) {
    for (let col = address.col; col < address.col + address.colCount; col += 1) callback(row, col);
  }
}

async function toBytes(
  input: FileBlob | Blob | ArrayBuffer | Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  if (input instanceof Uint8Array) {
    if (input.byteLength > maxBytes) {
      throw securityError("XLSX exceeds the compressed-size limit", "limit-exceeded");
    }
    return Uint8Array.prototype.slice.call(input) as Uint8Array;
  }
  if (input instanceof ArrayBuffer) {
    if (input.byteLength > maxBytes) {
      throw securityError("XLSX exceeds the compressed-size limit", "limit-exceeded");
    }
    return new Uint8Array(input.slice(0));
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    const size = Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get?.call(input);
    if (typeof size !== "number" || size > maxBytes) {
      throw securityError("XLSX exceeds the compressed-size limit", "limit-exceeded");
    }
    return new Uint8Array(await Blob.prototype.arrayBuffer.call(input));
  }
  throw new TypeError("XLSX input must be a Blob, ArrayBuffer, or Uint8Array");
}

async function workbookModelDigest(workbook: Workbook): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(workbook.toJSON())));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", owned));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** ExcelJS stamps ZIP headers with wall-clock time; normalize package metadata only. */
function normalizeGeneratedZip(input: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocdBytes = 22;
  if (bytes.byteLength < minimumEocdBytes) {
    throw new Error("Generated XLSX ZIP has no end-of-central-directory record");
  }
  const firstCandidate = Math.max(0, bytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - minimumEocdBytes; offset >= firstCandidate; offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + minimumEocdBytes + view.getUint16(offset + 20, true) === bytes.byteLength
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Generated XLSX ZIP has an invalid end-of-central-directory record");
  }
  const disk = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const entries = view.getUint16(eocdOffset + 10, true);
  const centralBytes = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entries ||
    entries === 0xffff ||
    centralBytes === 0xffff_ffff ||
    centralOffset === 0xffff_ffff ||
    centralOffset + centralBytes !== eocdOffset
  ) {
    throw new Error("Generated XLSX ZIP uses an unsupported central-directory layout");
  }
  let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > eocdOffset || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Generated XLSX ZIP central directory is malformed");
    }
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (
      nextOffset > eocdOffset ||
      localOffset + 30 > centralOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50
    ) {
      throw new Error("Generated XLSX ZIP entry offsets are malformed");
    }
    const localNameBytes = view.getUint16(localOffset + 26, true);
    const localExtraBytes = view.getUint16(localOffset + 28, true);
    const localExtraOffset = localOffset + 30 + localNameBytes;
    if (localExtraOffset + localExtraBytes > centralOffset) {
      throw new Error("Generated XLSX ZIP local metadata is malformed");
    }
    // Portable DOS 1980-01-01 00:00. File bytes and CRCs are untouched.
    view.setUint16(offset + 12, 0, true);
    view.setUint16(offset + 14, 0x21, true);
    view.setUint16(localOffset + 10, 0, true);
    view.setUint16(localOffset + 12, 0x21, true);
    normalizeZipTimestampExtras(view, offset + 46 + nameBytes, extraBytes);
    normalizeZipTimestampExtras(view, localExtraOffset, localExtraBytes);
    offset = nextOffset;
  }
  if (offset !== eocdOffset) {
    throw new Error("Generated XLSX ZIP central-directory size is inconsistent");
  }
  return bytes;
}

function normalizeZipTimestampExtras(view: DataView, start: number, length: number): void {
  const end = start + length;
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) throw new Error("Generated XLSX ZIP extra field is malformed");
    const kind = view.getUint16(offset, true);
    const fieldBytes = view.getUint16(offset + 2, true);
    const dataStart = offset + 4;
    const dataEnd = dataStart + fieldBytes;
    if (dataEnd > end) throw new Error("Generated XLSX ZIP extra field is malformed");
    if (kind === 0x5455 && fieldBytes > 0) {
      const flags = view.getUint8(dataStart);
      let timestampOffset = dataStart + 1;
      for (const flag of [1, 2, 4]) {
        if ((flags & flag) === 0) continue;
        if (timestampOffset + 4 > dataEnd) {
          throw new Error("Generated XLSX ZIP timestamp field is malformed");
        }
        view.setUint32(timestampOffset, 315_532_800, true);
        timestampOffset += 4;
      }
    }
    offset = dataEnd;
  }
}

type ZipEntry = BoundedZipEntry;

async function preflightXlsx(
  bytes: Uint8Array,
  limits: SpreadsheetXlsxImportLimits,
): Promise<{
  opaqueContent: SpreadsheetOpaqueContent;
  comments: readonly ImportedLegacyComment[];
}> {
  if (bytes.byteLength > limits.compressedBytes) {
    throw securityError(
      `XLSX exceeds the ${limits.compressedBytes} byte compressed-size limit`,
      "limit-exceeded",
    );
  }
  const entries = zipEntries(bytes, limits);
  const entryNames = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry.name]));
  for (const required of [
    "[content_types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
  ]) {
    if (!entryNames.has(required)) {
      throw securityError("Required XLSX package part is missing", "invalid-package", required);
    }
  }
  let expandedBytes = 0;
  let inspectedXmlBytes = 0;
  let xmlAttributes = 0;
  let xmlElements = 0;
  let xmlTextCharacters = 0;
  let worksheetCells = 0;
  let formulas = 0;
  let formulaBytes = 0;
  let sharedStrings = 0;
  let cellStyles = 0;
  let styleRecords = 0;
  let comments = 0;
  let relationships = 0;
  let mediaEntries = 0;
  let mediaBytes = 0;
  let imagePixels = 0;
  const allRelationships: InspectedRelationship[] = [];
  const contentTypeDeclarations: ContentTypeDeclaration[] = [];
  const workbookSheets: WorkbookSheetBinding[] = [];
  const legacyCommentParts: Array<{
    partName: string;
    comments: LegacyCommentRecord[];
  }> = [];
  const opaqueParts = new Set<string>();
  const opaqueFeatures = new Set<string>();
  const mediaTypes = new Map<string, string>();
  for (const entry of entries) {
    if (entry.directory) {
      await verifyBoundedZipEntry(bytes, entry, 0, xlsxZipFailure);
      continue;
    }
    expandedBytes += entry.expandedSize;
    if (expandedBytes > limits.expandedBytes) {
      throw securityError(
        `XLSX expands beyond the ${limits.expandedBytes} byte package limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    if (entry.expandedSize > limits.entryBytes) {
      throw securityError(
        `XLSX entry exceeds the ${limits.entryBytes} byte entry limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    if (
      entry.expandedSize > 1_048_576 &&
      entry.expandedSize / Math.max(1, entry.compressedSize) > limits.compressionRatio
    ) {
      throw securityError(
        `XLSX entry exceeds the ${limits.compressionRatio}:1 compression-ratio limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    rejectActiveEntry(entry.name);
    if (isMediaPart(entry.name)) {
      mediaEntries += 1;
      mediaBytes += entry.expandedSize;
      if (
        mediaEntries > limits.mediaEntries ||
        entry.expandedSize > limits.mediaEntryBytes ||
        mediaBytes > limits.mediaBytes
      ) {
        throw securityError(
          "Spreadsheet media exceeds its bounded import limits",
          "limit-exceeded",
          entry.name,
        );
      }
      const media = await inflateBoundedZipEntry(
        bytes,
        entry,
        limits.mediaEntryBytes,
        xlsxZipFailure,
      );
      let metadata: ReturnType<typeof inspectRasterImage>;
      try {
        metadata = inspectRasterImage(media);
      } catch (error) {
        const failure = securityError(
          `Spreadsheet media is not a structurally valid bounded raster image (${error instanceof Error ? error.message : "invalid image"})`,
          "active-content",
          entry.name,
        );
        Object.defineProperty(failure, "cause", {
          value: error,
          enumerable: false,
        });
        throw failure;
      }
      const expectedType = mediaTypeForExtension(entry.name);
      if (metadata.contentType !== expectedType) {
        throw securityError(
          "Spreadsheet media MIME does not match its file signature",
          "active-content",
          entry.name,
        );
      }
      imagePixels += metadata.width * metadata.height;
      if (imagePixels > limits.imagePixels) {
        throw securityError(
          "Spreadsheet images exceed their decoded-pixel limit",
          "limit-exceeded",
          entry.name,
        );
      }
      mediaTypes.set(entry.name.toLowerCase(), metadata.contentType);
      continue;
    }
    if (!isInspectableXml(entry.name)) {
      await verifyBoundedZipEntry(bytes, entry, limits.entryBytes, xlsxZipFailure);
      throw securityError(
        "XLSX part is neither modeled nor in the bounded inert OOXML allowlist",
        "active-content",
        entry.name,
      );
    }
    const disposition = partDisposition(entry.name);
    inspectedXmlBytes += entry.expandedSize;
    if (inspectedXmlBytes > limits.inspectedXmlBytes) {
      throw securityError(
        `Inspectable OOXML exceeds the ${limits.inspectedXmlBytes} byte inspection limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    const xmlBytes = await inflateBoundedZipEntry(bytes, entry, limits.entryBytes, xlsxZipFailure);
    const xml = decodeXml(xmlBytes, entry.name);
    const counts = inspectXml(xml, entry.name, limits, entryNames);
    xmlAttributes += counts.attributes;
    xmlElements += counts.elements;
    xmlTextCharacters += counts.textCharacters;
    worksheetCells += counts.worksheetCells;
    formulas += counts.formulas;
    formulaBytes += counts.formulaBytes;
    sharedStrings += counts.sharedStrings;
    cellStyles += counts.cellStyles;
    styleRecords += counts.styleRecords;
    comments += counts.comments.length;
    relationships += counts.relationships.length;
    allRelationships.push(...counts.relationships);
    contentTypeDeclarations.push(...counts.contentTypes);
    workbookSheets.push(...counts.workbookSheets);
    if (counts.comments.length > 0) {
      legacyCommentParts.push({
        partName: entry.name,
        comments: counts.comments,
      });
    }
    for (const feature of counts.opaqueFeatures) {
      opaqueFeatures.add(feature);
      opaqueParts.add(entry.name);
    }
    if (xmlAttributes > limits.xmlAttributes) {
      throw securityError(
        `OOXML package exceeds the ${limits.xmlAttributes} attribute limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    if (relationships > limits.relationships) {
      throw securityError(
        `OOXML package exceeds the ${limits.relationships} relationship limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    if (xmlElements > limits.xmlElements) {
      throw securityError(
        `OOXML package exceeds the ${limits.xmlElements} element limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    if (xmlTextCharacters > limits.xmlTextCharacters) {
      throw securityError(
        `OOXML package exceeds the ${limits.xmlTextCharacters} text-character limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    if (worksheetCells > limits.worksheetCells) {
      throw securityError(
        `OOXML package exceeds the ${limits.worksheetCells} worksheet-cell limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    if (sharedStrings > limits.sharedStrings) {
      throw securityError(
        `OOXML package exceeds the ${limits.sharedStrings} shared-string limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    if (cellStyles > limits.cellStyles) {
      throw securityError(
        `OOXML package exceeds the ${limits.cellStyles} cell-style limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    if (
      formulas > limits.formulas ||
      formulaBytes > limits.formulaBytes ||
      styleRecords > limits.styleRecords
    ) {
      throw securityError(
        "OOXML package exceeds formula or style aggregate limits",
        "limit-exceeded",
        entry.name,
      );
    }
    if (comments > limits.comments) {
      throw securityError(
        `OOXML package exceeds the ${limits.comments} comment limit`,
        "limit-exceeded",
        entry.name,
      );
    }
    if (disposition === "reject") {
      throw securityError(
        "XLSX XML part is neither modeled nor in the bounded inert allowlist",
        "active-content",
        entry.name,
      );
    }
    if (disposition === "opaque") {
      opaqueParts.add(entry.name);
      opaqueFeatures.add(opaqueFeatureForPart(entry.name));
    }
  }
  const opaqueRelationships: SpreadsheetOpaqueRelationship[] = [];
  for (const relationship of allRelationships) {
    if (
      relationship.opaque ||
      opaqueParts.has(relationship.sourcePart) ||
      opaqueParts.has(relationship.targetPart)
    ) {
      const { opaque: _opaque, id: _id, kind: _kind, ...metadata } = relationship;
      opaqueRelationships.push(metadata);
      opaqueParts.add(relationshipPartForSource(relationship.sourcePart));
    }
  }
  const contentTypes = resolveContentTypes(
    entries,
    contentTypeDeclarations,
    mediaTypes,
    opaqueParts,
  );
  const importedComments = resolveLegacyComments(
    workbookSheets,
    allRelationships,
    legacyCommentParts,
  );
  return {
    opaqueContent: {
      parts: [...opaqueParts].sort(compareStrings),
      relationships: opaqueRelationships.sort(compareOpaqueRelationships),
      contentTypes: contentTypes
        .filter((contentType) => opaqueParts.has(contentType.partName))
        .sort(compareOpaqueContentTypes),
      features: [...opaqueFeatures].sort(compareStrings),
    },
    comments: importedComments,
  };
}

function resolveLegacyComments(
  workbookSheets: readonly WorkbookSheetBinding[],
  relationships: readonly InspectedRelationship[],
  parts: readonly {
    partName: string;
    comments: readonly LegacyCommentRecord[];
  }[],
): ImportedLegacyComment[] {
  const worksheetPartsByRelationship = new Map(
    relationships
      .filter(
        (relationship) =>
          relationship.sourcePart.toLowerCase() === "xl/workbook.xml" &&
          relationship.kind === "worksheet",
      )
      .map((relationship) => [relationship.id, relationship.targetPart]),
  );
  const sheetNamesByPart = new Map<string, string>();
  for (const sheet of workbookSheets) {
    const partName = worksheetPartsByRelationship.get(sheet.relationshipId);
    if (!partName || sheetNamesByPart.has(partName.toLowerCase())) {
      throw securityError(
        "Workbook sheet relationship is missing or duplicated",
        "invalid-package",
        "xl/workbook.xml",
      );
    }
    sheetNamesByPart.set(partName.toLowerCase(), sheet.name);
  }

  const sheetPartsByCommentPart = new Map<string, string>();
  for (const relationship of relationships) {
    if (relationship.kind !== "comments") continue;
    const target = relationship.targetPart.toLowerCase();
    if (sheetPartsByCommentPart.has(target)) {
      throw securityError(
        "Spreadsheet comment part is linked from multiple worksheets",
        "invalid-package",
        relationship.targetPart,
      );
    }
    sheetPartsByCommentPart.set(target, relationship.sourcePart);
  }

  const result: ImportedLegacyComment[] = [];
  const cells = new Set<string>();
  for (const part of parts) {
    const sheetPart = sheetPartsByCommentPart.get(part.partName.toLowerCase());
    if (!sheetPart) continue;
    const sheetName = sheetNamesByPart.get(sheetPart.toLowerCase());
    if (!sheetName) {
      throw securityError(
        "Spreadsheet comment relationship does not target a workbook sheet",
        "invalid-package",
        part.partName,
      );
    }
    for (const comment of part.comments) {
      const key = `${sheetName}\u0000${comment.cell}`;
      if (cells.has(key)) {
        throw securityError(
          "Spreadsheet has duplicate comments for one cell",
          "invalid-package",
          part.partName,
        );
      }
      cells.add(key);
      result.push({ sheetName, cell: comment.cell, text: comment.text });
    }
  }
  return result;
}

function isMediaPart(name: string): boolean {
  return /^xl\/media\/[^/]+\.(?:png|jpe?g|gif)$/i.test(name);
}

function mediaTypeForExtension(name: string): "image/png" | "image/jpeg" | "image/gif" {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.gif$/i.test(name)) return "image/gif";
  throw securityError("Spreadsheet media extension is unsupported", "active-content", name);
}

function partDisposition(name: string): "modeled" | "opaque" | "reject" {
  if (
    name === "[Content_Types].xml" ||
    name === "_rels/.rels" ||
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    /^xl\/worksheets\/[^/]+\.xml$/i.test(name) ||
    /^xl\/worksheets\/_rels\/[^/]+\.xml\.rels$/i.test(name) ||
    /^xl\/(?:styles|sharedStrings|calcChain)\.xml$/i.test(name) ||
    /^xl\/tables\/[^/]+\.xml$/i.test(name) ||
    /^xl\/drawings\/[^/]+\.xml$/i.test(name) ||
    /^xl\/drawings\/_rels\/[^/]+\.xml\.rels$/i.test(name) ||
    /^xl\/comments[^/]*\.xml$/i.test(name) ||
    /^xl\/drawings\/[^/]+\.vml$/i.test(name)
  ) {
    return "modeled";
  }
  if (
    /^docProps\/custom\.xml$/i.test(name) ||
    /^xl\/charts\/[^/]+\.xml$/i.test(name) ||
    /^xl\/charts\/_rels\/[^/]+\.xml\.rels$/i.test(name) ||
    /^customXml\/item(?:Props)?\d+\.xml$/i.test(name) ||
    /^customXml\/_rels\/item\d+\.xml\.rels$/i.test(name)
  ) {
    return "opaque";
  }
  if (/^docProps\/(?:core|app)\.xml$/i.test(name) || /^xl\/theme\/[^/]+\.xml$/i.test(name)) {
    return "modeled";
  }
  return "reject";
}

function opaqueFeatureForPart(name: string): string {
  if (/^docProps\//i.test(name)) return "workbook-properties";
  if (/^xl\/theme\//i.test(name)) return "workbook-theme";
  if (/^xl\/charts\//i.test(name)) return "editable-charts";
  if (/^customXml\//i.test(name)) return "custom-xml";
  return "opaque-ooxml";
}

function resolveContentTypes(
  entries: readonly ZipEntry[],
  declarations: readonly ContentTypeDeclaration[],
  mediaTypes: ReadonlyMap<string, string>,
  opaqueParts: Set<string>,
): SpreadsheetOpaqueContentType[] {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const existing = new Set(
    entries.filter((entry) => !entry.directory).map((entry) => entry.name.toLowerCase()),
  );
  for (const declaration of declarations) {
    if (declaration.kind === "default") {
      if (defaults.has(declaration.extension)) {
        throw securityError(
          "XLSX has duplicate default content types",
          "invalid-package",
          "[Content_Types].xml",
        );
      }
      defaults.set(declaration.extension, declaration.contentType);
    } else {
      const key = declaration.partName.toLowerCase();
      if (overrides.has(key) || !existing.has(key)) {
        throw securityError(
          "XLSX has duplicate or dangling content type overrides",
          "invalid-package",
          declaration.partName,
        );
      }
      overrides.set(key, declaration.contentType);
    }
  }
  const output: SpreadsheetOpaqueContentType[] = [];
  for (const entry of entries) {
    if (entry.directory || entry.name === "[Content_Types].xml") continue;
    const extension = entry.name.includes(".")
      ? entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase()
      : "";
    const contentType = overrides.get(entry.name.toLowerCase()) ?? defaults.get(extension);
    if (!contentType) {
      throw securityError("XLSX part has no declared content type", "invalid-package", entry.name);
    }
    rejectActiveContentType(contentType, entry.name);
    if (/\.rels$/i.test(entry.name)) {
      if (contentType !== "application/vnd.openxmlformats-package.relationships+xml") {
        throw securityError("Relationship part MIME is inconsistent", "active-content", entry.name);
      }
    } else if (isMediaPart(entry.name)) {
      if (contentType !== mediaTypes.get(entry.name.toLowerCase())) {
        throw securityError(
          "Spreadsheet media content type is MIME-confused",
          "active-content",
          entry.name,
        );
      }
    } else if (/\.vml$/i.test(entry.name)) {
      if (contentType !== "application/vnd.openxmlformats-officedocument.vmlDrawing") {
        throw securityError("VML content type is inconsistent", "active-content", entry.name);
      }
    } else if (isInspectableXml(entry.name) && !isXmlContentType(contentType)) {
      throw securityError("XML part has a non-XML content type", "active-content", entry.name);
    }
    if (opaqueParts.has(entry.name)) output.push({ partName: entry.name, contentType });
  }
  return output;
}

function isXmlContentType(contentType: string): boolean {
  return (
    contentType === "application/xml" ||
    contentType === "text/xml" ||
    /\+xml(?:;|$)/i.test(contentType)
  );
}

function isCanonicalPartName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 2_048 &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.includes("\\") &&
    !name.includes("%") &&
    !/[\u0000-\u001f\u007f]/.test(name) &&
    name.normalize("NFC") === name &&
    name.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function relationshipPartForSource(sourcePart: string): string {
  if (sourcePart === "") return "_rels/.rels";
  const slash = sourcePart.lastIndexOf("/");
  const directory = slash < 0 ? "" : sourcePart.slice(0, slash + 1);
  const file = sourcePart.slice(slash + 1);
  return `${directory}_rels/${file}.rels`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOpaqueRelationships(
  left: SpreadsheetOpaqueRelationship,
  right: SpreadsheetOpaqueRelationship,
): number {
  return (
    compareStrings(left.sourcePart, right.sourcePart) ||
    compareStrings(left.type, right.type) ||
    compareStrings(left.targetPart, right.targetPart)
  );
}

function compareOpaqueContentTypes(
  left: SpreadsheetOpaqueContentType,
  right: SpreadsheetOpaqueContentType,
): number {
  return (
    compareStrings(left.partName, right.partName) ||
    compareStrings(left.contentType, right.contentType)
  );
}

function resolveImportLimits(
  options: Partial<SpreadsheetXlsxImportLimits> | undefined,
): SpreadsheetXlsxImportLimits {
  const resolved = { ...DEFAULT_XLSX_IMPORT_LIMITS, ...options };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new TypeError(`XLSX import limit ${name} must be a positive integer`);
    }
  }
  // Public callers may reduce work budgets for their deployment, but must not
  // expand the audited hard envelope before ZIP/XML preflight.
  for (const [name, maximum] of Object.entries(DEFAULT_XLSX_IMPORT_LIMITS) as Array<
    [keyof SpreadsheetXlsxImportLimits, number]
  >) {
    if (resolved[name] > maximum) {
      throw new TypeError(
        `XLSX import limit ${name} cannot exceed its hard safety cap of ${maximum}`,
      );
    }
  }
  return resolved;
}

function zipEntries(bytes: Uint8Array, limits: SpreadsheetXlsxImportLimits): ZipEntry[] {
  return parseBoundedZip(
    bytes,
    {
      entries: limits.entries,
      compressedEntryBytes: limits.compressedBytes,
      expandedEntryBytes: limits.entryBytes,
      expandedBytes: limits.expandedBytes,
      compressionRatio: limits.compressionRatio,
      compressionRatioThreshold: 1_048_576,
    },
    xlsxZipFailure,
  );
}

function rejectActiveEntry(name: string): void {
  if (
    /(?:^|\/)(?:vbaProject|vbaData)\.bin$/i.test(name) ||
    /(?:^|\/)(?:activeX|embeddings|externalLinks|queryTables|ctrlProps|webextensions)(?:\/|$)/i.test(
      name,
    ) ||
    /^xl\/connections\.xml$/i.test(name) ||
    /\.(?:exe|dll|com|msi|js|vbs|vbe|bat|cmd|ps1|sh|scr|jar)$/i.test(name)
  ) {
    throw securityError(
      "Active or externally connected OOXML content is unsupported",
      "active-content",
      name,
    );
  }
}

function isInspectableXml(name: string): boolean {
  return /(?:\.xml|\.rels|\.vml)$/i.test(name) || /^\[Content_Types\]\.xml$/i.test(name);
}

function decodeXml(bytes: Uint8Array, entryName: string): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw securityError("OOXML text is not valid UTF-8/UTF-16", "unsafe-xml", entryName);
  }
}

type ContentTypeDeclaration =
  | { kind: "default"; extension: string; contentType: string }
  | { kind: "override"; partName: string; contentType: string };

type InspectedRelationship = SpreadsheetOpaqueRelationship & {
  id: string;
  kind: string;
  opaque: boolean;
};

type WorkbookSheetBinding = { name: string; relationshipId: string };
type LegacyCommentRecord = { cell: string; text: string };

type XmlInspection = {
  attributes: number;
  elements: number;
  textCharacters: number;
  worksheetCells: number;
  formulas: number;
  formulaBytes: number;
  sharedStrings: number;
  cellStyles: number;
  styleRecords: number;
  workbookSheets: WorkbookSheetBinding[];
  comments: LegacyCommentRecord[];
  relationships: InspectedRelationship[];
  contentTypes: ContentTypeDeclaration[];
  opaqueFeatures: string[];
};

const FORMULA_ELEMENTS = new Set([
  "f",
  "formula",
  "formula1",
  "formula2",
  "definedName",
  "calculatedColumnFormula",
  "totalsRowFormula",
]);
const STYLE_RECORD_ELEMENTS = new Set([
  "numFmt",
  "font",
  "fill",
  "border",
  "xf",
  "cellStyle",
  "dxf",
]);
const SUPPORTED_CONDITIONAL_FORMAT_RULE_TYPES = new Set([
  "cellis",
  "expression",
  "colorscale",
  "databar",
  "iconset",
  "containstext",
  "notcontainstext",
  "beginswith",
  "endswith",
  "containsblanks",
  "notcontainsblanks",
  "containserrors",
  "notcontainserrors",
  "duplicatevalues",
  "uniquevalues",
  "timeperiod",
  "top10",
  "aboveaverage",
]);

function inspectXml(
  xml: string,
  entryName: string,
  limits: SpreadsheetXlsxImportLimits,
  entryNames: ReadonlyMap<string, string>,
): XmlInspection {
  const result: XmlInspection = {
    attributes: 0,
    elements: 0,
    textCharacters: 0,
    worksheetCells: 0,
    formulas: 0,
    formulaBytes: 0,
    sharedStrings: 0,
    cellStyles: 0,
    styleRecords: 0,
    workbookSheets: [],
    comments: [],
    relationships: [],
    contentTypes: [],
    opaqueFeatures: [],
  };
  const features = new Set<string>();
  const relationshipIds = new Set<string>();
  const relationshipTags: Array<ReadonlyMap<string, string>> = [];
  const stack: string[] = [];
  let activeFormula: { name: string; text: string } | null = null;
  let activeMetadata: { name: string; text: string } | null = null;
  let activeComment: LegacyCommentRecord | null = null;
  let failed: unknown;
  const parser = new SaxesParser<{ xmlns: true }>({ xmlns: true });

  const chargeText = (text: string): void => {
    result.textCharacters += text.length;
    if (result.textCharacters > limits.xmlTextCharactersPerPart) {
      throw securityError(
        `OOXML part exceeds the ${limits.xmlTextCharactersPerPart} text-character limit`,
        "limit-exceeded",
        entryName,
      );
    }
    if (activeFormula) {
      activeFormula.text += text;
      if (boundedUtf8ByteLength(activeFormula.text, 8_192) > 8_192) {
        throw securityError(
          "Spreadsheet formula exceeds its byte limit",
          "limit-exceeded",
          entryName,
        );
      }
    }
    if (activeMetadata) activeMetadata.text += text;
    if (activeComment && stack.at(-1) === "t") activeComment.text += text;
  };

  parser.on("doctype", () => {
    throw securityError(
      "DTD and entity declarations are forbidden in OOXML",
      "unsafe-xml",
      entryName,
    );
  });
  parser.on("processinginstruction", () => {
    throw securityError("OOXML processing instructions are unsupported", "unsafe-xml", entryName);
  });
  parser.on("comment", chargeText);
  parser.on("text", chargeText);
  parser.on("cdata", chargeText);
  parser.on("opentag", (tag: SaxesTagNS) => {
    const localName = tag.local;
    if (activeFormula) {
      throw securityError(
        "Spreadsheet formula elements cannot contain child markup",
        "unsafe-xml",
        entryName,
      );
    }
    result.elements += 1;
    if (result.elements > limits.xmlElementsPerPart) {
      throw securityError(
        `OOXML part exceeds the ${limits.xmlElementsPerPart} element limit`,
        "limit-exceeded",
        entryName,
      );
    }
    const elementAttributes = Object.keys(tag.attributes).length;
    if (elementAttributes > limits.xmlAttributesPerElement) {
      throw securityError(
        `OOXML element exceeds the ${limits.xmlAttributesPerElement} attribute limit`,
        "limit-exceeded",
        entryName,
      );
    }
    result.attributes += elementAttributes;
    if (result.attributes > limits.xmlAttributesPerPart) {
      throw securityError(
        `OOXML part exceeds the ${limits.xmlAttributesPerPart} attribute limit`,
        "limit-exceeded",
        entryName,
      );
    }
    stack.push(localName);
    if (stack.length > limits.xmlDepth) {
      throw securityError(
        `OOXML nesting exceeds the ${limits.xmlDepth} level limit`,
        "limit-exceeded",
        entryName,
      );
    }
    const attributes = localAttributes(tag, entryName);
    rejectActiveXmlElement(entryName, localName, attributes);
    detectOpaqueXmlFeature(entryName, localName, attributes, stack, features);

    if (/^xl\/workbook\.xml$/i.test(entryName) && localName === "sheet") {
      const name = attributes.get("name");
      const relationshipId = attributes.get("id");
      if (!name || name.length > 31 || !relationshipId || relationshipId.length > 512) {
        throw securityError(
          "Workbook sheet binding is missing or invalid",
          "invalid-package",
          entryName,
        );
      }
      result.workbookSheets.push({ name, relationshipId });
    }
    if (/^xl\/comments[^/]*\.xml$/i.test(entryName) && localName === "comment") {
      if (activeComment) {
        throw securityError("Spreadsheet comments cannot be nested", "unsafe-xml", entryName);
      }
      if (result.comments.length >= limits.commentsPerPart) {
        throw securityError(
          `OOXML part exceeds the ${limits.commentsPerPart} comment limit`,
          "limit-exceeded",
          entryName,
        );
      }
      const ref = attributes.get("ref");
      let range: RangeAddress;
      try {
        if (!ref) throw new Error("missing comment reference");
        range = parseRangeAddress(ref);
      } catch (error) {
        const failure = securityError(
          "Spreadsheet comment reference is invalid",
          "invalid-package",
          entryName,
        );
        Object.defineProperty(failure, "cause", {
          value: error,
          enumerable: false,
        });
        throw failure;
      }
      if (range.rowCount !== 1 || range.colCount !== 1) {
        throw securityError(
          "Spreadsheet comment must reference one cell",
          "invalid-package",
          entryName,
        );
      }
      activeComment = { cell: formatCellAddress(range), text: "" };
    }

    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(entryName) && localName === "c") {
      result.worksheetCells += 1;
      if (result.worksheetCells > limits.worksheetCellsPerPart) {
        throw securityError(
          `Worksheet exceeds the ${limits.worksheetCellsPerPart} cell limit`,
          "limit-exceeded",
          entryName,
        );
      }
    }
    if (/^xl\/sharedStrings\.xml$/i.test(entryName) && localName === "si") {
      result.sharedStrings += 1;
      if (result.sharedStrings > limits.sharedStrings) {
        throw securityError(
          `Shared strings exceed the ${limits.sharedStrings} item limit`,
          "limit-exceeded",
          entryName,
        );
      }
    }
    if (/^xl\/styles\.xml$/i.test(entryName) && STYLE_RECORD_ELEMENTS.has(localName)) {
      result.styleRecords += 1;
      if (localName === "xf") result.cellStyles += 1;
      if (result.cellStyles > limits.cellStyles || result.styleRecords > limits.styleRecords) {
        throw securityError(
          "Spreadsheet styles exceed their record limit",
          "limit-exceeded",
          entryName,
        );
      }
    }
    if (FORMULA_ELEMENTS.has(localName)) {
      result.formulas += 1;
      if (result.formulas > limits.formulasPerPart) {
        throw securityError(
          `OOXML part exceeds the ${limits.formulasPerPart} formula limit`,
          "limit-exceeded",
          entryName,
        );
      }
      activeFormula = { name: localName, text: "" };
    }
    if (
      /^docProps\/(?:core|app)\.xml$/i.test(entryName) &&
      new Set([
        "creator",
        "title",
        "subject",
        "description",
        "keywords",
        "category",
        "lastModifiedBy",
        "Company",
        "Manager",
      ]).has(localName)
    ) {
      activeMetadata = { name: localName, text: "" };
    }
    if (/\.rels$/i.test(entryName) && localName === "Relationship") {
      if (relationshipTags.length >= limits.relationshipsPerPart) {
        throw securityError(
          `OOXML part exceeds the ${limits.relationshipsPerPart} relationship limit`,
          "limit-exceeded",
          entryName,
        );
      }
      const id = attributes.get("Id");
      if (!id || relationshipIds.has(id)) {
        throw securityError(
          "OOXML relationship id is missing or duplicated",
          "invalid-package",
          entryName,
        );
      }
      relationshipIds.add(id);
      relationshipTags.push(attributes);
    }
    if (
      entryName === "[Content_Types].xml" &&
      (localName === "Default" || localName === "Override")
    ) {
      result.contentTypes.push(inspectContentTypeTag(localName, attributes, entryName));
    }
  });
  parser.on("closetag", (tag: SaxesTagNS) => {
    if (activeFormula && activeFormula.name === tag.local) {
      const formula = activeFormula.text.trim();
      if (formula.length > 0) {
        const formulaBytes = boundedUtf8ByteLength(formula, 8_192);
        result.formulaBytes += formulaBytes;
        if (result.formulaBytes > limits.formulaBytesPerPart) {
          throw securityError(
            `OOXML part exceeds the ${limits.formulaBytesPerPart} formula-byte limit`,
            "limit-exceeded",
            entryName,
          );
        }
        assertSafeFormula(formula, entryName);
      }
      activeFormula = null;
    }
    if (activeMetadata && activeMetadata.name === tag.local) {
      const value = activeMetadata.text.trim();
      if (
        value.length > 0 &&
        !(["creator", "lastModifiedBy"].includes(activeMetadata.name) && value === "OpenGeni")
      ) {
        features.add("workbook-properties");
      }
      activeMetadata = null;
    }
    if (activeComment && tag.local === "comment") {
      result.comments.push(activeComment);
      activeComment = null;
    }
    stack.pop();
  });
  parser.on("error", (error: Error) => {
    failed = securityError(`OOXML is malformed (${error.message})`, "unsafe-xml", entryName);
    throw failed;
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof SpreadsheetSecurityError) throw error;
    throw securityError(
      `OOXML is malformed (${error instanceof Error ? error.message : "parse failure"})`,
      "unsafe-xml",
      entryName,
    );
  }
  if (failed) throw failed;
  if (stack.length !== 0 || activeFormula || activeComment) {
    throw securityError("OOXML tags are structurally unbalanced", "unsafe-xml", entryName);
  }
  result.relationships = relationshipTags.map((attributes) =>
    inspectRelationshipTag(attributes, entryName, entryNames),
  );
  result.opaqueFeatures = [...features].sort();
  return result;
}

function localAttributes(tag: SaxesTagNS, entryName: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const attribute of Object.values(tag.attributes)) {
    const name = attribute.local;
    if (attributes.has(name)) {
      throw securityError("OOXML element has duplicate local attributes", "unsafe-xml", entryName);
    }
    attributes.set(name, attribute.value);
  }
  return attributes;
}

function inspectContentTypeTag(
  localName: "Default" | "Override",
  attributes: ReadonlyMap<string, string>,
  entryName: string,
): ContentTypeDeclaration {
  const expected =
    localName === "Default"
      ? new Set(["Extension", "ContentType"])
      : new Set(["PartName", "ContentType"]);
  if ([...attributes.keys()].some((name) => !expected.has(name))) {
    throw securityError("OOXML content type has unsupported attributes", "unsafe-xml", entryName);
  }
  const contentType = attributes.get("ContentType");
  if (!contentType || contentType.length > 2_048 || !/^[\x21-\x7e]+$/.test(contentType)) {
    throw securityError("OOXML content type is missing or invalid", "unsafe-xml", entryName);
  }
  rejectActiveContentType(contentType, entryName);
  if (localName === "Default") {
    const extension = attributes.get("Extension");
    if (!extension || extension.length > 32 || !/^[A-Za-z0-9]+$/.test(extension)) {
      throw securityError("OOXML default extension is invalid", "unsafe-xml", entryName);
    }
    return { kind: "default", extension: extension.toLowerCase(), contentType };
  }
  const rawPartName = attributes.get("PartName");
  if (!rawPartName || !rawPartName.startsWith("/") || rawPartName.length > 2_049) {
    throw securityError("OOXML override part name is invalid", "unsafe-xml", entryName);
  }
  const partName = rawPartName.slice(1);
  if (!isCanonicalPartName(partName)) {
    throw securityError("OOXML override part name is non-canonical", "invalid-package", entryName);
  }
  return { kind: "override", partName, contentType };
}

function rejectActiveContentType(contentType: string, entryName: string): void {
  if (
    /(?:macroenabled|vba|ole|activex|external(?:link|data)|connections?|querytable|webextension|html|javascript|svg|executable|encrypted|signature)/i.test(
      contentType,
    )
  ) {
    throw securityError("Active OOXML content types are unsupported", "active-content", entryName);
  }
}

function rejectActiveXmlElement(
  entryName: string,
  localName: string,
  attributes: ReadonlyMap<string, string>,
): void {
  if (
    new Set([
      "oleObject",
      "oleObjects",
      "controls",
      "control",
      "activeX",
      "externalLink",
      "externalData",
      "connection",
      "connections",
      "queryTable",
      "webExtension",
    ]).has(localName)
  ) {
    throw securityError(
      "Active or externally connected OOXML is unsupported",
      "active-content",
      entryName,
    );
  }
  if (/\.vml$/i.test(entryName)) {
    if (["imagedata", "OLEObject"].includes(localName)) {
      throw securityError(
        "Active or linked VML content is unsupported",
        "active-content",
        entryName,
      );
    }
    for (const name of ["href", "src"]) {
      if (attributes.has(name)) {
        throw securityError(
          "Active or linked VML content is unsupported",
          "active-content",
          entryName,
        );
      }
    }
  }
}

function detectOpaqueXmlFeature(
  entryName: string,
  localName: string,
  attributes: ReadonlyMap<string, string>,
  stack: readonly string[],
  features: Set<string>,
): void {
  if (/^xl\/charts\//i.test(entryName)) features.add("editable-charts");
  if (/^customXml\//i.test(entryName)) features.add("custom-xml");
  if (/^xl\/comments[^/]*\.xml$/i.test(entryName)) features.add("comment-metadata");
  if (/\.vml$/i.test(entryName)) features.add("comment-layout");

  if (/^xl\/workbook\.xml$/i.test(entryName)) {
    if (localName === "sheet" && (attributes.get("state") ?? "visible") !== "visible") {
      features.add("sheet-visibility");
    }
    if (localName === "definedName" || localName === "definedNames") {
      features.add("defined-names");
    }
    if (localName === "workbookPr" && isTruthyXml(attributes.get("date1904"))) {
      features.add("1904-date-system");
    }
    if (
      localName === "workbookView" &&
      (positiveXmlNumber(attributes.get("activeTab")) ||
        positiveXmlNumber(attributes.get("firstSheet")))
    ) {
      features.add("workbook-view-state");
    }
  }

  if (/^xl\/theme\/[^/]+\.xml$/i.test(entryName)) {
    if (
      (localName === "theme" && attributes.get("name") !== "Office Theme") ||
      (localName === "clrScheme" && attributes.get("name") !== "Office")
    ) {
      features.add("workbook-theme");
    }
    const colorRole = stack.at(-2);
    const expectedThemeColors: Readonly<Record<string, string>> = {
      dk1: "000000",
      lt1: "FFFFFF",
      dk2: "1F497D",
      lt2: "EEECE1",
      accent1: "4F81BD",
      accent2: "C0504D",
      accent3: "9BBB59",
      accent4: "8064A2",
      accent5: "4BACC6",
      accent6: "F79646",
      hlink: "0000FF",
      folHlink: "800080",
    };
    if ((localName === "sysClr" || localName === "srgbClr") && colorRole) {
      const expected = expectedThemeColors[colorRole];
      const actual = (attributes.get("lastClr") ?? attributes.get("val"))?.toUpperCase();
      if (expected !== undefined && actual !== expected) features.add("workbook-theme");
    }
    if (localName === "latin") {
      const fontRole = stack.at(-2);
      const expected =
        fontRole === "majorFont" ? "Cambria" : fontRole === "minorFont" ? "Calibri" : undefined;
      if (expected !== undefined && attributes.get("typeface") !== expected) {
        features.add("workbook-theme");
      }
    }
  }

  if (/^xl\/worksheets\/[^/]+\.xml$/i.test(entryName)) {
    if (
      new Set([
        "hyperlinks",
        "hyperlink",
        "sheetProtection",
        "protectedRanges",
        "autoFilter",
        "sortState",
        "printOptions",
        "headerFooter",
        "rowBreaks",
        "colBreaks",
        "selection",
      ]).has(localName)
    ) {
      features.add(`worksheet-${localName}`);
    }
    if (
      localName === "pageMargins" &&
      !xmlAttributesEqual(attributes, {
        left: "0.7",
        right: "0.7",
        top: "0.75",
        bottom: "0.75",
        header: "0.3",
        footer: "0.3",
      })
    ) {
      features.add("worksheet-pageMargins");
    }
    if (
      localName === "pageSetup" &&
      !xmlAttributesEqual(attributes, {
        orientation: "portrait",
        horizontalDpi: "4294967295",
        verticalDpi: "4294967295",
        scale: "100",
        fitToWidth: "1",
        fitToHeight: "1",
      })
    ) {
      features.add("worksheet-pageSetup");
    }
    if (
      localName === "row" &&
      ["hidden", "outlineLevel", "collapsed", "s", "customFormat"].some((name) =>
        attributes.has(name),
      )
    ) {
      features.add("row-metadata");
    }
    if (
      localName === "col" &&
      ["hidden", "outlineLevel", "collapsed", "style", "bestFit"].some((name) =>
        attributes.has(name),
      )
    ) {
      features.add("column-metadata");
    }
    if (localName === "sheetView") {
      const supported = new Set(["workbookViewId", "showGridLines"]);
      if ([...attributes.keys()].some((name) => !supported.has(name))) {
        features.add("worksheet-view-state");
      }
    }
    if (localName === "pane") {
      const supported = new Set(["xSplit", "ySplit", "state"]);
      if (
        (attributes.get("state") ?? "frozen") !== "frozen" ||
        [...attributes.keys()].some((name) => !supported.has(name))
      ) {
        features.add("worksheet-pane-state");
      }
    }
    if (localName === "f" && attributes.size > 0) features.add("special-formulas");
    if (localName === "extLst") features.add("worksheet-extensions");
    if (localName === "sparklineGroups" || localName === "sparklineGroup") {
      features.add("sparklines");
    }
    if (localName === "r" && stack.includes("is")) features.add("rich-text");
    if (localName === "cfRule") {
      const type = attributes.get("type");
      if (type && !SUPPORTED_CONDITIONAL_FORMAT_RULE_TYPES.has(type.toLowerCase())) {
        features.add("conditional-format-rules");
      }
    }
  }
  if (/^xl\/sharedStrings\.xml$/i.test(entryName) && localName === "r") {
    features.add("rich-text");
  }
  if (/^xl\/styles\.xml$/i.test(entryName)) {
    if (
      [
        "gradientFill",
        "protection",
        "vertical",
        "horizontal",
        "strike",
        "outline",
        "shadow",
        "condense",
        "extend",
        "vertAlign",
      ].includes(localName)
    ) {
      features.add("advanced-cell-styles");
    }
    if (
      [...attributes].some(
        ([name, value]) =>
          [
            "indexed",
            "auto",
            "textRotation",
            "indent",
            "shrinkToFit",
            "readingOrder",
            "justifyLastLine",
            "relativeIndent",
            "diagonalUp",
            "diagonalDown",
          ].includes(name) ||
          (name === "theme" && value !== "1"),
      )
    ) {
      features.add("advanced-cell-styles");
    }
    if (
      localName === "patternFill" &&
      ![undefined, "none", "gray125", "solid"].includes(attributes.get("patternType"))
    ) {
      features.add("advanced-cell-styles");
    }
  }
  if (/^xl\/tables\/[^/]+\.xml$/i.test(entryName)) {
    if (
      ["calculatedColumnFormula", "totalsRowFormula", "sortState", "filterColumn"].includes(
        localName,
      )
    ) {
      features.add("advanced-table-semantics");
    }
    if (
      localName === "tableStyleInfo" &&
      (isTruthyXml(attributes.get("showFirstColumn")) ||
        isTruthyXml(attributes.get("showLastColumn")) ||
        isTruthyXml(attributes.get("showRowStripes")) ===
          isTruthyXml(attributes.get("showColumnStripes")))
    ) {
      features.add("advanced-table-style");
    }
  }
  if (/^xl\/drawings\/[^/]+\.xml$/i.test(entryName)) {
    if (
      ["sp", "grpSp", "cxnSp", "graphicFrame", "absoluteAnchor", "twoCellAnchor"].includes(
        localName,
      )
    ) {
      features.add("drawing-objects");
    }
    if (localName === "cNvPr" && (attributes.has("descr") || attributes.has("title"))) {
      features.add("image-metadata");
    }
  }
}

function isTruthyXml(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function positiveXmlNumber(value: string | undefined): boolean {
  if (value === undefined) return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function xmlAttributesEqual(
  actual: ReadonlyMap<string, string>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const entries = Object.entries(expected);
  return (
    actual.size === entries.length && entries.every(([name, value]) => actual.get(name) === value)
  );
}

type RelationshipPolicy = {
  source: RegExp;
  kind: string;
  target: RegExp;
  opaque?: boolean;
};

const RELATIONSHIP_POLICIES: readonly RelationshipPolicy[] = [
  { source: /^$/, kind: "officeDocument", target: /^xl\/workbook\.xml$/i },
  { source: /^$/, kind: "core-properties", target: /^docProps\/core\.xml$/i },
  {
    source: /^$/,
    kind: "extended-properties",
    target: /^docProps\/app\.xml$/i,
  },
  {
    source: /^$/,
    kind: "custom-properties",
    target: /^docProps\/custom\.xml$/i,
    opaque: true,
  },
  {
    source: /^xl\/workbook\.xml$/i,
    kind: "styles",
    target: /^xl\/styles\.xml$/i,
  },
  {
    source: /^xl\/workbook\.xml$/i,
    kind: "theme",
    target: /^xl\/theme\/[^/]+\.xml$/i,
  },
  {
    source: /^xl\/workbook\.xml$/i,
    kind: "sharedStrings",
    target: /^xl\/sharedStrings\.xml$/i,
  },
  {
    source: /^xl\/workbook\.xml$/i,
    kind: "worksheet",
    target: /^xl\/worksheets\/[^/]+\.xml$/i,
  },
  {
    source: /^xl\/workbook\.xml$/i,
    kind: "calcChain",
    target: /^xl\/calcChain\.xml$/i,
  },
  {
    source: /^xl\/worksheets\/[^/]+\.xml$/i,
    kind: "comments",
    target: /^xl\/comments[^/]*\.xml$/i,
    opaque: true,
  },
  {
    source: /^xl\/worksheets\/[^/]+\.xml$/i,
    kind: "vmlDrawing",
    target: /^xl\/drawings\/[^/]+\.vml$/i,
    opaque: true,
  },
  {
    source: /^xl\/worksheets\/[^/]+\.xml$/i,
    kind: "table",
    target: /^xl\/tables\/[^/]+\.xml$/i,
  },
  {
    source: /^xl\/worksheets\/[^/]+\.xml$/i,
    kind: "drawing",
    target: /^xl\/drawings\/[^/]+\.xml$/i,
  },
  {
    source: /^xl\/drawings\/[^/]+\.xml$/i,
    kind: "image",
    target: /^xl\/media\/[^/]+\.(?:png|jpe?g|gif)$/i,
  },
  {
    source: /^xl\/drawings\/[^/]+\.xml$/i,
    kind: "chart",
    target: /^xl\/charts\/[^/]+\.xml$/i,
    opaque: true,
  },
  {
    source: /^xl\/charts\/[^/]+\.xml$/i,
    kind: "image",
    target: /^xl\/media\/[^/]+\.(?:png|jpe?g|gif)$/i,
    opaque: true,
  },
  {
    source: /^xl\/charts\/[^/]+\.xml$/i,
    kind: "themeOverride",
    target: /^xl\/theme\/[^/]+\.xml$/i,
    opaque: true,
  },
  {
    source: /^xl\/workbook\.xml$/i,
    kind: "customXml",
    target: /^customXml\/item\d+\.xml$/i,
    opaque: true,
  },
  {
    source: /^customXml\/item\d+\.xml$/i,
    kind: "customXmlProps",
    target: /^customXml\/itemProps\d+\.xml$/i,
    opaque: true,
  },
];

const OFFICE_RELATIONSHIP_PREFIXES = [
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/",
  "http://schemas.microsoft.com/office/2006/relationships/",
] as const;

function inspectRelationshipTag(
  attributes: ReadonlyMap<string, string>,
  entryName: string,
  entryNames: ReadonlyMap<string, string>,
): InspectedRelationship {
  const source = relationshipSource(entryName);
  for (const name of attributes.keys()) {
    if (!["Id", "Type", "Target", "TargetMode"].includes(name)) {
      throw securityError("OOXML relationship attributes are unsupported", "unsafe-xml", entryName);
    }
  }
  const type = attributes.get("Type");
  const target = attributes.get("Target");
  const id = attributes.get("Id");
  if (!id || id.length > 512 || !type || type.length > 2_048 || !target || target.length > 4_096) {
    throw securityError(
      "OOXML relationship is missing or exceeds required attributes",
      "unsafe-xml",
      entryName,
    );
  }
  if ((attributes.get("TargetMode") ?? "Internal") !== "Internal") {
    throw securityError(
      "External OOXML relationships are forbidden",
      "external-relationship",
      entryName,
    );
  }
  const kind = relationshipKind(type);
  const resolvedTarget = resolveRelationshipTarget(source, target, entryName);
  if (source !== "" && !entryNames.has(source.toLowerCase())) {
    throw securityError("OOXML relationship source part is missing", "invalid-package", entryName);
  }
  const policy = RELATIONSHIP_POLICIES.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.source.test(source) &&
      candidate.target.test(resolvedTarget),
  );
  if (!policy) {
    throw securityError(
      "Unsupported OOXML relationship type or target",
      "active-content",
      entryName,
    );
  }
  if (!entryNames.has(resolvedTarget.toLowerCase())) {
    throw securityError(
      "OOXML relationship target is missing from the package",
      "invalid-package",
      entryName,
    );
  }
  return {
    id,
    kind: kind!,
    sourcePart: source,
    type,
    targetPart: entryNames.get(resolvedTarget.toLowerCase())!,
    opaque: policy.opaque === true,
  };
}

function relationshipKind(type: string): string | null {
  if (
    type === "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"
  ) {
    return "core-properties";
  }
  for (const prefix of OFFICE_RELATIONSHIP_PREFIXES) {
    if (type.startsWith(prefix)) {
      const kind = type.slice(prefix.length);
      return /^[A-Za-z][A-Za-z0-9.-]*$/.test(kind) ? kind : null;
    }
  }
  return null;
}

function relationshipSource(entryName: string): string {
  if (entryName.toLowerCase() === "_rels/.rels") return "";
  const match = /^(.*\/)_rels\/([^/]+)\.rels$/i.exec(entryName);
  if (!match) {
    throw securityError(
      "OOXML relationship part has an invalid location",
      "invalid-package",
      entryName,
    );
  }
  return `${match[1]}${match[2]}`;
}

function resolveRelationshipTarget(source: string, target: string, entryName: string): string {
  if (
    target.length === 0 ||
    target.includes("\\") ||
    target.includes("%") ||
    target.includes("?") ||
    target.includes("#") ||
    target.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) ||
    /[\u0000-\u001f\u007f]/.test(target)
  ) {
    throw securityError(
      "External or ambiguous OOXML relationship target",
      "external-relationship",
      entryName,
    );
  }
  const segments = source.includes("/") ? source.split("/").slice(0, -1) : [];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw securityError(
          "OOXML relationship escapes the package root",
          "external-relationship",
          entryName,
        );
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  if (segments.length === 0) {
    throw securityError("OOXML relationship target is empty", "invalid-package", entryName);
  }
  return segments.join("/");
}

function securityError(
  message: string,
  code: SpreadsheetSecurityError["code"],
  entryName?: string,
): SpreadsheetSecurityError {
  return entryName
    ? new SpreadsheetSecurityError(`${message}: ${entryName}`, code, entryName)
    : new SpreadsheetSecurityError(message, code);
}

function xlsxZipFailure(
  kind: Parameters<BoundedZipFailure>[0],
  message: string,
  entryName?: string,
): never {
  throw securityError(
    message,
    kind === "limit"
      ? "limit-exceeded"
      : kind === "encrypted"
        ? "encrypted-content"
        : "invalid-package",
    entryName,
  );
}

function assertSafeFormula(formula: string, location: string): void {
  try {
    validateSupportedFormula(formula);
  } catch (error) {
    const failure = securityError(
      `Unsupported or potentially active spreadsheet formula at ${location}`,
      "active-content",
    );
    Object.defineProperty(failure, "cause", {
      value: error,
      enumerable: false,
    });
    throw failure;
  }
}

function safeExportImage(image: SpreadsheetImageConfig): SpreadsheetImageConfig {
  let normalized: SpreadsheetImageConfig;
  try {
    normalized = normalizeSpreadsheetImageConfig(image);
  } catch (error) {
    const failure = securityError("Spreadsheet image data is invalid", "active-content");
    Object.defineProperty(failure, "cause", {
      value: error,
      enumerable: false,
    });
    throw failure;
  }
  if (
    !normalized.dataUrl ||
    !["image/png", "image/jpeg", "image/gif"].includes(normalized.contentType ?? "")
  ) {
    throw securityError(
      "Spreadsheet images must be inline PNG, JPEG, or GIF data",
      "active-content",
    );
  }
  return normalized;
}
