import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ArtifactKernelRuntime } from "@opengeni/artifact-tool/runtime";
import { encodeEditableArtifactCausalFrontier } from "@opengeni/contracts/editable-artifact-causal-frontier";
import {
  editableArtifactContentHash,
  editableArtifactCausalFrontier,
  editableArtifactId,
  editableArtifactScope,
  editableArtifactSnapshotId,
  editableArtifactStateHash,
} from "@opengeni/core";
import type { BoundedObjectReadPort } from "@opengeni/storage";

import { NativeEditableArtifactKernelAdapter } from "../src/editable-artifact-native-kernel";

describe("NativeEditableArtifactKernelAdapter", () => {
  test("reconstructs an exact durable basis into a canonical compaction snapshot", async () => {
    const snapshotBytes = new Uint8Array([3, 1, 4, 1, 5]);
    const stateHash = editableArtifactStateHash(`sha256:${"2".repeat(64)}`);
    const frontierBytes = encodeEditableArtifactCausalFrontier([]);
    const rawSession = {
      authorTransaction() {
        throw new Error("unused");
      },
      applyCommitted() {
        throw new Error("unused");
      },
      query() {
        throw new Error("unused");
      },
      snapshot: () => snapshotBytes.slice(),
      frontier: () => frontierBytes.slice(),
      stateHash: () => stateHash,
      revision: () => 7n,
      fork() {
        throw new Error("unused");
      },
      isClosed: () => false,
      dispose() {},
    };
    const runtime = {
      kind: "native",
      target: "darwin-arm64",
      capabilities: {},
      buildIdentity: "native-kernel-test",
      openCollaborationSession: () => rawSession,
    } as unknown as ArtifactKernelRuntime;
    const objects: BoundedObjectReadPort = {
      async open() {
        return {
          byteSize: snapshotBytes.byteLength,
          contentType: "application/vnd.opengeni.editable-artifact-snapshot",
          chunks: async function* () {
            yield snapshotBytes.slice();
          },
          assertUnchanged: async () => undefined,
          close: async () => undefined,
        };
      },
    };
    const adapter = new NativeEditableArtifactKernelAdapter(runtime, objects);
    const scope = editableArtifactScope({
      accountId: "10000000-0000-4000-8000-000000000001",
      workspaceId: "20000000-0000-4000-8000-000000000002",
    });
    const artifactId = editableArtifactId("1".repeat(32));
    const contentHash = editableArtifactContentHash(
      `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`,
    );
    const snapshotId = editableArtifactSnapshotId("2".repeat(32));
    const result = await adapter.createCanonicalSnapshot({
      state: {
        modality: "spreadsheet",
        artifact: {
          scope,
          id: artifactId,
          modality: "spreadsheet",
          title: "Native compaction",
          lifecycle: "active",
          authorizationRevision: 1,
          headSequence: 9,
          causalFrontier: editableArtifactCausalFrontier([]),
          stateHash,
          currentSnapshotId: snapshotId,
          createdAt: "2026-08-08T10:00:00.000Z",
          updatedAt: "2026-08-08T10:00:00.000Z",
        },
        snapshot: {
          scope,
          artifactId,
          modality: "spreadsheet",
          snapshotId,
          blobReference: "objects/native-compaction-source",
          byteSize: snapshotBytes.byteLength,
          contentHash,
          mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
          coveredHeadSequence: 9,
          coveredCausalFrontier: editableArtifactCausalFrontier([]),
          stateHash,
          modelSchemaVersion: 1,
          operationProtocolVersion: 1,
          kernelVersion: runtime.buildIdentity,
          crdtStateVersion: 1,
          verifiedAt: "2026-08-08T10:00:00.000Z",
          publishedAt: "2026-08-08T10:00:00.000Z",
        },
        tailTransactionCount: 0,
        tailByteSize: 0,
        committedTransactionTail: [],
      },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.canonicalChunks) chunks.push(chunk.slice());
    expect(Buffer.concat(chunks).equals(snapshotBytes)).toBe(true);
    expect(result).toMatchObject({
      modality: "spreadsheet",
      coveredHeadSequence: 9,
      stateHash,
      canonicalContentHash: contentHash,
      coveredCausalFrontier: [],
    });
  });

  test("keeps durable head coverage independent from native spreadsheet revision", async () => {
    const snapshotBytes = new Uint8Array([7, 11, 13, 17]);
    const stateHash = editableArtifactStateHash(`sha256:${"1".repeat(64)}`);
    const frontierBytes = encodeEditableArtifactCausalFrontier([]);
    const rawSession = {
      authorTransaction() {
        throw new Error("unused");
      },
      applyCommitted() {
        throw new Error("unused");
      },
      query() {
        throw new Error("unused");
      },
      snapshot: () => snapshotBytes.slice(),
      frontier: () => frontierBytes.slice(),
      stateHash: () => stateHash,
      revision: () => 4n,
      fork() {
        throw new Error("unused");
      },
      isClosed: () => false,
      dispose() {},
    };
    const runtime = {
      kind: "native",
      target: "darwin-arm64",
      capabilities: {},
      buildIdentity: "native-kernel-test",
      openCollaborationSession: () => rawSession,
    } as unknown as ArtifactKernelRuntime;
    const adapter = new NativeEditableArtifactKernelAdapter(runtime, {} as BoundedObjectReadPort);
    const scope = editableArtifactScope({
      accountId: "10000000-0000-4000-8000-000000000001",
      workspaceId: "20000000-0000-4000-8000-000000000002",
    });
    const artifactId = editableArtifactId("1".repeat(32));
    const verifiedAt = "2026-08-08T12:00:00.000Z";
    const result = await adapter.verifyAndReconstruct({
      scope,
      artifactId,
      modality: "spreadsheet",
      expectedSnapshot: {
        modality: "spreadsheet",
        snapshotId: editableArtifactSnapshotId("2".repeat(32)),
        blobReference: "irrelevant/verified/snapshot",
        byteSize: snapshotBytes.byteLength,
        contentHash: editableArtifactContentHash(
          `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`,
        ),
        mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
        coveredHeadSequence: 9,
        coveredCausalFrontier: editableArtifactCausalFrontier([]),
        stateHash,
        modelSchemaVersion: 1,
        operationProtocolVersion: 1,
        kernelVersion: runtime.buildIdentity,
        crdtStateVersion: 1,
        verifiedAt,
      },
      snapshotChunks: (async function* () {
        yield snapshotBytes.slice();
      })(),
      expectedSnapshotByteSize: snapshotBytes.byteLength,
    });

    expect(result).toMatchObject({
      modality: "spreadsheet",
      coveredHeadSequence: 9,
      stateHash,
      coveredCausalFrontier: [],
    });
    expect(rawSession.revision()).toBe(4n);
  });
});
