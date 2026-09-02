import { z } from "zod";
import { ToolGatewayIdentity } from "./tool-catalog";

export const WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_ARTIFACT_SOURCE_MAX_UTF8_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_ARTIFACT_SOURCE_MAX_FILES = 128;
export const WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX = 128;
export const WORKSPACE_ARTIFACT_TITLE_MAX_CHARS = 120;
export const WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS = 2_000;
export const WORKSPACE_ARTIFACT_LIST_MAX = 100;
export const WORKSPACE_ARTIFACT_LIST_DEFAULT = 50;
export const WORKSPACE_ARTIFACT_CURSOR_MAX_CHARS = 512;

const encoder = new TextEncoder();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const WorkspaceArtifactSlug = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export type WorkspaceArtifactSlug = z.infer<typeof WorkspaceArtifactSlug>;

export const WorkspaceArtifactStatus = z.enum(["active", "archived"]);
export type WorkspaceArtifactStatus = z.infer<typeof WorkspaceArtifactStatus>;

export const WorkspaceArtifactSourcePath = z
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
  );
export type WorkspaceArtifactSourcePath = z.infer<typeof WorkspaceArtifactSourcePath>;

export const WorkspaceArtifactSourceFile = z
  .object({
    path: WorkspaceArtifactSourcePath,
    content: z.string(),
  })
  .strict();
export type WorkspaceArtifactSourceFile = z.infer<typeof WorkspaceArtifactSourceFile>;

/** Retained editable source; the published runtime remains one exact HTML document. */
export const WorkspaceArtifactSourceBundle = z
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
  });
export type WorkspaceArtifactSourceBundle = z.infer<typeof WorkspaceArtifactSourceBundle>;

export const WorkspaceArtifactRequestedTools = z
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
  });
export type WorkspaceArtifactRequestedTools = z.infer<typeof WorkspaceArtifactRequestedTools>;

export const WorkspaceArtifactVersion = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  artifactId: z.string().uuid(),
  revision: z.number().int().positive(),
  contentType: z.literal("text/html"),
  contentSha256: sha256,
  sizeBytes: z.number().int().positive().max(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES),
  sourceSha256: sha256.nullable(),
  sourceSizeBytes: z
    .number()
    .int()
    .positive()
    .max(WORKSPACE_ARTIFACT_SOURCE_MAX_UTF8_BYTES)
    .nullable(),
  requestedTools: WorkspaceArtifactRequestedTools,
  sourceSessionId: z.string().uuid().nullable(),
  sourceTurnId: z.string().uuid().nullable(),
  sourceAttemptId: z.string().uuid().nullable(),
  sourceExecutionGeneration: z.number().int().positive().nullable(),
  createdBySubjectId: z.string().min(1).max(1024),
  createdAt: z.string().datetime({ offset: true }),
});
export type WorkspaceArtifactVersion = z.infer<typeof WorkspaceArtifactVersion>;

export const WorkspaceArtifact = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  slug: WorkspaceArtifactSlug,
  title: z.string().trim().min(1).max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS),
  description: z.string().max(WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS).nullable(),
  status: WorkspaceArtifactStatus,
  currentVersion: WorkspaceArtifactVersion.nullable(),
  createdBySubjectId: z.string().min(1).max(1024),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkspaceArtifact = z.infer<typeof WorkspaceArtifact>;

export const WorkspaceArtifactEventType = z.enum([
  "published",
  "rolled_back",
  "archived",
  "restored",
]);
export type WorkspaceArtifactEventType = z.infer<typeof WorkspaceArtifactEventType>;

export const WorkspaceArtifactEvent = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  artifactId: z.string().uuid(),
  type: WorkspaceArtifactEventType,
  fromVersionId: z.string().uuid().nullable(),
  toVersionId: z.string().uuid(),
  sourceSessionId: z.string().uuid().nullable(),
  sourceTurnId: z.string().uuid().nullable(),
  sourceAttemptId: z.string().uuid().nullable(),
  sourceExecutionGeneration: z.number().int().positive().nullable(),
  actorSubjectId: z.string().min(1).max(1024),
  reason: z.string().min(1).max(4096),
  createdAt: z.string().datetime({ offset: true }),
});
export type WorkspaceArtifactEvent = z.infer<typeof WorkspaceArtifactEvent>;

