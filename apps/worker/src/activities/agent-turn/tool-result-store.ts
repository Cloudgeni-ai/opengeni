import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import {
  TOOL_RESULT_SPILL_MOUNT_PATH,
  TOOL_RESULT_STORED_MEDIA_TYPE,
  sandboxShellPath,
  toolResultSpillSandboxPath,
  toolResultStoredFilename,
  type FileAsset,
} from "@opengeni/contracts";
import {
  completeFileUpload,
  getFile,
  getMaterializedSandboxFileResources,
  markSandboxFileResourcesMaterialized,
  prepareGeneratedWorkspaceFile,
  type Database,
} from "@opengeni/db";
import { modelToolOutputInlineMaxBytes } from "@opengeni/codex";
import type { Observability } from "@opengeni/observability";
import {
  materializeSandboxFileDownloads,
  type CodemodeTokenWriterSession,
  type ModelToolResultStore,
  type SandboxFileDownload,
  type StoredToolResult,
  type StoredToolResultKey,
  type StoredToolResultReaders,
  type TurnToolCancellationFence,
} from "@opengeni/runtime";
import type { Settings } from "@opengeni/config";
import { type ObjectStorage } from "@opengeni/storage";
import { objectStorageForSandboxDownloads } from "./file-resources";
import type { ResumedTurnSandbox } from "../../sandbox-resume";

const UPLOAD_INTENT_TTL_MS = 60 * 60_000;
/** Stored texts this attempt keeps in memory for repeated reads. */
const READ_CACHE_ENTRIES = 4;

export type ToolResultStoreDeps = {
  db: Database;
  objectStorage: ObjectStorage | null;
  observability: Observability;
  accountId: string;
  workspaceId: string;
  attemptId: string;
  getModelRunSettings: () => Settings;
  getSandboxFileDownloadBackend: () => Settings["sandboxBackend"];
  getPublish: () =>
    | ((events: Array<{ type: string; payload: unknown }>, immediate?: boolean) => Promise<unknown>)
    | null;
  toolCancellationFenceRef: { current: TurnToolCancellationFence | null };
  getResolvedSandbox: () => ResumedTurnSandbox | null;
  getSetupBoxSession: () => unknown;
  getSdkOwnedSandboxSession: () => unknown;
  getSandboxGroupId: () => string | null;
  runWorkspaceMutation: <T>(
    sandbox: ResumedTurnSandbox,
    operation: string,
    mutation: () => Promise<T>,
  ) => Promise<T>;
};

/**
 * The attempt's store for tool results larger than the model may see inline.
 * The full model-visible text becomes a workspace File (one per result,
 * idempotent across retries of the same call), readable by byte offset with
 * `tool_result_read` whether or not the session has a sandbox. When a
 * sandbox is already running, a copy is also written there so the shell can
 * search it; the store never starts a sandbox for that.
 */
export class ToolResultStore implements ModelToolResultStore {
  private currentReaders: StoredToolResultReaders = { reader: "none", shell: false };
  private materializationCache: { instanceId: string; fileIds: Set<string> } | null = null;
  private readonly readCache = new Map<string, Buffer>();

  constructor(private readonly deps: ToolResultStoreDeps) {}

  inlineMaxBytes = (): number =>
    modelToolOutputInlineMaxBytes(this.deps.getModelRunSettings().modelToolOutputTruncationTokens);

  readers = (): StoredToolResultReaders => this.currentReaders;

  /** Set once the attempt knows which tools its model has. */
  setReaders(readers: StoredToolResultReaders): void {
    this.currentReaders = readers;
  }

