import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AppBuild,
  AppBuildCheckReceipt,
  AppBuildManifest,
  AppPreview,
  AppRelease,
  AppRuntimeToolCallError,
  AppSourceRevision,
  AppToolPolicyRevision,
  CanonicalToolIdentity,
  WorkspaceApp,
  WorkspaceAppDetailResponse,
  WorkspaceAppListResponse,
} from "@opengeni/contracts";
import { AppBuildManifest as AppBuildManifestSchema } from "@opengeni/contracts/apps";
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";

import type { Database } from "./database";
import { rawRows, withRlsContext, withSessionRlsActorContext } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import * as schema from "./schema";

type RawRow = Record<string, unknown>;
type LifecycleResult = {
  action: string;
  replayed: boolean;
  app?: RawRow;
  sourceRevision?: RawRow;
  toolPolicy?: RawRow;
  build?: RawRow;
  release?: RawRow;
  preview?: RawRow;
  publication?: RawRow;
};

export type AppPublication = {
  id: string;
  accountId: string;
  workspaceId: string;
  appId: string;
  releaseId: string;
  previousReleaseId: string | null;
  hostname: string;
  status: "active" | "retired";
  spaFallback: boolean;
  reason: string;
  createdBySubjectId: string;
  publishedAt: string;
  retiredAt: string | null;
};

export type AppLaunch = {
  id: string;
  accountId: string;
  workspaceId: string;
  appId: string;
  releaseId: string;
  previewId: string | null;
  publicationId: string | null;
  hostname: string;
  authorityHash: string | null;
  authorityEpoch: string | null;
  authorityGeneration: string;
  status: "active" | "revoked";
  expiresAt: string;
  revokedAt: string | null;
  createdBySubjectId: string;
  createdAt: string;
};

export type AppToolCall = {
  id: string;
  accountId: string;
  workspaceId: string;
  appId: string;
  releaseId: string;
  launchId: string;
  operationId: string;
  identity: CanonicalToolIdentity;
  catalogDigest: string;
  inputHash: string;
  status: "pending" | "succeeded" | "failed";
  output: unknown | null;
  error: AppRuntimeToolCallError | null;
  createdBySubjectId: string;
  startedAt: string;
  settledAt: string | null;
};

export type AppHostLaunchResolution = {
  appId: string;
  releaseId: string;
  launchId: string;
  previewId: string | null;
  publicationId: string | null;
  expiresAt: Date;
  spaFallback: boolean;
  requestedObject: { path: string; objectKey: string; versionToken: string } | null;
  entryObject: { path: string; objectKey: string; versionToken: string };
};

export type AppReleaseToolPolicy = {
  appId: string;
  releaseId: string;
  toolPolicyRevisionId: string;
  catalogDigest: string;
  allowedTools: CanonicalToolIdentity[];
};

export type AppBuildFilePersistenceInput = {
  id: string;
  path: string;
  stagingObjectKey: string;
  frozenObjectKey: string;
};

export type AppBuildFrozenFileReceipt = {
  fileId: string;
  frozenVersionToken: string;
};

export type AppSourceStorageRef = {
  sourceRevision: AppSourceRevision;
  stagingObjectKey: string;
  frozenObjectKey: string;
  frozenVersionToken: string | null;
};

export type AppBuildFileStorageRef = {
  id: string;
  path: string;
  contentType: string;
  contentSha256: string;
  sizeBytes: number;
  executable: boolean;
  stagingObjectKey: string;
  frozenObjectKey: string;
  frozenVersionToken: string | null;
};

export type AppBuildStoragePlan = {
  build: AppBuild;
  manifest: AppBuildManifest;
  manifestObjectKey: string;
  manifestVersionToken: string | null;
  files: AppBuildFileStorageRef[];
};

export type AppGcClaim = {
  id: string;
  accountId: string;
  workspaceId: string;
  appId: string;
  leaseToken: string;
  status: "claimed" | "completed" | "failed";
  objectKeys: string[];
  leaseExpiresAt: string;
  settledAt: string | null;
  errorCode: string | null;
};

export class AppPersistenceNotFoundError extends Error {
  readonly name = "AppPersistenceNotFoundError";
}

export class AppPersistenceConflictError extends Error {
  readonly name = "AppPersistenceConflictError";
}

export class AppPersistenceIdempotencyError extends Error {
  readonly name = "AppPersistenceIdempotencyError";
}

export class AppPersistenceStateError extends Error {
  readonly name = "AppPersistenceStateError";
}

function iso(value: Date | string | unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("App persistence returned an invalid timestamp");
}

function nullableIso(value: Date | string | null | unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function rawString(row: RawRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`App persistence omitted ${key}`);
  return value;
}

function rawNumber(row: RawRow, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error(`App persistence omitted ${key}`);
}

function rawNullableString(row: RawRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`App persistence returned invalid ${key}`);
  return value;
}

