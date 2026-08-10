import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { BoundedImmutableObjectWritePort } from "@opengeni/storage";

import {
  EditableArtifactCompactionPipeline,
  type AuthoritativeEditableArtifactCompactionKernelPort,
} from "../../src/domain/editable-artifacts/snapshot-compaction";
import type { EditableArtifactKernelState } from "../../src/domain/editable-artifacts/ports";
import {
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactSnapshotId,
  editableArtifactStateHash,
} from "../../src/domain/editable-artifacts/types";
import { artifactId, initialStateHash, scope, stableHex } from "./fixtures";

describe("trusted editable artifact compaction pipeline", () => {
  test("uploads canonical exact-head bytes and returns immutable publication metadata", async () => {
    const bytes = new TextEncoder().encode("canonical compacted snapshot");
    const contentHash = editableArtifactContentHash(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
    const state = spreadsheetState();
    let writes = 0;
    const objects: BoundedImmutableObjectWritePort = {
      async write(input) {
        writes += 1;
        expect(input.expectedByteSize).toBe(bytes.byteLength);
        expect(input.expectedContentHash).toBe(contentHash);
        const chunks: Uint8Array[] = [];
        for await (const chunk of input.chunks) chunks.push(chunk.slice());
        expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
        return Object.freeze({
          opaqueReference: "objects/sha256/canonical-compaction",
          byteSize: bytes.byteLength,
          contentHash,
          contentType: input.contentType,
        });
      },
    };
    const kernel: AuthoritativeEditableArtifactCompactionKernelPort = {
      async createCanonicalSnapshot(input) {
        expect(input.state).toBe(state);
        return Object.freeze({
          scope,
          artifactId,
          modality: "spreadsheet" as const,
          canonicalChunks: (async function* () {
            yield bytes.slice();
          })(),
          canonicalByteSize: bytes.byteLength,
          canonicalContentHash: contentHash,
          stateHash: state.artifact.stateHash,
          coveredHeadSequence: state.artifact.headSequence,
          modelSchemaVersion: 1,
          kernelVersion: "test-kernel/1",
          coveredCausalFrontier: state.artifact.causalFrontier,
          operationProtocolVersion: 1,
          crdtStateVersion: 1,
        });
      },
    };
    const pipeline = new EditableArtifactCompactionPipeline({
      kernel,
      objects,
      now: () => new Date("2026-08-08T12:00:00.000Z"),
    });
    const result = await pipeline.prepare({
      scope,
      artifactId,
      snapshotId: editableArtifactSnapshotId(stableHex(4, 8)),
      state,
    });

    expect(writes).toBe(1);
    expect(result).toMatchObject({
      modality: "spreadsheet",
      coveredHeadSequence: state.artifact.headSequence,
      stateHash: state.artifact.stateHash,
      blobReference: "objects/sha256/canonical-compaction",
      byteSize: bytes.byteLength,
      contentHash,
      verifiedAt: "2026-08-08T12:00:00.000Z",
    });
  });

  test("rejects kernel coverage drift before object publication", async () => {
    const state = spreadsheetState();
    let writes = 0;
    const pipeline = new EditableArtifactCompactionPipeline({
      kernel: {
        async createCanonicalSnapshot() {
          const bytes = Uint8Array.of(1);
          return {
            scope,
            artifactId,
            modality: "spreadsheet" as const,
            canonicalChunks: (async function* () {
              yield bytes;
            })(),
            canonicalByteSize: 1,
            canonicalContentHash: editableArtifactContentHash(
              `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            ),
            stateHash: editableArtifactStateHash(`sha256:${"9".repeat(64)}`),
            coveredHeadSequence: state.artifact.headSequence,
            modelSchemaVersion: 1,
            kernelVersion: "test-kernel/1",
            coveredCausalFrontier: state.artifact.causalFrontier,
            operationProtocolVersion: 1,
            crdtStateVersion: 1,
          };
        },
      },
      objects: {
        async write() {
          writes += 1;
          throw new Error("must not write");
        },
      },
      now: () => new Date("2026-08-08T12:00:00.000Z"),
    });
    await expect(
      pipeline.prepare({
        scope,
        artifactId,
        snapshotId: editableArtifactSnapshotId(stableHex(4, 9)),
        state,
      }),
    ).rejects.toMatchObject({ code: "coverage_mismatch" });
    expect(writes).toBe(0);
  });
});

function spreadsheetState(): Extract<EditableArtifactKernelState, { modality: "spreadsheet" }> {
  return Object.freeze({
    modality: "spreadsheet" as const,
    artifact: Object.freeze({
      scope,
      id: artifactId,
      modality: "spreadsheet" as const,
      title: "Compaction test",
      lifecycle: "active" as const,
      authorizationRevision: 1,
      headSequence: 0,
      causalFrontier: editableArtifactCausalFrontier([]),
      stateHash: initialStateHash,
      currentSnapshotId: editableArtifactSnapshotId(stableHex(4, 1)),
      createdAt: "2026-08-08T09:00:00.000Z",
      updatedAt: "2026-08-08T10:00:00.000Z",
    }),
    snapshot: Object.freeze({
      scope,
      artifactId,
      modality: "spreadsheet" as const,
      snapshotId: editableArtifactSnapshotId(stableHex(4, 1)),
      blobReference: "objects/source-snapshot",
      byteSize: 16,
      contentHash: editableArtifactContentHash(`sha256:${"1".repeat(64)}`),
      mimeType: "application/vnd.opengeni.editable-artifact-snapshot" as const,
      coveredHeadSequence: 0,
      coveredCausalFrontier: editableArtifactCausalFrontier([]),
      stateHash: initialStateHash,
      modelSchemaVersion: 1,
      operationProtocolVersion: 1,
      kernelVersion: "test-kernel/1",
      crdtStateVersion: 1,
      verifiedAt: "2026-08-08T08:59:00.000Z",
      publishedAt: "2026-08-08T09:00:00.000Z",
    }),
    tailTransactionCount: 0,
    tailByteSize: 0,
    committedTransactionTail: Object.freeze([]),
  });
}
