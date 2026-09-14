import { z } from "zod";
import { KnowledgeEntryListResponse, KnowledgeEntryScope } from "./knowledge-entries";

/** Read-only discovery before a model decides whether and where to save. */
export const KnowledgeSavePreparationRequest = z
  .object({
    query: z.string().trim().min(1).max(4096),
    limit: z.number().int().positive().max(20).default(8),
    collectionCursors: z
      .object({
        published: z.string().min(1).max(2048).nullable(),
        needs_review: z.string().min(1).max(2048).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type KnowledgeSavePreparationRequest = z.input<typeof KnowledgeSavePreparationRequest>;

export const KnowledgeCollectionDescriptor = z
  .object({
    id: z.uuid(),
    revisionId: z.uuid(),
    version: z.number().int().positive(),
    scope: KnowledgeEntryScope,
    view: z.enum(["published", "needs_review"]),
    title: z.string(),
    description: z.string(),
    descriptionTruncated: z.boolean(),
    parentIds: z.array(z.uuid()),
  })
  .strict();

export const KnowledgeSavePreparationResponse = z
  .object({
    collections: z.object({
      entries: z.array(KnowledgeCollectionDescriptor),
      complete: z.boolean(),
      nextCursors: z.object({
        published: z.string().nullable(),
        needs_review: z.string().nullable(),
      }),
    }),
    matches: z.object({
      published: KnowledgeEntryListResponse,
      needs_review: KnowledgeEntryListResponse,
    }),
  })
  .strict();
export type KnowledgeSavePreparationResponse = z.infer<typeof KnowledgeSavePreparationResponse>;
