import { createHash } from "node:crypto";
import {
  TOOL_RESULT_SPILL_MEDIA_TYPE,
  TOOL_RESULT_SPILL_MOUNT_PATH,
  toolResultSpillFilename,
  toolResultSpillSandboxPath,
  type AttemptToolResult as AttemptToolResultValue,
  type FileAsset,
  type ToolResultSpilledReceipt,
} from "@opengeni/contracts";
import {
  completeFileUpload,
  getFile,
  getMaterializedSandboxFileResources,
  markSandboxFileResourcesMaterialized,
  prepareGeneratedWorkspaceFile,
  type Database,
} from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import {
  materializeSandboxFileDownloads,
  sandboxRunAs,
  spilledModelToolResult,
  type CodemodeTokenWriterSession,
  type SandboxFileDownload,
  type TurnToolCancellationFence,
} from "@opengeni/runtime";
import type { Settings } from "@opengeni/config";
import { type ObjectStorage } from "@opengeni/storage";
import { objectStorageForSandboxDownloads } from "./file-resources";
import type { ResumedTurnSandbox } from "../../sandbox-resume";

const UPLOAD_INTENT_TTL_MS = 60 * 60_000;

export type ToolResultSpillReceipt = ToolResultSpilledReceipt;

export type ToolResultSpillDeps = {
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

export class ToolResultSpill {
  readonly receiptsCreatedThisTurn = new Map<string, ToolResultSpillReceipt>();
  private materializationCache: { instanceId: string; fileIds: Set<string> } | null = null;

  constructor(private readonly deps: ToolResultSpillDeps) {}

  spill = async (input: {
    operationId: string;
    result: AttemptToolResultValue;
  }): Promise<AttemptToolResultValue> => {
    const { objectStorage } = this.deps;
    if (!objectStorage) {
      throw new Error("Oversized tool-result spill requires configured object storage");
    }
    const bytes = Buffer.from(JSON.stringify(input.result) ?? "null");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const identity = toolResultSpillIdentity({
      workspaceId: this.deps.workspaceId,
      attemptId: this.deps.attemptId,
      operationId: input.operationId,
    });
    const filename = toolResultSpillFilename(input.operationId);
    const intendedSandboxPath = toolResultSpillSandboxPath(filename);
    const objectKey = `workspaces/${this.deps.workspaceId}/files/${identity.fileId}/tool-results/${filename}`;
    const prepared = await prepareGeneratedWorkspaceFile(this.deps.db, {
      accountId: this.deps.accountId,
      workspaceId: this.deps.workspaceId,
      fileId: identity.fileId,
      uploadId: identity.uploadId,
      filename,
      safeFilename: filename,
      contentType: TOOL_RESULT_SPILL_MEDIA_TYPE,
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
          contentType: TOOL_RESULT_SPILL_MEDIA_TYPE,
          body: bytes,
          sha256,
        });
      }
      file = await completeFileUpload(this.deps.db, this.deps.workspaceId, identity.uploadId);
    }
    const materialized = await this.materializeFile(file);
    const receipt: ToolResultSpillReceipt = {
      type: "tool_result_spilled",
      sandboxPath: materialized ? intendedSandboxPath : null,
      fileId: file.id,
      byteSize: file.sizeBytes,
      mediaType: TOOL_RESULT_SPILL_MEDIA_TYPE,
    };
    this.receiptsCreatedThisTurn.set(file.id, {
      ...receipt,
      sandboxPath: intendedSandboxPath,
    });
    return spilledModelToolResult(receipt);
  };

  materializeDeferred = async (): Promise<void> => {
    for (const receipt of this.receiptsCreatedThisTurn.values()) {
      const file = await getFile(this.deps.db, this.deps.workspaceId, receipt.fileId);
      if (file) await this.materializeFile(file);
    }
  };

  private async materializeFile(file: FileAsset): Promise<boolean> {
    if (this.deps.getSandboxFileDownloadBackend() === "none") return false;
    try {
      const sandbox = this.deps.getResolvedSandbox();
      const setupBoxSession = this.deps.getSetupBoxSession();
      if (sandbox && setupBoxSession) {
        return await this.materializeInSandbox(file, sandbox, setupBoxSession);
      }
      const sdkOwned = this.deps.getSdkOwnedSandboxSession();
      if (sdkOwned) {
        return await this.writeDownload(sdkOwned, await this.prepareDownload(file));
      }
      return false;
    } catch (error) {
      this.deps.observability.warn("Tool result spill sandbox materialization deferred", {
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
    await this.deps.runWorkspaceMutation(sandbox, "toolResultSpillMaterialization", async () => {
      const ok = await this.writeDownload(session, download);
      if (!ok) throw new Error("Tool result spill sandbox copy failed");
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
      throw new Error("Oversized tool-result spill requires configured object storage");
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
    const runAs = sandboxRunAs(this.deps.getModelRunSettings());
    const publish = this.deps.getPublish();
    const fence = this.deps.toolCancellationFenceRef.current;
    const materialized = await materializeSandboxFileDownloads(
      session as CodemodeTokenWriterSession,
      [download],
      {
        onRuntimeEvent: async (event) => {
          await publish?.([{ type: event.type, payload: event.payload }], true);
        },
        ...(runAs ? { runAs } : {}),
        ...(fence ? { commandRunner: fence.runSandboxCommand.bind(fence) } : {}),
      },
    );
    return materialized.failures.length === 0;
  }
}

export function toolResultSpillIdentity(input: {
  workspaceId: string;
  attemptId: string;
  operationId: string;
}): { fileId: string; uploadId: string } {
  const digest = createHash("sha256")
    .update("opengeni-tool-result-spill-v1\0")
    .update(input.workspaceId)
    .update("\0")
    .update(input.attemptId)
    .update("\0")
    .update(input.operationId.toLowerCase())
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
