import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import { RetainedArtifactReferenceSchema } from "./retained-output";

export const ArtifactCatalogKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["site", "document", "spreadsheet", "presentation", "image", "file"]),
);
export type ArtifactCatalogKind = z.infer<typeof ArtifactCatalogKind>;

/** Metadata only: native domain IDs, never content, storage keys or credentials. */
export const ArtifactCatalogItem = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: z.string().min(1).max(128),
      kind: ArtifactCatalogKind,
      title: z.string().min(1).max(1024),
      createdAt: primitives.string.datetime({ offset: true }),
      updatedAt: primitives.string.datetime({ offset: true }),
      status: z.enum(["active", "archived"]),
      /** Shared workspace metadata, not content-access authority. */
      pinned: primitives.optionalBoolean,
      /** Sites and files: "private" when only its owner (the viewer) can see it. */
      visibility: z.enum(["private", "workspace"]).optional(),
      /** Files only: the viewer owns the file, so they can share or limit it. */
      ownedByViewer: primitives.optionalBoolean,
      sourceSessionId: primitives.optionalUuid,
      versionId: z.string().min(1).max(128).optional(),
      file: RetainedArtifactReferenceSchema.optional(),
      filename: z.string().max(1024).optional(),
      contentType: z.string().max(127).optional(),
      sizeBytes: primitives.nonnegativeInteger.safe().optional(),
    })
    .strict(),
);
export type ArtifactCatalogItem = z.infer<typeof ArtifactCatalogItem>;

const QueryBoolean = /* @__PURE__ */ defineSchema(() =>
  z
    .union([primitives.boolean, z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true"),
);

export const ArtifactCatalogListQuery = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      sourceSessionId: primitives.optionalUuid,
      /**
       * With `sourceSessionId`: also list the artifacts of that chat's
       * sub-sessions (the ones its lineage lists) in the same read.
       */
      includeSubSessions: QueryBoolean.optional(),
      q: primitives.string
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
    .strict(),
);
export type ArtifactCatalogListQuery = z.infer<typeof ArtifactCatalogListQuery>;
export type ArtifactCatalogListOptions = Omit<z.input<typeof ArtifactCatalogListQuery>, "limit"> & {
  limit?: number;
};

export const ArtifactCatalogListResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      items: z.array(ArtifactCatalogItem).max(100),
      nextCursor: z.string().max(8192).nullable(),
    })
    .strict(),
);
export type ArtifactCatalogListResponse = z.infer<typeof ArtifactCatalogListResponse>;

export const UpdateArtifactPinRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ pinned: primitives.boolean }).strict(),
);
export type UpdateArtifactPinRequest = z.infer<typeof UpdateArtifactPinRequest>;

export const ArtifactPinResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: ArtifactCatalogKind,
      artifactId: z.string().min(1).max(128),
      pinned: primitives.boolean,
    })
    .strict(),
);
export type ArtifactPinResponse = z.infer<typeof ArtifactPinResponse>;
