import { z } from "zod";

export const WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES = 512 * 1024;
export const WORKSPACE_ARTIFACT_TITLE_MAX_CHARS = 120;
export const WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS = 2_000;
export const WORKSPACE_ARTIFACT_LIST_MAX = 100;

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

export const WorkspaceArtifactVersion = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  artifactId: z.string().uuid(),
  revision: z.number().int().positive(),
  contentType: z.literal("text/html"),
  contentSha256: sha256,
  sizeBytes: z.number().int().nonnegative().max(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES),
  sourceSessionId: z.string().uuid().nullable(),
  sourceTurnId: z.string().uuid().nullable(),
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

export const WorkspaceArtifactEventType = z.enum(["published", "rolled_back"]);
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
  actorSubjectId: z.string().min(1).max(1024),
  reason: z.string().min(1).max(4096),
  createdAt: z.string().datetime({ offset: true }),
});
export type WorkspaceArtifactEvent = z.infer<typeof WorkspaceArtifactEvent>;

export const WorkspaceArtifactListResponse = z.object({
  artifacts: z.array(WorkspaceArtifact).max(WORKSPACE_ARTIFACT_LIST_MAX),
});
export type WorkspaceArtifactListResponse = z.infer<typeof WorkspaceArtifactListResponse>;

export const WorkspaceArtifactDetailResponse = z.object({
  artifact: WorkspaceArtifact,
  versions: z.array(WorkspaceArtifactVersion).max(WORKSPACE_ARTIFACT_LIST_MAX),
  events: z.array(WorkspaceArtifactEvent).max(WORKSPACE_ARTIFACT_LIST_MAX),
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
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type CreateWorkspaceArtifactRequest = z.infer<typeof CreateWorkspaceArtifactRequest>;

export const PublishWorkspaceArtifactVersionRequest = z.object({
  title: z.string().trim().min(1).max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS).optional(),
  description: z.string().max(WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS).nullable().optional(),
  html: WorkspaceArtifactHtml,
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
