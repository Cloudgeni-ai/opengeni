import {
  DOCUMENT_ARTIFACT_QUERY_MAX_ITEMS,
  DOCUMENT_ARTIFACT_QUERY_MAX_TABLE_CELLS,
  DOCUMENT_ARTIFACT_QUERY_MAX_TEXT_UTF16,
  DOCUMENT_ARTIFACT_MAX_STRUCTURAL_COUNTER,
  PRESENTATION_ARTIFACT_MAX_COORDINATE,
  PRESENTATION_ARTIFACT_QUERY_MAX_NODES,
  PRESENTATION_ARTIFACT_QUERY_MAX_SLIDES,
  PRESENTATION_ARTIFACT_QUERY_MAX_TEXT_BYTES,
  PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
  SPREADSHEET_ARTIFACT_METADATA_MAX_SHEETS,
  SPREADSHEET_ARTIFACT_METADATA_MIN_RESPONSE_BYTES,
  SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
  SPREADSHEET_ARTIFACT_VIEWPORT_MAX_AREA,
  SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS,
  SPREADSHEET_ARTIFACT_VIEWPORT_MIN_RESPONSE_BYTES,
  type EditableArtifactStableId,
} from "@opengeni/contracts/editable-artifacts";
import type { EditableArtifactAgentQuery } from "@opengeni/core/editable-artifacts";
import * as z from "zod/v4";

const UINT32_MAX = 0xffff_ffff;

const Uint32 = z.number().int().min(0).max(UINT32_MAX);
const PositiveUint32 = z.number().int().min(1).max(UINT32_MAX);
const SafeCursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const CanonicalStableId = z
  .string()
  .regex(/^[0-9a-f]{32}$/u)
  .transform((value): EditableArtifactStableId => value as EditableArtifactStableId);
const SpreadsheetSheetId = z
  .string()
  .regex(/^[0-9a-f]{32}$/u)
  .refine(
    (value) => value.slice(0, 16) !== "0000000000000000" && value.slice(16) !== "0000000000000000",
    "Object id must have allocated namespace and counter halves",
  )
  .transform((value): EditableArtifactStableId => value as EditableArtifactStableId);
const DocumentSectionId = z
  .string()
  .regex(/^sec\/[0-9a-f]{32}$/u)
  .refine((value) => {
    const counter = BigInt(`0x${value.slice(-16)}`);
    return counter > 0n && counter <= BigInt(DOCUMENT_ARTIFACT_MAX_STRUCTURAL_COUNTER);
  }, "Section id counter must be allocated and within the document limit");

const SpreadsheetMetadataRequest = z
  .object({
    kind: z.literal("workbook-metadata"),
    query: z
      .object({
        maxSheets: z.number().int().min(1).max(SPREADSHEET_ARTIFACT_METADATA_MAX_SHEETS),
        maxBytes: z
          .number()
          .int()
          .min(SPREADSHEET_ARTIFACT_METADATA_MIN_RESPONSE_BYTES)
          .max(SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES),
      })
      .strict(),
  })
  .strict();

const SpreadsheetViewportRequest = z
  .object({
    kind: z.literal("viewport"),
    query: z
      .object({
        sheetId: SpreadsheetSheetId,
        startRow: Uint32,
        startColumn: Uint32,
        rowCount: PositiveUint32,
        columnCount: PositiveUint32,
        maxCells: z.number().int().min(1).max(SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS),
        maxBytes: z
          .number()
          .int()
          .min(SPREADSHEET_ARTIFACT_VIEWPORT_MIN_RESPONSE_BYTES)
          .max(SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES),
      })
      .strict()
      .superRefine((query, context) => {
        const area = query.rowCount * query.columnCount;
        if (!Number.isSafeInteger(area) || area > SPREADSHEET_ARTIFACT_VIEWPORT_MAX_AREA) {
          context.addIssue({
            code: "custom",
            message: `Viewport area must not exceed ${SPREADSHEET_ARTIFACT_VIEWPORT_MAX_AREA}`,
          });
        }
        if (
          query.rowCount - 1 > UINT32_MAX - query.startRow ||
          query.columnCount - 1 > UINT32_MAX - query.startColumn
        ) {
          context.addIssue({
            code: "custom",
            message: "Viewport extent exceeds spreadsheet coordinates",
          });
        }
      }),
  })
  .strict();

const DocumentLimits = z
  .object({
    maxItems: z.number().int().min(1).max(DOCUMENT_ARTIFACT_QUERY_MAX_ITEMS),
    maxTextUtf16: z.number().int().min(1).max(DOCUMENT_ARTIFACT_QUERY_MAX_TEXT_UTF16),
    maxTableCells: z.number().int().min(1).max(DOCUMENT_ARTIFACT_QUERY_MAX_TABLE_CELLS),
  })
  .strict();

