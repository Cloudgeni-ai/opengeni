import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createBoundedImmutableObjectWritePort,
  createBoundedObjectReadPort,
  type ImmutableContentAddressedWriteBackend,
  type VersionedRangeObjectBackend,
} from "@opengeni/storage";
import {
  EditableArtifactGenesisPipeline,
  ProductionEditableArtifactSnapshotVerifier,
  type AuthoritativeEditableArtifactGenesisKernelPort,
  type IsolatedEditableArtifactSnapshotKernelPort,
} from "../../src/domain/editable-artifacts";
import {
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactClientTransactionId,
  editableArtifactId,
  editableArtifactReplicaId,
  editableArtifactRequestHash,
  editableArtifactSnapshotId,
  editableArtifactStateHash,
} from "../../src/domain/editable-artifacts/types";

const scope = Object.freeze({ accountId: "account-one", workspaceId: "workspace-one" });
const artifactId = editableArtifactId("11111111111111111111111111111111");
const snapshotId = editableArtifactSnapshotId("22222222222222222222222222222222");
const stateHash = editableArtifactStateHash(`sha256:${"3".repeat(64)}`);
const actor = Object.freeze({
  kind: "service" as const,
  subjectId: "artifact-creator",
  replicaId: editableArtifactReplicaId("1111111111111111"),
  service: "artifact-creation",
});

describe("trusted editable-artifact genesis pipeline", () => {
  test("kernel creates, storage promotes/read-backs, then the service verifier reconstructs", async () => {
    const bytes = new TextEncoder().encode("canonical empty full-crdt snapshot");
    const fixture = genesisFixture(bytes);
    const candidate = await fixture.pipeline.prepare(prepareInput("spreadsheet"));
    await fixture.verifier.verify({ scope, artifactId, actor, snapshot: candidate });
    expect(candidate).toMatchObject({
      snapshotId,
      byteSize: bytes.byteLength,
      contentHash: digest(bytes),
      coveredHeadSequence: 0,
      coveredCausalFrontier: [],
      stateHash,
      modelSchemaVersion: 1,
      operationProtocolVersion: 1,
      kernelVersion: "native-kernel/1",
      crdtStateVersion: 1,
      verifiedAt: "2026-08-08T10:00:00.000Z",
    });
    expect(fixture.genesisCalls).toBe(1);
    expect(fixture.verifierCalls).toBe(1);
    expect(fixture.commits).toBe(1);
    expect(fixture.reads).toBeGreaterThan(1);
  });

  test("rejects wrong embedded tenant, nonempty frontier, and nonzero coverage before upload", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    for (const override of [
      { scope: { ...scope, workspaceId: "wrong-workspace" } },
      {
        coveredCausalFrontier: editableArtifactCausalFrontier([
          { replicaId: actor.replicaId, counter: 1 },
        ]),
      },
      { coveredHeadSequence: 1 as never },
    ]) {
      const fixture = genesisFixture(bytes, override);
      await expect(fixture.pipeline.prepare(prepareInput("spreadsheet"))).rejects.toBeInstanceOf(
        Error,
      );
      expect(fixture.commits).toBe(0);
    }
  });

  test("post-upload canonical verification prevents a bad candidate from publication", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fixture = genesisFixture(bytes, {}, { wrongVerifierState: true });
    const candidate = await fixture.pipeline.prepare(prepareInput("document"));
    await expect(
      fixture.verifier.verify({ scope, artifactId, actor, snapshot: candidate }),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(fixture.commits).toBe(1);
    expect(fixture.verifierCalls).toBe(1);
  });

  test("caller-only idempotency facts cannot cross the native genesis boundary", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fixture = genesisFixture(bytes);
    const first = await fixture.pipeline.prepare(prepareInput("presentation"));
    const second = await fixture.pipeline.prepare({
      ...prepareInput("presentation"),
      idempotencyKey: editableArtifactClientTransactionId("different-client-key"),
      requestHash: editableArtifactRequestHash(`sha256:${"a".repeat(64)}`),
    } as never);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.stateHash).toBe(first.stateHash);
    expect(second.blobReference).toBe(first.blobReference);
  });
});

