import {
  getMaterializedSandboxFileResources,
  markSandboxFileResourcesMaterialized,
  requireFile,
} from "@opengeni/db";
import {
  materializeSandboxFileDownloads,
  sandboxRunAs,
  type CodemodeTokenWriterSession,
  type RetainableSessionImageOutputHook,
  type SandboxFileDownload,
  type TurnToolCancellationFence,
} from "@opengeni/runtime";
import type { Settings } from "@opengeni/config";
import type { RetainedArtifactMetadata } from "@opengeni/contracts";
import type { ResumedTurnSandbox } from "../../sandbox-resume";
import type { SharedActivityServices } from "../types";
import {
  assertGeneratedImageHistoryRetained,
  collectGeneratedImageReceipts,
  compactGeneratedImageRunState,
  generatedImagesFromHistory,
  retainGeneratedImage,
  type GeneratedImageOutput,
  type GeneratedImageReceipt,
} from "../generated-images";
import {
  collectRetainedScreenshotReceipts,
  compactRetainedScreenshotRunState,
  materializeRetainedScreenshotHistory,
  retainComputerScreenshot,
  toolOutputContainsInlineImage,
  typedScreenshotFromToolOutput,
  unavailableRetainedSessionImage,
} from "../retained-screenshots";
import { objectStorageForSandboxDownloads } from "./file-resources";
import type { TurnEventPublisher } from "./model-usage";

export type NativeImageGenerationRetention = {
  providerId: string;
  providerBindingHash: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
};

export type TurnMediaArtifactDeps = {
  db: SharedActivityServices["db"];
  objectStorage: SharedActivityServices["objectStorage"];
  observability: SharedActivityServices["observability"];
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  getTurnId: () => string | undefined;
  getModelRunSettings: () => Settings;
  getPublish: () => TurnEventPublisher | null;
  toolCancellationFenceRef: { current: TurnToolCancellationFence | null };
  getResolvedSandbox: () => ResumedTurnSandbox | null;
  getSetupBoxSession: () => unknown;
  getSandboxGroupId: () => string | null;
  runWorkspaceMutation: <T>(
    sandbox: ResumedTurnSandbox,
    operation: string,
    mutation: () => Promise<T>,
  ) => Promise<T>;
};

export class TurnMediaArtifacts {
  readonly retainedScreenshotReceiptsByCallId = new Map<string, RetainedArtifactMetadata>();
  modelCanReceiveRetainedSessionImages = true;
  readonly generatedImageReceiptsByProviderItemId = new Map<string, GeneratedImageReceipt>();
  readonly generatedImageReceiptsCreatedThisTurn = new Map<string, GeneratedImageReceipt>();
  private generatedImageMaterializationCache: {
    instanceId: string;
    fileIds: Set<string>;
  } | null = null;
  sdkOwnedSandboxSession: CodemodeTokenWriterSession | null = null;
  sandboxFileDownloadBackend: Settings["sandboxBackend"];
  nativeImageGenerationRetention: NativeImageGenerationRetention | null = null;
  readonly retainedSessionImageCallIds = new Set<string>();

  constructor(private readonly deps: TurnMediaArtifactDeps) {
    this.sandboxFileDownloadBackend = deps.getModelRunSettings().sandboxBackend;
  }

  rememberGeneratedImageCreatedThisTurn = (receipt: GeneratedImageReceipt): void => {
    this.generatedImageReceiptsCreatedThisTurn.set(receipt.artifact.artifactId, receipt);
  };

  private prepareGeneratedImageDownload = async (receipt: GeneratedImageReceipt) => {
    const { db, objectStorage } = this.deps;
    if (!objectStorage) {
      throw new Error("Generated image sandbox materialization requires object storage");
    }
    const file = await requireFile(db, this.deps.workspaceId, receipt.artifact.artifactId);
    const downloadStorage = objectStorageForSandboxDownloads(
      this.deps.getModelRunSettings(),
      objectStorage,
      this.sandboxFileDownloadBackend,
    );
    const signed = await downloadStorage.createGetUrl({
      key: file.objectKey,
    });
    return {
      file,
      download: {
        fileId: file.id,
        mountPath: "generated-images",
        filename: file.safeFilename,
        url: signed.url,
        expiresAt: signed.expiresAt,
        sizeBytes: file.sizeBytes,
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
      } satisfies SandboxFileDownload,
    };
  };