const DocumentSummaryRequest = z.object({ kind: z.literal("summary") }).strict();
const DocumentBodyRequest = z
  .object({ kind: z.literal("body"), startBlock: SafeCursor, limits: DocumentLimits })
  .strict();
const DocumentStoryRequest = z
  .object({
    kind: z.literal("story"),
    sectionId: DocumentSectionId,
    storyKind: z.enum(["header", "footer"]),
    variant: z.enum(["default", "first", "even"]),
    startBlock: SafeCursor,
    limits: DocumentLimits,
  })
  .strict();
const DocumentSectionsRequest = z
  .object({ kind: z.literal("sections"), startSection: SafeCursor, limits: DocumentLimits })
  .strict();
const DocumentReviewRequest = z
  .object({ kind: z.literal("review"), startItem: SafeCursor, limits: DocumentLimits })
  .strict();

const PresentationOwner = z
  .object({ kind: z.enum(["master", "layout", "slide"]), id: CanonicalStableId })
  .strict();
const PresentationCoordinate = z
  .number()
  .int()
  .min(-PRESENTATION_ARTIFACT_MAX_COORDINATE)
  .max(PRESENTATION_ARTIFACT_MAX_COORDINATE);
const PresentationExtent = z.number().int().min(1).max(PRESENTATION_ARTIFACT_MAX_COORDINATE);
const PresentationRect = z
  .object({
    x: PresentationCoordinate,
    y: PresentationCoordinate,
    width: PresentationExtent,
    height: PresentationExtent,
  })
  .strict()
  .superRefine((rect, context) => {
    if (
      Math.abs(rect.x + rect.width) > PRESENTATION_ARTIFACT_MAX_COORDINATE ||
      Math.abs(rect.y + rect.height) > PRESENTATION_ARTIFACT_MAX_COORDINATE
    ) {
      context.addIssue({
        code: "custom",
        message: "Viewport extent exceeds presentation coordinates",
      });
    }
  });
const PresentationNodeLimit = z.number().int().min(1).max(PRESENTATION_ARTIFACT_QUERY_MAX_NODES);
const PresentationTextLimit = z
  .number()
  .int()
  .min(1)
  .max(PRESENTATION_ARTIFACT_QUERY_MAX_TEXT_BYTES);
const presentationResponseBytes = (minimum: number) =>
  z.number().int().min(minimum).max(PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES);

const PresentationViewportRequest = z
  .object({
    kind: z.literal("viewport"),
    owner: PresentationOwner,
    viewport: PresentationRect,
    maxNodes: PresentationNodeLimit,
    maxBytes: presentationResponseBytes(89),
  })
  .strict();
const PresentationHitTestRequest = z
  .object({
    kind: z.literal("hit-test"),
    owner: PresentationOwner,
    x: PresentationCoordinate,
    y: PresentationCoordinate,
    maxNodes: PresentationNodeLimit,
    maxBytes: presentationResponseBytes(89),
  })
  .strict();
const PresentationResolvedSlideRequest = z
  .object({
    kind: z.literal("resolved-slide"),
    slideId: CanonicalStableId,
    maxNodes: PresentationNodeLimit,
    maxBytes: presentationResponseBytes(56),
  })
  .strict();
const PresentationMetadataRequest = z
  .object({ kind: z.literal("metadata"), maxBytes: presentationResponseBytes(84) })
  .strict();
const PresentationSlideCatalogRequest = z
  .object({
    kind: z.literal("slide-catalog"),
    startSlide: Uint32,
    maxSlides: z.number().int().min(1).max(PRESENTATION_ARTIFACT_QUERY_MAX_SLIDES),
    maxTextBytes: PresentationTextLimit,
    maxBytes: presentationResponseBytes(53),
  })
  .strict();
const PresentationEditorSlideRequest = z
  .object({
    kind: z.literal("editor-slide"),
    slideId: CanonicalStableId,
    maxNodes: PresentationNodeLimit,
    maxTextBytes: PresentationTextLimit,
    maxBytes: presentationResponseBytes(75),
  })
  .strict();

/** Exact bounded query union shared by the model-facing direct inspect tool. */
export const EditableArtifactQueryRequestSchema: z.ZodType<EditableArtifactAgentQuery["query"]> = z
  .union([
    SpreadsheetMetadataRequest,
    SpreadsheetViewportRequest,
    DocumentSummaryRequest,
    DocumentBodyRequest,
    DocumentStoryRequest,
    DocumentSectionsRequest,
    DocumentReviewRequest,
    PresentationViewportRequest,
    PresentationHitTestRequest,
    PresentationResolvedSlideRequest,
    PresentationMetadataRequest,
    PresentationSlideCatalogRequest,
    PresentationEditorSlideRequest,
  ])
  .describe(
    "Exact bounded query for the selected modality. Spreadsheet requests retain their required nested query envelope; document and presentation requests use the fields shown by this schema.",
  );
