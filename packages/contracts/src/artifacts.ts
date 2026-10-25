import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import { ToolGatewayIdentity } from "./tool-catalog";

export const WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES = 5_000_000_000;
export const WORKSPACE_ARTIFACT_SOURCE_MAX_UTF8_BYTES = 5_000_000_000;
export const WORKSPACE_ARTIFACT_SOURCE_MAX_FILES = Number.MAX_SAFE_INTEGER;
export const WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX = 128;
export const WORKSPACE_ARTIFACT_TITLE_MAX_CHARS = 120;
export const WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS = 2_000;
export const WORKSPACE_ARTIFACT_LIST_MAX = 100;
export const WORKSPACE_ARTIFACT_LIST_DEFAULT = 50;
export const WORKSPACE_ARTIFACT_CURSOR_MAX_CHARS = 512;

const encoder = new TextEncoder();
const sha256 = /* @__PURE__ */ defineSchema(() => primitives.string.regex(/^[0-9a-f]{64}$/));

export const WorkspaceArtifactSlug = /* @__PURE__ */ defineSchema(() =>
  primitives.string
    .trim()
    .min(1)
    .max(96)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
);
export type WorkspaceArtifactSlug = z.infer<typeof WorkspaceArtifactSlug>;

export const WorkspaceArtifactStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["active", "archived"]),
);
export type WorkspaceArtifactStatus = z.infer<typeof WorkspaceArtifactStatus>;

export const WorkspaceArtifactSourcePath = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u)
    .refine(
      (value) =>
        !value
          .split("/")
          .some((segment) => segment === "." || segment === ".." || segment.length === 0),
      { message: "artifact source paths must be relative and traversal-free" },
    ),
);
export type WorkspaceArtifactSourcePath = z.infer<typeof WorkspaceArtifactSourcePath>;

export const WorkspaceArtifactSourceFile = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      path: WorkspaceArtifactSourcePath,
      content: primitives.string,
    })
    .strict(),
);
export type WorkspaceArtifactSourceFile = z.infer<typeof WorkspaceArtifactSourceFile>;

/** Retained editable source; the published runtime remains one exact HTML document. */
export const WorkspaceArtifactSourceBundle = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      entrypoint: WorkspaceArtifactSourcePath,
      files: z.array(WorkspaceArtifactSourceFile).min(1).max(WORKSPACE_ARTIFACT_SOURCE_MAX_FILES),
    })
    .strict()
    .superRefine((value, context) => {
      const paths = new Set<string>();
      for (const [index, file] of value.files.entries()) {
        if (paths.has(file.path)) {
          context.addIssue({
            code: "custom",
            path: ["files", index, "path"],
            message: "artifact source file paths must be unique",
          });
        }
        paths.add(file.path);
      }
      if (!paths.has(value.entrypoint)) {
        context.addIssue({
          code: "custom",
          path: ["entrypoint"],
          message: "artifact source entrypoint must name one retained file",
        });
      }
      if (
        encoder.encode(JSON.stringify(value)).byteLength > WORKSPACE_ARTIFACT_SOURCE_MAX_UTF8_BYTES
      ) {
        context.addIssue({
          code: "custom",
          message: `artifact source exceeds ${WORKSPACE_ARTIFACT_SOURCE_MAX_UTF8_BYTES} UTF-8 bytes`,
        });
      }
    }),
);
export type WorkspaceArtifactSourceBundle = z.infer<typeof WorkspaceArtifactSourceBundle>;

export const WorkspaceArtifactRequestedTools = /* @__PURE__ */ defineSchema(() =>
  z
    .array(ToolGatewayIdentity)
    .max(WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX)
    .superRefine((tools, context) => {
      const seen = new Set<string>();
      for (const [index, identity] of tools.entries()) {
        const key = `${identity.serverId}\u0000${identity.toolName}`;
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "requested artifact tools must be unique",
          });
        }
        seen.add(key);
      }
    }),
);
export type WorkspaceArtifactRequestedTools = z.infer<typeof WorkspaceArtifactRequestedTools>;

