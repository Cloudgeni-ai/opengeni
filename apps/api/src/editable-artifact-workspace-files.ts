import { createHash } from "node:crypto";

import {
  type EditableArtifactAgentWorkspaceFilePort,
  type EditableArtifactDurableExportService,
} from "@opengeni/core/editable-artifacts";
import { completeFileUpload, prepareGeneratedWorkspaceFile, type Database } from "@opengeni/db";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";

const UPLOAD_INTENT_TTL_MS = 60 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type EditableArtifactWorkspaceFileAdapterDependencies = Readonly<{
  db: Database;
  objectStorage: ObjectStorage;
  durableExports: EditableArtifactDurableExportService;
  now?: () => Date;
  prepareFile?: typeof prepareGeneratedWorkspaceFile;
  completeFile?: typeof completeFileUpload;
}>;

/**
 * Promotes one immutable materialization into the normal workspace-file domain.
 * The returned file ID is the only artifact export handle exposed to agents.
 */
export class EditableArtifactWorkspaceFileAdapter implements EditableArtifactAgentWorkspaceFilePort {
  private readonly now: () => Date;
  private readonly prepareFile: typeof prepareGeneratedWorkspaceFile;
  private readonly completeFile: typeof completeFileUpload;

  constructor(private readonly dependencies: EditableArtifactWorkspaceFileAdapterDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.prepareFile = dependencies.prepareFile ?? prepareGeneratedWorkspaceFile;
    this.completeFile = dependencies.completeFile ?? completeFileUpload;
  }

  async ensureMaterializationFile(
    input: Parameters<EditableArtifactAgentWorkspaceFilePort["ensureMaterializationFile"]>[0],
  ): ReturnType<EditableArtifactAgentWorkspaceFilePort["ensureMaterializationFile"]> {
    throwIfAborted(input.signal);
    const storage = this.dependencies.objectStorage;
    if (!storage.headObject || !storage.putObjectStreamIfAbsent) {
      throw new Error("Object storage lacks immutable streaming upload support");
    }
    const download = await this.dependencies.durableExports.openMaterializationDownload({
      scope: input.scope,
      actor: input.actor,
      artifactId: input.artifact.id,
      jobId: input.jobId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    try {
      const sha256 = plainSha256(download.contentHash);
      const filename = exportFilename(input.filename, download.format);
      const fileId = deterministicUuid(
        `editable-artifact-export:file:${input.scope.workspaceId}:${input.artifact.id}:${input.versionId}:${input.jobId}`,
      );
      const uploadId = deterministicUuid(
        `editable-artifact-export:upload:${input.scope.workspaceId}:${input.artifact.id}:${input.versionId}:${input.jobId}`,
      );
      const safeFilename = `artifact-${input.artifact.id}-${input.jobId}.${download.format}`;
      const objectKey = `workspaces/${input.scope.workspaceId}/files/${fileId}/artifact-exports/${safeFilename}`;
      const prepared = await this.prepareFile(this.dependencies.db, {
        accountId: input.scope.accountId,
        workspaceId: input.scope.workspaceId,
        fileId,
        uploadId,
        filename,
        safeFilename,
        contentType: download.mimeType,
        sizeBytes: download.byteSize,
        sha256,
        bucket: storage.bucket,
        objectKey,
        expiresAt: new Date(this.now().getTime() + UPLOAD_INTENT_TTL_MS),
      });

      let file = prepared.file;
      if (file.status !== "ready") {
        const existing = await storage.headObject(objectKey);
        if (existing) {
          assertStoredExport(existing, download.byteSize, download.mimeType, sha256);
        } else {
          await storage.putObjectStreamIfAbsent({
            key: objectKey,
            contentType: download.mimeType,
            chunks: download.chunks(input.signal ? { signal: input.signal } : {}),
            byteSize: download.byteSize,
            sha256,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          const stored = await storage.headObject(objectKey);
          assertStoredExport(stored, download.byteSize, download.mimeType, sha256);
        }
        await download.assertUnchanged(input.signal);
        throwIfAborted(input.signal);
        file = await this.completeFile(this.dependencies.db, input.scope.workspaceId, uploadId);
      } else {
        assertStoredExport(
          await storage.headObject(objectKey),
          download.byteSize,
          download.mimeType,
          sha256,
        );
        await download.assertUnchanged(input.signal);
      }
      if (
        file.id !== fileId ||
        file.status !== "ready" ||
        file.filename !== filename ||
        file.contentType !== download.mimeType ||
        file.sizeBytes !== download.byteSize ||
        file.sha256 !== sha256
      ) {
        throw new Error("Generated workspace file differs from its immutable export");
      }

      return Object.freeze({
        fileId: file.id,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        sha256,
        artifactId: input.artifact.id,
        versionId: input.versionId,
        materializationJobId: input.jobId,
        sourceHeadSequence: input.sourceHeadSequence,
        sourceStateHash: input.sourceStateHash,
      });
    } finally {
      await download.close();
    }
  }
}

function assertStoredExport(
  head: ObjectHead | null,
  byteSize: number,
  contentType: string,
  sha256: string,
): void {
  if (
    !head ||
    head.ContentLength !== byteSize ||
    head.ContentType !== contentType ||
    head.Metadata?.sha256 !== sha256 ||
    typeof head.VersionToken !== "string" ||
    head.VersionToken.length < 1
  ) {
    throw new Error("Workspace export object differs from its durable materialization");
  }
}

function exportFilename(value: string, format: string): string {
  const expectedExtension = `.${format}`;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
  const stem = normalized.toLowerCase().endsWith(expectedExtension)
    ? normalized.slice(0, -expectedExtension.length)
    : normalized;
  return `${stem.replace(/[. ]+$/u, "").slice(0, 190) || "artifact"}${expectedExtension}`;
}

function plainSha256(value: string): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(value);
  if (!match) throw new Error("Materialized artifact content hash is invalid");
  return match[1]!;
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_PATTERN.test(value)) throw new Error("Generated workspace file identity is invalid");
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Artifact export aborted");
}
