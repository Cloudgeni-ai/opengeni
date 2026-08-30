import {
  AppBuildManifest,
  type AppBuildManifest as AppBuildManifestType,
} from "@opengeni/contracts/apps";
import { createHash } from "node:crypto";

export const APP_BUILD_VERIFICATION_RANGE_BYTES = 4 * 1024 * 1024;
export const APP_BUILD_VERIFICATION_CONCURRENCY = 8;

export type AppImmutableObjectHead = {
  ContentLength?: number;
  ContentType?: string;
  Metadata?: Record<string, string>;
  VersionToken?: string;
};

export type AppImmutableObjectReader = {
  headObject(key: string): Promise<AppImmutableObjectHead | null>;
  getObjectRange(args: {
    key: string;
    start: number;
    endInclusive: number;
    expectedVersionToken: string;
  }): Promise<{ bytes: Uint8Array; versionToken: string } | null>;
};

export type AppImmutableObjectWriter = {
  putObjectStreamIfAbsent(args: {
    key: string;
    contentType: string;
    chunks: AsyncIterable<Uint8Array>;
    byteSize: number;
    sha256: string;
    signal?: AbortSignal;
  }): Promise<boolean>;
};

export type AppBuildVerificationFailureCode =
  | "object_missing"
  | "object_size_mismatch"
  | "object_content_type_mismatch"
  | "object_version_unavailable"
  | "object_version_changed"
  | "object_range_invalid"
  | "object_sha256_mismatch";

export type AppBuildVerificationFailure = {
  path: string;
  code: AppBuildVerificationFailureCode;
};

export type AppBuildVerificationResult =
  | { ready: true; verifiedFiles: number; verifiedBytes: number }
  | { ready: false; failure: AppBuildVerificationFailure };

export type FrozenAppBuildFile = {
  path: string;
  key: string;
  contentSha256: string;
  sizeBytes: number;
  versionToken: string;
};

export type AppBuildFreezeResult =
  | { ready: true; frozenFiles: FrozenAppBuildFile[]; verifiedBytes: number }
  | { ready: false; failure: AppBuildVerificationFailure };

export type AppSourceFreezeResult =
  | { ready: true; frozenVersionToken: string }
  | { ready: false; failure: AppBuildVerificationFailure };

function appStoragePrefix(workspaceId: string, appId: string): string {
  return `workspaces/${workspaceId}/apps/${appId}`;
}

export function appSourceStagingObjectKey(input: {
  workspaceId: string;
  appId: string;
  sourceRevisionId: string;
  uploadId: string;
}): string {
  return `${appStoragePrefix(input.workspaceId, input.appId)}/sources/${input.sourceRevisionId}/staging/${input.uploadId}.tar`;
}

export function appSourceObjectKey(input: {
  workspaceId: string;
  appId: string;
  sourceRevisionId: string;
  contentSha256: string;
}): string {
  return `${appStoragePrefix(input.workspaceId, input.appId)}/sources/${input.sourceRevisionId}/frozen/${input.contentSha256}.tar`;
}

export function appBuildStagingObjectKey(input: {
  workspaceId: string;
  appId: string;
  buildId: string;
  fileId: string;
}): string {
  return `${appStoragePrefix(input.workspaceId, input.appId)}/builds/${input.buildId}/staging/${input.fileId}`;
}

export function appBuildObjectKey(input: {
  workspaceId: string;
  appId: string;
  buildId: string;
  fileId: string;
  contentSha256: string;
}): string {
  return `${appStoragePrefix(input.workspaceId, input.appId)}/builds/${input.buildId}/frozen/${input.contentSha256}/${input.fileId}`;
}

export function appBuildManifestObjectKey(input: {
  workspaceId: string;
  appId: string;
  buildId: string;
  manifestSha256: string;
}): string {
  return `${appStoragePrefix(input.workspaceId, input.appId)}/builds/${input.buildId}/frozen/${input.manifestSha256}/manifest.json`;
}

/**
 * Resolve the dedicated origin for one stable App id. Deployment configuration
 * must place the id in the hostname and cannot smuggle authority in a path,
 * query, fragment, or userinfo component.
 */
export function resolveWorkspaceAppOrigin(template: string, appId: string): string {
  const occurrences = template.split("{appId}").length - 1;
  if (occurrences !== 1) {
    throw new Error("OPENGENI_APP_ORIGIN_TEMPLATE must contain {appId} exactly once");
  }
  const origin = new URL(template.replace("{appId}", appId));
  const appHostLabel = origin.hostname.split(".", 1)[0];
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    appHostLabel !== appId.toLowerCase()
  ) {
    throw new Error(
      "OPENGENI_APP_ORIGIN_TEMPLATE must resolve to a dedicated HTTPS origin with no path, query, fragment, or userinfo",
    );
  }
  return origin.origin;
}

function normalizedContentType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

