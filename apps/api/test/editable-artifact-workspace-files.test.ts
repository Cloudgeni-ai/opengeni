import { describe, expect, test } from "bun:test";
import type { FileAsset } from "@opengeni/contracts";
import type { EditableArtifactAgentWorkspaceFilePort } from "@opengeni/core/editable-artifacts";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";

import { EditableArtifactWorkspaceFileAdapter } from "../src/editable-artifact-workspace-files";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const bytes = new TextEncoder().encode("durable xlsx bytes");
const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("editable artifact workspace export files", () => {
  test("streams once into a deterministic workspace file and replays the ready receipt", async () => {
    const objects = new Map<string, { bytes: Uint8Array; head: ObjectHead }>();
    const storage = objectStorage(objects);
    let preparedFile: FileAsset | null = null;
    let uploads = 0;
    let unchanged = 0;
    let closed = 0;
    const adapter = new EditableArtifactWorkspaceFileAdapter({
      db: {} as never,
      objectStorage: storage,
      durableExports: {
        async openMaterializationDownload() {
          return {
            artifactId: "a".repeat(32),
            jobId: "job-1",
            format: "xlsx" as const,
            byteSize: bytes.byteLength,
            contentHash: `sha256:${sha256}` as never,
            mimeType,
            async *chunks() {
              yield bytes.subarray(0, 4);
              yield bytes.subarray(4);
            },
            async assertUnchanged() {
              unchanged += 1;
            },
            async close() {
              closed += 1;
            },
          };
        },
      } as never,
      now: () => new Date("2026-08-10T10:00:00.000Z"),
      async prepareFile(_db, input) {
        if (!preparedFile) {
          preparedFile = fileAsset(input, "pending_upload");
          return { file: preparedFile, uploadId: input.uploadId, created: true };
        }
        return { file: preparedFile, uploadId: input.uploadId, created: false };
      },
      async completeFile(_db, _workspaceId, _uploadId) {
        preparedFile = { ...preparedFile!, status: "ready" };
        return preparedFile;
      },
    });
    const input = exportInput();

    const first = await adapter.ensureMaterializationFile(input);
    const second = await adapter.ensureMaterializationFile(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      filename: "Quarterly plan.xlsx",
      contentType: mimeType,
      sizeBytes: bytes.byteLength,
      sha256,
      artifactId: "a".repeat(32),
      materializationJobId: "job-1",
    });
    expect(first.fileId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(uploads).toBe(1);
    expect(unchanged).toBe(2);
    expect(closed).toBe(2);

    function objectStorage(objectsByKey: typeof objects): ObjectStorage {
      return {
        bucket: "test-bucket",
        backend: "s3-compatible",
        maxSinglePutSizeBytes: 5_000_000_000,
        async headObject(key) {
          return objectsByKey.get(key)?.head ?? null;
        },
        async putObjectStreamIfAbsent(upload) {
          uploads += 1;
          const chunks: Uint8Array[] = [];
          for await (const chunk of upload.chunks) chunks.push(chunk);
          const body = concat(chunks);
          objectsByKey.set(upload.key, {
            bytes: body,
            head: {
              ContentLength: body.byteLength,
              ContentType: upload.contentType,
              Metadata: { sha256: upload.sha256 },
              VersionToken: "v1",
            },
          });
          return true;
        },
      } as ObjectStorage;
    }
  });

  test("fails closed when an existing deterministic key has different bytes", async () => {
    const storage = objectStorageWithConflict();
    const adapter = new EditableArtifactWorkspaceFileAdapter({
      db: {} as never,
      objectStorage: storage,
      durableExports: {
        async openMaterializationDownload() {
          return {
            artifactId: "a".repeat(32),
            jobId: "job-1",
            format: "xlsx" as const,
            byteSize: bytes.byteLength,
            contentHash: `sha256:${sha256}` as never,
            mimeType,
            async *chunks() {
              yield bytes;
            },
            async assertUnchanged() {},
            async close() {},
          };
        },
      } as never,
      async prepareFile(_db, input) {
        return {
          file: fileAsset(input, "pending_upload"),
          uploadId: input.uploadId,
          created: true,
        };
      },
      async completeFile() {
        throw new Error("must not complete a conflicting object");
      },
    });

    await expect(adapter.ensureMaterializationFile(exportInput())).rejects.toThrow(
      "differs from its durable materialization",
    );
  });
});

function exportInput(): Parameters<
  EditableArtifactAgentWorkspaceFilePort["ensureMaterializationFile"]
>[0] {
  return {
    scope: { accountId, workspaceId } as never,
    actor: {
      kind: "agent",
      subjectId: "worker:test",
      replicaId: "1111111111111111",
      sessionId,
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      generation: 1,
    } as never,
    artifact: {
      id: "a".repeat(32),
      modality: "spreadsheet",
      title: "Quarterly plan",
    } as never,
    versionId: "version-1",
    jobId: "job-1",
    filename: "Quarterly plan.xlsx",
    sourceHeadSequence: 4,
    sourceStateHash: `sha256:${"b".repeat(64)}`,
  };
}

function fileAsset(
  input: {
    workspaceId: string;
    fileId: string;
    filename: string;
    safeFilename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    bucket: string;
    objectKey: string;
  },
  status: FileAsset["status"],
): FileAsset {
  return {
    id: input.fileId,
    workspaceId: input.workspaceId,
    status,
    filename: input.filename,
    safeFilename: input.safeFilename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    bucket: input.bucket,
    objectKey: input.objectKey,
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  };
}

function objectStorageWithConflict(): ObjectStorage {
  return {
    bucket: "test-bucket",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    async headObject() {
      return {
        ContentLength: bytes.byteLength + 1,
        ContentType: mimeType,
        Metadata: { sha256 },
        VersionToken: "wrong",
      };
    },
    async putObjectStreamIfAbsent() {
      throw new Error("must not overwrite an existing object");
    },
  } as ObjectStorage;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
