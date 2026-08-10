export const PPTX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation" as const;

export type PresentationPptxFeature =
  | "animation"
  | "audio"
  | "custom-geometry"
  | "connector"
  | "embedded-object"
  | "group"
  | "hyperlink"
  | "master"
  | "layout"
  | "media"
  | "placeholder"
  | "source-only"
  | "smart-art"
  | "table-style"
  | "theme"
  | "transition"
  | "unsupported-chart"
  | "video";

export type PresentationFidelityIssue = {
  code:
    | "content-preserved-in-source"
    | "content-will-be-discarded"
    | "group-will-be-flattened"
    | "style-approximated";
  severity: "warning" | "error";
  feature: PresentationPptxFeature;
  message: string;
  parts?: readonly string[];
};

export type PresentationPptxImportLimits = {
  compressedBytes: number;
  expandedBytes: number;
  entryBytes: number;
  entries: number;
  compressionRatio: number;
  totalXmlBytes: number;
  xmlBytes: number;
  xmlDepth: number;
  xmlNodes: number;
  xmlAttributesPerElement: number;
  relationshipsPerPart: number;
  relationships: number;
  slides: number;
  elements: number;
  textCharacters: number;
  imageBytes: number;
  chartPoints: number;
  nestedPackageBytes: number;
  nestedExpandedBytes: number;
  nestedEntries: number;
  retainedBytes: number;
};

export type PresentationPptxImportOptions = {
  /** Preserve unsupported, inert content in the original package or reject it. */
  unsupportedContent?: "preserve" | "error";
  /** Every limit is applied before or while allocating decoded package state. */
  limits?: Partial<PresentationPptxImportLimits>;
};

export type PresentationPptxExportOptions = {
  fileName?: string;
  /** Explicitly acknowledge content the editable model cannot regenerate. */
  unsupportedContent?: "error" | "discard";
};

export type PresentationLossPreservationEnvelope = {
  version: 1;
  mediaType: typeof PPTX_MEDIA_TYPE;
  sourceBytes: Uint8Array;
  sourceDigest: string;
  unsupportedParts: readonly string[];
  modelDigest: string;
};

export class PresentationFidelityError extends Error {
  readonly issues: readonly PresentationFidelityIssue[];

  constructor(message: string, issues: readonly PresentationFidelityIssue[]) {
    super(message);
    this.name = "PresentationFidelityError";
    this.issues = issues;
  }
}

export class PresentationSecurityError extends Error {
  constructor(
    message: string,
    readonly code:
      | "active-content"
      | "encrypted-content"
      | "external-relationship"
      | "invalid-package"
      | "limit-exceeded"
      | "unsafe-xml",
    readonly entryName?: string,
  ) {
    super(message);
    this.name = "PresentationSecurityError";
  }
}