async function inspectExactObject(input: {
  reader: AppImmutableObjectReader;
  key: string;
  path: string;
  contentType: string;
  contentSha256: string;
  sizeBytes: number;
  rangeBytes: number;
}): Promise<
  { ready: true; versionToken: string } | { ready: false; failure: AppBuildVerificationFailure }
> {
  const head = await input.reader.headObject(input.key);
  if (!head) return { ready: false, failure: { path: input.path, code: "object_missing" } };
  if (head.ContentLength !== input.sizeBytes) {
    return { ready: false, failure: { path: input.path, code: "object_size_mismatch" } };
  }
  if (
    head.ContentType &&
    normalizedContentType(head.ContentType) !== normalizedContentType(input.contentType)
  ) {
    return {
      ready: false,
      failure: { path: input.path, code: "object_content_type_mismatch" },
    };
  }
  const versionToken = head.VersionToken;
  if (!versionToken) {
    return { ready: false, failure: { path: input.path, code: "object_version_unavailable" } };
  }

  const hash = createHash("sha256");
  for (let start = 0; start < input.sizeBytes; start += input.rangeBytes) {
    const endInclusive = Math.min(input.sizeBytes - 1, start + input.rangeBytes - 1);
    const range = await input.reader.getObjectRange({
      key: input.key,
      start,
      endInclusive,
      expectedVersionToken: versionToken,
    });
    if (!range) return { ready: false, failure: { path: input.path, code: "object_missing" } };
    if (range.versionToken !== versionToken) {
      return { ready: false, failure: { path: input.path, code: "object_version_changed" } };
    }
    if (range.bytes.byteLength !== endInclusive - start + 1) {
      return { ready: false, failure: { path: input.path, code: "object_range_invalid" } };
    }
    hash.update(range.bytes);
  }
  if (hash.digest("hex") !== input.contentSha256) {
    return { ready: false, failure: { path: input.path, code: "object_sha256_mismatch" } };
  }
  const after = await input.reader.headObject(input.key);
  if (!after) return { ready: false, failure: { path: input.path, code: "object_missing" } };
  if (after.VersionToken !== versionToken) {
    return { ready: false, failure: { path: input.path, code: "object_version_changed" } };
  }
  return { ready: true, versionToken };
}

/**
 * Verify every staging object before a worker freezes it to a distinct digest
 * key. This function never makes staging launchable; callers must copy/stream
 * the verified bytes into immutable keys and commit those identities before a
 * build can become succeeded.
 */
export async function verifyAppBuildStagingObjects(input: {
  reader: AppImmutableObjectReader;
  workspaceId: string;
  appId: string;
  buildId: string;
  fileIdsByPath: Readonly<Record<string, string>>;
  manifest: AppBuildManifestType;
  rangeBytes?: number;
  concurrency?: number;
}): Promise<AppBuildVerificationResult> {
  const manifest = AppBuildManifest.parse(input.manifest);
  const rangeBytes = input.rangeBytes ?? APP_BUILD_VERIFICATION_RANGE_BYTES;
  const concurrency = input.concurrency ?? APP_BUILD_VERIFICATION_CONCURRENCY;
  if (!Number.isSafeInteger(rangeBytes) || rangeBytes <= 0) {
    throw new Error("App build verification rangeBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > 32) {
    throw new Error("App build verification concurrency must be between 1 and 32");
  }
  for (const file of manifest.files) {
    if (!input.fileIdsByPath[file.path]) {
      throw new Error(`App build file identity is missing for ${file.path}`);
    }
  }

  let nextIndex = 0;
  let failure: AppBuildVerificationFailure | null = null;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, manifest.files.length) }, async () => {
      while (!failure) {
        const index = nextIndex++;
        const file = manifest.files[index];
        if (!file) return;
        const result = await inspectExactObject({
          reader: input.reader,
          key: appBuildStagingObjectKey({
            workspaceId: input.workspaceId,
            appId: input.appId,
            buildId: input.buildId,
            fileId: input.fileIdsByPath[file.path]!,
          }),
          path: file.path,
          contentType: file.contentType,
          contentSha256: file.contentSha256,
          sizeBytes: file.sizeBytes,
          rangeBytes,
        });
        if (!result.ready) failure ??= result.failure;
      }
    }),
  );
  return failure
    ? { ready: false, failure }
    : { ready: true, verifiedFiles: manifest.files.length, verifiedBytes: manifest.totalBytes };
}

async function* exactObjectChunks(input: {
  reader: AppImmutableObjectReader;
  key: string;
  byteSize: number;
  versionToken: string;
  rangeBytes: number;
  signal?: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  for (let start = 0; start < input.byteSize; start += input.rangeBytes) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("App build freeze aborted");
    const endInclusive = Math.min(input.byteSize - 1, start + input.rangeBytes - 1);
    const range = await input.reader.getObjectRange({
      key: input.key,
      start,
      endInclusive,
      expectedVersionToken: input.versionToken,
    });
    if (!range || range.versionToken !== input.versionToken) {
      throw new Error("App build staging object changed while it was being frozen");
    }
    if (range.bytes.byteLength !== endInclusive - start + 1) {
      throw new Error("App build staging object returned a truncated range while being frozen");
    }
    yield range.bytes;
  }
}

