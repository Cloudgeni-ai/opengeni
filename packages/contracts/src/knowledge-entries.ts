import { z } from "zod";
import { AgentLearningMode } from "./agent-learning";

export const KnowledgeEntryKind = z.enum([
  "source",
  "fact",
  "decision",
  "requirement",
  "incident",
  "note",
  "group",
]);
export type KnowledgeEntryKind = z.infer<typeof KnowledgeEntryKind>;

export const KnowledgeEntryScope = z.enum(["organization", "workspace", "personal"]);
export type KnowledgeEntryScope = z.infer<typeof KnowledgeEntryScope>;

/** Source-shaped location, not a second copy of the source body. */
export const KnowledgeEvidenceLocation = z
  .object({
    page: z.number().int().positive().optional(),
    passage: z.string().max(2048).optional(),
    messageIds: z.array(z.string().min(1).max(1024)).max(256).optional(),
    path: z.string().min(1).max(4096).optional(),
    commit: z.string().min(1).max(256).optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.lineEnd === undefined ||
      (value.lineStart !== undefined && value.lineEnd >= value.lineStart),
    "an ending line requires a starting line and cannot precede it",
  );
export type KnowledgeEvidenceLocation = z.infer<typeof KnowledgeEvidenceLocation>;

export const KnowledgeEntryEvidence = z
  .object({
    entryId: z.uuid(),
    revisionId: z.uuid(),
    location: KnowledgeEvidenceLocation.default({}),
    quote: z.string().optional(),
  })
  .strict();
export type KnowledgeEntryEvidence = z.infer<typeof KnowledgeEntryEvidence>;

export const KnowledgeEntrySource = z
  .object({
    kind: z.enum([
      "file",
      "slack",
      "conversation",
      "repository",
      "web",
      "connector",
      "manual",
      "task_note",
    ]),
    noteId: z.uuid().optional(),
    fileId: z.uuid().optional(),
    documentId: z.uuid().optional(),
    sessionId: z.uuid().optional(),
    uri: z.string().min(1).max(8192).optional(),
    externalId: z.string().min(1).max(2048).optional(),
    version: z.string().min(1).max(2048).optional(),
    capturedAt: z.string().datetime({ offset: true }).optional(),
    retention: z.enum(["full_text", "passages", "reference"]).optional(),
  })
  .strict();
export type KnowledgeEntrySource = z.infer<typeof KnowledgeEntrySource>;

export const KnowledgeEntryRelationship = z
  .object({
    entryId: z.uuid(),
    relation: z.enum(["related_to", "depends_on", "applies_to", "conflicts_with", "supersedes"]),
  })
  .strict();
export type KnowledgeEntryRelationship = z.infer<typeof KnowledgeEntryRelationship>;

export const KnowledgeEntryContent = z
  .object({
    title: z.string().min(1),
    kind: KnowledgeEntryKind,
    // Exact accepted content. Request admission and paginated reads own size;
    // source text is not truncated to the former 4,000-character Memory cap.
    content: z.string(),
    source: KnowledgeEntrySource.optional(),
    evidence: z.array(KnowledgeEntryEvidence).max(256).default([]),
    groupIds: z.array(z.uuid()).max(256).default([]),
    relationships: z.array(KnowledgeEntryRelationship).max(256).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== "group" && value.kind !== "source" && !value.content.trim()) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "knowledge content is empty",
      });
    }
    if (value.kind === "source" && !value.source) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "source entries require source identity",
      });
    }
    if (new Set(value.groupIds).size !== value.groupIds.length) {
      context.addIssue({
        code: "custom",
        path: ["groupIds"],
        message: "group membership contains duplicate IDs",
      });
    }
  });
export type KnowledgeEntryContent = z.infer<typeof KnowledgeEntryContent>;
/** Historical relationships are lossless. Admission limits apply to new writes. */
export const StoredKnowledgeEntryContent = KnowledgeEntryContent.safeExtend({
  evidence: z.array(KnowledgeEntryEvidence).default([]),
  groupIds: z.array(z.uuid()).default([]),
  relationships: z.array(KnowledgeEntryRelationship).default([]),
});

