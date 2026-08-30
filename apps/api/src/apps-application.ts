import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type {
  AppBuildManifest,
  AppRuntimeToolCallResponse,
  PrepareAppBuildResponse,
  WorkspaceAppDetailResponse,
} from "@opengeni/contracts/apps";
import {
  appBuildManifestObjectKey,
  appBuildObjectKey,
  appBuildStagingObjectKey,
  appSourceObjectKey,
  appSourceStagingObjectKey,
  callAppRuntimeTool,
  freezeAppBuildObjects,
  freezeAppSourceArchive,
  projectAvailableAppRuntimeCatalog,
  projectAppRuntimeCatalog,
  resolveWorkspaceAppOrigin,
  type AppRuntimeToolProvider,
  type AppsApplicationPort,
} from "@opengeni/core";
import { canonicalToolIdentityKey } from "@opengeni/tool-runtime";
import {
  AppPersistenceConflictError,
  AppPersistenceIdempotencyError,
  AppPersistenceNotFoundError,
  AppPersistenceStateError,
  archiveWorkspaceApp,
  beginAppSourceUpload,
  beginAppToolCall,
  completeAppBuild,
  completeAppSourceUpload,
  createAppLaunch,
  createAppPreview,
  createAppToolPolicyRevision,
  createWorkspaceApp,
  failAppBuild,
  failAppSourceUpload,
  getAppBuildStoragePlan,
  getAppReleaseToolPolicy,
  getAppSourceStorageRef,
  getWorkspaceApp,
  listWorkspaceApps,
  prepareAppBuild,
  promoteAppBuild,
  publishAppRelease,
  resolveAppHostLaunch,
  settleAppToolCall,
  unpublishWorkspaceApp,
  updateWorkspaceApp,
  type AppBuildFrozenFileReceipt,
  type AppBuildStoragePlan,
  type Database,
} from "@opengeni/db";
import { createImmutableRawObjectReader, type ObjectStorage } from "@opengeni/storage";
import { HTTPException } from "hono/http-exception";

const SOURCE_CONTENT_TYPE = "application/x-tar";
const DEFAULT_PREVIEW_TTL_SECONDS = 60 * 60;
const DEFAULT_LAUNCH_TTL_SECONDS = 15 * 60;
const APP_SOURCE_DOWNLOAD_TTL_SECONDS = 5 * 60;