function genesisFixture(
  bytes: Uint8Array,
  generatedOverride: Record<string, unknown> = {},
  options: { wrongVerifierState?: boolean } = {},
): {
  pipeline: EditableArtifactGenesisPipeline;
  verifier: ProductionEditableArtifactSnapshotVerifier;
  genesisCalls: number;
  verifierCalls: number;
  commits: number;
  reads: number;
} {
  const objects = new Map<string, Uint8Array>();
  const fixture = {
    genesisCalls: 0,
    verifierCalls: 0,
    commits: 0,
    reads: 0,
    pipeline: undefined as unknown as EditableArtifactGenesisPipeline,
    verifier: undefined as unknown as ProductionEditableArtifactSnapshotVerifier,
  };
  const readBackend: VersionedRangeObjectBackend = {
    async describe(input) {
      const object = objects.get(input.opaqueReference);
      if (!object) return null;
      return {
        byteSize: object.byteLength,
        versionToken: "immutable-v1",
        immutableReference: true,
        contentType: "application/vnd.opengeni.editable-artifact-snapshot",
      };
    },
    async readRange(input) {
      fixture.reads += 1;
      const object = objects.get(input.opaqueReference);
      if (!object) return null;
      return {
        bytes: object.slice(input.start, input.endInclusive + 1),
        versionToken: "immutable-v1",
      };
    },
  };
  const writeBackend: ImmutableContentAddressedWriteBackend = {
    async begin() {
      const staged: Uint8Array[] = [];
      return {
        async write(chunk) {
          staged.push(chunk.slice());
        },
        async commit(input) {
          fixture.commits += 1;
          const reference = `opaque:${input.contentHash}`;
          objects.set(reference, Buffer.concat(staged, input.byteSize));
          return { opaqueReference: reference };
        },
        abort() {},
      };
    },
  };
  const objectsPort = createBoundedObjectReadPort(readBackend);
  const writer = createBoundedImmutableObjectWritePort({
    backend: writeBackend,
    readback: objectsPort,
  });
  const genesisKernel: AuthoritativeEditableArtifactGenesisKernelPort = {
    async createCanonicalEmptySnapshot(input) {
      fixture.genesisCalls += 1;
      const common = {
        scope: input.scope,
        artifactId: input.artifactId,
        modality: input.modality,
        canonicalChunks: {
          async *[Symbol.asyncIterator]() {
            const split = Math.max(1, Math.floor(bytes.byteLength / 2));
            yield bytes.slice(0, split);
            if (split < bytes.byteLength) yield bytes.slice(split);
          },
        },
        canonicalByteSize: bytes.byteLength,
        canonicalContentHash: digest(bytes),
        stateHash,
        coveredHeadSequence: 0,
        modelSchemaVersion: 1,
        kernelVersion: "native-kernel/1",
      } as const;
      return input.modality === "spreadsheet"
        ? ({
            ...common,
            modality: "spreadsheet",
            coveredCausalFrontier: editableArtifactCausalFrontier([]),
            operationProtocolVersion: 1,
            crdtStateVersion: 1,
            ...generatedOverride,
          } as never)
        : ({
            ...common,
            modality: input.modality,
            nativeRevision: 0,
            ...generatedOverride,
          } as never);
    },
  };
  const verificationKernel: IsolatedEditableArtifactSnapshotKernelPort = {
    async verifyAndReconstruct(input) {
      fixture.verifierCalls += 1;
      let received = 0;
      for await (const chunk of input.snapshotChunks) received += chunk.byteLength;
      const common = {
        modality: input.modality,
        canonicalReencodeVerified: true,
        scope: options.wrongVerifierState ? { ...scope, workspaceId: "wrong" } : scope,
        artifactId,
        canonicalByteSize: received,
        canonicalContentHash: digest(bytes),
        coveredHeadSequence: 0,
        stateHash,
        modelSchemaVersion: 1,
        kernelVersion: "native-kernel/1",
      } as const;
      return input.modality === "spreadsheet"
        ? {
            ...common,
            modality: "spreadsheet" as const,
            fullCrdtStateVerified: true as const,
            coveredCausalFrontier: editableArtifactCausalFrontier([]),
            operationProtocolVersion: 1,
            crdtStateVersion: 1,
          }
        : {
            ...common,
            modality: input.modality,
            nativeRevision: 0,
          };
    },
  };
  fixture.verifier = new ProductionEditableArtifactSnapshotVerifier({
    objects: objectsPort,
    kernel: verificationKernel,
  });
  fixture.pipeline = new EditableArtifactGenesisPipeline({
    kernel: genesisKernel,
    objects: writer,
    now: () => new Date("2026-08-08T10:00:00.000Z"),
  });
  return fixture;
}

function prepareInput(modality: "spreadsheet" | "presentation" | "document") {
  return {
    scope,
    artifactId,
    snapshotId,
    modality,
  };
}

function digest(bytes: Uint8Array) {
  return editableArtifactContentHash(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}