export const WorkspaceArtifactListQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(WORKSPACE_ARTIFACT_LIST_MAX)
    .default(WORKSPACE_ARTIFACT_LIST_DEFAULT),
  cursor: z.string().min(1).max(WORKSPACE_ARTIFACT_CURSOR_MAX_CHARS).optional(),
});
export type WorkspaceArtifactListQuery = z.infer<typeof WorkspaceArtifactListQuery>;

export const WorkspaceArtifactListResponse = z.object({
  artifacts: z.array(WorkspaceArtifact).max(WORKSPACE_ARTIFACT_LIST_MAX),
  nextCursor: z.string().max(WORKSPACE_ARTIFACT_CURSOR_MAX_CHARS).nullable(),
  truncated: z.boolean(),
});
export type WorkspaceArtifactListResponse = z.infer<typeof WorkspaceArtifactListResponse>;

export const WorkspaceArtifactDetailResponse = z.object({
  artifact: WorkspaceArtifact,
  versions: z.array(WorkspaceArtifactVersion).max(WORKSPACE_ARTIFACT_LIST_MAX),
  events: z.array(WorkspaceArtifactEvent).max(WORKSPACE_ARTIFACT_LIST_MAX),
  versionsTruncated: z.boolean(),
  eventsTruncated: z.boolean(),
});
export type WorkspaceArtifactDetailResponse = z.infer<typeof WorkspaceArtifactDetailResponse>;

export const WorkspaceArtifactHtml = z
  .string()
  .min(1)
  .max(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES)
  .superRefine((value, ctx) => {
    if (encoder.encode(value).byteLength > WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `artifact HTML exceeds ${WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES} UTF-8 bytes`,
      });
    }
  });

export const CreateWorkspaceArtifactRequest = z.object({
  slug: WorkspaceArtifactSlug.optional(),
  title: z.string().trim().min(1).max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS),
  description: z.string().max(WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS).nullable().optional(),
  html: WorkspaceArtifactHtml,
  source: WorkspaceArtifactSourceBundle.optional(),
  requestedTools: WorkspaceArtifactRequestedTools.optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type CreateWorkspaceArtifactRequest = z.infer<typeof CreateWorkspaceArtifactRequest>;

export const PublishWorkspaceArtifactVersionRequest = z.object({
  title: z.string().trim().min(1).max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS).optional(),
  description: z.string().max(WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS).nullable().optional(),
  html: WorkspaceArtifactHtml,
  source: WorkspaceArtifactSourceBundle.optional(),
  requestedTools: WorkspaceArtifactRequestedTools.optional(),
  expectedCurrentVersionId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type PublishWorkspaceArtifactVersionRequest = z.infer<
  typeof PublishWorkspaceArtifactVersionRequest
>;

export const RollbackWorkspaceArtifactRequest = z.object({
  versionId: z.string().uuid(),
  expectedCurrentVersionId: z.string().uuid(),
  reason: z.string().trim().min(1).max(4096),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type RollbackWorkspaceArtifactRequest = z.infer<typeof RollbackWorkspaceArtifactRequest>;

export const SetWorkspaceArtifactStatusRequest = z.object({
  status: WorkspaceArtifactStatus,
  expectedCurrentVersionId: z.string().uuid(),
  reason: z.string().trim().min(1).max(4096),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type SetWorkspaceArtifactStatusRequest = z.infer<typeof SetWorkspaceArtifactStatusRequest>;

export const WorkspaceArtifactMutationResponse = z.object({
  artifact: WorkspaceArtifact,
  version: WorkspaceArtifactVersion,
  event: WorkspaceArtifactEvent,
  replayed: z.boolean(),
});
export type WorkspaceArtifactMutationResponse = z.infer<typeof WorkspaceArtifactMutationResponse>;

export const WorkspaceArtifactContentResponse = z.object({
  artifactId: z.string().uuid(),
  versionId: z.string().uuid(),
  contentType: z.literal("text/html"),
  contentSha256: sha256,
  html: WorkspaceArtifactHtml,
  source: WorkspaceArtifactSourceBundle,
  requestedTools: WorkspaceArtifactRequestedTools,
});
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