export function createDatabaseAppsApplication(input: {
  db: Database;
  storage: ObjectStorage | null;
  settings: Settings;
  runtimeToolProvider?: AppRuntimeToolProvider;
}): AppsApplicationPort {
  const storage = () => {
    if (!input.storage) {
      throw new HTTPException(503, { message: "Apps object storage is not configured" });
    }
    return input.storage;
  };

  const application: AppsApplicationPort = {
    async resolveHostLaunch(request) {
      const resolution = await resolveAppHostLaunch(input.db, request);
      return resolution ? { ...resolution, expiresAt: resolution.expiresAt.toISOString() } : null;
    },

    async list(request) {
      return await appPersistence(() =>
        listWorkspaceApps(input.db, {
          accountId: request.authority.accountId,
          workspaceId: request.authority.workspaceId,
          limit: request.query.limit,
          ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        }),
      );
    },

    async create({ authority, request }) {
      const appId = stableUuid("app", authority.workspaceId, request.idempotencyKey);
      const slugBase = request.slug ?? "app";
      const slug = request.slug ?? `${slugBase.slice(0, 87)}-${appId.slice(0, 8)}`;
      return await appPersistence(() =>
        createWorkspaceApp(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          slug,
          title: request.title,
          description: request.description ?? null,
          idempotencyKey: request.idempotencyKey,
        }),
      );
    },

    async get({ authority, appId }) {
      return await detail(input.db, authority, appId);
    },

    async update({ authority, appId, request }) {
      return await appPersistence(() =>
        updateWorkspaceApp(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          expectedVersion: request.expectedVersion,
          idempotencyKey: request.idempotencyKey,
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.description === undefined ? {} : { description: request.description }),
        }),
      );
    },

    async getAvailableRuntimeCatalog({ authority, appId }, options) {
      if (!input.runtimeToolProvider) {
        throw new HTTPException(503, { message: "Apps runtime tools are not configured" });
      }
      return await projectAvailableAppRuntimeCatalog({
        authority,
        appId,
        provider: input.runtimeToolProvider,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },

    async createToolPolicy({ authority, appId, request }, options) {
      if (!input.runtimeToolProvider) {
        throw new HTTPException(503, { message: "Apps runtime tools are not configured" });
      }
      const available = await projectAvailableAppRuntimeCatalog({
        authority,
        appId,
        provider: input.runtimeToolProvider,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (available.catalogDigest !== request.catalogDigest) {
        throw new HTTPException(409, { message: "Apps tool catalog changed" });
      }
      const availableIdentities = new Set(
        available.tools.map((tool) => canonicalToolIdentityKey(tool.identity)),
      );
      if (
        request.allowedTools.some(
          (identity) => !availableIdentities.has(canonicalToolIdentityKey(identity)),
        )
      ) {
        throw new HTTPException(422, { message: "App tool policy contains an unavailable tool" });
      }
      await appPersistence(() =>
        createAppToolPolicyRevision(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          allowedTools: request.allowedTools,
          catalogDigest: request.catalogDigest,
          expectedAppVersion: request.expectedAppVersion,
          idempotencyKey: request.idempotencyKey,
        }),
      );
      return await detail(input.db, authority, appId);
    },

    async beginSourceUpload({ authority, appId, request }) {
      const objectStore = storage();
      const sourceRevisionId = stableUuid("source", authority.workspaceId, request.idempotencyKey);
      const stagingObjectKey = appSourceStagingObjectKey({
        workspaceId: authority.workspaceId,
        appId,
        sourceRevisionId,
        uploadId: stableUuid("source-upload", sourceRevisionId, request.idempotencyKey),
      });
      const frozenObjectKey = appSourceObjectKey({
        workspaceId: authority.workspaceId,
        appId,
        sourceRevisionId,
        contentSha256: request.contentSha256,
      });
      const result = await appPersistence(() =>
        beginAppSourceUpload(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          sourceRevisionId,
          stagingObjectKey,
          frozenObjectKey,
          contentSha256: request.contentSha256,
          sizeBytes: request.sizeBytes,
          expectedAppVersion: request.expectedAppVersion,
          idempotencyKey: request.idempotencyKey,
          sourceSessionId: authority.sourceSessionId,
          sourceTurnId: authority.sourceTurnId,
          sourceAttemptId: authority.sourceAttemptId,
          sourceExecutionGeneration: authority.sourceExecutionGeneration,
        }),
      );
      const signed = await objectStore.createPutUrl({
        key: stagingObjectKey,
        contentType: SOURCE_CONTENT_TYPE,
        sha256: request.contentSha256,
        audience: "public",
      });
      return {
        sourceRevision: result.sourceRevision,
        stagingUpload: signedUpload(signed),
        replayed: result.replayed,
      };
    },

    async completeSourceUpload({ authority, appId, sourceRevisionId, request }, options) {
      const objectStore = storage();
      const source = await appPersistence(() =>
        getAppSourceStorageRef(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          appId,
          sourceRevisionId,
        }),
      );
      assertAppSourceCompletionIdentity(source.sourceRevision, request);
      const ports = immutablePorts(objectStore);
      const frozen = await freezeAppSourceArchive({
        ...ports,
        stagingObjectKey: source.stagingObjectKey,
        frozenObjectKey: source.frozenObjectKey,
        contentSha256: source.sourceRevision.contentSha256,
        sizeBytes: source.sourceRevision.sizeBytes,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (!frozen.ready) {
        await appPersistence(() =>
          failAppSourceUpload(input.db, {
            accountId: authority.accountId,
            workspaceId: authority.workspaceId,
            actorSubjectId: authority.subjectId,
            appId,
            sourceRevisionId,
            expectedContentSha256: source.sourceRevision.contentSha256,
            expectedSizeBytes: source.sourceRevision.sizeBytes,
            failureCode: frozen.failure.code,
            idempotencyKey: `${request.idempotencyKey}:failed`,
          }),
        );
        throw new HTTPException(422, { message: "App source verification failed" });
      }
      await appPersistence(() =>
        completeAppSourceUpload(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          sourceRevisionId,
          expectedContentSha256: source.sourceRevision.contentSha256,
          expectedSizeBytes: source.sourceRevision.sizeBytes,
          fileCount: request.fileCount,
          frozenVersionToken: frozen.frozenVersionToken,
          idempotencyKey: request.idempotencyKey,
        }),
      );
      return await detail(input.db, authority, appId);
    },

    async getSourceDownload({ authority, appId, sourceRevisionId, downloadUrl }) {
      storage();
      const source = await appPersistence(() =>
        getAppSourceStorageRef(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          appId,
          sourceRevisionId,
        }),
      );
      if (source.sourceRevision.status !== "ready" || !source.frozenVersionToken) {
        throw new HTTPException(409, { message: "App source revision is not ready" });
      }
      const expiresAt = new Date(Date.now() + APP_SOURCE_DOWNLOAD_TTL_SECONDS * 1_000);
      const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1_000);
      const signature = createAppSourceDownloadSignature(input.settings, {
        authority,
        appId,
        sourceRevisionId,
        expiresAtSeconds,
      });
      const url = new URL(downloadUrl);
      url.searchParams.set("expires", String(expiresAtSeconds));
      url.searchParams.set("signature", signature);
      return {
        sourceRevision: source.sourceRevision,
        url: url.toString(),
        expiresAt: expiresAt.toISOString(),
      };
    },

    async openSourceDownload(
      { authority, appId, sourceRevisionId, expiresAtSeconds, signature },
      options,
    ) {
      const nowSeconds = Math.floor(Date.now() / 1_000);
      if (
        !Number.isSafeInteger(expiresAtSeconds) ||
        expiresAtSeconds < nowSeconds ||
        expiresAtSeconds > nowSeconds + APP_SOURCE_DOWNLOAD_TTL_SECONDS
      ) {
        throw new HTTPException(404, { message: "App source download not found" });
      }
      const expected = createAppSourceDownloadSignature(input.settings, {
        authority,
        appId,
        sourceRevisionId,
        expiresAtSeconds,
      });
      if (!equalDigest(signature, expected)) {
        throw new HTTPException(404, { message: "App source download not found" });
      }
      const objectStore = storage();
      const source = await appPersistence(() =>
        getAppSourceStorageRef(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          appId,
          sourceRevisionId,
        }),
      );
      if (source.sourceRevision.status !== "ready" || !source.frozenVersionToken) {
        throw new HTTPException(404, { message: "App source download not found" });
      }
      const reader = createImmutableRawObjectReader(objectStore);
      const head = await reader.head({
        key: source.frozenObjectKey,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (
        !head ||
        head.versionToken !== source.frozenVersionToken ||
        head.byteSize !== source.sourceRevision.sizeBytes
      ) {
        throw new HTTPException(404, { message: "App source download not found" });
      }
      return {
        byteSize: head.byteSize,
        contentType: SOURCE_CONTENT_TYPE,
        body: reader.streamRange({
          key: source.frozenObjectKey,
          start: 0,
          endInclusive: head.byteSize - 1,
          expectedVersionToken: source.frozenVersionToken,
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
      };
    },

    async prepareBuild({ authority, appId, request }) {
      const manifestBytes = verifiedAppBuildManifestBytes(request.manifest, request.manifestSha256);
      const objectStore = storage();
      const buildId = stableUuid("build", authority.workspaceId, request.idempotencyKey);
      const fileObjects = request.manifest.files.map((file) => {
        const id = stableUuid("build-file", buildId, file.path);
        return {
          id,
          path: file.path,
          stagingObjectKey: appBuildStagingObjectKey({
            workspaceId: authority.workspaceId,
            appId,
            buildId,
            fileId: id,
          }),
          frozenObjectKey: appBuildObjectKey({
            workspaceId: authority.workspaceId,
            appId,
            buildId,
            fileId: id,
            contentSha256: file.contentSha256,
          }),
        };
      });
      const prepared = await appPersistence(() =>
        prepareAppBuild(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          buildId,
          sourceRevisionId: request.sourceRevisionId,
          toolPolicyRevisionId: request.toolPolicyRevisionId,
          manifestObjectKey: appBuildManifestObjectKey({
            workspaceId: authority.workspaceId,
            appId,
            buildId,
            manifestSha256: request.manifestSha256,
          }),
          manifestSha256: request.manifestSha256,
          manifest: request.manifest,
          checks: request.checks,
          fileObjects,
          expectedAppVersion: request.expectedAppVersion,
          idempotencyKey: request.idempotencyKey,
        }),
      );
      if (!objectStore.putObjectIfAbsent) {
        throw new HTTPException(503, {
          message: "Apps immutable manifest storage is not supported by this provider",
        });
      }
      await objectStore.putObjectIfAbsent({
        key: appBuildManifestObjectKey({
          workspaceId: authority.workspaceId,
          appId,
          buildId,
          manifestSha256: request.manifestSha256,
        }),
        contentType: "application/json; charset=utf-8",
        body: manifestBytes,
        sha256: request.manifestSha256,
      });
      return await buildUploadPage({
        objectStore,
        build: prepared.build,
        manifest: request.manifest,
        fileObjects,
        offset: 0,
        replayed: prepared.replayed,
      });
    },

    async listBuildUploads({ authority, appId, buildId, query }) {
      const objectStore = storage();
      const plan = await appPersistence(() =>
        getAppBuildStoragePlan(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          appId,
          buildId,
        }),
      );
      const offset = decodeOffset(query.cursor);
      const page = plan.files.slice(offset, offset + query.limit);
      return {
        buildId,
        uploads: await Promise.all(
          page.map(async (file) => ({
            path: file.path,
            stagingUpload: signedUpload(
              await objectStore.createPutUrl({
                key: file.stagingObjectKey,
                contentType: file.contentType,
                sha256: file.contentSha256,
                audience: "public",
              }),
            ),
          })),
        ),
        nextCursor:
          offset + page.length < plan.files.length ? encodeOffset(offset + page.length) : null,
      };
    },

    async completeBuild({ authority, appId, buildId, request }, options) {
      const objectStore = storage();
      const plan = await appPersistence(() =>
        getAppBuildStoragePlan(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          appId,
          buildId,
        }),
      );
      const preflight = preflightAppBuildCompletion(plan, request.expectedManifestSha256);
      if (preflight.kind === "replay") {
        return await appPersistence(() =>
          completeAppBuild(input.db, {
            accountId: authority.accountId,
            workspaceId: authority.workspaceId,
            actorSubjectId: authority.subjectId,
            appId,
            buildId,
            expectedManifestSha256: request.expectedManifestSha256,
            frozenFiles: preflight.frozenFiles,
            manifestVersionToken: preflight.manifestVersionToken,
            receiptDigest: preflight.receiptDigest,
            idempotencyKey: request.idempotencyKey,
          }),
        );
      }
      const frozen = await freezeAppBuildObjects({
        ...immutablePorts(objectStore),
        workspaceId: authority.workspaceId,
        appId,
        buildId,
        fileIdsByPath: Object.fromEntries(plan.files.map((file) => [file.path, file.id])),
        manifest: plan.manifest,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (!frozen.ready) {
        await appPersistence(() =>
          failAppBuild(input.db, {
            accountId: authority.accountId,
            workspaceId: authority.workspaceId,
            actorSubjectId: authority.subjectId,
            appId,
            buildId,
            expectedManifestSha256: request.expectedManifestSha256,
            failureCode: frozen.failure.code,
            idempotencyKey: `${request.idempotencyKey}:failed`,
          }),
        );
        throw new HTTPException(422, { message: "App build verification failed" });
      }
      const receiptDigest = createHash("sha256")
        .update(
          JSON.stringify({
            checks: plan.build.checks,
            frozenFiles: frozen.frozenFiles.map((file) => ({
              path: file.path,
              contentSha256: file.contentSha256,
              sizeBytes: file.sizeBytes,
              versionToken: file.versionToken,
            })),
          }),
          "utf8",
        )
        .digest("hex");
      if (!objectStore.headObject) {
        throw new HTTPException(503, {
          message: "Apps immutable manifest verification is not supported by this provider",
        });
      }
      const manifestHead = await objectStore.headObject(plan.manifestObjectKey);
      const manifestVersionToken = manifestHead?.VersionToken;
      if (!manifestVersionToken) {
        throw new HTTPException(422, { message: "App build manifest is unavailable" });
      }
      return await appPersistence(() =>
        completeAppBuild(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          buildId,
          expectedManifestSha256: request.expectedManifestSha256,
          frozenFiles: plan.files.map((file) => ({
            fileId: file.id,
            frozenVersionToken: frozen.frozenFiles.find((item) => item.path === file.path)!
              .versionToken,
          })),
          manifestVersionToken,
          receiptDigest,
          idempotencyKey: request.idempotencyKey,
        }),
      );
    },

    async promoteBuild({ authority, appId, request }) {
      return await appPersistence(() =>
        promoteAppBuild(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          buildId: request.buildId,
          expectedAppVersion: request.expectedAppVersion,
          idempotencyKey: request.idempotencyKey,
        }),
      );
    },

    async createPreview({ authority, appId, request }) {
      const origin = appOrigin(input.settings, appId);
      const preview = await appPersistence(() =>
        createAppPreview(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          releaseId: request.releaseId,
          hostname: new URL(origin).hostname,
          expiresAt: new Date(
            Date.now() + (request.ttlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS) * 1_000,
          ),
          idempotencyKey: request.idempotencyKey,
        }),
      );
      return {
        preview: preview.preview,
        url: appRunShellUrl(input.settings, authority.workspaceId, appId, preview.preview.id),
        replayed: preview.replayed,
      };
    },

    async publish({ authority, appId, request }) {
      const origin = appOrigin(input.settings, appId);
      const result = await appPersistence(() =>
        publishAppRelease(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          releaseId: request.releaseId,
          hostname: new URL(origin).hostname,
          reason: request.reason,
          expectedAppVersion: request.expectedAppVersion,
          idempotencyKey: request.idempotencyKey,
        }),
      );
      return { app: result.app, release: result.release, replayed: result.replayed };
    },

    async rollback({ authority, appId, request }) {
      const origin = appOrigin(input.settings, appId);
      const result = await appPersistence(() =>
        publishAppRelease(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          releaseId: request.releaseId,
          hostname: new URL(origin).hostname,
          reason: request.reason,
          expectedAppVersion: request.expectedAppVersion,
          idempotencyKey: request.idempotencyKey,
        }),
      );
      return { app: result.app, release: result.release, replayed: result.replayed };
    },

    async unpublish({ authority, appId, request }) {
      return await appPersistence(() =>
        unpublishWorkspaceApp(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          expectedAppVersion: request.expectedAppVersion,
          reason: request.reason,
          idempotencyKey: request.idempotencyKey,
        }),
      );
    },

    async archive({ authority, appId, request }) {
      return await appPersistence(() =>
        archiveWorkspaceApp(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          expectedAppVersion: request.expectedAppVersion,
          reason: request.reason,
          idempotencyKey: request.idempotencyKey,
        }),
      );
    },

    async createLaunch({ authority, appId, request }) {
      const origin = appOrigin(input.settings, appId);
      const authorityGeneration = randomUUID();
      const result = await appPersistence(() =>
        createAppLaunch(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          actorSubjectId: authority.subjectId,
          appId,
          ...(request.releaseId ? { releaseId: request.releaseId } : {}),
          ...(request.previewId ? { previewId: request.previewId } : {}),
          ttlSeconds: request.ttlSeconds ?? DEFAULT_LAUNCH_TTL_SECONDS,
          authorityHash: authority.managedSessionSetAuthorityHash,
          authorityEpoch: authority.managedActorEpoch,
          authorityGeneration,
        }),
      );
      if (result.launch.hostname !== new URL(origin).hostname) {
        throw new HTTPException(409, { message: "App launch origin changed" });
      }
      return {
        launchId: result.launch.id,
        appId,
        releaseId: result.launch.releaseId,
        authorityGeneration,
        launchUrl: `${origin}/.opengeni/launch/${result.nonce}/`,
        appOrigin: origin,
        nonce: result.nonce,
        expiresAt: result.launch.expiresAt,
      };
    },

    async getRuntimeCatalog({ authority, appId, releaseId }, options) {
      const policy = await appPersistence(() =>
        getAppReleaseToolPolicy(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          appId,
          releaseId,
        }),
      );
      if (!input.runtimeToolProvider) {
        if (policy.allowedTools.length > 0) {
          throw new HTTPException(503, { message: "Apps runtime tools are not configured" });
        }
        return { ...policy, tools: [] };
      }
      return await projectAppRuntimeCatalog({
        authority,
        policy,
        provider: input.runtimeToolProvider,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },

    async callRuntimeTool(
      { authority, appId, releaseId, launchId, authorityGeneration, launchNonce, request },
      options,
    ) {
      if (!input.runtimeToolProvider) {
        throw new HTTPException(503, { message: "Apps runtime tools are not configured" });
      }
      const launchNonceSha256 = `sha256:${createHash("sha256")
        .update(launchNonce, "utf8")
        .digest("hex")}`;
      const common = {
        accountId: authority.accountId,
        workspaceId: authority.workspaceId,
        actorSubjectId: authority.subjectId,
        appId,
        releaseId,
        launchId,
        launchNonceSha256,
        authorityHash: authority.managedSessionSetAuthorityHash,
        authorityEpoch: authority.managedActorEpoch,
        authorityGeneration,
        operationId: request.operationId,
      };
      const begun = await appPersistence(() =>
        beginAppToolCall(input.db, {
          ...common,
          identity: request.identity,
          catalogDigest: request.catalogDigest,
          input: request.input,
        }),
      );
      if (begun.toolCall.status !== "pending") {
        return toolCallResponse(begun.toolCall, true);
      }
      const policy = await appPersistence(() =>
        getAppReleaseToolPolicy(input.db, {
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          appId,
          releaseId,
        }),
      );
      let response: AppRuntimeToolCallResponse;
      try {
        response = await callAppRuntimeTool({
          authority,
          policy,
          request,
          provider: input.runtimeToolProvider,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      } catch {
        response = {
          operationId: request.operationId,
          status: "failed",
          output: null,
          error: {
            code: "app_tool_unavailable",
            message: "The App tool is unavailable",
            retryable: false,
          },
          replayed: false,
        };
      }
      const settled = await appPersistence(() =>
        settleAppToolCall(input.db, {
          ...common,
          status: response.status,
          ...(response.status === "succeeded" ? { output: response.output } : {}),
          ...(response.status === "failed" && response.error ? { error: response.error } : {}),
        }),
      );
      return toolCallResponse(settled.toolCall, begun.replayed || settled.replayed);
    },
  };
  return Object.freeze(application);
}

async function detail(
  db: Database,
  authority: { accountId: string; workspaceId: string },
  appId: string,
): Promise<WorkspaceAppDetailResponse> {
  return await appPersistence(() =>
    getWorkspaceApp(db, {
      accountId: authority.accountId,
      workspaceId: authority.workspaceId,
      appId,
    }),
  );
}

async function appPersistence<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppPersistenceNotFoundError) {
      throw new HTTPException(404, { message: error.message });
    }
    if (error instanceof AppPersistenceConflictError) {
      throw new HTTPException(409, { message: error.message });
    }
    if (error instanceof AppPersistenceIdempotencyError) {
      throw new HTTPException(409, { message: error.message });
    }
    if (error instanceof AppPersistenceStateError) {
      throw new HTTPException(422, { message: error.message });
    }
    throw error;
  }
}

