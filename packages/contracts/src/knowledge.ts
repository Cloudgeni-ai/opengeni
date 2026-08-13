import { z } from "zod";

export const KNOWLEDGE_BROWSE_CURSOR_MAX_CHARS = 1_024;
export const KNOWLEDGE_BROWSE_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_BROWSE_MAX_LIMIT = 50;

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
  uri: z.string().min(1).max(8_192).nullable(),
  externalId: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  version: z.string().nullable(),
});
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

export const KnowledgeLinkTarget = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("knowledge"),
    id: KnowledgeRecordId,
  }),
  z.object({
    kind: z.literal("external"),
    uri: z.string().min(1).max(8_192),
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
  title: z.string(),
  content: z.object({
    format: z.literal("markdown"),
    body: z.string().nullable(),
    summary: z.string().nullable(),
    topics: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()),
  }),
  authority: KnowledgeAuthority,
  provenance: z.object({
    source: KnowledgeSource,
    indexedAt: z.string(),
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
  links: z.array(KnowledgeLink),
});
export type KnowledgeRecord = z.infer<typeof KnowledgeRecord>;

export const KnowledgeSearchResult = z.object({
  record: KnowledgeRecord,
  retrieval: z.object({
    score: z.number(),
    matchType: z.enum(["hybrid", "vector", "keyword"]),
    vectorScore: z.number().nullable(),
    keywordScore: z.number().nullable(),
  }),
});
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResult>;

export const KnowledgeSearchResponse = z.object({
  results: z.array(KnowledgeSearchResult),
});
export type KnowledgeSearchResponse = z.infer<typeof KnowledgeSearchResponse>;

export const KnowledgeGetResponse = z.object({
  record: KnowledgeRecord,
});
export type KnowledgeGetResponse = z.infer<typeof KnowledgeGetResponse>;

export const KnowledgeBrowseResponse = z.object({
  records: z.array(KnowledgeRecord),
  nextCursor: z.string().min(1).max(KNOWLEDGE_BROWSE_CURSOR_MAX_CHARS).nullable(),
  hasMore: z.boolean(),
});
export type KnowledgeBrowseResponse = z.infer<typeof KnowledgeBrowseResponse>;
