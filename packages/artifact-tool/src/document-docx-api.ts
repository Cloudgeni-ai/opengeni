import type { DocxImportLimits } from "./document-docx-import";

export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

export type DocumentOpaqueRelationship = {
  sourcePart: string;
  type: string;
  targetPart: string;
};

export type DocumentOpaqueContentType = {
  partName: string;
  contentType: string;
};

export type DocumentOpaqueContent = {
  parts: readonly string[];
  relationships: readonly DocumentOpaqueRelationship[];
  contentTypes: readonly DocumentOpaqueContentType[];
};

export type DocumentFidelityIssue = {
  code: "content-preserved-in-source" | "content-will-be-discarded";
  severity: "warning" | "error";
  feature: "opaque-ooxml";
  message: string;
  parts: readonly string[];
  relationships: readonly DocumentOpaqueRelationship[];
  contentTypes: readonly DocumentOpaqueContentType[];
};

export type DocumentDocxImportOptions = {
  /** Preserve bounded inert OOXML outside the editable model, or reject it. */
  unsupportedContent?: "preserve" | "error";
  /** Every limit can only tighten the codec's hard browser-safe ceiling. */
  limits?: Partial<DocxImportLimits>;
};

export type DocumentDocxExportOptions = {
  fileName?: string;
  /** Explicit acknowledgement required after editing a source with opaque OOXML. */
  unsupportedContent?: "error" | "discard";
};

export type DocumentLossPreservationEnvelope = {
  version: 1;
  mediaType: typeof DOCX_MEDIA_TYPE;
  sourceBytes: Uint8Array;
  sourceDigest: string;
  opaqueContent: DocumentOpaqueContent;
  modelDigest: string;
};

export class DocumentFidelityError extends Error {
  readonly name = "DocumentFidelityError";

  constructor(
    message: string,
    readonly issues: readonly DocumentFidelityIssue[],
  ) {
    super(message);
  }
}
