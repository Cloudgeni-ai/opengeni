import type { Workbook } from "./spreadsheet";
import {
  XLSX_MEDIA_TYPE,
  type SpreadsheetFidelityIssue,
  type SpreadsheetLossPreservationEnvelope,
  type SpreadsheetOpaqueContent,
} from "./spreadsheet-xlsx-api";

export type SpreadsheetLossPreservationState = {
  sourceBytes: Uint8Array;
  sourceDigest: string;
  importedRevision: number;
  opaqueContent: SpreadsheetOpaqueContent;
  modelDigest: string;
};

export const LOSS_PRESERVATION = new WeakMap<Workbook, SpreadsheetLossPreservationState>();

export function spreadsheetFidelityReport(workbook: Workbook): readonly SpreadsheetFidelityIssue[] {
  const issues: SpreadsheetFidelityIssue[] = [];
  const envelope = LOSS_PRESERVATION.get(workbook);
  if (envelope && hasOpaqueContent(envelope.opaqueContent)) {
    const severity = workbook.revision === envelope.importedRevision ? "warning" : "error";
    const categorized = opaqueContentIssues(envelope.opaqueContent, severity);
    issues.push(...categorized);
  }
  for (const worksheet of workbook.worksheets.items) {
    const charts = worksheet.charts.items.length;
    if (charts > 0) {
      issues.push({
        code: "editable-chart-not-exportable",
        severity: "error",
        feature: "chart",
        message: `Worksheet ${JSON.stringify(worksheet.name)} has ${charts} editable chart(s); XLSX chart authoring is not implemented`,
      });
    }
    const sparklines = worksheet.sparklineGroups.items.length;
    if (sparklines > 0) {
      issues.push({
        code: "sparkline-not-exportable",
        severity: "error",
        feature: "sparkline",
        message: `Worksheet ${JSON.stringify(worksheet.name)} has ${sparklines} editable sparkline group(s); XLSX sparkline authoring is not implemented`,
      });
    }
    const imageMetadata = worksheet.images.items.filter((image) => Boolean(image.config.alt));
    if (imageMetadata.length > 0) {
      issues.push({
        code: "image-metadata-not-exportable",
        severity: "error",
        feature: "image",
        message: `Worksheet ${JSON.stringify(worksheet.name)} has ${imageMetadata.length} image(s) with accessibility text that ExcelJS cannot author`,
      });
    }
  }
  if (workbook.comments.items.length > 0) {
    issues.push({
      code: "comment-thread-not-exportable",
      severity: "error",
      feature: "comment",
      message: `The workbook has ${workbook.comments.items.length} threaded comment(s); XLSX legacy notes cannot preserve authorship, replies, resolution, and timestamps`,
    });
  }
  return issues;
}

export function opaqueContentIssues(
  content: SpreadsheetOpaqueContent,
  severity: SpreadsheetFidelityIssue["severity"],
): SpreadsheetFidelityIssue[] {
  const features = new Set(content.features);
  const issues: SpreadsheetFidelityIssue[] = [];
  if (features.has("editable-charts")) {
    issues.push({
      code: severity === "warning" ? "editable-chart-preserved" : "editable-chart-not-exportable",
      severity,
      feature: "chart",
      message:
        severity === "warning"
          ? "Imported editable chart OOXML is retained in the original XLSX package"
          : "The workbook changed, so retained editable chart OOXML would be discarded",
      ...opaqueMetadataFor(content, (part) => /^xl\/charts\//i.test(part)),
    });
    features.delete("editable-charts");
  }
  if (features.has("sparklines")) {
    issues.push({
      code: severity === "warning" ? "sparkline-preserved" : "sparkline-not-exportable",
      severity,
      feature: "sparkline",
      message:
        severity === "warning"
          ? "Imported sparkline OOXML is retained in the original XLSX package"
          : "The workbook changed, so retained sparkline OOXML would be discarded",
      ...opaqueMetadataFor(
        content,
        (part) => content.features.includes("sparklines") && /^xl\/worksheets\//i.test(part),
      ),
    });
    features.delete("sparklines");
    features.delete("worksheet-extensions");
  }
  if (features.size > 0 || issues.length === 0) {
    const remaining = {
      ...cloneOpaqueContent(content),
      features: [...features].sort(),
    };
    issues.push(opaqueContentIssue(remaining, severity));
  }
  return issues;
}

function opaqueMetadataFor(
  content: SpreadsheetOpaqueContent,
  matchesPart: (part: string) => boolean,
): Pick<SpreadsheetFidelityIssue, "parts" | "relationships" | "contentTypes"> {
  const parts = content.parts.filter(matchesPart);
  const selected = new Set(parts);
  return {
    parts,
    relationships: content.relationships
      .filter(
        (relationship) =>
          selected.has(relationship.sourcePart) || selected.has(relationship.targetPart),
      )
      .map((relationship) => ({ ...relationship })),
    contentTypes: content.contentTypes
      .filter((contentType) => selected.has(contentType.partName))
      .map((contentType) => ({ ...contentType })),
  };
}

export function spreadsheetLossPreservationEnvelope(
  workbook: Workbook,
): SpreadsheetLossPreservationEnvelope | null {
  const envelope = LOSS_PRESERVATION.get(workbook);
  if (!envelope) return null;
  return {
    version: 1,
    mediaType: XLSX_MEDIA_TYPE,
    sourceBytes: envelope.sourceBytes.slice(),
    sourceDigest: envelope.sourceDigest,
    opaqueContent: cloneOpaqueContent(envelope.opaqueContent),
    modelDigest: envelope.modelDigest,
  };
}

export function opaqueContentIssue(
  content: SpreadsheetOpaqueContent,
  severity: SpreadsheetFidelityIssue["severity"],
): SpreadsheetFidelityIssue {
  const changed = severity === "error";
  return {
    code: changed ? "content-will-be-discarded" : "content-preserved-in-source",
    severity,
    feature: "opaque-ooxml",
    message: changed
      ? "The imported XLSX contains bounded inert OOXML outside the editable model; the workbook changed, so regeneration would discard it"
      : "The imported XLSX contains bounded inert OOXML outside the editable model; unchanged export returns the original package byte-for-byte",
    parts: [...content.parts],
    relationships: content.relationships.map((relationship) => ({
      ...relationship,
    })),
    contentTypes: content.contentTypes.map((contentType) => ({
      ...contentType,
    })),
    features: [...content.features],
  };
}

export function hasOpaqueContent(content: SpreadsheetOpaqueContent): boolean {
  return (
    content.parts.length > 0 ||
    content.relationships.length > 0 ||
    content.contentTypes.length > 0 ||
    content.features.length > 0
  );
}

export function cloneOpaqueContent(content: SpreadsheetOpaqueContent): SpreadsheetOpaqueContent {
  return {
    parts: [...content.parts],
    relationships: content.relationships.map((relationship) => ({
      ...relationship,
    })),
    contentTypes: content.contentTypes.map((contentType) => ({
      ...contentType,
    })),
    features: [...content.features],
  };
}