export const WorkspaceArtifactVersion = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    accountId: primitives.uuid,
    workspaceId: primitives.uuid,
    artifactId: primitives.uuid,
    revision: primitives.positiveInteger,
    contentType: z.literal("text/html"),
    contentSha256: sha256.nullable(),
    sizeBytes: primitives.positiveInteger.max(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES),
    sourceSha256: sha256.nullable(),
    sourceSizeBytes: primitives.positiveInteger
      .max(WORKSPACE_ARTIFACT_SOURCE_MAX_UTF8_BYTES)
      .nullable(),
    requestedTools: WorkspaceArtifactRequestedTools,
    sourceSessionId: primitives.nullableUuid,
    sourceTurnId: primitives.nullableUuid,
    sourceAttemptId: primitives.nullableUuid,
    sourceExecutionGeneration: z.number().int().positive().nullable(),
    createdBySubjectId: z.string().min(1).max(1024),
    createdAt: primitives.string.datetime({ offset: true }),
  }),
);
export type WorkspaceArtifactVersion = z.infer<typeof WorkspaceArtifactVersion>;

/**
 * Who can see a Site, in the same words as a chat or a schedule: everyone in
 * the workspace, or only its owner ("Only me").
 */
export const WorkspaceArtifactVisibility = /* @__PURE__ */ defineSchema(() =>
  z.enum(["private", "workspace"]),
);
export type WorkspaceArtifactVisibility = z.infer<typeof WorkspaceArtifactVisibility>;

export const WorkspaceArtifact = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    accountId: primitives.uuid,
    workspaceId: primitives.uuid,
    slug: WorkspaceArtifactSlug,
    title: primitives.string.trim().min(1).max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS),
    description: primitives.string.max(WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS).nullable(),
    status: WorkspaceArtifactStatus,
    /** Absent from older servers, where every Site is visible to the workspace. */
    visibility: WorkspaceArtifactVisibility.default("workspace"),
    /** The person the Site belongs to; only they can change its audience. */
    ownerSubjectId: z.string().min(1).max(1024).nullable().default(null),
    currentVersion: WorkspaceArtifactVersion.nullable(),
    createdBySubjectId: z.string().min(1).max(1024),
    createdAt: primitives.string.datetime({ offset: true }),
    updatedAt: primitives.string.datetime({ offset: true }),
  }),
);
export type WorkspaceArtifact = z.infer<typeof WorkspaceArtifact>;

export const WorkspaceArtifactEventType = /* @__PURE__ */ defineSchema(() =>
  z.enum(["published", "rolled_back", "archived", "restored"]),
);
export type WorkspaceArtifactEventType = z.infer<typeof WorkspaceArtifactEventType>;

export const WorkspaceArtifactEvent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    accountId: primitives.uuid,
    workspaceId: primitives.uuid,
    artifactId: primitives.uuid,
    type: WorkspaceArtifactEventType,
    fromVersionId: primitives.nullableUuid,
    toVersionId: primitives.uuid,
    sourceSessionId: primitives.nullableUuid,
    sourceTurnId: primitives.nullableUuid,
    sourceAttemptId: primitives.nullableUuid,
    sourceExecutionGeneration: z.number().int().positive().nullable(),
    actorSubjectId: z.string().min(1).max(1024),
    reason: z.string().min(1).max(4096),
    createdAt: primitives.string.datetime({ offset: true }),
  }),
);
export type WorkspaceArtifactEvent = z.infer<typeof WorkspaceArtifactEvent>;

/** When this person last opened the Site; it orders the Site's sidebar row. */
export const SiteOpenedResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    openedAt: primitives.string.datetime({ offset: true }),
  }),
);
export type SiteOpenedResponse = z.infer<typeof SiteOpenedResponse>;

/**
 * Pin or archive a Site row in this person's own sidebar. Archive only hides
 * the row for them; the Site stays published for everyone.
 */
export const UpdateSiteSidebarStateRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
    })
    .strict()
    .refine((value) => value.pinned !== undefined || value.archived !== undefined, {
      message: "Set pinned or archived",
    }),
);
export type UpdateSiteSidebarStateRequest = z.infer<typeof UpdateSiteSidebarStateRequest>;

export const SiteSidebarStateResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    siteId: z.string().uuid(),
    pinned: z.boolean(),
    pinnedAt: z.string().datetime({ offset: true }).nullable(),
    archived: z.boolean(),
    archivedAt: z.string().datetime({ offset: true }).nullable(),
  }),
);
export type SiteSidebarStateResponse = z.infer<typeof SiteSidebarStateResponse>;

export const WorkspaceArtifactListQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(WORKSPACE_ARTIFACT_LIST_MAX)
      .default(WORKSPACE_ARTIFACT_LIST_DEFAULT),
    cursor: primitives.nonEmptyString.max(WORKSPACE_ARTIFACT_CURSOR_MAX_CHARS).optional(),
    status: WorkspaceArtifactStatus.optional(),
    /** Sites created or published by this session, including older versions. */
    sourceSessionId: primitives.optionalUuid,
  }),
);
export type WorkspaceArtifactListQuery = z.infer<typeof WorkspaceArtifactListQuery>;

export const WorkspaceArtifactListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    artifacts: z.array(WorkspaceArtifact).max(WORKSPACE_ARTIFACT_LIST_MAX),
    nextCursor: primitives.string.max(WORKSPACE_ARTIFACT_CURSOR_MAX_CHARS).nullable(),
    truncated: primitives.boolean,
  }),
);
export type WorkspaceArtifactListResponse = z.infer<typeof WorkspaceArtifactListResponse>;

export const WorkspaceArtifactDetailResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    artifact: WorkspaceArtifact,
    versions: z.array(WorkspaceArtifactVersion).max(WORKSPACE_ARTIFACT_LIST_MAX),
    events: z.array(WorkspaceArtifactEvent).max(WORKSPACE_ARTIFACT_LIST_MAX),
    versionsTruncated: primitives.boolean,
    eventsTruncated: primitives.boolean,
  }),
);
export type WorkspaceArtifactDetailResponse = z.infer<typeof WorkspaceArtifactDetailResponse>;

/**
 * A Site and its current version without its history or who made it: what an
 * open Site view checks to see whether a new version is live.
 */
export const WorkspaceArtifactCurrentResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    artifact: WorkspaceArtifact,
  }),
);
export type WorkspaceArtifactCurrentResponse = z.infer<typeof WorkspaceArtifactCurrentResponse>;

export const WorkspaceArtifactHtml = /* @__PURE__ */ defineSchema(() =>
  primitives.nonEmptyString
    .max(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES)
    .superRefine((value, ctx) => {
      if (encoder.encode(value).byteLength > WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES) {
        ctx.addIssue({
          code: "custom",
          message: `artifact HTML exceeds ${WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES} UTF-8 bytes`,
        });
      }
    }),
);

export const CreateWorkspaceArtifactRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      slug: WorkspaceArtifactSlug.optional(),
      title: primitives.string.trim().min(1).max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS),
      description: primitives.string
        .max(WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS)
        .nullable()
        .optional(),
      html: WorkspaceArtifactHtml.optional(),
      uploadId: primitives.optionalUuid,
      source: WorkspaceArtifactSourceBundle.optional(),
      requestedTools: WorkspaceArtifactRequestedTools.optional(),
      /** Who can see the new Site. Omitted: the whole workspace. */
      visibility: WorkspaceArtifactVisibility.optional(),
      idempotencyKey: primitives.string.trim().min(1).max(200),
    })
    .refine((value) => (value.html !== undefined) !== (value.uploadId !== undefined), {
      message: "Provide either html or uploadId",
    })
    .refine((value) => !value.uploadId || value.source === undefined, {
      message: "Upload source using the prepared source URL",
    }),
);
export type CreateWorkspaceArtifactRequest = z.infer<typeof CreateWorkspaceArtifactRequest>;

export const PublishWorkspaceArtifactVersionRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      title: primitives.string.trim().min(1).max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS).optional(),
      description: primitives.string
        .max(WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS)
        .nullable()
        .optional(),
      html: WorkspaceArtifactHtml.optional(),
      uploadId: primitives.optionalUuid,
      source: WorkspaceArtifactSourceBundle.optional(),
      requestedTools: WorkspaceArtifactRequestedTools.optional(),
      expectedCurrentVersionId: primitives.uuid,
      idempotencyKey: primitives.string.trim().min(1).max(200),
    })
    .refine((value) => (value.html !== undefined) !== (value.uploadId !== undefined), {
      message: "Provide either html or uploadId",
    })
    .refine((value) => !value.uploadId || value.source === undefined, {
      message: "Upload source using the prepared source URL",
    }),
);
export type PublishWorkspaceArtifactVersionRequest = z.infer<
  typeof PublishWorkspaceArtifactVersionRequest
>;

export const RollbackWorkspaceArtifactRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    versionId: primitives.uuid,
    expectedCurrentVersionId: primitives.uuid,
    reason: primitives.string.trim().min(1).max(4096),
    idempotencyKey: primitives.string.trim().min(1).max(200),
  }),
);
export type RollbackWorkspaceArtifactRequest = z.infer<typeof RollbackWorkspaceArtifactRequest>;

/**
 * A new Site from another Site's current version: its HTML, source and
 * requested tools. Its publication, data and history stay with the original.
 */
export const DuplicateWorkspaceArtifactRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Omitted: the original's title followed by "(copy)". */
    title: primitives.string.trim().min(1).max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS).optional(),
    idempotencyKey: primitives.string.trim().min(1).max(200),
  }),
);
export type DuplicateWorkspaceArtifactRequest = z.infer<typeof DuplicateWorkspaceArtifactRequest>;

export const SetWorkspaceArtifactStatusRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    status: WorkspaceArtifactStatus,
    expectedCurrentVersionId: primitives.uuid,
    reason: primitives.string.trim().min(1).max(4096),
    idempotencyKey: primitives.string.trim().min(1).max(200),
  }),
);
export type SetWorkspaceArtifactStatusRequest = z.infer<typeof SetWorkspaceArtifactStatusRequest>;

/** Change who can see a Site. Only its owner can. */
export const UpdateWorkspaceArtifactVisibilityRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      visibility: WorkspaceArtifactVisibility,
    })
    .strict(),
);
export type UpdateWorkspaceArtifactVisibilityRequest = z.infer<
  typeof UpdateWorkspaceArtifactVisibilityRequest
>;

export const UpdateWorkspaceArtifactVisibilityResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    artifact: WorkspaceArtifact,
  }),
);
export type UpdateWorkspaceArtifactVisibilityResponse = z.infer<
  typeof UpdateWorkspaceArtifactVisibilityResponse
>;

export const WorkspaceArtifactMutationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    artifact: WorkspaceArtifact,
    version: WorkspaceArtifactVersion,
    event: WorkspaceArtifactEvent,
    replayed: primitives.boolean,
  }),
);
export type WorkspaceArtifactMutationResponse = z.infer<typeof WorkspaceArtifactMutationResponse>;

export const WorkspaceArtifactContentResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    artifactId: primitives.uuid,
    versionId: primitives.uuid,
    contentType: z.literal("text/html"),
    contentSha256: sha256.nullable(),
    html: WorkspaceArtifactHtml,
    source: WorkspaceArtifactSourceBundle,
    requestedTools: WorkspaceArtifactRequestedTools,
  }),
);
export type WorkspaceArtifactContentResponse = z.infer<typeof WorkspaceArtifactContentResponse>;

export function normalizeWorkspaceArtifactSlug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
    .replace(/-+$/g, "");
}
