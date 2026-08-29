import { z } from "zod";
import { CanonicalProgrammaticToolEntry, CanonicalToolIdentity } from "./tool-catalog";

export const WORKSPACE_APP_TITLE_MAX_CHARS = 120;
export const WORKSPACE_APP_DESCRIPTION_MAX_CHARS = 2_000;
export const WORKSPACE_APP_LIST_MAX = 100;
export const WORKSPACE_APP_LIST_DEFAULT = 50;
export const WORKSPACE_APP_CURSOR_MAX_CHARS = 512;
export const WORKSPACE_APP_SOURCE_MAX_FILES = 20_000;
export const WORKSPACE_APP_SOURCE_MAX_BYTES = 512 * 1024 * 1024;
export const WORKSPACE_APP_BUILD_MAX_FILES = 2_000;
export const WORKSPACE_APP_BUILD_MAX_BYTES = 250 * 1024 * 1024;
export const WORKSPACE_APP_BUILD_FILE_MAX_BYTES = 32 * 1024 * 1024;
/** @deprecated Use WORKSPACE_APP_BUILD_MAX_FILES. */
export const WORKSPACE_APP_RELEASE_MAX_FILES = WORKSPACE_APP_BUILD_MAX_FILES;
/** @deprecated Use WORKSPACE_APP_BUILD_MAX_BYTES. */
export const WORKSPACE_APP_RELEASE_MAX_BYTES = WORKSPACE_APP_BUILD_MAX_BYTES;
/** @deprecated Use WORKSPACE_APP_BUILD_FILE_MAX_BYTES. */
export const WORKSPACE_APP_RELEASE_FILE_MAX_BYTES = WORKSPACE_APP_BUILD_FILE_MAX_BYTES;
export const WORKSPACE_APP_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_APP_UPLOAD_URL_PAGE_MAX = 200;
export const WORKSPACE_APP_LAUNCH_TTL_MAX_SECONDS = 15 * 60;
export const WORKSPACE_APP_PREVIEW_TTL_MAX_SECONDS = 24 * 60 * 60;

const Uuid = z.string().uuid();
const Timestamp = z.string().datetime({ offset: true });
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const SubjectId = z.string().trim().min(1).max(1_024);
const IdempotencyKey = z.string().trim().min(1).max(200);
const PositiveVersion = z.number().int().positive();

export const WorkspaceAppSlug = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export type WorkspaceAppSlug = z.infer<typeof WorkspaceAppSlug>;

export const WorkspaceAppStatus = z.enum(["active", "archived"]);
export type WorkspaceAppStatus = z.infer<typeof WorkspaceAppStatus>;

export const AppSourceRevisionStatus = z.enum([
  "uploading",
  "verifying",
  "ready",
  "failed",
  "expired",
  "deleting",
  "deleted",
]);
export type AppSourceRevisionStatus = z.infer<typeof AppSourceRevisionStatus>;

export const AppBuildStatus = z.enum([
  "queued",
  "running",
  "uploading",
  "verifying",
  "succeeded",
  "failed",
  "deleting",
  "deleted",
]);
export type AppBuildStatus = z.infer<typeof AppBuildStatus>;

export const AppReleaseStatus = z.enum(["ready", "deleting", "deleted"]);
export type AppReleaseStatus = z.infer<typeof AppReleaseStatus>;

export const AppPreviewStatus = z.enum(["active", "expired", "revoked"]);
export type AppPreviewStatus = z.infer<typeof AppPreviewStatus>;

export const AppSourceFormat = z.literal("portable_tar_v1");
export type AppSourceFormat = z.infer<typeof AppSourceFormat>;

export const AppBuildManifestVersion = z.literal("opengeni.app-build.v1");
export type AppBuildManifestVersion = z.infer<typeof AppBuildManifestVersion>;
/** @deprecated Releases promote an AppBuildManifest without accepting new upload bytes. */
export const AppReleaseManifestVersion = AppBuildManifestVersion;
export type AppReleaseManifestVersion = AppBuildManifestVersion;

