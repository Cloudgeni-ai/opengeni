export const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;

export type SpreadsheetOpaqueRelationship = {
  sourcePart: string;
  type: string;
  targetPart: string;
};

export type SpreadsheetOpaqueContentType = {
  partName: string;
  contentType: string;
};

/** Bounded, inert OOXML which is retained only in the original source package. */
export type SpreadsheetOpaqueContent = {
  parts: readonly string[];
  relationships: readonly SpreadsheetOpaqueRelationship[];
  contentTypes: readonly SpreadsheetOpaqueContentType[];
  features: readonly string[];
};

export type SpreadsheetFidelityIssue = {
  code:
    | "content-preserved-in-source"
    | "content-will-be-discarded"
    | "editable-chart-preserved"
    | "editable-chart-not-exportable"
    | "sparkline-preserved"
    | "sparkline-not-exportable"
    | "image-metadata-not-exportable"
    | "comment-thread-not-exportable";
  severity: "warning" | "error";
  feature: "opaque-ooxml" | "chart" | "sparkline" | "image" | "comment";
  message: string;
  parts?: readonly string[];
  relationships?: readonly SpreadsheetOpaqueRelationship[];
  contentTypes?: readonly SpreadsheetOpaqueContentType[];
  features?: readonly string[];
};

export type SpreadsheetXlsxImportOptions = {
  /** Reject unsupported editable OOXML instead of retaining its original package. */
  unsupportedContent?: "preserve" | "error";
  /** Bounded before ExcelJS allocates or parses any OOXML. */
  limits?: Partial<SpreadsheetXlsxImportLimits>;
};

export type SpreadsheetXlsxImportLimits = {
  compressedBytes: number;
  expandedBytes: number;
  entryBytes: number;
  entries: number;
  compressionRatio: number;
  inspectedXmlBytes: number;
  xmlDepth: number;
  xmlAttributesPerElement: number;
  xmlAttributesPerPart: number;
  xmlAttributes: number;
  xmlElementsPerPart: number;
  xmlElements: number;
  xmlTextCharactersPerPart: number;
  xmlTextCharacters: number;
  worksheetCellsPerPart: number;
  worksheetCells: number;
  formulasPerPart: number;
  formulas: number;
  formulaBytesPerPart: number;
  formulaBytes: number;
  sharedStrings: number;
  cellStyles: number;
  styleRecords: number;
  commentsPerPart: number;
  comments: number;
  relationshipsPerPart: number;
  relationships: number;
  mediaEntries: number;
  mediaEntryBytes: number;
  mediaBytes: number;
  imagePixels: number;
};

export type SpreadsheetLossPreservationEnvelope = {
  version: 1;
  mediaType: typeof XLSX_MEDIA_TYPE;
  sourceBytes: Uint8Array;
  sourceDigest: string;
  opaqueContent: SpreadsheetOpaqueContent;
  modelDigest: string;
};

export type SpreadsheetXlsxExportOptions = {
  fileName?: string;
  /** Must be explicit because ExcelJS cannot author every retained editable OOXML feature. */
  unsupportedContent?: "error" | "discard";
};

export class SpreadsheetFidelityError extends Error {
  readonly issues: readonly SpreadsheetFidelityIssue[];

  constructor(message: string, issues: readonly SpreadsheetFidelityIssue[]) {
    super(message);
    this.name = "SpreadsheetFidelityError";
    this.issues = issues;
  }
}

export class SpreadsheetSecurityError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-package"
      | "limit-exceeded"
      | "encrypted-content"
      | "active-content"
      | "unsafe-xml"
      | "external-relationship",
    readonly entryName?: string,
  ) {
    super(message);
    this.name = "SpreadsheetSecurityError";
  }
}