  private writeGeneratedImageDownload = async (
    sessionForDownload: CodemodeTokenWriterSession,
    download: SandboxFileDownload,
  ): Promise<void> => {
    const runAs = sandboxRunAs(this.deps.getModelRunSettings());
    const publish = this.deps.getPublish();
    const fence = this.deps.toolCancellationFenceRef.current;
    const materialized = await materializeSandboxFileDownloads(sessionForDownload, [download], {
      onRuntimeEvent: async (event) => {
        await publish?.([{ type: event.type, payload: event.payload }], true);
      },
      ...(runAs ? { runAs } : {}),
      ...(fence ? { commandRunner: fence.runSandboxCommand.bind(fence) } : {}),
    });
    if (materialized.failures.length > 0) {
      throw new Error(materialized.failures[0]!.reason);
    }
  };

  private warnGeneratedImageMaterializationDeferred = (error: unknown): void => {
    this.deps.observability.warn("Generated image sandbox materialization deferred", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
      errorCode: "generated_image_materialization_deferred",
      origin: "worker",
    });
  };

  materializeGeneratedImageInSandbox = async (
    receipt: GeneratedImageReceipt,
    sandbox: ResumedTurnSandbox,
    sessionForDownload: unknown,
  ): Promise<boolean> => {
    try {
      const { file, download } = await this.prepareGeneratedImageDownload(receipt);
      if (this.generatedImageMaterializationCache?.instanceId !== sandbox.established.instanceId) {
        const fileIds = this.deps.getSandboxGroupId()
          ? await getMaterializedSandboxFileResources(this.deps.db, {
              accountId: this.deps.accountId,
              workspaceId: this.deps.workspaceId,
              sandboxGroupId: this.deps.getSandboxGroupId()!,
              expectedEpoch: sandbox.leaseEpoch,
              instanceId: sandbox.established.instanceId,
            })
          : new Set<string>();
        this.generatedImageMaterializationCache = {
          instanceId: sandbox.established.instanceId,
          fileIds,
        };
      }
      if (this.generatedImageMaterializationCache.fileIds.has(file.id)) return true;
      await this.deps.runWorkspaceMutation(
        sandbox,
        "generatedImageMaterialization",
        async () =>
          await this.writeGeneratedImageDownload(
            sessionForDownload as CodemodeTokenWriterSession,
            download,
          ),
      );
      this.generatedImageMaterializationCache.fileIds.add(file.id);
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
    } catch (error) {
      this.warnGeneratedImageMaterializationDeferred(error);
      return false;
    }
  };

  materializeGeneratedImageInOwnedSdkSession = async (
    receipt: GeneratedImageReceipt,
    sessionForDownload: unknown,
  ): Promise<boolean> => {
    try {
      const { download } = await this.prepareGeneratedImageDownload(receipt);
      await this.writeGeneratedImageDownload(
        sessionForDownload as CodemodeTokenWriterSession,
        download,
      );
      return true;
    } catch (error) {
      this.warnGeneratedImageMaterializationDeferred(error);
      return false;
    }
  };

  materializeGeneratedImage = async (receipt: GeneratedImageReceipt): Promise<boolean> => {
    if (this.sandboxFileDownloadBackend === "none") return false;
    const resolvedSandbox = this.deps.getResolvedSandbox();
    const setupBoxSession = this.deps.getSetupBoxSession();
    if (resolvedSandbox && setupBoxSession) {
      return await this.materializeGeneratedImageInSandbox(
        receipt,
        resolvedSandbox,
        setupBoxSession,
      );
    }
    if (this.sdkOwnedSandboxSession) {
      return await this.materializeGeneratedImageInOwnedSdkSession(
        receipt,
        this.sdkOwnedSandboxSession,
      );
    }
    return false;
  };

  retainNativeGeneratedImage = async (
    output: GeneratedImageOutput,
  ): Promise<GeneratedImageReceipt> => {
    if (output.providerItemId) {
      const existing = this.generatedImageReceiptsByProviderItemId.get(output.providerItemId);
      if (existing) return existing;
    }
    const context = this.nativeImageGenerationRetention;
    if (!context || !output.providerItemId) {
      throw new Error("Native generated image arrived without provider retention identity");
    }
    const retained = await retainGeneratedImage({
      db: this.deps.db,
      objectStorage: this.deps.objectStorage,
      accountId: this.deps.accountId,
      workspaceId: this.deps.workspaceId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      attemptId: context.attemptId,
      sourceStrategy: "native_hosted",
      providerId: context.providerId,
      providerBindingHash: context.providerBindingHash,
      output,
    });
    this.generatedImageReceiptsByProviderItemId.set(output.providerItemId, retained.receipt);
    this.rememberGeneratedImageCreatedThisTurn(retained.receipt);
    await this.materializeGeneratedImage(retained.receipt);
    return retained.receipt;
  };

  retainNativeGeneratedImagesFromHistory = async (
    history: Array<Record<string, unknown>>,
  ): Promise<void> => {
    collectGeneratedImageReceipts(history, this.generatedImageReceiptsByProviderItemId);
    for (const output of generatedImagesFromHistory(
      history,
      this.generatedImageReceiptsByProviderItemId,
    )) {
      if (
        !output.providerItemId ||
        this.generatedImageReceiptsByProviderItemId.has(output.providerItemId)
      ) {
        continue;
      }
      await this.retainNativeGeneratedImage(output);
    }
    assertGeneratedImageHistoryRetained(history, this.generatedImageReceiptsByProviderItemId);
  };

  compactMediaRunState = (serialized: string): string =>
    compactGeneratedImageRunState(
      compactRetainedScreenshotRunState(serialized, this.retainedScreenshotReceiptsByCallId),
      this.generatedImageReceiptsByProviderItemId,
    );

  retainSessionImageAtToolBoundary: RetainableSessionImageOutputHook = async ({
    toolCallId,
    output,
  }) => {
    const activeTurnId = this.deps.getTurnId();
    if (!activeTurnId) {
      throw new Error("Session image tool completed before turn initialization");
    }
    const typedScreenshot = typedScreenshotFromToolOutput({
      callId: toolCallId,
      output,
    });
    this.retainedSessionImageCallIds.add(toolCallId);
    if (!typedScreenshot) {
      if (toolOutputContainsInlineImage(output)) {
        this.retainedScreenshotReceiptsByCallId.set(
          toolCallId,
          unavailableRetainedSessionImage({
            sessionId: this.deps.sessionId,
            turnId: activeTurnId,
            attemptId: this.deps.attemptId,
            toolCallId,
            toolOutputId: toolCallId,
            reason: "unsupported",
          }),
        );
      }
      return;
    }
    this.retainedScreenshotReceiptsByCallId.set(
      toolCallId,
      unavailableRetainedSessionImage({
        sessionId: this.deps.sessionId,
        turnId: activeTurnId,
        attemptId: this.deps.attemptId,
        toolCallId,
        toolOutputId: toolCallId,
        reason: "pending",
      }),
    );
    this.retainedScreenshotReceiptsByCallId.set(
      toolCallId,
      await retainComputerScreenshot({
        db: this.deps.db,
        objectStorage: this.deps.objectStorage,
        accountId: this.deps.accountId,
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.sessionId,
        turnId: activeTurnId,
        attemptId: this.deps.attemptId,
        output: typedScreenshot,
      }),
    );
  };

  materializeScreenshotHistory = async (history: Array<Record<string, unknown>>) => {
    collectRetainedScreenshotReceipts(history, this.retainedScreenshotReceiptsByCallId);
    if (!this.modelCanReceiveRetainedSessionImages) return history;
    return await materializeRetainedScreenshotHistory({
      db: this.deps.db,
      objectStorage: this.deps.objectStorage,
      workspaceId: this.deps.workspaceId,
      sessionId: this.deps.sessionId,
      history,
    });
  };
}

export function createTurnMediaArtifacts(deps: TurnMediaArtifactDeps): TurnMediaArtifacts {
  return new TurnMediaArtifacts(deps);
}