export const AppFilePath = z
  .string()
  .min(1)
  .max(1_024)
  .superRefine((value, ctx) => {
    const segments = value.split("/");
    if (
      value.startsWith("/") ||
      value.endsWith("/") ||
      value.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(value) ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "app file paths must be normalized relative POSIX paths without control characters",
      });
    }
  });
export type AppFilePath = z.infer<typeof AppFilePath>;

export const AppBuildFile = z.object({
  path: AppFilePath,
  contentType: z.string().trim().min(1).max(255),
  contentSha256: Sha256,
  sizeBytes: z.number().int().nonnegative().max(WORKSPACE_APP_BUILD_FILE_MAX_BYTES),
  executable: z.boolean().default(false),
});
export type AppBuildFile = z.infer<typeof AppBuildFile>;
/** @deprecated Use AppBuildFile. */
export const AppReleaseFile = AppBuildFile;
export type AppReleaseFile = AppBuildFile;

export const AppBuildManifest = z
  .object({
    version: AppBuildManifestVersion,
    entryPath: AppFilePath,
    files: z.array(AppBuildFile).min(1).max(WORKSPACE_APP_BUILD_MAX_FILES),
    totalBytes: z.number().int().nonnegative().max(WORKSPACE_APP_BUILD_MAX_BYTES),
  })
  .superRefine((manifest, ctx) => {
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const [index, file] of manifest.files.entries()) {
      if (paths.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "app build file paths must be unique",
        });
      }
      paths.add(file.path);
      totalBytes += file.sizeBytes;
    }
    if (!paths.has(manifest.entryPath)) {
      ctx.addIssue({
        code: "custom",
        path: ["entryPath"],
        message: "app build entryPath must name one of the build files",
      });
    }
    if (totalBytes !== manifest.totalBytes) {
      ctx.addIssue({
        code: "custom",
        path: ["totalBytes"],
        message: "app build totalBytes must equal the sum of file sizes",
      });
    }
  });
export type AppBuildManifest = z.infer<typeof AppBuildManifest>;
/** @deprecated Use AppBuildManifest. */
export const AppReleaseManifest = AppBuildManifest;
export type AppReleaseManifest = AppBuildManifest;

/** App projection of the caller-neutral canonical catalog. */
export const AppToolDescriptor = CanonicalProgrammaticToolEntry.superRefine(
  (descriptor, context) => {
    if (
      !descriptor.supportedSurfaces.includes("app") ||
      descriptor.effect !== "read" ||
      descriptor.replaySafety !== "safe" ||
      descriptor.approval !== "none" ||
      descriptor.openWorld
    ) {
      context.addIssue({
        code: "custom",
        message:
          "OpenGeni Apps tools must be closed-world, read-only, replay-safe, App-supported, and require no approval",
      });
    }
  },
);
export type AppToolDescriptor = z.infer<typeof AppToolDescriptor>;