/** Physically freeze one portable source archive away from its signed staging key. */
export async function freezeAppSourceArchive(input: {
  reader: AppImmutableObjectReader;
  writer: AppImmutableObjectWriter;
  stagingObjectKey: string;
  frozenObjectKey: string;
  contentSha256: string;
  sizeBytes: number;
  rangeBytes?: number;
  signal?: AbortSignal;
}): Promise<AppSourceFreezeResult> {
  const rangeBytes = input.rangeBytes ?? APP_BUILD_VERIFICATION_RANGE_BYTES;
  if (!Number.isSafeInteger(rangeBytes) || rangeBytes <= 0) {
    throw new Error("App source freeze rangeBytes must be a positive safe integer");
  }
  const staging = await inspectExactObject({
    reader: input.reader,
    key: input.stagingObjectKey,
    path: "source.tar",
    contentType: "application/x-tar",
    contentSha256: input.contentSha256,
    sizeBytes: input.sizeBytes,
    rangeBytes,
  });
  if (!staging.ready) return staging;
  await input.writer.putObjectStreamIfAbsent({
    key: input.frozenObjectKey,
    contentType: "application/x-tar",
    byteSize: input.sizeBytes,
    sha256: input.contentSha256,
    chunks: exactObjectChunks({
      reader: input.reader,
      key: input.stagingObjectKey,
      byteSize: input.sizeBytes,
      versionToken: staging.versionToken,
      rangeBytes,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const frozen = await inspectExactObject({
    reader: input.reader,
    key: input.frozenObjectKey,
    path: "source.tar",
    contentType: "application/x-tar",
    contentSha256: input.contentSha256,
    sizeBytes: input.sizeBytes,
    rangeBytes,
  });
  return frozen.ready ? { ready: true, frozenVersionToken: frozen.versionToken } : frozen;
}

/**
 * Physically freeze verified staging bytes to create-only digest keys. The
 * staging object is read twice under one provider version: the first pass
 * proves its digest, and the second streams to a distinct immutable target.
 * An existing target is accepted only after the same full-byte verification.
 */
export async function freezeAppBuildObjects(input: {
  reader: AppImmutableObjectReader;
  writer: AppImmutableObjectWriter;
  workspaceId: string;
  appId: string;
  buildId: string;
  fileIdsByPath: Readonly<Record<string, string>>;
  manifest: AppBuildManifestType;
  rangeBytes?: number;
  signal?: AbortSignal;
}): Promise<AppBuildFreezeResult> {
  const manifest = AppBuildManifest.parse(input.manifest);
  const rangeBytes = input.rangeBytes ?? APP_BUILD_VERIFICATION_RANGE_BYTES;
  if (!Number.isSafeInteger(rangeBytes) || rangeBytes <= 0) {
    throw new Error("App build freeze rangeBytes must be a positive safe integer");
  }
  const frozenFiles: FrozenAppBuildFile[] = [];
  for (const file of manifest.files) {
    const fileId = input.fileIdsByPath[file.path];
    if (!fileId) throw new Error(`App build file identity is missing for ${file.path}`);
    const stagingKey = appBuildStagingObjectKey({
      workspaceId: input.workspaceId,
      appId: input.appId,
      buildId: input.buildId,
      fileId,
    });
    const staging = await inspectExactObject({
      reader: input.reader,
      key: stagingKey,
      path: file.path,
      contentType: file.contentType,
      contentSha256: file.contentSha256,
      sizeBytes: file.sizeBytes,
      rangeBytes,
    });
    if (!staging.ready) return staging;

    const frozenKey = appBuildObjectKey({
      workspaceId: input.workspaceId,
      appId: input.appId,
      buildId: input.buildId,
      fileId,
      contentSha256: file.contentSha256,
    });
    await input.writer.putObjectStreamIfAbsent({
      key: frozenKey,
      contentType: file.contentType,
      byteSize: file.sizeBytes,
      sha256: file.contentSha256,
      chunks: exactObjectChunks({
        reader: input.reader,
        key: stagingKey,
        byteSize: file.sizeBytes,
        versionToken: staging.versionToken,
        rangeBytes,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const frozen = await inspectExactObject({
      reader: input.reader,
      key: frozenKey,
      path: file.path,
      contentType: file.contentType,
      contentSha256: file.contentSha256,
      sizeBytes: file.sizeBytes,
      rangeBytes,
    });
    if (!frozen.ready) return frozen;
    frozenFiles.push({
      path: file.path,
      key: frozenKey,
      contentSha256: file.contentSha256,
      sizeBytes: file.sizeBytes,
      versionToken: frozen.versionToken,
    });
  }
  return { ready: true, frozenFiles, verifiedBytes: manifest.totalBytes };
}