function immutablePorts(storage: ObjectStorage) {
  if (!storage.headObject || !storage.getObjectRange || !storage.putObjectStreamIfAbsent) {
    throw new HTTPException(503, {
      message: "Apps immutable object verification is not supported by this storage provider",
    });
  }
  return {
    reader: {
      headObject: storage.headObject.bind(storage),
      getObjectRange: storage.getObjectRange.bind(storage),
    },
    writer: {
      putObjectStreamIfAbsent: storage.putObjectStreamIfAbsent.bind(storage),
    },
  };
}

function signedUpload(input: {
  url: string;
  requiredHeaders: Record<string, string>;
  expiresAt: Date;
}) {
  return {
    url: input.url,
    method: "PUT" as const,
    headers: input.requiredHeaders,
    expiresAt: input.expiresAt.toISOString(),
  };
}

async function buildUploadPage(input: {
  objectStore: ObjectStorage;
  build: PrepareAppBuildResponse["build"];
  manifest: Parameters<typeof prepareAppBuild>[1]["manifest"];
  fileObjects: Parameters<typeof prepareAppBuild>[1]["fileObjects"];
  offset: number;
  replayed: boolean;
}): Promise<PrepareAppBuildResponse> {
  const page = input.fileObjects.slice(input.offset, input.offset + 200);
  const filesByPath = new Map(input.manifest.files.map((file) => [file.path, file]));
  return {
    build: input.build,
    uploads: await Promise.all(
      page.map(async (fileObject) => {
        const file = filesByPath.get(fileObject.path)!;
        return {
          path: file.path,
          stagingUpload: signedUpload(
            await input.objectStore.createPutUrl({
              key: fileObject.stagingObjectKey,
              contentType: file.contentType,
              sha256: file.contentSha256,
              audience: "public",
            }),
          ),
        };
      }),
    ),
    nextCursor:
      input.offset + page.length < input.fileObjects.length
        ? encodeOffset(input.offset + page.length)
        : null,
    replayed: input.replayed,
  };
}