function mapApp(row: RawRow): WorkspaceApp {
  return {
    id: rawString(row, "id"),
    accountId: rawString(row, "account_id"),
    workspaceId: rawString(row, "workspace_id"),
    slug: rawString(row, "slug"),
    title: rawString(row, "title"),
    description: rawNullableString(row, "description"),
    status: rawString(row, "status") as WorkspaceApp["status"],
    version: rawNumber(row, "version"),
    latestSourceRevisionId: rawNullableString(row, "latest_source_revision_id"),
    latestBuildId: rawNullableString(row, "latest_build_id"),
    activeReleaseId: rawNullableString(row, "active_release_id"),
    createdBySubjectId: rawString(row, "created_by_subject_id"),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapBuild(row: RawRow): AppBuild {
  return {
    id: rawString(row, "id"),
    accountId: rawString(row, "account_id"),
    workspaceId: rawString(row, "workspace_id"),
    appId: rawString(row, "app_id"),
    sourceRevisionId: rawString(row, "source_revision_id"),
    toolPolicyRevisionId: rawString(row, "tool_policy_revision_id"),
    revision: rawNumber(row, "revision"),
    status: rawString(row, "status") as AppBuild["status"],
    manifestSha256: rawString(row, "manifest_sha256"),
    entryPath: rawString(row, "entry_path"),
    fileCount: rawNumber(row, "file_count"),
    totalBytes: rawNumber(row, "total_bytes"),
    checks: Array.isArray(row.checks) ? (row.checks as AppBuildCheckReceipt[]) : [],
    receiptDigest: rawNullableString(row, "receipt_digest"),
    failureCode: rawNullableString(row, "failure_code"),
    createdBySubjectId: rawString(row, "created_by_subject_id"),
    createdAt: iso(row.created_at),
    verifiedAt: nullableIso(row.verified_at),
  };
}

function mapSourceRevision(row: RawRow): AppSourceRevision {
  return {
    id: rawString(row, "id"),
    accountId: rawString(row, "account_id"),
    workspaceId: rawString(row, "workspace_id"),
    appId: rawString(row, "app_id"),
    revision: rawNumber(row, "revision"),
    format: "portable_tar_v1",
    status: rawString(row, "status") as AppSourceRevision["status"],
    contentSha256: rawString(row, "content_sha256"),
    sizeBytes: rawNumber(row, "size_bytes"),
    fileCount: row.file_count === null ? null : rawNumber(row, "file_count"),
    failureCode: rawNullableString(row, "failure_code"),
    sourceSessionId: rawNullableString(row, "source_session_id"),
    sourceTurnId: rawNullableString(row, "source_turn_id"),
    sourceAttemptId: rawNullableString(row, "source_attempt_id"),
    sourceExecutionGeneration:
      row.source_execution_generation === null
        ? null
        : rawNumber(row, "source_execution_generation"),
    createdBySubjectId: rawString(row, "created_by_subject_id"),
    createdAt: iso(row.created_at),
    verifiedAt: nullableIso(row.verified_at),
  };
}

function mapToolPolicy(row: RawRow): AppToolPolicyRevision {
  return {
    id: rawString(row, "id"),
    accountId: rawString(row, "account_id"),
    workspaceId: rawString(row, "workspace_id"),
    appId: rawString(row, "app_id"),
    revision: rawNumber(row, "revision"),
    catalogDigest: rawString(row, "catalog_digest"),
    allowedTools: Array.isArray(row.allowed_tools)
      ? (row.allowed_tools as CanonicalToolIdentity[])
      : [],
    createdBySubjectId: rawString(row, "created_by_subject_id"),
    createdAt: iso(row.created_at),
  };
}

function mapRelease(row: RawRow): AppRelease {
  return {
    id: rawString(row, "id"),
    accountId: rawString(row, "account_id"),
    workspaceId: rawString(row, "workspace_id"),
    appId: rawString(row, "app_id"),
    buildId: rawString(row, "build_id"),
    sourceRevisionId: rawString(row, "source_revision_id"),
    toolPolicyRevisionId: rawString(row, "tool_policy_revision_id"),
    revision: rawNumber(row, "revision"),
    status: rawString(row, "status") as AppRelease["status"],
    manifestSha256: rawString(row, "manifest_sha256"),
    entryPath: rawString(row, "entry_path"),
    fileCount: rawNumber(row, "file_count"),
    totalBytes: rawNumber(row, "total_bytes"),
    buildReceiptDigest: rawString(row, "build_receipt_digest"),
    createdBySubjectId: rawString(row, "created_by_subject_id"),
    createdAt: iso(row.created_at),
  };
}

function mapPreview(row: RawRow): AppPreview {
  return {
    id: rawString(row, "id"),
    accountId: rawString(row, "account_id"),
    workspaceId: rawString(row, "workspace_id"),
    appId: rawString(row, "app_id"),
    releaseId: rawString(row, "release_id"),
    status: rawString(row, "status") as AppPreview["status"],
    createdBySubjectId: rawString(row, "created_by_subject_id"),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
  };
}

function mapPublication(row: RawRow): AppPublication {
  return {
    id: rawString(row, "id"),
    accountId: rawString(row, "account_id"),
    workspaceId: rawString(row, "workspace_id"),
    appId: rawString(row, "app_id"),
    releaseId: rawString(row, "release_id"),
    previousReleaseId: rawNullableString(row, "previous_release_id"),
    hostname: rawString(row, "hostname"),
    status: rawString(row, "status") as AppPublication["status"],
    spaFallback: row.spa_fallback === true,
    reason: rawString(row, "reason"),
    createdBySubjectId: rawString(row, "created_by_subject_id"),
    publishedAt: iso(row.published_at),
    retiredAt: nullableIso(row.retired_at),
  };
}

function mapLaunch(row: RawRow): AppLaunch {
  return {
    id: rawString(row, "id"),
    accountId: rawString(row, "account_id"),
    workspaceId: rawString(row, "workspace_id"),
    appId: rawString(row, "app_id"),
    releaseId: rawString(row, "release_id"),
    previewId: rawNullableString(row, "preview_id"),
    publicationId: rawNullableString(row, "publication_id"),
    hostname: rawString(row, "hostname"),
    authorityHash: rawNullableString(row, "authority_hash"),
    authorityEpoch: rawNullableString(row, "authority_epoch"),
    authorityGeneration: rawString(row, "authority_generation"),
    status: rawString(row, "status") as AppLaunch["status"],
    expiresAt: iso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
    createdBySubjectId: rawString(row, "created_by_subject_id"),
    createdAt: iso(row.created_at),
  };
}

function mapToolCall(row: RawRow): AppToolCall {
  return {
    id: rawString(row, "id"),
    accountId: rawString(row, "account_id"),
    workspaceId: rawString(row, "workspace_id"),
    appId: rawString(row, "app_id"),
    releaseId: rawString(row, "release_id"),
    launchId: rawString(row, "launch_id"),
    operationId: rawString(row, "operation_id"),
    identity: {
      serverId: rawString(row, "tool_server_id"),
      toolName: rawString(row, "tool_name"),
    },
    catalogDigest: rawString(row, "catalog_digest"),
    inputHash: rawString(row, "input_hash"),
    status: rawString(row, "status") as AppToolCall["status"],
    output: row.output ?? null,
    error: (row.error as AppRuntimeToolCallError | null | undefined) ?? null,
    createdBySubjectId: rawString(row, "created_by_subject_id"),
    startedAt: iso(row.started_at),
    settledAt: nullableIso(row.settled_at),
  };
}

function mapGcClaim(row: RawRow): AppGcClaim {
  return {
    id: rawString(row, "id"),
    accountId: rawString(row, "account_id"),
    workspaceId: rawString(row, "workspace_id"),
    appId: rawString(row, "app_id"),
    leaseToken: rawString(row, "lease_token"),
    status: rawString(row, "status") as AppGcClaim["status"],
    objectKeys: Array.isArray(row.object_keys) ? row.object_keys.map(String) : [],
    leaseExpiresAt: iso(row.lease_expires_at),
    settledAt: nullableIso(row.settled_at),
    errorCode: rawNullableString(row, "error_code"),
  };
}

function snakeRow(row: Record<string, unknown>): RawRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`),
      value,
    ]),
  );
}

function stableUuid(namespace: string, ...parts: string[]): string {
  const bytes = createHash("sha256")
    .update([namespace, ...parts].join("\0"), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function translatePersistenceError(error: unknown): never {
  const state = nestedPostgresSqlState(error);
  const message = error instanceof Error ? error.message : String(error);
  if (state === "40001") throw new AppPersistenceConflictError(message);
  if (state === "P0002") throw new AppPersistenceNotFoundError(message);
  if (state === "22023" && message.toLowerCase().includes("idempotency")) {
    throw new AppPersistenceIdempotencyError(message);
  }
  if (state === "55000" || state === "22023") throw new AppPersistenceStateError(message);
  throw error;
}

function lifecycleCommandQuery(action: string, payload: string): SQL {
  switch (action) {
    case "create_app":
      return sql`select create_workspace_app_command(${payload}::jsonb) as result`;
    case "update_app":
      return sql`select update_workspace_app_command(${payload}::jsonb) as result`;
    case "create_tool_policy":
      return sql`select create_app_tool_policy_command(${payload}::jsonb) as result`;
    case "begin_source_upload":
      return sql`select begin_app_source_upload_command(${payload}::jsonb) as result`;
    case "complete_source_upload":
      return sql`select complete_app_source_upload_command(${payload}::jsonb) as result`;
    case "fail_source_upload":
      return sql`select fail_app_source_upload_command(${payload}::jsonb) as result`;
    case "prepare_build":
      return sql`select prepare_app_build_command(${payload}::jsonb) as result`;
    case "complete_build":
      return sql`select complete_app_build_command(${payload}::jsonb) as result`;
    case "fail_build":
      return sql`select fail_app_build_command(${payload}::jsonb) as result`;
    case "promote_build":
      return sql`select promote_app_build_command(${payload}::jsonb) as result`;
    case "create_preview":
      return sql`select create_app_preview_command(${payload}::jsonb) as result`;
    case "revoke_preview":
      return sql`select revoke_app_preview_command(${payload}::jsonb) as result`;
    case "publish_release":
      return sql`select publish_app_release_command(${payload}::jsonb) as result`;
    case "unpublish_app":
      return sql`select unpublish_workspace_app_command(${payload}::jsonb) as result`;
    case "archive_app":
      return sql`select archive_workspace_app_command(${payload}::jsonb) as result`;
    default:
      throw new AppPersistenceStateError(`Unsupported App lifecycle action: ${action}`);
  }
}

async function runLifecycle(
  db: Database,
  command: Record<string, unknown> & {
    action: string;
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    idempotencyKey: string;
  },
): Promise<LifecycleResult> {
  try {
    return await withSessionRlsActorContext(
      { subjectId: command.actorSubjectId },
      async () =>
        await withRlsContext(db, command, async (scopedDb) => {
          const [row] = await rawRows<{ result: LifecycleResult }>(
            scopedDb,
            lifecycleCommandQuery(command.action, JSON.stringify(command)),
          );
          if (!row) throw new Error("App lifecycle command returned no result");
          return row.result;
        }),
    );
  } catch (error) {
    return translatePersistenceError(error);
  }
}

export async function listWorkspaceApps(
  db: Database,
  input: { accountId: string; workspaceId: string; limit?: number; cursor?: string },
): Promise<WorkspaceAppListResponse> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const predicate = cursor
      ? and(
          eq(schema.apps.workspaceId, input.workspaceId),
          or(
            lt(schema.apps.updatedAt, cursor.updatedAt),
            and(eq(schema.apps.updatedAt, cursor.updatedAt), lt(schema.apps.id, cursor.id)),
          ),
        )
      : eq(schema.apps.workspaceId, input.workspaceId);
    const rows = await scopedDb
      .select()
      .from(schema.apps)
      .where(predicate)
      .orderBy(desc(schema.apps.updatedAt), desc(schema.apps.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const truncated = rows.length > limit;
    return {
      apps: page.map((row) => mapApp(snakeRow(row as unknown as Record<string, unknown>))),
      nextCursor: truncated && page.length > 0 ? encodeCursor(page.at(-1)!) : null,
      truncated,
    };
  });
}

function encodeCursor(row: typeof schema.apps.$inferSelect): string {
  return Buffer.from(JSON.stringify([iso(row.updatedAt), row.id]), "utf8").toString("base64url");
}

function decodeCursor(value: string): { updatedAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("invalid cursor");
    const updatedAt = new Date(parsed[0]);
    if (!Number.isFinite(updatedAt.getTime()) || typeof parsed[1] !== "string") {
      throw new Error("invalid cursor");
    }
    return { updatedAt, id: parsed[1] };
  } catch {
    throw new AppPersistenceStateError("Invalid App list cursor");
  }
}

export async function getWorkspaceApp(
  db: Database,
  input: { accountId: string; workspaceId: string; appId: string },
): Promise<WorkspaceAppDetailResponse> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [appRows, sourceRows, buildRows, releaseRows, previewRows, policyRows] =
      await Promise.all([
        scopedDb
          .select()
          .from(schema.apps)
          .where(
            and(eq(schema.apps.workspaceId, input.workspaceId), eq(schema.apps.id, input.appId)),
          )
          .limit(1),
        scopedDb
          .select()
          .from(schema.appSourceRevisions)
          .where(
            and(
              eq(schema.appSourceRevisions.workspaceId, input.workspaceId),
              eq(schema.appSourceRevisions.appId, input.appId),
            ),
          )
          .orderBy(desc(schema.appSourceRevisions.revision))
          .limit(101),
        scopedDb
          .select()
          .from(schema.appBuilds)
          .where(
            and(
              eq(schema.appBuilds.workspaceId, input.workspaceId),
              eq(schema.appBuilds.appId, input.appId),
            ),
          )
          .orderBy(desc(schema.appBuilds.revision))
          .limit(101),
        scopedDb
          .select()
          .from(schema.appReleases)
          .where(
            and(
              eq(schema.appReleases.workspaceId, input.workspaceId),
              eq(schema.appReleases.appId, input.appId),
            ),
          )
          .orderBy(desc(schema.appReleases.revision))
          .limit(101),
        scopedDb
          .select()
          .from(schema.appPreviews)
          .where(
            and(
              eq(schema.appPreviews.workspaceId, input.workspaceId),
              eq(schema.appPreviews.appId, input.appId),
            ),
          )
          .orderBy(desc(schema.appPreviews.createdAt))
          .limit(101),
        scopedDb
          .select()
          .from(schema.appToolPolicyRevisions)
          .where(
            and(
              eq(schema.appToolPolicyRevisions.workspaceId, input.workspaceId),
              eq(schema.appToolPolicyRevisions.appId, input.appId),
            ),
          )
          .orderBy(desc(schema.appToolPolicyRevisions.revision))
          .limit(101),
      ]);
    const app = appRows[0];
    if (!app) throw new AppPersistenceNotFoundError("App not found");
    return {
      app: mapApp(snakeRow(app as unknown as Record<string, unknown>)),
      sourceRevisions: sourceRows
        .slice(0, 100)
        .map((row) => mapSourceRevision(snakeRow(row as unknown as Record<string, unknown>))),
      builds: buildRows
        .slice(0, 100)
        .map((row) => mapBuild(snakeRow(row as unknown as Record<string, unknown>))),
      releases: releaseRows
        .slice(0, 100)
        .map((row) => mapRelease(snakeRow(row as unknown as Record<string, unknown>))),
      previews: previewRows
        .slice(0, 100)
        .map((row) => mapPreview(snakeRow(row as unknown as Record<string, unknown>))),
      toolPolicies: policyRows
        .slice(0, 100)
        .map((row) => mapToolPolicy(snakeRow(row as unknown as Record<string, unknown>))),
      historyTruncated: [sourceRows, buildRows, releaseRows, previewRows, policyRows].some(
        (rows) => rows.length > 100,
      ),
    };
  });
}

export async function getAppSourceStorageRef(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    appId: string;
    sourceRevisionId: string;
  },
): Promise<AppSourceStorageRef> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.appSourceRevisions)
      .where(
        and(
          eq(schema.appSourceRevisions.workspaceId, input.workspaceId),
          eq(schema.appSourceRevisions.appId, input.appId),
          eq(schema.appSourceRevisions.id, input.sourceRevisionId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new AppPersistenceNotFoundError("App source revision not found");
    return {
      sourceRevision: mapSourceRevision(snakeRow(row as unknown as Record<string, unknown>)),
      stagingObjectKey: row.stagingObjectKey,
      frozenObjectKey: row.frozenObjectKey,
      frozenVersionToken: row.frozenVersionToken,
    };
  });
}

export async function getAppBuildStoragePlan(
  db: Database,
  input: { accountId: string; workspaceId: string; appId: string; buildId: string },
): Promise<AppBuildStoragePlan> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [buildRows, fileRows] = await Promise.all([
      scopedDb
        .select()
        .from(schema.appBuilds)
        .where(
          and(
            eq(schema.appBuilds.workspaceId, input.workspaceId),
            eq(schema.appBuilds.appId, input.appId),
            eq(schema.appBuilds.id, input.buildId),
          ),
        )
        .limit(1),
      scopedDb
        .select()
        .from(schema.appBuildFiles)
        .where(
          and(
            eq(schema.appBuildFiles.workspaceId, input.workspaceId),
            eq(schema.appBuildFiles.appId, input.appId),
            eq(schema.appBuildFiles.buildId, input.buildId),
          ),
        )
        .orderBy(schema.appBuildFiles.path),
    ]);
    const buildRow = buildRows[0];
    if (!buildRow) throw new AppPersistenceNotFoundError("App build not found");
    return {
      build: mapBuild(snakeRow(buildRow as unknown as Record<string, unknown>)),
      manifest: AppBuildManifestSchema.parse(buildRow.manifest),
      manifestObjectKey: buildRow.manifestObjectKey,
      manifestVersionToken: buildRow.manifestVersionToken,
      files: fileRows.map((row) => ({
        id: row.id,
        path: row.path,
        contentType: row.contentType,
        contentSha256: row.contentSha256,
        sizeBytes: row.sizeBytes,
        executable: row.executable,
        stagingObjectKey: row.stagingObjectKey,
        frozenObjectKey: row.frozenObjectKey,
        frozenVersionToken: row.frozenVersionToken,
      })),
    };
  });
}

export async function createWorkspaceApp(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    slug: string;
    title: string;
    description?: string | null;
    idempotencyKey: string;
  },
): Promise<{ app: WorkspaceApp; replayed: boolean }> {
  const result = await runLifecycle(db, { action: "create_app", ...input });
  return { app: mapApp(result.app!), replayed: result.replayed };
}

export async function updateWorkspaceApp(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    title?: string;
    description?: string | null;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<{ app: WorkspaceApp; replayed: boolean }> {
  const result = await runLifecycle(db, { action: "update_app", ...input });
  return { app: mapApp(result.app!), replayed: result.replayed };
}

export async function createAppToolPolicyRevision(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    allowedTools: CanonicalToolIdentity[];
    catalogDigest: string;
    expectedAppVersion: number;
    idempotencyKey: string;
  },
): Promise<{ app: WorkspaceApp; toolPolicy: AppToolPolicyRevision; replayed: boolean }> {
  const result = await runLifecycle(db, {
    action: "create_tool_policy",
    toolPolicyRevisionId: stableUuid("app-tool-policy", input.workspaceId, input.idempotencyKey),
    ...input,
  });
  return {
    app: mapApp(result.app!),
    toolPolicy: mapToolPolicy(result.toolPolicy!),
    replayed: result.replayed,
  };
}

export async function beginAppSourceUpload(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    sourceRevisionId?: string;
    stagingObjectKey: string;
    frozenObjectKey: string;
    contentSha256: string;
    sizeBytes: number;
    expectedAppVersion: number;
    idempotencyKey: string;
    sourceSessionId?: string | null;
    sourceTurnId?: string | null;
    sourceAttemptId?: string | null;
    sourceExecutionGeneration?: number | null;
  },
): Promise<{ app: WorkspaceApp; sourceRevision: AppSourceRevision; replayed: boolean }> {
  const result = await runLifecycle(db, {
    action: "begin_source_upload",
    ...input,
    sourceRevisionId:
      input.sourceRevisionId ?? stableUuid("app-source", input.workspaceId, input.idempotencyKey),
    format: "portable_tar_v1",
  });
  return {
    app: mapApp(result.app!),
    sourceRevision: mapSourceRevision(result.sourceRevision!),
    replayed: result.replayed,
  };
}

export async function completeAppSourceUpload(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    sourceRevisionId: string;
    expectedContentSha256: string;
    expectedSizeBytes: number;
    fileCount: number;
    frozenVersionToken: string;
    idempotencyKey: string;
  },
): Promise<{ sourceRevision: AppSourceRevision; replayed: boolean }> {
  const result = await runLifecycle(db, { action: "complete_source_upload", ...input });
  return { sourceRevision: mapSourceRevision(result.sourceRevision!), replayed: result.replayed };
}

export async function failAppSourceUpload(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    sourceRevisionId: string;
    expectedContentSha256: string;
    expectedSizeBytes: number;
    failureCode: string;
    idempotencyKey: string;
  },
): Promise<{ sourceRevision: AppSourceRevision; replayed: boolean }> {
  const result = await runLifecycle(db, { action: "fail_source_upload", ...input });
  return { sourceRevision: mapSourceRevision(result.sourceRevision!), replayed: result.replayed };
}

export async function prepareAppBuild(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    buildId?: string;
    sourceRevisionId: string;
    toolPolicyRevisionId: string;
    manifestObjectKey: string;
    manifestSha256: string;
    manifest: AppBuildManifest;
    checks: AppBuildCheckReceipt[];
    fileObjects: AppBuildFilePersistenceInput[];
    expectedAppVersion: number;
    idempotencyKey: string;
  },
): Promise<{ app: WorkspaceApp; build: AppBuild; replayed: boolean }> {
  const result = await runLifecycle(db, {
    action: "prepare_build",
    ...input,
    buildId: input.buildId ?? stableUuid("app-build", input.workspaceId, input.idempotencyKey),
  });
  return {
    app: mapApp(result.app!),
    build: mapBuild(result.build!),
    replayed: result.replayed,
  };
}

export async function completeAppBuild(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    buildId: string;
    expectedManifestSha256: string;
    frozenFiles: AppBuildFrozenFileReceipt[];
    manifestVersionToken: string;
    receiptDigest: string;
    idempotencyKey: string;
  },
): Promise<{ app: WorkspaceApp; build: AppBuild; replayed: boolean }> {
  const result = await runLifecycle(db, { action: "complete_build", ...input });
  return {
    app: mapApp(result.app!),
    build: mapBuild(result.build!),
    replayed: result.replayed,
  };
}

export async function failAppBuild(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    buildId: string;
    expectedManifestSha256: string;
    failureCode: string;
    idempotencyKey: string;
  },
): Promise<{ app: WorkspaceApp; build: AppBuild; replayed: boolean }> {
  const result = await runLifecycle(db, { action: "fail_build", ...input });
  return {
    app: mapApp(result.app!),
    build: mapBuild(result.build!),
    replayed: result.replayed,
  };
}

export async function promoteAppBuild(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    buildId: string;
    expectedAppVersion: number;
    idempotencyKey: string;
  },
): Promise<{ app: WorkspaceApp; release: AppRelease; replayed: boolean }> {
  const result = await runLifecycle(db, {
    action: "promote_build",
    releaseId: stableUuid("app-release", input.workspaceId, input.idempotencyKey),
    ...input,
  });
  return {
    app: mapApp(result.app!),
    release: mapRelease(result.release!),
    replayed: result.replayed,
  };
}

export async function createAppPreview(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    releaseId: string;
    hostname: string;
    expiresAt: Date;
    spaFallback?: boolean;
    idempotencyKey: string;
  },
): Promise<{ preview: AppPreview; replayed: boolean }> {
  const result = await runLifecycle(db, {
    action: "create_preview",
    previewId: stableUuid("app-preview", input.workspaceId, input.idempotencyKey),
    ...input,
    expiresAt: input.expiresAt.toISOString(),
  });
  return { preview: mapPreview(result.preview!), replayed: result.replayed };
}

export async function revokeAppPreview(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    previewId: string;
    idempotencyKey: string;
  },
): Promise<{ preview: AppPreview; replayed: boolean }> {
  const result = await runLifecycle(db, { action: "revoke_preview", ...input });
  return { preview: mapPreview(result.preview!), replayed: result.replayed };
}

export async function publishAppRelease(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    releaseId: string;
    hostname: string;
    reason: string;
    expectedAppVersion: number;
    spaFallback?: boolean;
    idempotencyKey: string;
  },
): Promise<{
  app: WorkspaceApp;
  release: AppRelease;
  publication: AppPublication;
  replayed: boolean;
}> {
  const result = await runLifecycle(db, {
    action: "publish_release",
    publicationId: stableUuid("app-publication", input.workspaceId, input.idempotencyKey),
    ...input,
  });
  return {
    app: mapApp(result.app!),
    release: mapRelease(result.release!),
    publication: mapPublication(result.publication!),
    replayed: result.replayed,
  };
}

export async function unpublishWorkspaceApp(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    expectedAppVersion: number;
    reason: string;
    idempotencyKey: string;
  },
): Promise<{ app: WorkspaceApp; replayed: boolean }> {
  const result = await runLifecycle(db, { action: "unpublish_app", ...input });
  return { app: mapApp(result.app!), replayed: result.replayed };
}

export async function archiveWorkspaceApp(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    expectedAppVersion: number;
    reason: string;
    idempotencyKey: string;
  },
): Promise<{ app: WorkspaceApp; replayed: boolean }> {
  const result = await runLifecycle(db, { action: "archive_app", ...input });
  return { app: mapApp(result.app!), replayed: result.replayed };
}

/** @deprecated Apps retain immutable history and are archived rather than deleted. */
export const deleteWorkspaceApp = archiveWorkspaceApp;

export async function claimArchivedAppGc(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    idempotencyKey: string;
  },
): Promise<{ claim: AppGcClaim; replayed: boolean }> {
  const command = {
    ...input,
    leaseToken: stableUuid("app-gc-lease", input.workspaceId, input.idempotencyKey),
  };
  return await withSessionRlsActorContext(
    { subjectId: input.actorSubjectId },
    async () =>
      await withRlsContext(db, input, async (scopedDb) => {
        const [row] = await rawRows<{ result: { claim: RawRow; replayed: boolean } }>(
          scopedDb,
          sql`select claim_archived_app_gc_command(${JSON.stringify(command)}::jsonb) as result`,
        );
        if (!row) throw new Error("App GC claim returned no result");
        return { claim: mapGcClaim(row.result.claim), replayed: row.result.replayed };
      }),
  );
}

export async function settleArchivedAppGc(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    claimId: string;
    leaseToken: string;
    status: "completed" | "failed";
    deletedObjects?: { objectKey: string; providerReceipt?: string | null }[];
    errorCode?: string;
  },
): Promise<{ claim: AppGcClaim; replayed: boolean }> {
  return await withSessionRlsActorContext(
    { subjectId: input.actorSubjectId },
    async () =>
      await withRlsContext(db, input, async (scopedDb) => {
        const [row] = await rawRows<{ result: { claim: RawRow; replayed: boolean } }>(
          scopedDb,
          sql`select settle_archived_app_gc_command(${JSON.stringify(input)}::jsonb) as result`,
        );
        if (!row) throw new Error("App GC settlement returned no result");
        return { claim: mapGcClaim(row.result.claim), replayed: row.result.replayed };
      }),
  );
}

export type AppObjectCleanupClaim = {
  id: string;
  accountId: string;
  workspaceId: string;
  appId: string;
  objectKey: string;
  reason: "archive" | "workspace_delete" | "abandoned_source" | "abandoned_build";
  claimId: string;
  attemptCount: number;
};

/** Expire a bounded batch of uploads that never reached a terminal receipt. */
export async function reapAbandonedAppUploads(
  db: Database,
  input: { limit?: number } = {},
): Promise<number> {
  const [row] = await rawRows<{ reaped: number }>(
    db,
    sql`select reap_abandoned_app_uploads_command(${input.limit ?? 32}) as reaped`,
  );
  return row?.reaped ?? 0;
}

/** Claim a globally bounded batch after delayed/stale claims become due. */
export async function claimAppObjectCleanups(
  db: Database,
  input: { claimId: string; limit?: number; claimSeconds?: number },
): Promise<AppObjectCleanupClaim[]> {
  const rows = await rawRows<{
    id: string;
    account_id: string;
    workspace_id: string;
    app_id: string;
    object_key: string;
    reason: AppObjectCleanupClaim["reason"];
    attempt_count: number;
  }>(
    db,
    sql`select * from claim_app_object_cleanups(
      ${input.claimId}, ${input.limit ?? 32}, ${input.claimSeconds ?? 15}
    )`,
  );
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    appId: row.app_id,
    objectKey: row.object_key,
    reason: row.reason,
    claimId: input.claimId,
    attemptCount: row.attempt_count,
  }));
}

export async function settleAppObjectCleanup(
  db: Database,
  input: { id: string; claimId: string; error?: string | null },
): Promise<boolean> {
  const [row] = await rawRows<{ settled: boolean }>(
    db,
    sql`select settle_app_object_cleanup(
      ${input.id}, ${input.claimId}, ${input.error ?? null}
    ) as settled`,
  );
  return row?.settled === true;
}

export async function createAppLaunch(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    releaseId?: string;
    previewId?: string;
    ttlSeconds: number;
    authorityHash: string | null;
    authorityEpoch: string | null;
    authorityGeneration: string;
  },
): Promise<{ launch: AppLaunch; nonce: string; replayed: boolean }> {
  const launchId = randomUUID();
  const nonce = randomBytes(32).toString("base64url");
  const nonceSha256 = `sha256:${createHash("sha256").update(nonce, "utf8").digest("hex")}`;
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  try {
    return await withSessionRlsActorContext(
      { subjectId: input.actorSubjectId },
      async () =>
        await withRlsContext(db, input, async (scopedDb) => {
          const command = {
            ...input,
            launchId,
            nonceSha256,
            expiresAt: expiresAt.toISOString(),
          };
          const [row] = await rawRows<{ result: { replayed: boolean; launch: RawRow } }>(
            scopedDb,
            sql`select app_launch_command(${JSON.stringify(command)}::jsonb) as result`,
          );
          if (!row) throw new Error("App launch command returned no result");
          return { launch: mapLaunch(row.result.launch), nonce, replayed: row.result.replayed };
        }),
    );
  } catch (error) {
    return translatePersistenceError(error);
  }
}

export async function beginAppToolCall(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    releaseId: string;
    launchId: string;
    launchNonceSha256: string;
    authorityHash: string | null;
    authorityEpoch: string | null;
    authorityGeneration: string;
    operationId: string;
    identity: CanonicalToolIdentity;
    catalogDigest: string;
    input: Record<string, unknown>;
  },
): Promise<{ toolCall: AppToolCall; replayed: boolean }> {
  try {
    return await withSessionRlsActorContext(
      { subjectId: input.actorSubjectId },
      async () =>
        await withRlsContext(db, input, async (scopedDb) => {
          const command = { action: "begin", ...input };
          const [row] = await rawRows<{ result: { replayed: boolean; toolCall: RawRow } }>(
            scopedDb,
            sql`select app_tool_call_command(${JSON.stringify(command)}::jsonb) as result`,
          );
          if (!row) throw new Error("App tool-call command returned no result");
          return { toolCall: mapToolCall(row.result.toolCall), replayed: row.result.replayed };
        }),
    );
  } catch (error) {
    return translatePersistenceError(error);
  }
}

/**
 * Returns the immutable tool-policy snapshot bound to one release. Callers
 * intersect allowedTools with the current safe runtime catalog; persistence
 * never widens a release when the deployment catalog changes.
 */
export async function getAppReleaseToolPolicy(
  db: Database,
  input: { accountId: string; workspaceId: string; appId: string; releaseId: string },
): Promise<AppReleaseToolPolicy> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await rawRows<{
      app_id: string;
      release_id: string;
      tool_policy_revision_id: string;
      catalog_digest: string;
      allowed_tools: CanonicalToolIdentity[];
    }>(
      scopedDb,
      sql`select app_release.app_id, app_release.id as release_id,
        app_release.tool_policy_revision_id, app_policy.catalog_digest,
        app_policy.allowed_tools
      from ${schema.appReleases} app_release
      join ${schema.appToolPolicyRevisions} app_policy
        on app_policy.workspace_id = app_release.workspace_id
        and app_policy.app_id = app_release.app_id
        and app_policy.id = app_release.tool_policy_revision_id
      where app_release.workspace_id = ${input.workspaceId}
        and app_release.app_id = ${input.appId}
        and app_release.id = ${input.releaseId}
        and app_release.status = 'ready'
      limit 1`,
    );
    if (!row) throw new AppPersistenceNotFoundError("Ready App release policy not found");
    return {
      appId: row.app_id,
      releaseId: row.release_id,
      toolPolicyRevisionId: row.tool_policy_revision_id,
      catalogDigest: row.catalog_digest,
      allowedTools: Array.isArray(row.allowed_tools)
        ? (row.allowed_tools as CanonicalToolIdentity[])
        : [],
    };
  });
}

export async function settleAppToolCall(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    appId: string;
    releaseId: string;
    launchId: string;
    launchNonceSha256: string;
    authorityHash: string | null;
    authorityEpoch: string | null;
    authorityGeneration: string;
    operationId: string;
    status: "succeeded" | "failed";
    output?: unknown;
    error?: AppRuntimeToolCallError;
  },
): Promise<{ toolCall: AppToolCall; replayed: boolean }> {
  try {
    return await withSessionRlsActorContext(
      { subjectId: input.actorSubjectId },
      async () =>
        await withRlsContext(db, input, async (scopedDb) => {
          const command = { action: "settle", ...input };
          const [row] = await rawRows<{ result: { replayed: boolean; toolCall: RawRow } }>(
            scopedDb,
            sql`select app_tool_call_command(${JSON.stringify(command)}::jsonb) as result`,
          );
          if (!row) throw new Error("App tool-call settlement returned no result");
          return { toolCall: mapToolCall(row.result.toolCall), replayed: row.result.replayed };
        }),
    );
  } catch (error) {
    return translatePersistenceError(error);
  }
}

export async function resolveAppHostLaunch(
  db: Database,
  input: {
    host: string;
    launchTokenDigest: string;
    requestedPath: string | null;
  },
): Promise<AppHostLaunchResolution | null> {
  const [row] = await rawRows<{
    app_id: string;
    release_id: string;
    launch_id: string;
    preview_id: string | null;
    publication_id: string | null;
    expires_at: Date | string;
    spa_fallback: boolean;
    requested_path: string | null;
    requested_object_key: string | null;
    requested_version_token: string | null;
    entry_path: string;
    entry_object_key: string;
    entry_version_token: string;
  }>(
    db,
    sql`select * from opengeni_private.resolve_app_host_launch(
      ${input.host}, ${input.launchTokenDigest}, ${input.requestedPath}
    )`,
  );
  return row
    ? {
        appId: row.app_id,
        releaseId: row.release_id,
        launchId: row.launch_id,
        previewId: row.preview_id,
        publicationId: row.publication_id,
        expiresAt: new Date(row.expires_at),
        spaFallback: row.spa_fallback,
        requestedObject:
          row.requested_path && row.requested_object_key && row.requested_version_token
            ? {
                path: row.requested_path,
                objectKey: row.requested_object_key,
                versionToken: row.requested_version_token,
              }
            : null,
        entryObject: {
          path: row.entry_path,
          objectKey: row.entry_object_key,
          versionToken: row.entry_version_token,
        },
      }
    : null;
}

/** Structurally implements apps/app-host's AppLaunchResolver without a package dependency. */
export function createDatabaseAppLaunchResolver(db: Database): {
  resolve(input: {
    host: string;
    launchTokenDigest: string;
    requestedPath: string | null;
  }): Promise<AppHostLaunchResolution | null>;
} {
  return Object.freeze({ resolve: (input) => resolveAppHostLaunch(db, input) });
}