const AppToolIdentityList = z
  .array(CanonicalToolIdentity)
  .max(1_000)
  .superRefine((identities, context) => {
    const seen = new Set<string>();
    for (const [index, identity] of identities.entries()) {
      const key = `${identity.serverId}\u0000${identity.toolName}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "duplicate canonical tool identity",
        });
      }
      seen.add(key);
    }
  });

export const AppToolPolicyRevision = z.object({
  id: Uuid,
  accountId: Uuid,
  workspaceId: Uuid,
  appId: Uuid,
  revision: PositiveVersion,
  catalogDigest: Sha256,
  allowedTools: AppToolIdentityList,
  createdBySubjectId: SubjectId,
  createdAt: Timestamp,
});
export type AppToolPolicyRevision = z.infer<typeof AppToolPolicyRevision>;

export const AppSourceRevision = z.object({
  id: Uuid,
  accountId: Uuid,
  workspaceId: Uuid,
  appId: Uuid,
  revision: PositiveVersion,
  format: AppSourceFormat,
  status: AppSourceRevisionStatus,
  contentSha256: Sha256,
  sizeBytes: z.number().int().positive().max(WORKSPACE_APP_SOURCE_MAX_BYTES),
  fileCount: z.number().int().positive().max(WORKSPACE_APP_SOURCE_MAX_FILES).nullable(),
  failureCode: z.string().trim().min(1).max(256).nullable(),
  sourceSessionId: Uuid.nullable(),
  sourceTurnId: Uuid.nullable(),
  sourceAttemptId: Uuid.nullable(),
  sourceExecutionGeneration: PositiveVersion.nullable(),
  createdBySubjectId: SubjectId,
  createdAt: Timestamp,
  verifiedAt: Timestamp.nullable(),
});
export type AppSourceRevision = z.infer<typeof AppSourceRevision>;

export const AppBuildCheckReceipt = z.object({
  kind: z.enum(["typecheck", "test", "build"]),
  status: z.literal("succeeded"),
  commandDigest: Sha256,
  outputDigest: Sha256,
  durationMs: z.number().int().nonnegative(),
});
export type AppBuildCheckReceipt = z.infer<typeof AppBuildCheckReceipt>;

export const AppBuild = z.object({
  id: Uuid,
  accountId: Uuid,
  workspaceId: Uuid,
  appId: Uuid,
  sourceRevisionId: Uuid,
  toolPolicyRevisionId: Uuid,
  revision: PositiveVersion,
  status: AppBuildStatus,
  manifestSha256: Sha256,
  entryPath: AppFilePath,
  fileCount: z.number().int().positive().max(WORKSPACE_APP_BUILD_MAX_FILES),
  totalBytes: z.number().int().nonnegative().max(WORKSPACE_APP_BUILD_MAX_BYTES),
  checks: z.array(AppBuildCheckReceipt).max(32),
  receiptDigest: Sha256.nullable(),
  failureCode: z.string().trim().min(1).max(256).nullable(),
  createdBySubjectId: SubjectId,
  createdAt: Timestamp,
  verifiedAt: Timestamp.nullable(),
});
export type AppBuild = z.infer<typeof AppBuild>;

export const AppRelease = z.object({
  id: Uuid,
  accountId: Uuid,
  workspaceId: Uuid,
  appId: Uuid,
  buildId: Uuid,
  sourceRevisionId: Uuid,
  toolPolicyRevisionId: Uuid,
  revision: PositiveVersion,
  status: AppReleaseStatus,
  manifestSha256: Sha256,
  entryPath: AppFilePath,
  fileCount: z.number().int().positive().max(WORKSPACE_APP_BUILD_MAX_FILES),
  totalBytes: z.number().int().nonnegative().max(WORKSPACE_APP_BUILD_MAX_BYTES),
  buildReceiptDigest: Sha256,
  createdBySubjectId: SubjectId,
  createdAt: Timestamp,
});
export type AppRelease = z.infer<typeof AppRelease>;

export const AppPreview = z.object({
  id: Uuid,
  accountId: Uuid,
  workspaceId: Uuid,
  appId: Uuid,
  releaseId: Uuid,
  status: AppPreviewStatus,
  createdBySubjectId: SubjectId,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  revokedAt: Timestamp.nullable(),
});
export type AppPreview = z.infer<typeof AppPreview>;

export const WorkspaceApp = z.object({
  id: Uuid,
  accountId: Uuid,
  workspaceId: Uuid,
  slug: WorkspaceAppSlug,
  title: z.string().trim().min(1).max(WORKSPACE_APP_TITLE_MAX_CHARS),
  description: z.string().max(WORKSPACE_APP_DESCRIPTION_MAX_CHARS).nullable(),
  status: WorkspaceAppStatus,
  version: PositiveVersion,
  latestSourceRevisionId: Uuid.nullable(),
  latestBuildId: Uuid.nullable(),
  activeReleaseId: Uuid.nullable(),
  createdBySubjectId: SubjectId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type WorkspaceApp = z.infer<typeof WorkspaceApp>;

export const WorkspaceAppListQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(WORKSPACE_APP_LIST_MAX)
    .default(WORKSPACE_APP_LIST_DEFAULT),
  cursor: z.string().min(1).max(WORKSPACE_APP_CURSOR_MAX_CHARS).optional(),
});
export type WorkspaceAppListQuery = z.infer<typeof WorkspaceAppListQuery>;

export const WorkspaceAppListResponse = z.object({
  apps: z.array(WorkspaceApp).max(WORKSPACE_APP_LIST_MAX),
  nextCursor: z.string().max(WORKSPACE_APP_CURSOR_MAX_CHARS).nullable(),
  truncated: z.boolean(),
});
export type WorkspaceAppListResponse = z.infer<typeof WorkspaceAppListResponse>;

export const WorkspaceAppDetailResponse = z.object({
  app: WorkspaceApp,
  sourceRevisions: z.array(AppSourceRevision).max(WORKSPACE_APP_LIST_MAX),
  builds: z.array(AppBuild).max(WORKSPACE_APP_LIST_MAX),
  releases: z.array(AppRelease).max(WORKSPACE_APP_LIST_MAX),
  previews: z.array(AppPreview).max(WORKSPACE_APP_LIST_MAX),
  toolPolicies: z.array(AppToolPolicyRevision).max(WORKSPACE_APP_LIST_MAX),
  historyTruncated: z.boolean(),
});
export type WorkspaceAppDetailResponse = z.infer<typeof WorkspaceAppDetailResponse>;

export const CreateWorkspaceAppRequest = z.object({
  slug: WorkspaceAppSlug.optional(),
  title: z.string().trim().min(1).max(WORKSPACE_APP_TITLE_MAX_CHARS),
  description: z.string().max(WORKSPACE_APP_DESCRIPTION_MAX_CHARS).nullable().optional(),
  idempotencyKey: IdempotencyKey,
});
export type CreateWorkspaceAppRequest = z.infer<typeof CreateWorkspaceAppRequest>;

export const UpdateWorkspaceAppRequest = z.object({
  title: z.string().trim().min(1).max(WORKSPACE_APP_TITLE_MAX_CHARS).optional(),
  description: z.string().max(WORKSPACE_APP_DESCRIPTION_MAX_CHARS).nullable().optional(),
  expectedVersion: PositiveVersion,
  idempotencyKey: IdempotencyKey,
});
export type UpdateWorkspaceAppRequest = z.infer<typeof UpdateWorkspaceAppRequest>;

export const WorkspaceAppMutationResponse = z.object({
  app: WorkspaceApp,
  replayed: z.boolean(),
});
export type WorkspaceAppMutationResponse = z.infer<typeof WorkspaceAppMutationResponse>;

export const CreateAppToolPolicyRequest = z.object({
  allowedTools: AppToolIdentityList,
  catalogDigest: Sha256,
  expectedAppVersion: PositiveVersion,
  idempotencyKey: IdempotencyKey,
});
export type CreateAppToolPolicyRequest = z.infer<typeof CreateAppToolPolicyRequest>;

export const BeginAppSourceUploadRequest = z.object({
  format: AppSourceFormat.default("portable_tar_v1"),
  contentSha256: Sha256,
  sizeBytes: z.number().int().positive().max(WORKSPACE_APP_SOURCE_MAX_BYTES),
  expectedAppVersion: PositiveVersion,
  idempotencyKey: IdempotencyKey,
});
export type BeginAppSourceUploadRequest = z.infer<typeof BeginAppSourceUploadRequest>;

export const AppSignedUpload = z.object({
  url: z.string().url(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expiresAt: Timestamp,
});
export type AppSignedUpload = z.infer<typeof AppSignedUpload>;

export const BeginAppSourceUploadResponse = z.object({
  sourceRevision: AppSourceRevision,
  stagingUpload: AppSignedUpload,
  replayed: z.boolean(),
});
export type BeginAppSourceUploadResponse = z.infer<typeof BeginAppSourceUploadResponse>;

export const CompleteAppSourceUploadRequest = z.object({
  expectedContentSha256: Sha256,
  expectedSizeBytes: z.number().int().positive().max(WORKSPACE_APP_SOURCE_MAX_BYTES),
  fileCount: z.number().int().positive().max(WORKSPACE_APP_SOURCE_MAX_FILES),
  idempotencyKey: IdempotencyKey,
});
export type CompleteAppSourceUploadRequest = z.infer<typeof CompleteAppSourceUploadRequest>;

export const AppSourceDownloadResponse = z.object({
  sourceRevision: AppSourceRevision,
  url: z.string().url(),
  expiresAt: Timestamp,
});
export type AppSourceDownloadResponse = z.infer<typeof AppSourceDownloadResponse>;

export const PrepareAppBuildRequest = z.object({
  sourceRevisionId: Uuid,
  toolPolicyRevisionId: Uuid,
  manifestSha256: Sha256,
  manifest: AppBuildManifest,
  checks: z.array(AppBuildCheckReceipt).min(3).max(32),
  expectedAppVersion: PositiveVersion,
  idempotencyKey: IdempotencyKey,
});
export type PrepareAppBuildRequest = z.infer<typeof PrepareAppBuildRequest>;

export const AppBuildFileUpload = z.object({
  path: AppFilePath,
  stagingUpload: AppSignedUpload,
});
export type AppBuildFileUpload = z.infer<typeof AppBuildFileUpload>;

export const PrepareAppBuildResponse = z.object({
  build: AppBuild,
  uploads: z.array(AppBuildFileUpload).max(WORKSPACE_APP_UPLOAD_URL_PAGE_MAX),
  nextCursor: z.string().max(WORKSPACE_APP_CURSOR_MAX_CHARS).nullable(),
  replayed: z.boolean(),
});
export type PrepareAppBuildResponse = z.infer<typeof PrepareAppBuildResponse>;

export const AppBuildUploadListQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(WORKSPACE_APP_UPLOAD_URL_PAGE_MAX)
    .default(WORKSPACE_APP_UPLOAD_URL_PAGE_MAX),
  cursor: z.string().min(1).max(WORKSPACE_APP_CURSOR_MAX_CHARS).optional(),
});
export type AppBuildUploadListQuery = z.infer<typeof AppBuildUploadListQuery>;

export const AppBuildUploadListResponse = z.object({
  buildId: Uuid,
  uploads: z.array(AppBuildFileUpload).max(WORKSPACE_APP_UPLOAD_URL_PAGE_MAX),
  nextCursor: z.string().max(WORKSPACE_APP_CURSOR_MAX_CHARS).nullable(),
});
export type AppBuildUploadListResponse = z.infer<typeof AppBuildUploadListResponse>;

export const CompleteAppBuildRequest = z.object({
  expectedManifestSha256: Sha256,
  idempotencyKey: IdempotencyKey,
});
export type CompleteAppBuildRequest = z.infer<typeof CompleteAppBuildRequest>;

export const AppBuildMutationResponse = z.object({
  app: WorkspaceApp,
  build: AppBuild,
  replayed: z.boolean(),
});
export type AppBuildMutationResponse = z.infer<typeof AppBuildMutationResponse>;

export const PromoteAppBuildRequest = z.object({
  buildId: Uuid,
  expectedAppVersion: PositiveVersion,
  idempotencyKey: IdempotencyKey,
});
export type PromoteAppBuildRequest = z.infer<typeof PromoteAppBuildRequest>;

export const AppReleaseMutationResponse = z.object({
  app: WorkspaceApp,
  release: AppRelease,
  replayed: z.boolean(),
});
export type AppReleaseMutationResponse = z.infer<typeof AppReleaseMutationResponse>;

export const CreateAppPreviewRequest = z.object({
  releaseId: Uuid,
  ttlSeconds: z.number().int().positive().max(WORKSPACE_APP_PREVIEW_TTL_MAX_SECONDS).optional(),
  idempotencyKey: IdempotencyKey,
});
export type CreateAppPreviewRequest = z.infer<typeof CreateAppPreviewRequest>;

export const CreateAppPreviewResponse = z.object({
  preview: AppPreview,
  url: z.string().url(),
  replayed: z.boolean(),
});
export type CreateAppPreviewResponse = z.infer<typeof CreateAppPreviewResponse>;

export const PublishAppReleaseRequest = z.object({
  releaseId: Uuid,
  expectedAppVersion: PositiveVersion,
  reason: z.string().trim().min(1).max(4_096),
  idempotencyKey: IdempotencyKey,
});
export type PublishAppReleaseRequest = z.infer<typeof PublishAppReleaseRequest>;

export const RollbackAppReleaseRequest = PublishAppReleaseRequest;
export type RollbackAppReleaseRequest = z.infer<typeof RollbackAppReleaseRequest>;

export const UnpublishWorkspaceAppRequest = z.object({
  expectedAppVersion: PositiveVersion,
  reason: z.string().trim().min(1).max(4_096),
  idempotencyKey: IdempotencyKey,
});
export type UnpublishWorkspaceAppRequest = z.infer<typeof UnpublishWorkspaceAppRequest>;

export const ArchiveWorkspaceAppRequest = z.object({
  expectedAppVersion: PositiveVersion,
  reason: z.string().trim().min(1).max(4_096),
  idempotencyKey: IdempotencyKey,
});
export type ArchiveWorkspaceAppRequest = z.infer<typeof ArchiveWorkspaceAppRequest>;
/** @deprecated The MVP archives Apps and retains history; it does not hard-delete them. */
export const DeleteWorkspaceAppRequest = ArchiveWorkspaceAppRequest;
export type DeleteWorkspaceAppRequest = ArchiveWorkspaceAppRequest;

export const CreateAppLaunchRequest = z.object({
  releaseId: Uuid.optional(),
  previewId: Uuid.optional(),
  ttlSeconds: z.number().int().positive().max(WORKSPACE_APP_LAUNCH_TTL_MAX_SECONDS).optional(),
});
export type CreateAppLaunchRequest = z.infer<typeof CreateAppLaunchRequest>;

export const CreateAppLaunchResponse = z.object({
  launchId: Uuid,
  appId: Uuid,
  releaseId: Uuid,
  authorityGeneration: z.string().trim().min(1).max(256),
  launchUrl: z.string().url(),
  appOrigin: z.string().url(),
  nonce: z.string().min(32).max(256),
  expiresAt: Timestamp,
});
export type CreateAppLaunchResponse = z.infer<typeof CreateAppLaunchResponse>;

export const AppRuntimeCatalogResponse = z.object({
  appId: Uuid,
  releaseId: Uuid,
  toolPolicyRevisionId: Uuid,
  catalogDigest: Sha256,
  tools: z.array(AppToolDescriptor).max(1_000),
});
export type AppRuntimeCatalogResponse = z.infer<typeof AppRuntimeCatalogResponse>;

export const AppRuntimeToolCallRequest = z.object({
  operationId: Uuid,
  identity: CanonicalToolIdentity,
  input: z.record(z.string(), z.unknown()),
  catalogDigest: Sha256,
});
export type AppRuntimeToolCallRequest = z.infer<typeof AppRuntimeToolCallRequest>;

export const AppRuntimeToolCallError = z.object({
  code: z.string().trim().min(1).max(256),
  message: z.string().max(4_096),
  retryable: z.boolean(),
});
export type AppRuntimeToolCallError = z.infer<typeof AppRuntimeToolCallError>;

export const AppRuntimeToolCallResponse = z.object({
  operationId: Uuid,
  status: z.enum(["succeeded", "failed"]),
  output: z.unknown().nullable(),
  error: AppRuntimeToolCallError.nullable(),
  replayed: z.boolean(),
});
export type AppRuntimeToolCallResponse = z.infer<typeof AppRuntimeToolCallResponse>;

export function normalizeWorkspaceAppSlug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
    .replace(/-+$/g, "");
}