function appOrigin(settings: Settings, appId: string): string {
  if (!settings.appOriginTemplate) {
    throw new HTTPException(503, { message: "Apps origin template is not configured" });
  }
  return resolveWorkspaceAppOrigin(settings.appOriginTemplate, appId);
}

function appRunShellUrl(
  settings: Settings,
  workspaceId: string,
  appId: string,
  previewId: string,
): string {
  const base = settings.webBaseUrl ?? settings.publicBaseUrl;
  if (!base) throw new HTTPException(503, { message: "Apps web origin is not configured" });
  const url = new URL(`/workspaces/${workspaceId}/apps/${appId}/run`, base);
  url.searchParams.set("previewId", previewId);
  return url.toString();
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

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HTTPException(422, { message: "Invalid App upload cursor" });
  }
  return value;
}

function toolCallResponse(
  call: {
    operationId: string;
    status: "pending" | "succeeded" | "failed";
    output: unknown | null;
    error: AppRuntimeToolCallResponse["error"];
  },
  replayed: boolean,
): AppRuntimeToolCallResponse {
  if (call.status === "pending") {
    throw new HTTPException(409, { message: "App tool operation is still pending" });
  }
  return {
    operationId: call.operationId,
    status: call.status,
    output: call.output,
    error: call.error,
    replayed,
  };
}

