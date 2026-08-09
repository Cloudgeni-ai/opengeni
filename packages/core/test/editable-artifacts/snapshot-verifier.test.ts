import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createBoundedObjectReadPort, type VersionedRangeObjectBackend } from "@opengeni/storage";
import {
  EditableArtifactSnapshotVerificationError,
  ProductionEditableArtifactSnapshotVerifier,
  editableArtifactMaterializationKey,
  type EditableArtifactSnapshotReplayPlan,
  type IsolatedEditableArtifactSnapshotKernelPort,
  type IsolatedEditableArtifactSnapshotKernelResult,
} from "../../src/domain/editable-artifacts";
import {
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactId,
  editableArtifactReplicaId,
  editableArtifactSnapshotId,
  editableArtifactStateHash,
  type PublishEditableArtifactSnapshotRequest,
} from "../../src/domain/editable-artifacts/types";

const scope = Object.freeze({
  accountId: "account-one",
  workspaceId: "workspace-one",
});
const artifactId = editableArtifactId("11111111111111111111111111111111");
const replicaId = editableArtifactReplicaId("1111111111111111");
const frontier = editableArtifactCausalFrontier([{ replicaId, counter: 4 }]);
const stateHash = editableArtifactStateHash(`sha256:${"2".repeat(64)}`);
const actor = Object.freeze({
  kind: "service" as const,
  subjectId: "snapshot-worker",
  replicaId,
  service: "artifact-snapshotter",
});