  store = async (input: { key: StoredToolResultKey; text: string }): Promise<StoredToolResult> => {
    const { objectStorage } = this.deps;
    if (!objectStorage) {
      throw new Error("Storing a large tool result requires configured object storage");
    }
    const bytes = Buffer.from(input.text, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const identity = toolResultStoreIdentity({
      workspaceId: this.deps.workspaceId,
      attemptId: this.deps.attemptId,
      key: input.key,
    });
    const filename = toolResultStoredFilename(identity.fileId);
    const objectKey = `workspaces/${this.deps.workspaceId}/files/${identity.fileId}/tool-results/${filename}`;
    const prepared = await prepareGeneratedWorkspaceFile(this.deps.db, {
      accountId: this.deps.accountId,
      workspaceId: this.deps.workspaceId,
      fileId: identity.fileId,
      uploadId: identity.uploadId,
      filename,
      safeFilename: filename,
      contentType: TOOL_RESULT_STORED_MEDIA_TYPE,
      sizeBytes: bytes.byteLength,
      sha256,
      bucket: objectStorage.bucket,
      objectKey,
      expiresAt: new Date(Date.now() + UPLOAD_INTENT_TTL_MS),
    });
    let file = prepared.file;
    if (file.status !== "ready") {
      if (!(await objectStorage.fileExists(file))) {
        await objectStorage.putObject({
          key: objectKey,
          contentType: TOOL_RESULT_STORED_MEDIA_TYPE,
          body: bytes,
          sha256,
        });
      }
      file = await completeFileUpload(this.deps.db, this.deps.workspaceId, identity.uploadId);
    }
    this.remember(file.id, bytes);
    const copied = await this.copyIntoLiveSandbox(file);
    return {
      resultId: file.id,
      byteSize: file.sizeBytes,
      sandboxPath: copied ? this.placedShellPath(filename) : null,
    };
  };

  /**
   * The bytes of one stored tool result of this workspace, or null when the
   * id names no stored tool result. Results stored before this store (exact
   * JSON over 1 MiB) are read the same way.
   */
  readBytes = async (resultId: string): Promise<Buffer | null> => {
    const cached = this.readCache.get(resultId);
    if (cached) return cached;
    const { objectStorage } = this.deps;
    if (!objectStorage) return null;
    const file = await getFile(this.deps.db, this.deps.workspaceId, resultId);
    if (!file || file.status !== "ready" || !file.objectKey.includes("/tool-results/")) {
      return null;
    }
    const object = await objectStorage.getObjectBytes(file.objectKey);
    if (!object) return null;
    const bytes = Buffer.from(object.bytes);
    this.remember(resultId, bytes);
    return bytes;
  };

  private remember(resultId: string, bytes: Buffer): void {
    this.readCache.delete(resultId);
    this.readCache.set(resultId, bytes);
    while (this.readCache.size > READ_CACHE_ENTRIES) {
      const oldest = this.readCache.keys().next().value;
      if (oldest === undefined) break;
      this.readCache.delete(oldest);
    }
  }

  /** The copy's absolute path in the placement it was just written to, so the
   * shell opens it from any working directory. A placement whose root is not
   * an absolute POSIX path keeps the cwd-relative form. */
  private placedShellPath(filename: string): string {
    const setupBoxSession = this.deps.getResolvedSandbox() ? this.deps.getSetupBoxSession() : null;
    const session = setupBoxSession ?? this.deps.getSdkOwnedSandboxSession();
    const root = (session as { state?: { manifest?: { root?: unknown } } } | null)?.state?.manifest
      ?.root;
    return typeof root === "string" && posixPath.isAbsolute(root)
      ? posixPath.join(root, TOOL_RESULT_SPILL_MOUNT_PATH, filename)
      : sandboxShellPath(toolResultSpillSandboxPath(filename));
  }

  /** Copy into a sandbox that is already running; false when none is or the copy failed. */
  private async copyIntoLiveSandbox(file: FileAsset): Promise<boolean> {
    if (this.deps.getSandboxFileDownloadBackend() === "none") return false;
    try {
      const sandbox = this.deps.getResolvedSandbox();
      const setupBoxSession = this.deps.getSetupBoxSession();
      if (sandbox && setupBoxSession) {
        return await this.materializeInSandbox(file, sandbox, setupBoxSession);
      }
      const sdkOwned = this.deps.getSdkOwnedSandboxSession();
      if (sdkOwned) return await this.writeDownload(sdkOwned, await this.prepareDownload(file));
      return false;
    } catch (error) {
      this.deps.observability.warn("Stored tool result sandbox copy failed", {
        errorClass: error instanceof Error ? error.name : "UnknownError",
        errorCode: "worker_operation_failed",
        origin: "worker",
      });
      return false;
    }
  }

  private async materializeInSandbox(
    file: FileAsset,
    sandbox: ResumedTurnSandbox,
    session: unknown,
  ): Promise<boolean> {
    const download = await this.prepareDownload(file);
    if (this.materializationCache?.instanceId !== sandbox.established.instanceId) {
      const sandboxGroupId = this.deps.getSandboxGroupId();
      const fileIds = sandboxGroupId
        ? await getMaterializedSandboxFileResources(this.deps.db, {
            accountId: this.deps.accountId,
            workspaceId: this.deps.workspaceId,
            sandboxGroupId,
            expectedEpoch: sandbox.leaseEpoch,
            instanceId: sandbox.established.instanceId,
          })
        : new Set<string>();
      this.materializationCache = {
        instanceId: sandbox.established.instanceId,
        fileIds,
      };
    }
    if (this.materializationCache.fileIds.has(file.id)) return true;
    await this.deps.runWorkspaceMutation(sandbox, "toolResultStoreMaterialization", async () => {
      const ok = await this.writeDownload(session, download);
      if (!ok) throw new Error("Stored tool result sandbox copy failed");
    });
    this.materializationCache.fileIds.add(file.id);
    const sandboxGroupId = this.deps.getSandboxGroupId();
    if (sandboxGroupId) {
      await markSandboxFileResourcesMaterialized(this.deps.db, {
        accountId: this.deps.accountId,
        workspaceId: this.deps.workspaceId,
        sandboxGroupId,
        expectedEpoch: sandbox.leaseEpoch,
        instanceId: sandbox.established.instanceId,
        fileIds: [file.id],
      });
    }
    return true;
  }

  private async prepareDownload(file: FileAsset): Promise<SandboxFileDownload> {
    const { objectStorage } = this.deps;
    if (!objectStorage) {
      throw new Error("Storing a large tool result requires configured object storage");
    }
    const settings = this.deps.getModelRunSettings();
    const downloadStorage = objectStorageForSandboxDownloads(
      settings,
      objectStorage,
      this.deps.getSandboxFileDownloadBackend(),
    );
    const signed = await downloadStorage.createGetUrl({ key: file.objectKey });
    return {
      fileId: file.id,
      mountPath: TOOL_RESULT_SPILL_MOUNT_PATH,
      filename: file.safeFilename,
      url: signed.url,
      expiresAt: signed.expiresAt,
      sizeBytes: file.sizeBytes,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
    };
  }

  private async writeDownload(session: unknown, download: SandboxFileDownload): Promise<boolean> {
    const publish = this.deps.getPublish();
    const fence = this.deps.toolCancellationFenceRef.current;
    const materialized = await materializeSandboxFileDownloads(
      session as CodemodeTokenWriterSession,
      [download],
      {
        sandboxBackend: this.deps.getSandboxFileDownloadBackend(),
        onRuntimeEvent: async (event) => {
          await publish?.([{ type: event.type, payload: event.payload }], true);
        },
        ...(fence ? { commandRunner: fence.runSandboxCommand.bind(fence) } : {}),
      },
    );
    return materialized.failures.length === 0;
  }
}

/**
 * Deterministic File and upload ids for one result, so a retried store of the
 * same call in the same attempt reuses its File.
 */
export function toolResultStoreIdentity(input: {
  workspaceId: string;
  attemptId: string;
  key: StoredToolResultKey;
}): { fileId: string; uploadId: string } {
  const keyValue =
    input.key.kind === "operation" ? input.key.operationId.toLowerCase() : input.key.callId;
  const digest = createHash("sha256")
    .update("opengeni-tool-result-store-v1\0")
    .update(input.workspaceId)
    .update("\0")
    .update(input.attemptId)
    .update("\0")
    .update(input.key.kind)
    .update("\0")
    .update(keyValue)
    .digest("hex");
  return {
    fileId: uuidFromDigest(digest, 0),
    uploadId: uuidFromDigest(digest, 16),
  };
}

function uuidFromDigest(digest: string, startByte: number): string {
  const bytes = Buffer.from(digest, "hex").subarray(startByte, startByte + 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