/** Scope identity and agent policy are resolved by the host, never supplied by the model. */
export const KnowledgeEntrySaveRequest = z
  .object({
    operationId: z.uuid(),
    entryId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    scope: KnowledgeEntryScope.optional(),
    entry: KnowledgeEntryContent.safeExtend({ title: z.string().min(1).max(1024) }),
  })
  .strict();
export type KnowledgeEntrySaveRequest = z.input<typeof KnowledgeEntrySaveRequest>;

export const KnowledgeTaskNotePromotionRequest = z
  .object({
    operationId: z.uuid(),
    entryId: z.uuid(),
    expectedVersion: z.literal(0),
    noteId: z.uuid(),
    expectedNoteVersion: z.literal(1),
    title: z.string().min(1).max(1024),
    groupIds: z.array(z.uuid()).max(256).default([]),
  })
  .strict();
export type KnowledgeTaskNotePromotionRequest = z.input<typeof KnowledgeTaskNotePromotionRequest>;

export const KnowledgeEntryReviewRequest = z
  .object({
    operationId: z.uuid(),
    entryId: z.uuid(),
    revisionId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    decision: z.enum(["approve", "reject"]),
    entry: KnowledgeEntryContent.safeExtend({ title: z.string().min(1).max(1024) }).optional(),
  })
  .strict()
  .refine(
    (value) => !value.entry || value.decision === "approve",
    "Only approval can include an edited entry",
  );
export type KnowledgeEntryReviewRequest = z.input<typeof KnowledgeEntryReviewRequest>;

export const KnowledgeEntryBatchReviewRequest = z
  .object({
    entries: z.array(KnowledgeEntryReviewRequest).min(1).max(100),
  })
  .strict()
  .refine(
    (value) => new Set(value.entries.map((entry) => entry.entryId)).size === value.entries.length,
    "A review batch cannot repeat an entry",
  );
export type KnowledgeEntryBatchReviewRequest = z.input<typeof KnowledgeEntryBatchReviewRequest>;

export const KnowledgeEntryRestoreRequest = z
  .object({
    operationId: z.uuid(),
    entryId: z.uuid(),
    revisionId: z.uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type KnowledgeEntryRestoreRequest = z.infer<typeof KnowledgeEntryRestoreRequest>;

export const KnowledgeEntryWriteReceipt = z
  .object({
    operationId: z.uuid(),
    entryId: z.uuid(),
    revisionId: z.uuid(),
    version: z.number().int().positive(),
    outcome: z.enum(["published", "pending", "rejected", "archived"]),
    reviewBatchId: z.uuid().nullable(),
    replayed: z.boolean(),
  })
  .strict();
export type KnowledgeEntryWriteReceipt = z.infer<typeof KnowledgeEntryWriteReceipt>;

export const KnowledgeFilePreparationResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("retained"),
      fileId: z.uuid(),
      filename: z.string(),
      receipt: KnowledgeEntryWriteReceipt,
    })
    .strict(),
  z.object({ status: z.literal("disabled"), fileId: z.uuid() }).strict(),
]);
export type KnowledgeFilePreparationResult = z.infer<typeof KnowledgeFilePreparationResult>;

export const KnowledgeEntryRevision = z
  .object({
    id: z.uuid(),
    entryId: z.uuid(),
    number: z.number().int().positive(),
    change: z.enum(["upsert", "archive"]),
    entry: StoredKnowledgeEntryContent,
    previousRevisionId: z.uuid().nullable(),
    restoredFromRevisionId: z.uuid().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    createdBySessionId: z.uuid().nullable(),
    reviewBatchId: z.uuid().nullable(),
    outcome: z.enum(["published", "pending", "rejected", "superseded"]),
  })
  .strict();
export type KnowledgeEntryRevision = z.infer<typeof KnowledgeEntryRevision>;

