import { z } from "zod";
import { RetainedArtifactReferenceSchema } from "./retained-output";

export const ArtifactCatalogKind = z.enum([
  "site",
  "document",
  "spreadsheet",
  "presentation",
  "image",
  "file",
]);
export type ArtifactCatalogKind = z.infer<typeof ArtifactCatalogKind>;

/** Metadata only: native domain IDs, never content, storage keys or credentials. */
export const ArtifactCatalogItem = z
  .object({
    id: z.string().min(1).max(128),
    kind: ArtifactCatalogKind,
    title: z.string().min(1).max(1024),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    status: z.enum(["active", "archived"]),
    sourceSessionId: z.string().uuid().optional(),
    versionId: z.string().min(1).max(128).optional(),
    file: RetainedArtifactReferenceSchema.optional(),
    filename: z.string().max(1024).optional(),
    contentType: z.string().max(127).optional(),
    sizeBytes: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
export type ArtifactCatalogItem = z.infer<typeof ArtifactCatalogItem>;

export const ArtifactCatalogListQuery = z
  .object({
    sourceSessionId: z.string().uuid().optional(),
    q: z
      .string()
      .trim()
      .max(200)
      .refine((value) => !value.includes("\0"))
      .optional(),
    kind: ArtifactCatalogKind.optional(),
    sort: z.enum(["updated", "newest", "title"]).default("updated"),
    status: z.enum(["active", "archived"]).default("active"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();
export type ArtifactCatalogListQuery = z.infer<typeof ArtifactCatalogListQuery>;
export type ArtifactCatalogListOptions = Omit<z.input<typeof ArtifactCatalogListQuery>, "limit"> & {
  limit?: number;
};

export const ArtifactCatalogListResponse = z
  .object({
    items: z.array(ArtifactCatalogItem).max(100),
    nextCursor: z.string().max(8192).nullable(),
  })
  .strict();
export type ArtifactCatalogListResponse = z.infer<typeof ArtifactCatalogListResponse>;
