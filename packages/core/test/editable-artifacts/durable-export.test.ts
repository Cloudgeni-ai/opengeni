import { describe, expect, test } from "bun:test";

import {
  EditableArtifactDurableExportError,
  EditableArtifactDurableExportService,
  type EditableArtifactDurableExportIdFactoryPort,
  type EditableArtifactDurableExportStorePort,
  type EditableArtifactMaterializationJob,
  type EditableArtifactPinnedVersion,
} from "../../src/domain/editable-artifacts/durable-export";
import {
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactSnapshotId,
} from "../../src/domain/editable-artifacts/types";
import {
  TestArtifactAuthorization,
  artifactId,
  humanActor,
  initialStateHash,
  scope,
  stableHex,
} from "./fixtures";

const SNAPSHOT_ID = editableArtifactSnapshotId(stableHex(9, 1));
const VERSION_ID = stableHex(9, 2);
const JOB_ID = stableHex(9, 3);
const RESULT_ID = stableHex(9, 4);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;
const NOW = "2026-08-08T12:00:00.000Z";

describe("editable artifact durable export service", () => {
  test("pins the exact compacted head and preserves store idempotency", async () => {
    const authorization = new TestArtifactAuthorization();
    const calls: unknown[] = [];
    const version = pinnedVersion();
    const store = baseStore({
      async pinVersion(input) {
        calls.push(input);
        return { kind: "result", version, replayed: true };
      },
    });
    let compacted = 0;
    const service = new EditableArtifactDurableExportService({
      authorization,
      exactSnapshots: {
        async ensure(input) {
          compacted += 1;
          expect(input).toMatchObject({ scope, artifactId, actor: humanActor });
          return snapshot();
        },
      },
      store,
      ids: ids(),
      profiles: xlsxProfiles(),
      materializationObjects: neverObjects(),
    });

    await expect(
      service.pinVersion({
        scope,
        artifactId,
        actor: humanActor,
        idempotencyKey: "pin-forecast-1",
        name: "Forecast v1",
      }),
    ).resolves.toEqual({ version, replayed: true });
    expect(compacted).toBe(1);
    expect(authorization.calls.map((call) => call.permission)).toEqual(["export"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      snapshot: { snapshotId: SNAPSHOT_ID, coveredHeadSequence: 7 },
      expectedAuthorizationRevision: 1,
      idempotencyKey: "pin-forecast-1",
      name: "Forecast v1",
    });
  });

  test("enqueues only a server-owned supported profile from an immutable version", async () => {
    const version = pinnedVersion();
    const job = pendingJob();
    let enqueues = 0;
    const service = new EditableArtifactDurableExportService({
      authorization: new TestArtifactAuthorization(),
      exactSnapshots: {
        async ensure() {
          return snapshot();
        },
      },
      store: baseStore({
        async readVersion() {
          return { kind: "result", version };
        },
        async enqueueMaterialization(input) {
          enqueues += 1;
          expect(input).toMatchObject({
            versionId: VERSION_ID,
            profile: {
              modality: "spreadsheet",
              format: "xlsx",
              codecId: "opengeni.xlsx",
              normalizedOptions: "{}",
            },
          });
          return { kind: "result", job, replayed: false };
        },
      }),
      ids: ids(),
      profiles: xlsxProfiles(),
      materializationObjects: neverObjects(),
    });

    await expect(
      service.enqueueMaterialization({
        scope,
        artifactId,
        actor: humanActor,
        idempotencyKey: "xlsx-forecast-1",
        versionId: VERSION_ID,
        format: "xlsx",
      }),
    ).resolves.toEqual({ job, replayed: false });
    expect(enqueues).toBe(1);

    await expect(
      service.enqueueMaterialization({
        scope,
        artifactId,
        actor: humanActor,
        idempotencyKey: "pdf-forecast-1",
        versionId: VERSION_ID,
        format: "pdf",
      }),
    ).rejects.toMatchObject<EditableArtifactDurableExportError>({
      code: "unsupported_format",
    });
    expect(enqueues).toBe(1);
  });

  test("opens only a succeeded bounded result and exposes no storage reference", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    let closed = 0;
    const service = new EditableArtifactDurableExportService({
      authorization: new TestArtifactAuthorization(),
      exactSnapshots: {
        async ensure() {
          return snapshot();
        },
      },
      store: baseStore({
        async readMaterializationDownload() {
          return {
            kind: "result",
            job: succeededJob(bytes.byteLength),
            objectReference: "private/materialization/object",
          };
        },
      }),
      ids: ids(),
      profiles: xlsxProfiles(),
      materializationObjects: {
        async open(input) {
          expect(input).toEqual({
            opaqueReference: "private/materialization/object",
            maxBytes: 512 * 1024 * 1024,
            expectedByteSize: bytes.byteLength,
          });
          return {
            byteSize: bytes.byteLength,
            contentType: XLSX_MIME,
            async *chunks() {
              yield bytes;
            },
            async assertUnchanged() {},
            async close() {
              closed += 1;
            },
          };
        },
      },
    });

    const download = await service.openMaterializationDownload({
      scope,
      artifactId,
      actor: humanActor,
      jobId: JOB_ID,
    });
    expect(download).toMatchObject({
      artifactId,
      jobId: JOB_ID,
      format: "xlsx",
      byteSize: 3,
      mimeType: XLSX_MIME,
    });
    expect("objectReference" in download).toBe(false);
    const chunks: Uint8Array[] = [];
    for await (const chunk of download.chunks()) chunks.push(chunk);
    expect(chunks).toEqual([bytes]);
    await download.assertUnchanged();
    await download.close();
    expect(closed).toBe(1);
  });
});