/** Private owner IDs are not part of a content-discovery projection. */
export const KnowledgeEntryRecord = z
  .object({
    id: z.uuid(),
    scope: KnowledgeEntryScope,
    version: z.number().int().positive(),
    publishedRevisionId: z.uuid().nullable(),
    latestRevisionId: z.uuid(),
    revision: KnowledgeEntryRevision,
    archived: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type KnowledgeEntryRecord = z.infer<typeof KnowledgeEntryRecord>;

export const KnowledgeEntryListRequest = z
  .object({
    query: z.string().max(4096).optional(),
    mode: z.enum(["hybrid", "keyword", "vector"]).default("hybrid"),
    scope: KnowledgeEntryScope.optional(),
    groupId: z.uuid().optional(),
    fileId: z.uuid().optional(),
    kind: KnowledgeEntryKind.optional(),
    view: z.enum(["published", "needs_review", "archived", "rejected"]).default("published"),
    sessionId: z.uuid().optional(),
    reviewBatchId: z.uuid().optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().positive().max(50).default(20),
  })
  .strict();
export type KnowledgeEntryListRequest = z.input<typeof KnowledgeEntryListRequest>;

/** Lists never transfer whole source texts or evidence quotations. */
export const KnowledgeEntrySummary = KnowledgeEntryRecord.omit({ revision: true }).extend({
  score: z.number().finite().optional(),
  excerpts: z
    .array(
      z.object({
        field: z.enum(["title", "content"]),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        text: z.string(),
      }),
    )
    .default([]),
  revision: KnowledgeEntryRevision.omit({ entry: true }).extend({
    title: z.string(),
    kind: KnowledgeEntryKind,
    preview: z.string(),
    groupIds: z.array(z.uuid()),
    sourceKind: KnowledgeEntrySource.shape.kind.nullable(),
  }),
});
export type KnowledgeEntrySummary = z.infer<typeof KnowledgeEntrySummary>;

export const KnowledgeEntryListResponse = z.object({
  entries: z.array(KnowledgeEntrySummary),
  nextCursor: z.string().nullable(),
  searchMode: z.enum(["keyword", "hybrid", "vector"]).optional(),
});
export type KnowledgeEntryListResponse = z.infer<typeof KnowledgeEntryListResponse>;

export const KnowledgeReviewBatch = z.object({
  id: z.uuid(),
  sessionId: z.uuid().nullable(),
  scheduledTaskId: z.uuid().nullable(),
  scheduledTaskRunId: z.uuid().nullable(),
  title: z.string().nullable(),
  scope: KnowledgeEntryScope,
  pendingCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
});
export type KnowledgeReviewBatch = z.infer<typeof KnowledgeReviewBatch>;

export const KnowledgeReviewBatchListRequest = z
  .object({
    scope: KnowledgeEntryScope.optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().positive().max(50).default(20),
  })
  .strict();
export type KnowledgeReviewBatchListRequest = z.input<typeof KnowledgeReviewBatchListRequest>;
export const KnowledgeReviewBatchListResponse = z.object({
  batches: z.array(KnowledgeReviewBatch),
  nextCursor: z.string().nullable(),
});
export type KnowledgeReviewBatchListResponse = z.infer<typeof KnowledgeReviewBatchListResponse>;

/** All policy outcomes are nonblocking; Off refuses authoring, not task execution. */
export function knowledgeWriteDisposition(mode: z.infer<typeof AgentLearningMode>) {
  switch (AgentLearningMode.parse(mode)) {
    case "automatic":
      return "published" as const;
    case "review_first":
      return "pending" as const;
    case "off":
      return "disabled" as const;
  }
}

export const KnowledgeOriginalFileDownload = z
  .object({
    url: z.string().url(),
    expiresAt: z.string(),
    fileId: z.uuid(),
    filename: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type KnowledgeOriginalFileDownload = z.infer<typeof KnowledgeOriginalFileDownload>;
