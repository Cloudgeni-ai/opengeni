import { z } from "zod";

export const KNOWLEDGE_BROWSE_CURSOR_MAX_CHARS = 1_024;
export const KNOWLEDGE_BROWSE_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_BROWSE_MAX_LIMIT = 50;
export const KNOWLEDGE_BROWSE_MAX_RESPONSE_BYTES = 64 * 1_024;
export const KNOWLEDGE_TITLE_MAX_BYTES = 1_024;
export const KNOWLEDGE_BODY_MAX_BYTES = 16 * 1_024;
export const KNOWLEDGE_SUMMARY_MAX_BYTES = 4 * 1_024;
export const KNOWLEDGE_TOPIC_MAX_BYTES = 256;
export const KNOWLEDGE_TOPICS_MAX_ITEMS = 32;
export const KNOWLEDGE_METADATA_MAX_BYTES = 8 * 1_024;
export const KNOWLEDGE_METADATA_MAX_ITEMS = 64;
export const KNOWLEDGE_METADATA_MAX_DEPTH = 4;
export const KNOWLEDGE_SOURCE_STRING_MAX_BYTES = 2_048;
export const KNOWLEDGE_SOURCE_URI_MAX_BYTES = 8_192;
export const KNOWLEDGE_SEARCH_MAX_RESULTS = 50;
export const KNOWLEDGE_SEARCH_MAX_RESPONSE_BYTES = 64 * 1_024;
export const KNOWLEDGE_SEARCH_TOKEN_ESTIMATE_BYTES_PER_TOKEN = 4;
export const KNOWLEDGE_SEARCH_MAX_FLOOR_OMISSIONS = 200;
// Cosine similarity for unrelated embeddings clusters around 0.5 after the
// distance conversion used by Documents. Keyword search already excludes
// non-matches in SQL, but a small normalized floor removes incidental hits.
export const KNOWLEDGE_SEARCH_MIN_VECTOR_SCORE = 0.52;
export const KNOWLEDGE_SEARCH_MIN_KEYWORD_SCORE = 0.01;
export const KNOWLEDGE_QUERY_MAX_BYTES = 4 * 1_024;

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const boundedUtf8 = (maxBytes: number) =>
  z.string().superRefine((value, ctx) => {
    if (utf8Bytes(value) > maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be at most ${maxBytes} UTF-8 bytes`,
      });
    }
  });

function boundedJson(value: unknown): boolean {
  let items = 0;
  let valid = true;
  const visit = (candidate: unknown, depth: number): void => {
    if (!valid || ++items > KNOWLEDGE_METADATA_MAX_ITEMS || depth > KNOWLEDGE_METADATA_MAX_DEPTH) {
      valid = false;
      return;
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return;
    }
    if (typeof candidate === "string") {
      if (utf8Bytes(candidate) > KNOWLEDGE_SOURCE_STRING_MAX_BYTES) valid = false;
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (typeof candidate === "object") {
      for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
        if (utf8Bytes(key) > KNOWLEDGE_TOPIC_MAX_BYTES) valid = false;
        visit(item, depth + 1);
      }
      return;
    }
    valid = false;
  };
  visit(value, 0);
  if (!valid) return false;
  try {
    return utf8Bytes(JSON.stringify(value)) <= KNOWLEDGE_METADATA_MAX_BYTES;
  } catch {
    return false;
  }
}

export const KnowledgeRecordId = z
  .string()
  .regex(
    /^(document|document_chunk):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
export type KnowledgeRecordId = z.infer<typeof KnowledgeRecordId>;

export const KnowledgeRecordKind = z.enum(["document", "document_chunk"]);
export type KnowledgeRecordKind = z.infer<typeof KnowledgeRecordKind>;

export const KnowledgeAuthority = z.object({
  kind: z.enum(["organization", "workspace", "personal"]),
});
export type KnowledgeAuthority = z.infer<typeof KnowledgeAuthority>;

export const KnowledgeSource = z.object({
  kind: z.enum([
    "manual_upload",
    "meeting_transcript",
    "repository",
    "email",
    "chat",
    "document",
    "web",
    "other",
  ]),
  uri: boundedUtf8(KNOWLEDGE_SOURCE_URI_MAX_BYTES).pipe(z.string().min(1)).nullable(),
  externalId: boundedUtf8(KNOWLEDGE_SOURCE_STRING_MAX_BYTES).nullable(),
  title: boundedUtf8(KNOWLEDGE_SOURCE_STRING_MAX_BYTES).nullable(),
  author: boundedUtf8(KNOWLEDGE_SOURCE_STRING_MAX_BYTES).nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  version: boundedUtf8(KNOWLEDGE_SOURCE_STRING_MAX_BYTES).nullable(),
});
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

export const KnowledgeSearchRequest = z
  .object({
    query: boundedUtf8(KNOWLEDGE_QUERY_MAX_BYTES).pipe(z.string().min(1)),
    baseIds: z.array(z.string().uuid()).max(50).optional(),
    mode: z.enum(["hybrid", "vector", "keyword"]).optional(),
    sourceKinds: z.array(KnowledgeSource.shape.kind).max(8).optional(),
    aclTags: z
      .array(boundedUtf8(KNOWLEDGE_TOPIC_MAX_BYTES).pipe(z.string().min(1)))
      .max(64)
      .optional(),
    limit: z.number().int().positive().max(KNOWLEDGE_SEARCH_MAX_RESULTS).default(5),
  })
  .strict();
export type KnowledgeSearchRequest = z.input<typeof KnowledgeSearchRequest>;

export const KnowledgeBrowseRequest = z
  .object({
    parentId: KnowledgeRecordId.optional(),
    topic: boundedUtf8(KNOWLEDGE_TOPIC_MAX_BYTES).pipe(z.string().min(1)).optional(),
    sourceKinds: z.array(KnowledgeSource.shape.kind).max(8).optional(),
    cursor: z.string().min(1).max(KNOWLEDGE_BROWSE_CURSOR_MAX_CHARS).optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(KNOWLEDGE_BROWSE_MAX_LIMIT)
      .default(KNOWLEDGE_BROWSE_DEFAULT_LIMIT),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.parentId && (value.topic || (value.sourceKinds?.length ?? 0) > 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "document contents do not accept topic or source filters",
      });
    }
  });
export type KnowledgeBrowseRequest = z.input<typeof KnowledgeBrowseRequest>;

export const KnowledgeProviderCitation = z.object({
  provider: z.literal("google_drive"),
  externalObjectId: boundedUtf8(KNOWLEDGE_SOURCE_STRING_MAX_BYTES),
  providerRevision: boundedUtf8(KNOWLEDGE_SOURCE_STRING_MAX_BYTES).nullable(),
  sourceVersion: boundedUtf8(KNOWLEDGE_SOURCE_STRING_MAX_BYTES),
  driveId: boundedUtf8(KNOWLEDGE_SOURCE_STRING_MAX_BYTES).nullable(),
  deepLink: boundedUtf8(KNOWLEDGE_SOURCE_URI_MAX_BYTES).pipe(z.string().min(1)).nullable(),
  aclRevision: z.string().regex(/^[0-9a-f]{64}$/u),
  authorizationObservedAt: z.string().datetime({ offset: true }),
  authorizationExpiresAt: z.string().datetime({ offset: true }),
  reauthorizedAt: z.string().datetime({ offset: true }),
});
export type KnowledgeProviderCitation = z.infer<typeof KnowledgeProviderCitation>;

export const KnowledgeLinkTarget = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("knowledge"),
    id: KnowledgeRecordId,
  }),
  z.object({
    kind: z.literal("external"),
    uri: boundedUtf8(KNOWLEDGE_SOURCE_URI_MAX_BYTES).pipe(z.string().min(1)),
  }),
]);
export type KnowledgeLinkTarget = z.infer<typeof KnowledgeLinkTarget>;

export const KnowledgeLink = z.object({
  relation: z.enum(["parent", "contents", "previous", "next", "source"]),
  target: KnowledgeLinkTarget,
});
export type KnowledgeLink = z.infer<typeof KnowledgeLink>;

/**
 * Permission-safe agent projection over one flexible knowledge record. Scope,
 * provenance, lifecycle, and stable identity are strict. The body and metadata
 * stay source-shaped so varied company knowledge does not require one rigid
 * taxonomy. Personal subject ids and inaccessible linked-record metadata are
 * deliberately absent.
 */
export const KnowledgeRecord = z.object({
  id: KnowledgeRecordId,
  kind: KnowledgeRecordKind,
  title: boundedUtf8(KNOWLEDGE_TITLE_MAX_BYTES),
  content: z.object({
    format: z.literal("markdown"),
    body: boundedUtf8(KNOWLEDGE_BODY_MAX_BYTES).nullable(),
    summary: boundedUtf8(KNOWLEDGE_SUMMARY_MAX_BYTES).nullable(),
    topics: z.array(boundedUtf8(KNOWLEDGE_TOPIC_MAX_BYTES)).max(KNOWLEDGE_TOPICS_MAX_ITEMS),
    metadata: z.record(z.string(), z.unknown()).refine(boundedJson, {
      message: "knowledge metadata exceeds its JSON projection boundary",
    }),
  }),
  authority: KnowledgeAuthority,
  provenance: z.object({
    source: KnowledgeSource,
    indexedAt: z.string(),
    citation: KnowledgeProviderCitation.nullable().optional(),
  }),
  lifecycle: z.object({
    state: z.literal("active"),
    updatedAt: z.string(),
  }),
  quality: z.object({
    trust: z.literal("sourced"),
    freshnessAt: z.string(),
    conflict: z.literal("not_evaluated"),
    correction: z.literal("current_source_version"),
  }),
  links: z.array(KnowledgeLink).max(8),
  projection: z.object({
    truncated: z.boolean(),
    fields: z
      .array(
        z.enum([
          "title",
          "content.body",
          "content.summary",
          "content.topics",
          "content.metadata",
          "provenance.source.uri",
          "provenance.source.externalId",
          "provenance.source.title",
          "provenance.source.author",
          "provenance.source.version",
          "provenance.citation",
        ]),
      )
      .max(11),
  }),
});
export type KnowledgeRecord = z.infer<typeof KnowledgeRecord>;

export const KnowledgeSearchResult = z.object({
  record: KnowledgeRecord,
  retrieval: z.object({
    /** Final bounded ordering score after the documented quality adjustment. */
    score: z.number().min(0).max(1),
    /** Semantic score before the quality adjustment. */
    semanticScore: z.number().min(0).max(1),
    matchType: z.enum(["hybrid", "vector", "keyword"]),
    vectorScore: z.number().min(0).max(1).nullable(),
    keywordScore: z.number().min(0).max(1).nullable(),
    relevanceSignals: z
      .array(z.enum(["vector", "keyword"]))
      .min(1)
      .max(2),
    freshness: z.enum(["current", "aging", "stale"]),
    qualityAdjustment: z.number().min(0).max(1),
    duplicateCount: z.number().int().nonnegative(),
  }),
});
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResult>;

export const KnowledgeSearchResponse = z.object({
  results: z.array(KnowledgeSearchResult).max(KNOWLEDGE_SEARCH_MAX_RESULTS),
  selection: z.object({
    relevanceFloor: z.object({
      policy: z.literal("any_signal"),
      vectorScore: z.literal(KNOWLEDGE_SEARCH_MIN_VECTOR_SCORE),
      keywordScore: z.literal(KNOWLEDGE_SEARCH_MIN_KEYWORD_SCORE),
    }),
    dedupe: z.object({
      policy: z.literal("exact_textual_content"),
    }),
    candidates: z.object({
      ranked: z.number().int().nonnegative().max(KNOWLEDGE_SEARCH_MAX_RESULTS),
      rechecked: z.number().int().nonnegative().max(KNOWLEDGE_SEARCH_MAX_RESULTS),
      omittedOnRecheck: z.number().int().nonnegative().max(KNOWLEDGE_SEARCH_MAX_RESULTS),
    }),
    omitted: z.object({
      belowRelevanceFloor: z.number().int().nonnegative().max(KNOWLEDGE_SEARCH_MAX_FLOOR_OMISSIONS),
      asDuplicate: z.number().int().nonnegative().max(KNOWLEDGE_SEARCH_MAX_RESULTS),
      forLimit: z.number().int().nonnegative().max(KNOWLEDGE_SEARCH_MAX_RESULTS),
      forResponseBudget: z.number().int().nonnegative().max(KNOWLEDGE_SEARCH_MAX_RESULTS),
    }),
    budget: z.object({
      maxResults: z.literal(KNOWLEDGE_SEARCH_MAX_RESULTS),
      maxResponseBytes: z.literal(KNOWLEDGE_SEARCH_MAX_RESPONSE_BYTES),
      responseBytes: z.number().int().nonnegative().max(KNOWLEDGE_SEARCH_MAX_RESPONSE_BYTES),
      tokenEstimateBytesPerToken: z.literal(KNOWLEDGE_SEARCH_TOKEN_ESTIMATE_BYTES_PER_TOKEN),
      estimatedTokens: z.number().int().nonnegative(),
      maxEstimatedTokens: z.literal(
        Math.ceil(
          KNOWLEDGE_SEARCH_MAX_RESPONSE_BYTES / KNOWLEDGE_SEARCH_TOKEN_ESTIMATE_BYTES_PER_TOKEN,
        ),
      ),
    }),
  }),
});
export type KnowledgeSearchResponse = z.infer<typeof KnowledgeSearchResponse>;

export const KnowledgeGetResponse = z.object({
  record: KnowledgeRecord,
});
export type KnowledgeGetResponse = z.infer<typeof KnowledgeGetResponse>;

export const KnowledgeBrowseResponse = z.object({
  records: z.array(KnowledgeRecord).max(KNOWLEDGE_BROWSE_MAX_LIMIT),
  nextCursor: z.string().min(1).max(KNOWLEDGE_BROWSE_CURSOR_MAX_CHARS).nullable(),
  hasMore: z.boolean(),
  selection: z.object({
    omitted: z.object({
      forResponseBudget: z.number().int().nonnegative().max(KNOWLEDGE_BROWSE_MAX_LIMIT),
    }),
    compactedRecordCount: z.number().int().nonnegative().max(1),
    budget: z.object({
      maxResults: z.literal(KNOWLEDGE_BROWSE_MAX_LIMIT),
      maxResponseBytes: z.literal(KNOWLEDGE_BROWSE_MAX_RESPONSE_BYTES),
      responseBytes: z.number().int().nonnegative().max(KNOWLEDGE_BROWSE_MAX_RESPONSE_BYTES),
      tokenEstimateBytesPerToken: z.literal(KNOWLEDGE_SEARCH_TOKEN_ESTIMATE_BYTES_PER_TOKEN),
      estimatedTokens: z.number().int().nonnegative(),
      maxEstimatedTokens: z.literal(
        Math.ceil(
          KNOWLEDGE_BROWSE_MAX_RESPONSE_BYTES / KNOWLEDGE_SEARCH_TOKEN_ESTIMATE_BYTES_PER_TOKEN,
        ),
      ),
    }),
  }),
});
export type KnowledgeBrowseResponse = z.infer<typeof KnowledgeBrowseResponse>;
