import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  ArtifactOfficeSourceUnsupportedError,
  type PreparedArtifactOfficeImport,
} from "@opengeni/artifact-tool/office-import";
import { EditableArtifactOfficeImportError } from "@opengeni/core/editable-artifacts";
import type { BoundedImmutableObjectWritePort, ObjectStorage } from "@opengeni/storage";

import { EditableArtifactOfficeImportAdapter } from "../src/editable-artifact-office-import";

const FILE_ID = "60000000-0000-4000-8000-000000000006";
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const sourceBytes = Uint8Array.of(1, 2, 3, 4);
const sourceHash = sha256(sourceBytes);
const snapshotBytes = Uint8Array.of(5, 6, 7);
const snapshotHash = sha256(snapshotBytes);

describe("editable artifact Office import adapter", () => {
  test("reads one immutable workspace generation and retains exact source and snapshot bytes", async () => {
    const sourceWrites: Uint8Array[] = [];
    const snapshotWrites: Uint8Array[] = [];
    let prepareCalls = 0;
    const adapter = new EditableArtifactOfficeImportAdapter({
      db: {} as never,
      objectStorage: storage(),
      runtime: runtime(),
      sourceObjects: writer("source-ref", sourceWrites),
      snapshotObjects: writer("snapshot-ref", snapshotWrites),
      readFiles: async () => [file()],
      prepareOffice: async (input) => {
        prepareCalls += 1;
        expect(input.bytes).toEqual(sourceBytes);
        expect(input.expectedRuntimeTarget).toBe("darwin-arm64");
        expect(input.expectedKernelVersion).toBe("kernel/1");
        return prepared();
      },
    });

    const result = await adapter.prepare(request());

    expect(prepareCalls).toBe(1);
    expect(concat(sourceWrites)).toEqual(sourceBytes);
    expect(concat(snapshotWrites)).toEqual(snapshotBytes);
    expect(result).toMatchObject({
      originalImport: {
        fileId: FILE_ID,
        blobReference: "source-ref",
        byteSize: sourceBytes.byteLength,
        contentHash: sourceHash,
      },
      snapshot: {
        blobReference: "snapshot-ref",
        coveredHeadSequence: 0,
        stateHash: `sha256:${"c".repeat(64)}`,
      },
    });
  });

  test("fails before native import when the object generation changes", async () => {
    let heads = 0;
    const objectStorage = storage();
    objectStorage.headFile = async () => ({
      ContentLength: sourceBytes.byteLength,
      ContentType: MIME,
      Metadata: { sha256: sourceHash.slice("sha256:".length) },
      VersionToken: ++heads === 1 ? "generation-1" : "generation-2",
    });
    const adapter = new EditableArtifactOfficeImportAdapter({
      db: {} as never,
      objectStorage,
      runtime: runtime(),
      sourceObjects: writer("unused", []),
      snapshotObjects: writer("unused", []),
      readFiles: async () => [file()],
      prepareOffice: async () => {
        throw new Error("native import must not run");
      },
    });

    await expect(adapter.prepare(request())).rejects.toEqual(
      new EditableArtifactOfficeImportError("source_changed"),
    );
  });

  test("maps only a typed unsupported Office source to user input failure", async () => {
    const adapter = new EditableArtifactOfficeImportAdapter({
      db: {} as never,
      objectStorage: storage(),
      runtime: runtime(),
      sourceObjects: writer("unused", []),
      snapshotObjects: writer("unused", []),
      readFiles: async () => [file()],
      prepareOffice: async () => {
        throw new ArtifactOfficeSourceUnsupportedError(".xlsx", {
          cause: new Error("unsupported relationship"),
        });
      },
    });

    await expect(adapter.prepare(request())).rejects.toEqual(
      new EditableArtifactOfficeImportError("unsupported_content"),
    );
  });

  test("rejects contradictory Office metadata before reading object bytes", async () => {
    let storageReads = 0;
    const objectStorage = storage();
    objectStorage.headFile = async () => {
      storageReads += 1;
      throw new Error("must not read invalid source metadata");
    };
    const adapter = new EditableArtifactOfficeImportAdapter({
      db: {} as never,
      objectStorage,
      runtime: runtime(),
      sourceObjects: writer("unused", []),
      snapshotObjects: writer("unused", []),
      readFiles: async () => [{ ...file(), filename: "forecast.docx" }],
      prepareOffice: async () => {
        throw new Error("native import must not run");
      },
    });

    await expect(adapter.prepare(request())).rejects.toEqual(
      new EditableArtifactOfficeImportError("invalid_source"),
    );
    expect(storageReads).toBe(0);
  });

  for (const condition of [
    "denied ACL evidence",
    "stale or expired ACL evidence",
    "disconnected Drive authority",
    "revoked Drive scope",
    "a denied Drive protector beside an ordinary mapping",
  ]) {
    test(`fails before reading Office bytes for ${condition}`, async () => {
      let storageReads = 0;
      const objectStorage = storage();
      objectStorage.headFile = async () => {
        storageReads += 1;
        throw new Error("unauthorized bytes must not be read");
      };
      const adapter = new EditableArtifactOfficeImportAdapter({
        db: {} as never,
        objectStorage,
        runtime: runtime(),
        sourceObjects: writer("unused", []),
        snapshotObjects: writer("unused", []),
        readFiles: async () => [],
      });

      await expect(adapter.prepare(request())).rejects.toEqual(
        new EditableArtifactOfficeImportError("invalid_source"),
      );
      expect(storageReads).toBe(0);
    });
  }

  test("uses the immutable initiating human for an agent Office import", async () => {
    let observedSubjectId: string | null | undefined;
    const adapter = new EditableArtifactOfficeImportAdapter({
      db: {} as never,
      objectStorage: storage(),
      runtime: runtime(),
      sourceObjects: writer("source-ref", []),
      snapshotObjects: writer("snapshot-ref", []),
      resolveFileAuthoritySubjectId: async () => "user:drive-owner",
      readFiles: async (_db, input) => {
        observedSubjectId = input.subjectId;
        return [file()];
      },
      prepareOffice: async () => prepared(),
    });

    await adapter.prepare({
      ...request(),
      actor: {
        kind: "agent",
        subjectId: "worker:first-party-mcp",
        replicaId: "1111111111111111",
        sessionId: "11111111-1111-4111-8111-111111111111",
        turnId: "22222222-2222-4222-8222-222222222222",
        attemptId: "33333333-3333-4333-8333-333333333333",
        generation: 1,
      } as never,
    });
    expect(observedSubjectId).toBe("user:drive-owner");
  });
});