export function createAppSourceDownloadSignature(
  settings: Settings,
  input: Readonly<{
    authority: { accountId: string; workspaceId: string; subjectId: string };
    appId: string;
    sourceRevisionId: string;
    expiresAtSeconds: number;
  }>,
): string {
  const secret = settings.appHostResolverKey;
  if (!secret) {
    throw new HTTPException(503, { message: "Apps download signing is not configured" });
  }
  return createHmac("sha256", secret)
    .update(
      [
        "opengeni-app-source-download-v1",
        input.authority.accountId,
        input.authority.workspaceId,
        input.authority.subjectId,
        input.appId,
        input.sourceRevisionId,
        String(input.expiresAtSeconds),
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
}

export function assertAppSourceCompletionIdentity(
  sourceRevision: Readonly<{ contentSha256: string; sizeBytes: number }>,
  request: Readonly<{
    expectedContentSha256: string;
    expectedSizeBytes: number;
  }>,
): void {
  if (
    sourceRevision.contentSha256 !== request.expectedContentSha256 ||
    sourceRevision.sizeBytes !== request.expectedSizeBytes
  ) {
    throw new HTTPException(409, {
      message: "App source upload identity changed",
    });
  }
}

export function verifiedAppBuildManifestBytes(
  manifest: AppBuildManifest,
  expectedManifestSha256: string,
): Uint8Array {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const actualManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (actualManifestSha256 !== expectedManifestSha256) {
    throw new HTTPException(422, { message: "App build manifest digest does not match" });
  }
  return manifestBytes;
}

type AppBuildCompletionPreflight =
  | Readonly<{ kind: "verify" }>
  | Readonly<{
      kind: "replay";
      frozenFiles: AppBuildFrozenFileReceipt[];
      manifestVersionToken: string;
      receiptDigest: string;
    }>;

export function preflightAppBuildCompletion(
  plan: Pick<AppBuildStoragePlan, "build" | "files" | "manifestVersionToken">,
  expectedManifestSha256: string,
): AppBuildCompletionPreflight {
  if (plan.build.manifestSha256 !== expectedManifestSha256) {
    throw new HTTPException(409, { message: "App build manifest changed" });
  }
  if (["queued", "running", "uploading", "verifying"].includes(plan.build.status)) {
    return { kind: "verify" };
  }
  if (plan.build.status !== "succeeded") {
    throw new HTTPException(422, { message: "App build is already settled" });
  }
  if (
    !plan.manifestVersionToken ||
    !plan.build.receiptDigest ||
    plan.files.some((file) => !file.frozenVersionToken)
  ) {
    throw new HTTPException(422, { message: "Completed App build receipts are incomplete" });
  }
  return {
    kind: "replay",
    frozenFiles: plan.files.map((file) => ({
      fileId: file.id,
      frozenVersionToken: file.frozenVersionToken!,
    })),
    manifestVersionToken: plan.manifestVersionToken,
    receiptDigest: plan.build.receiptDigest,
  };
}

function equalDigest(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
