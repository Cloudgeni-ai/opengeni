import type { Document } from "./document";
import {
  DOCX_MEDIA_TYPE,
  type DocumentFidelityIssue,
  type DocumentLossPreservationEnvelope,
  type DocumentOpaqueContent,
} from "./document-docx-api";

export type DocumentLossPreservationState = {
  sourceBytes: Uint8Array;
  sourceDigest: string;
  importedRevision: number;
  opaqueContent: DocumentOpaqueContent;
  modelDigest: string;
};

export const DOCUMENT_LOSS_PRESERVATION = new WeakMap<Document, DocumentLossPreservationState>();

export function documentFidelityReport(document: Document): readonly DocumentFidelityIssue[] {
  const envelope = DOCUMENT_LOSS_PRESERVATION.get(document);
  if (!envelope) return [];
  const changed = document.revision !== envelope.importedRevision;
  return [
    {
      code: changed ? "content-will-be-discarded" : "content-preserved-in-source",
      severity: changed ? "error" : "warning",
      feature: "opaque-ooxml",
      message: changed
        ? "The imported DOCX contains bounded inert OOXML outside the editable model; the document changed, so regenerating DOCX would discard it"
        : "The imported DOCX contains bounded inert OOXML outside the editable model; unchanged export returns the original package byte-for-byte",
      parts: [...envelope.opaqueContent.parts],
      relationships: envelope.opaqueContent.relationships.map((relationship) => ({
        ...relationship,
      })),
      contentTypes: envelope.opaqueContent.contentTypes.map((contentType) => ({ ...contentType })),
    },
  ];
}

export function documentLossPreservationEnvelope(
  document: Document,
): DocumentLossPreservationEnvelope | null {
  const envelope = DOCUMENT_LOSS_PRESERVATION.get(document);
  if (!envelope) return null;
  return {
    version: 1,
    mediaType: DOCX_MEDIA_TYPE,
    sourceBytes: envelope.sourceBytes.slice(),
    sourceDigest: envelope.sourceDigest,
    opaqueContent: {
      parts: [...envelope.opaqueContent.parts],
      relationships: envelope.opaqueContent.relationships.map((relationship) => ({
        ...relationship,
      })),
      contentTypes: envelope.opaqueContent.contentTypes.map((contentType) => ({ ...contentType })),
    },
    modelDigest: envelope.modelDigest,
  };
}