function request() {
  return {
    scope: { accountId: "account", workspaceId: "workspace" } as never,
    actor: { kind: "human", subjectId: "user:test", replicaId: "1111111111111111" } as never,
    fileId: FILE_ID,
    modality: "spreadsheet" as const,
  };
}

function file() {
  return {
    id: FILE_ID,
    workspaceId: "workspace",
    status: "ready" as const,
    filename: "forecast.xlsx",
    safeFilename: "forecast.xlsx",
    contentType: MIME,
    sizeBytes: sourceBytes.byteLength,
    sha256: sourceHash.slice("sha256:".length),
    bucket: "files",
    objectKey: "workspace/source",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  };
}

function storage(): ObjectStorage {
  return {
    headFile: async () => ({
      ContentLength: sourceBytes.byteLength,
      ContentType: MIME,
      Metadata: { sha256: sourceHash.slice("sha256:".length) },
      VersionToken: "generation-1",
    }),
    getFileRange: async (_file, range) => sourceBytes.slice(range.start, range.end + 1),
  } as ObjectStorage;
}

function writer(reference: string, writes: Uint8Array[]): BoundedImmutableObjectWritePort {
  return {
    async write(input) {
      for await (const chunk of input.chunks) writes.push(Uint8Array.from(chunk));
      return {
        opaqueReference: reference,
        byteSize: input.expectedByteSize!,
        contentHash: input.expectedContentHash!,
        contentType: input.contentType,
      };
    },
  };
}

function runtime() {
  return {
    facade: {},
    location: { target: "darwin-arm64" },
    runtime: { buildIdentity: "kernel/1" },
  } as never;
}

function prepared(): PreparedArtifactOfficeImport {
  return {
    source: {
      filename: "forecast.xlsx",
      byteSize: sourceBytes.byteLength,
      contentHash: sourceHash,
      mimeType: MIME,
    },
    snapshot: {
      modality: "spreadsheet",
      bytes: snapshotBytes,
      byteSize: snapshotBytes.byteLength,
      contentHash: snapshotHash,
      stateHash: `sha256:${"c".repeat(64)}`,
      modelSchemaVersion: 1,
      kernelVersion: "kernel/1",
      coveredCausalFrontier: [],
      operationProtocolVersion: 1,
      crdtStateVersion: 1,
    },
  };
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
