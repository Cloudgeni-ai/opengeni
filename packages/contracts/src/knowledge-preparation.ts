import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import { KnowledgeEntryListResponse, KnowledgeEntryScope } from "./knowledge-entries";

/** Read-only discovery before a model decides whether and where to save. */
export const KnowledgeSavePreparationRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      query: primitives.string.trim().min(1).max(4096),
      limit: z.number().int().positive().max(20).default(8),
      collectionCursors: z
        .object({
          published: z.string().min(1).max(2048).nullable(),
          needs_review: z.string().min(1).max(2048).nullable(),
        })
        .strict()
        .optional(),
    })
    .strict(),
);
export type KnowledgeSavePreparationRequest = z.input<typeof KnowledgeSavePreparationRequest>;

export const KnowledgeCollectionDescriptor = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: z.uuid(),
      revisionId: z.uuid(),
      version: primitives.positiveInteger,
      scope: KnowledgeEntryScope,
      view: z.enum(["published", "needs_review"]),
      title: primitives.string,
      description: primitives.string,
      descriptionTruncated: primitives.boolean,
      parentIds: z.array(z.uuid()),
    })
    .strict(),
);

export const KnowledgeSavePreparationResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      collections: z.object({
        entries: z.array(KnowledgeCollectionDescriptor),
        complete: primitives.boolean,
        nextCursors: z.object({
          published: primitives.nullableString,
          needs_review: primitives.nullableString,
        }),
      }),
      matches: z.object({
        published: KnowledgeEntryListResponse,
        needs_review: KnowledgeEntryListResponse,
      }),
    })
    .strict(),
);
export type KnowledgeSavePreparationResponse = z.infer<typeof KnowledgeSavePreparationResponse>;