function snapshot() {
  return Object.freeze({
    scope,
    artifactId,
    modality: "spreadsheet" as const,
    snapshotId: SNAPSHOT_ID,
    blobReference: "private/snapshot/object",
    byteSize: 123,
    contentHash: editableArtifactContentHash(`sha256:${"2".repeat(64)}`),
    mimeType: "application/vnd.opengeni.editable-artifact-snapshot" as const,
    coveredHeadSequence: 7,
    coveredCausalFrontier: editableArtifactCausalFrontier([
      { replicaId: humanActor.replicaId, counter: 7 },
    ]),
    stateHash: initialStateHash,
    modelSchemaVersion: 1,
    operationProtocolVersion: 1,
    kernelVersion: "artifact-kernel/test",
    crdtStateVersion: 1,
    verifiedAt: NOW,
    publishedAt: NOW,
  });
}

function pinnedVersion(): EditableArtifactPinnedVersion {
  return Object.freeze({
    scope,
    artifactId,
    id: VERSION_ID,
    modality: "spreadsheet",
    snapshotId: SNAPSHOT_ID,
    headSequence: 7,
    causalFrontier: snapshot().coveredCausalFrontier,
    nativeRevision: null,
    stateHash: initialStateHash,
    name: "Forecast v1",
    pinned: true,
    createdBySubjectId: humanActor.subjectId,
    createdAt: NOW,
  });
}

function pendingJob(): EditableArtifactMaterializationJob {
  return Object.freeze({
    scope,
    artifactId,
    id: JOB_ID,
    versionId: VERSION_ID,
    inputSnapshotId: SNAPSHOT_ID,
    targetHeadSequence: 7,
    stateHash: initialStateHash,
    format: "xlsx",
    state: "pending",
    attemptCount: 0,
    errorCode: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    result: null,
  });
}

function succeededJob(byteSize: number): EditableArtifactMaterializationJob {
  return Object.freeze({
    ...pendingJob(),
    state: "succeeded",
    attemptCount: 1,
    startedAt: NOW,
    completedAt: NOW,
    result: Object.freeze({
      id: RESULT_ID,
      byteSize,
      contentHash: editableArtifactContentHash(`sha256:${"3".repeat(64)}`),
      mimeType: XLSX_MIME,
      verifiedAt: NOW,
      createdAt: NOW,
    }),
  });
}

function ids(): EditableArtifactDurableExportIdFactoryPort {
  const values = [stableHex(9, 5), VERSION_ID, stableHex(9, 6), JOB_ID];
  return { next: () => values.shift() ?? stableHex(9, 7) };
}

function xlsxProfiles() {
  return {
    async resolve(input: { modality: string; format: string; options: Record<string, unknown> }) {
      if (
        input.modality !== "spreadsheet" ||
        input.format !== "xlsx" ||
        Object.keys(input.options).length > 0
      )
        return null;
      return Object.freeze({
        modality: "spreadsheet" as const,
        format: "xlsx" as const,
        codecId: "opengeni.xlsx",
        codecVersion: "1",
        kernelVersion: "artifact-kernel/test",
        fontRegistryHash: `sha256:${"4".repeat(64)}`,
        policyHash: `sha256:${"5".repeat(64)}`,
        normalizedOptions: "{}",
      });
    },
  };
}

function baseStore(
  overrides: Partial<EditableArtifactDurableExportStorePort> = {},
): EditableArtifactDurableExportStorePort {
  return {
    async pinVersion() {
      throw new Error("unexpected pin");
    },
    async enqueueMaterialization() {
      throw new Error("unexpected enqueue");
    },
    async readVersion() {
      return { kind: "result", version: null };
    },
    async readMaterialization() {
      return { kind: "result", job: null };
    },
    async readMaterializationDownload() {
      return { kind: "result", job: null, objectReference: null };
    },
    ...overrides,
  };
}

function neverObjects() {
  return {
    async open(): Promise<never> {
      throw new Error("unexpected object read");
    },
  };
}
