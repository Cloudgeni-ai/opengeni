import {
  getFilesForSubject,
  requireFileForSubject,
  areGitHubRepositoriesAllowedForWorkspace,
} from "@opengeni/db";
import { type SandboxFileDownload, type SandboxFileDownloadFailure } from "@opengeni/runtime";
import { type Settings } from "@opengeni/config";
import { mergeResourceRefs } from "../common";
import {
  gitHubTokenAuthorizationSelections,
  type GitHubTokenMintAuthorization,
} from "../environment";
import type { TurnActivityServices as ActivityServices } from "../types";
import { createObjectStorage, type ObjectStorage } from "@opengeni/storage";
import { CAPABILITY_DESCRIPTORS, resourceMountPath, type ResourceRef } from "@opengeni/contracts";

export function filterUnmaterializedSandboxFileDownloads(
  downloads: SandboxFileDownload[],
  materializedFileIds: Set<string>,
): SandboxFileDownload[] {
  if (downloads.length === 0 || materializedFileIds.size === 0) {
    return downloads;
  }
  return downloads.filter((download) => !materializedFileIds.has(download.fileId));
}

export function runtimeResourcesForTurn(
  sessionResources: readonly ResourceRef[],
  currentTurnResources: readonly ResourceRef[],
): ResourceRef[] {
  return mergeResourceRefs(
    sessionResources.filter((resource) => resource.kind !== "file"),
    [...currentTurnResources],
  );
}

export function sandboxFileMaterializationOutcome(
  failures: readonly SandboxFileDownloadFailure[],
): "completed" | "failed" {
  return failures.length === 0 ? "completed" : "failed";
}

/** Fixed-length one-way tenant correlation for metrics/alerts; never a raw id. */
export async function assertGitHubResourcesRemainAuthorized(
  db: Parameters<typeof areGitHubRepositoriesAllowedForWorkspace>[0],
  workspaceId: string,
  resources: ResourceRef[],
  authorize?: GitHubTokenMintAuthorization,
): Promise<void> {
  // Must check exactly what sandboxEnvironmentForRun would mint a token for,
  // so the selection is derived from the same extraction as the mint path.
  for (const selection of gitHubTokenAuthorizationSelections(resources)) {
    if (authorize) {
      await authorize(selection);
    } else {
      await assertGitHubTokenMintSelectionAuthorized(
        db,
        workspaceId,
        selection.installationId,
        selection.repositoryIds,
      );
    }
  }
}

export async function assertFileResourcesRemainAuthorized(
  db: ActivityServices["db"],
  accountId: string,
  workspaceId: string,
  subjectId: string | null,
  resources: ResourceRef[],
): Promise<void> {
  const fileIds = resources.flatMap((resource) =>
    resource.kind === "file" ? [resource.fileId] : [],
  );
  if (fileIds.length === 0) return;
  const authorized = await getFilesForSubject(db, {
    accountId,
    workspaceId,
    subjectId,
    fileIds,
  });
  if (authorized.length !== new Set(fileIds).size) {
    throw new Error("One or more file resources are unavailable or no longer authorized");
  }
}

export async function assertGitHubTokenMintSelectionAuthorized(
  db: Parameters<typeof areGitHubRepositoriesAllowedForWorkspace>[0],
  workspaceId: string,
  installationId: number,
  repositoryIds: number[],
): Promise<void> {
  if (
    !(await areGitHubRepositoriesAllowedForWorkspace(
      db,
      workspaceId,
      installationId,
      repositoryIds,
    ))
  ) {
    throw new Error(
      "This workspace no longer authorizes one or more GitHub repositories attached to the session",
    );
  }
}

/**
 * True when the error is transient upstream backpressure — a model-provider 5xx,
 * a "server had a bad minute" body, or a dropped/again-able network connection —
 * rather than a request the session got wrong. These are safe to recover as a new
 * fenced attempt of the SAME turn after PROVIDER_BACKPRESSURE_DELAY_MS. Durable
 * tool results are preserved and ambiguous in-flight effects are closed before
 * the new attempt, independent of whether the session has an active goal.
 *
 * This is the classification gap that hard-failed a fleet of prod sessions during a
 * provider degradation window: their errors ("Our servers are currently overloaded",
 * the generic 500 "An error occurred while processing your request", "Connection
 * error") carried no retryable marker and fell through to a terminal session.failed.
 *
 * HTTP status is authoritative when present — EVERY 5xx is a server-side failure that
 * is safe to retry, while 4xx (validation, auth, 404) is a request fault that must
 * still hard-fail. The code/message matches are the fallback for network faults and
 * SDK-rethrown bare Errors that carry no status. A ChatGPT/Codex usage cap (a 429
 * that will NOT clear on retry) is classified and returned BEFORE this in
 * agentRunFailurePayload, so it never reaches here.
 */