describe("production editable-artifact snapshot verifier", () => {
  test("streams, hashes, reconstructs full CRDT state, and read-back revalidates", async () => {
    const bytes = new TextEncoder().encode("canonical full crdt snapshot");
    const snapshot = snapshotRequest(bytes);
    const object = memoryObject(bytes);
    const kernel = kernelFixture(snapshot);
    const verifier = verifierFixture(object.backend, kernel.port, {
      snapshotChunkBytes: 5,
    });

    await verifier.verify({ scope, artifactId, actor, snapshot });

    expect(kernel.chunks).toEqual([5, 5, 5, 5, 5, 3]);
    expect(kernel.receivedBytes).toBe(bytes.byteLength);
    expect(object.describeCalls).toBe(2);
    expect(object.closed).toBe(1);
  });

  test("rejects corrupt content independently of the kernel", async () => {
    const expected = new TextEncoder().encode("expected snapshot");
    const corrupt = new TextEncoder().encode("corrupt! snapshot");
    expect(corrupt.byteLength).toBe(expected.byteLength);
    const snapshot = snapshotRequest(expected);
    const object = memoryObject(corrupt);
    const kernel = kernelFixture(snapshot);
    const verifier = verifierFixture(object.backend, kernel.port);

    await expect(verifier.verify({ scope, artifactId, actor, snapshot })).rejects.toMatchObject({
      code: "content_hash_mismatch",
    });
    expect(object.closed).toBe(1);
  });

  test("rejects truncated objects and closes the range handle", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const snapshot = snapshotRequest(bytes);
    const object = memoryObject(bytes, { truncateRanges: true });
    const verifier = verifierFixture(object.backend, kernelFixture(snapshot).port, {
      snapshotChunkBytes: 2,
    });
    await expect(verifier.verify({ scope, artifactId, actor, snapshot })).rejects.toMatchObject({
      code: "truncated",
    });
    expect(object.closed).toBe(1);
  });

  test("rejects wrong tenant and artifact identities embedded by the kernel", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const snapshot = snapshotRequest(bytes);
    for (const override of [
      { scope: { ...scope, workspaceId: "workspace-other" } },
      { artifactId: editableArtifactId("22222222222222222222222222222222") },
    ]) {
      const object = memoryObject(bytes);
      const kernel = kernelFixture(snapshot, override);
      await expect(
        verifierFixture(object.backend, kernel.port).verify({
          scope,
          artifactId,
          actor,
          snapshot,
        }),
      ).rejects.toMatchObject({ code: "identity_mismatch" });
    }
  });

  test("rejects wrong coverage, frontier, state, and every semantic version", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const snapshot = snapshotRequest(bytes);
    const cases: Array<{
      expectedCode: string;
      override: Partial<IsolatedEditableArtifactSnapshotKernelResult>;
    }> = [
      {
        expectedCode: "coverage_mismatch",
        override: { coveredHeadSequence: snapshot.coveredHeadSequence + 1 },
      },
      {
        expectedCode: "frontier_mismatch",
        override: { coveredCausalFrontier: editableArtifactCausalFrontier([]) },
      },
      {
        expectedCode: "state_hash_mismatch",
        override: {
          stateHash: editableArtifactStateHash(`sha256:${"3".repeat(64)}`),
        },
      },
      {
        expectedCode: "version_mismatch",
        override: { modelSchemaVersion: 2 },
      },
      {
        expectedCode: "version_mismatch",
        override: { operationProtocolVersion: 2 },
      },
      {
        expectedCode: "version_mismatch",
        override: { kernelVersion: "kernel/other" },
      },
      {
        expectedCode: "version_mismatch",
        override: { crdtStateVersion: 2 },
      },
    ];
    for (const item of cases) {
      const object = memoryObject(bytes);
      await expect(
        verifierFixture(object.backend, kernelFixture(snapshot, item.override).port).verify({
          scope,
          artifactId,
          actor,
          snapshot,
        }),
      ).rejects.toMatchObject({ code: item.expectedCode });
    }
  });

  test("rejects noncanonical re-encoding and an ignored replay tail", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const snapshot = snapshotRequest(bytes);
    const noncanonical = kernelFixture(snapshot, {
      canonicalContentHash: editableArtifactContentHash(`sha256:${"4".repeat(64)}`),
    });
    await expect(
      verifierFixture(memoryObject(bytes).backend, noncanonical.port).verify({
        scope,
        artifactId,
        actor,
        snapshot,
      }),
    ).rejects.toMatchObject({ code: "canonical_mismatch" });

    const replayPlan = validReplayPlan(snapshot);
    const ignoredKernel = kernelFixture(snapshot, {}, { consumeReplay: false });
    await expect(
      verifierFixture(memoryObject(bytes).backend, ignoredKernel.port, {
        replayPlan,
      }).verify({ scope, artifactId, actor, snapshot }),
    ).rejects.toMatchObject({ code: "replay_invalid" });
  });

  test("validates exact contiguous replay bytes through the native adapter", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const snapshot = snapshotRequest(bytes);
    const replayPlan = validReplayPlan(snapshot);
    const kernel = kernelFixture(
      snapshot,
      {
        replayedTarget: {
          headSequence: replayPlan.targetHeadSequence,
          causalFrontier: replayPlan.targetCausalFrontier,
          stateHash: replayPlan.targetStateHash,
        },
      },
      { consumeReplay: true },
    );
    await verifierFixture(memoryObject(bytes).backend, kernel.port, {
      replayPlan,
    }).verify({ scope, artifactId, actor, snapshot });
    expect(kernel.replaySegments).toBe(2);

    const gap = validReplayPlan(snapshot, { secondSequenceStart: 3 });
    await expect(
      verifierFixture(
        memoryObject(bytes).backend,
        kernelFixture(snapshot, {}, { consumeReplay: true }).port,
        { replayPlan: gap },
      ).verify({ scope, artifactId, actor, snapshot }),
    ).rejects.toMatchObject({ code: "replay_invalid" });
  });

  test("detects provider object replacement during the verification window", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const snapshot = snapshotRequest(bytes);
    const object = memoryObject(bytes);
    const kernel = kernelFixture(
      snapshot,
      {},
      {
        afterConsume() {
          object.version = "v2";
        },
      },
    );
    await expect(
      verifierFixture(object.backend, kernel.port).verify({
        scope,
        artifactId,
        actor,
        snapshot,
      }),
    ).rejects.toMatchObject({ code: "object_changed" });
    expect(object.closed).toBe(1);
  });

  test("enforces configured size before any range read", async () => {
    const bytes = new Uint8Array(5);
    const snapshot = snapshotRequest(bytes);
    const object = memoryObject(bytes);
    await expect(
      verifierFixture(object.backend, kernelFixture(snapshot).port, {
        maxSnapshotBytes: 4,
      }).verify({ scope, artifactId, actor, snapshot }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(object.rangeCalls).toBe(0);
  });

  test("cannot configure limits above the browser-compatible product boundary", () => {
    const bytes = new Uint8Array([1]);
    const snapshot = snapshotRequest(bytes);
    expect(() =>
      verifierFixture(memoryObject(bytes).backend, kernelFixture(snapshot).port, {
        maxSnapshotBytes: 64 * 1024 * 1024 + 1,
      }),
    ).toThrow("absolute safety bounds");
  });

  test("cancellation stops reconstruction, cleans up, and scrubs opaque references", async () => {
    const secretReference = "bucket/private/snapshot?signature=secret";
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const snapshot = { ...snapshotRequest(bytes), blobReference: secretReference };
    const object = memoryObject(bytes);
    const controller = new AbortController();
    const port: IsolatedEditableArtifactSnapshotKernelPort = {
      async verifyAndReconstruct(input) {
        for await (const _chunk of input.snapshotChunks) {
          controller.abort();
        }
        throw new Error(`native adapter failed for ${secretReference}`);
      },
    };
    let failure: unknown;
    try {
      await verifierFixture(object.backend, port).verify({
        scope,
        artifactId,
        actor,
        snapshot,
        signal: controller.signal,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EditableArtifactSnapshotVerificationError);
    expect(failure).toMatchObject({ code: "cancelled" });
    expect((failure as Error).message).not.toContain(secretReference);
    expect(object.closed).toBe(1);
  });

  test("scrubs isolated-kernel diagnostics", async () => {
    const bytes = new Uint8Array([1]);
    const snapshot = snapshotRequest(bytes);
    const secret = snapshot.blobReference;
    const port: IsolatedEditableArtifactSnapshotKernelPort = {
      async verifyAndReconstruct(input) {
        for await (const _chunk of input.snapshotChunks) {
          // consume so cleanup semantics match a real subprocess
        }
        throw new Error(`decode failed: ${secret}`);
      },
    };
    let failure: unknown;
    try {
      await verifierFixture(memoryObject(bytes).backend, port).verify({
        scope,
        artifactId,
        actor,
        snapshot,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "kernel_rejected" });
    expect((failure as Error).message).not.toContain(secret);
  });
});

describe("editable artifact materialization key", () => {
  const base = {
    stateHash: `sha256:${"1".repeat(64)}`,
    format: "xlsx",
    optionsHash: `sha256:${"2".repeat(64)}`,
    codecVersion: "xlsx-codec/1",
    kernelVersion: "kernel/1",
    fontRegistryHash: `sha256:${"3".repeat(64)}`,
    policyHash: `sha256:${"4".repeat(64)}`,
  };

  test("is deterministic and includes every documented identity field", () => {
    const key = editableArtifactMaterializationKey(base);
    expect(editableArtifactMaterializationKey({ ...base })).toBe(key);
    for (const [field, value] of [
      ["stateHash", `sha256:${"5".repeat(64)}`],
      ["format", "pdf"],
      ["optionsHash", `sha256:${"6".repeat(64)}`],
      ["codecVersion", "xlsx-codec/2"],
      ["kernelVersion", "kernel/2"],
      ["fontRegistryHash", `sha256:${"7".repeat(64)}`],
      ["policyHash", `sha256:${"8".repeat(64)}`],
    ] as const) {
      expect(editableArtifactMaterializationKey({ ...base, [field]: value })).not.toBe(key);
    }
  });

  test("rejects noncanonical hashes and ambiguous versions", () => {
    expect(() => editableArtifactMaterializationKey({ ...base, optionsHash: "bad" })).toThrow(
      "canonical SHA-256",
    );
    expect(() =>
      editableArtifactMaterializationKey({ ...base, codecVersion: "bad\nversion" }),
    ).toThrow("invalid");
  });
});

function verifierFixture(
  backend: VersionedRangeObjectBackend,
  kernel: IsolatedEditableArtifactSnapshotKernelPort,
  options: {
    maxSnapshotBytes?: number;
    snapshotChunkBytes?: number;
    replayPlan?: EditableArtifactSnapshotReplayPlan;
  } = {},
): ProductionEditableArtifactSnapshotVerifier {
  return new ProductionEditableArtifactSnapshotVerifier({
    objects: createBoundedObjectReadPort(backend),
    kernel,
    ...(options.maxSnapshotBytes === undefined
      ? {}
      : { maxSnapshotBytes: options.maxSnapshotBytes }),
    ...(options.snapshotChunkBytes === undefined
      ? {}
      : { snapshotChunkBytes: options.snapshotChunkBytes }),
    ...(options.replayPlan
      ? {
          replayPlans: {
            async resolve() {
              return options.replayPlan ?? null;
            },
          },
        }
      : {}),
  });
}

function snapshotRequest(bytes: Uint8Array): PublishEditableArtifactSnapshotRequest {
  return Object.freeze({
    modality: "spreadsheet",
    snapshotId: editableArtifactSnapshotId("22222222222222222222222222222222"),
    blobReference: "opaque:snapshot-upload-1",
    byteSize: bytes.byteLength,
    contentHash: digest(bytes),
    mimeType: "application/vnd.opengeni.editable-artifact-snapshot" as const,
    coveredHeadSequence: 4,
    coveredCausalFrontier: frontier,
    stateHash,
    modelSchemaVersion: 1,
    operationProtocolVersion: 1,
    kernelVersion: "kernel/1",
    crdtStateVersion: 1,
    verifiedAt: "2026-08-08T10:00:00.000Z",
  });
}

function kernelFixture(
  snapshot: PublishEditableArtifactSnapshotRequest,
  override: Partial<IsolatedEditableArtifactSnapshotKernelResult> = {},
  options: {
    consumeReplay?: boolean;
    afterConsume?: () => void;
  } = {},
): {
  port: IsolatedEditableArtifactSnapshotKernelPort;
  chunks: number[];
  receivedBytes: number;
  replaySegments: number;
} {
  const fixture = {
    chunks: [] as number[],
    receivedBytes: 0,
    replaySegments: 0,
    port: {} as IsolatedEditableArtifactSnapshotKernelPort,
  };
  fixture.port = {
    async verifyAndReconstruct(input) {
      for await (const chunk of input.snapshotChunks) {
        fixture.chunks.push(chunk.byteLength);
        fixture.receivedBytes += chunk.byteLength;
      }
      if (options.consumeReplay && input.replayPlan) {
        for await (const _segment of input.replayPlan.segments) {
          fixture.replaySegments += 1;
        }
      }
      options.afterConsume?.();
      return {
        modality: "spreadsheet",
        fullCrdtStateVerified: true,
        canonicalReencodeVerified: true,
        scope,
        artifactId,
        canonicalByteSize: snapshot.byteSize,
        canonicalContentHash: snapshot.contentHash,
        coveredHeadSequence: snapshot.coveredHeadSequence,
        coveredCausalFrontier: snapshot.coveredCausalFrontier,
        stateHash: snapshot.stateHash,
        modelSchemaVersion: snapshot.modelSchemaVersion,
        operationProtocolVersion: snapshot.operationProtocolVersion,
        kernelVersion: snapshot.kernelVersion,
        crdtStateVersion: snapshot.crdtStateVersion,
        ...override,
      } as IsolatedEditableArtifactSnapshotKernelResult;
    },
  };
  return fixture;
}

function validReplayPlan(
  snapshot: PublishEditableArtifactSnapshotRequest,
  options: { secondSequenceStart?: number } = {},
): EditableArtifactSnapshotReplayPlan {
  const first = new Uint8Array([1, 2]);
  const second = new Uint8Array([3, 4]);
  const targetCausalFrontier = editableArtifactCausalFrontier([{ replicaId, counter: 6 }]);
  const targetStateHash = editableArtifactStateHash(`sha256:${"9".repeat(64)}`);
  return Object.freeze({
    modality: "spreadsheet",
    baseHeadSequence: snapshot.coveredHeadSequence,
    targetHeadSequence: snapshot.coveredHeadSequence + 2,
    targetCausalFrontier,
    targetStateHash,
    segments: {
      async *[Symbol.asyncIterator]() {
        yield {
          modality: "spreadsheet" as const,
          sequenceStart: snapshot.coveredHeadSequence + 1,
          sequenceEnd: snapshot.coveredHeadSequence + 1,
          operationProtocolVersion: snapshot.operationProtocolVersion,
          contentHash: digest(first),
          bytes: first,
        };
        yield {
          modality: "spreadsheet" as const,
          sequenceStart: options.secondSequenceStart ?? snapshot.coveredHeadSequence + 2,
          sequenceEnd: snapshot.coveredHeadSequence + 2,
          operationProtocolVersion: snapshot.operationProtocolVersion,
          contentHash: digest(second),
          bytes: second,
        };
      },
    },
  });
}

function memoryObject(
  initialBytes: Uint8Array,
  options: { truncateRanges?: boolean } = {},
): {
  backend: VersionedRangeObjectBackend;
  version: string;
  describeCalls: number;
  rangeCalls: number;
  closed: number;
} {
  const fixture = {
    version: "v1",
    describeCalls: 0,
    rangeCalls: 0,
    closed: 0,
    backend: {} as VersionedRangeObjectBackend,
  };
  fixture.backend = {
    async describe() {
      fixture.describeCalls += 1;
      return {
        byteSize: initialBytes.byteLength,
        versionToken: fixture.version,
        immutableReference: true,
        contentType: "application/vnd.opengeni.editable-artifact-snapshot",
      };
    },
    async readRange(input) {
      fixture.rangeCalls += 1;
      const bytes = initialBytes.slice(input.start, input.endInclusive + 1);
      return {
        bytes: options.truncateRanges ? bytes.subarray(0, -1) : bytes,
        versionToken: fixture.version,
      };
    },
    close() {
      fixture.closed += 1;
    },
  };
  return fixture;
}

function digest(bytes: Uint8Array) {
  return editableArtifactContentHash(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}