export async function sandboxFileDownloadsForRun(
  settings: Settings,
  db: ActivityServices["db"],
  objectStorage: ObjectStorage | null,
  accountId: string,
  workspaceId: string,
  subjectId: string | null,
  resources: ResourceRef[],
  activeSandboxBackend: Settings["sandboxBackend"] = settings.sandboxBackend,
): Promise<SandboxFileDownload[]> {
  if (!requiresSignedFileResourceDownloads(settings, activeSandboxBackend)) {
    return [];
  }
  const fileResources = resources.filter(
    (resource): resource is Extract<ResourceRef, { kind: "file" }> => resource.kind === "file",
  );
  if (fileResources.length === 0) {
    return [];
  }
  if (!objectStorage) {
    throw new Error(
      `${settings.objectStorageBackend} file resources require configured object storage`,
    );
  }
  const downloadStorage = objectStorageForSandboxDownloads(
    settings,
    objectStorage,
    activeSandboxBackend,
  );
  const downloads: SandboxFileDownload[] = [];
  for (const resource of fileResources) {
    const file = await requireFileForSubject(db, {
      accountId,
      workspaceId,
      subjectId,
      fileId: resource.fileId,
    });
    const url = await downloadStorage.createGetUrl({ key: file.objectKey });
    downloads.push({
      fileId: file.id,
      mountPath: resourceMountPath(resource),
      filename: file.safeFilename,
      url: url.url,
      expiresAt: url.expiresAt,
      sizeBytes: file.sizeBytes,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
    });
  }
  return downloads;
}

export function requiresSignedFileResourceDownloads(
  settings: Settings,
  activeSandboxBackend: Settings["sandboxBackend"] = settings.sandboxBackend,
): boolean {
  if (activeSandboxBackend === "none") {
    return false;
  }
  // A selfhosted machine (bring-your-own-compute) can NEVER mount ANY object store
  // — it is a remote user machine reached only over NATS, so file resources are
  // ALWAYS delivered by exec-curling a pre-signed URL onto it. Without this a
  // machine-home turn (sandbox_backend "selfhosted") would silently drop file
  // resources on an azure-blob / s3-compatible store (nativeBucketMount=false),
  // a regression from the pre-honest-label path where the same turn ran home=modal
  // and modal's descriptor forced signed downloads.
  if (activeSandboxBackend === "selfhosted") {
    return true;
  }
  // A nativeBucketMount backend (modal) cannot mount Azure Blob entries, so it
  // needs pre-signed downloads for that store. Keying on the descriptor (not the
  // "modal" literal) keeps this correct as bucket-mount backends are added.
  const nativeBucketMount = CAPABILITY_DESCRIPTORS[activeSandboxBackend].nativeBucketMount;
  return (
    (activeSandboxBackend === "docker" && settings.objectStorageBackend === "s3-compatible") ||
    settings.objectStorageBackend === "aws-s3" ||
    settings.objectStorageBackend === "gcs" ||
    (nativeBucketMount && settings.objectStorageBackend === "azure-blob")
  );
}

export function objectStorageForSandboxDownloads(
  settings: Settings,
  objectStorage: ObjectStorage,
  activeSandboxBackend: Settings["sandboxBackend"] = settings.sandboxBackend,
): ObjectStorage {
  // Connected Machines are not on the Docker compose network. Sign with the
  // ambient public endpoint; never rewrite to OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT.
  if (activeSandboxBackend === "selfhosted") {
    return objectStorage;
  }
  if (settings.objectStorageBackend !== "s3-compatible" || !settings.objectStorageSandboxEndpoint) {
    return objectStorage;
  }
  return (
    createObjectStorage({
      ...settings,
      objectStorageEndpoint: settings.objectStorageSandboxEndpoint,
    }) ?? objectStorage
  );
}
