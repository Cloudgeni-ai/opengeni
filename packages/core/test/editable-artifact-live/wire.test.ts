import { describe, expect, test } from "bun:test";
import {
  EDITABLE_ARTIFACT_INTENT_VERSION,
  hashEditableArtifactMutationIntent,
} from "@opengeni/contracts/editable-artifacts";

import {
  decodeEditableArtifactLiveClientWireFrame,
  editableArtifactId,
  editableArtifactRequestHash,
  editableArtifactReplicaId,
  editableArtifactStateHash,
  encodeEditableArtifactLiveAppliedWireFrame,
  encodeEditableArtifactLiveMutationWireFrame,
  encodeEditableArtifactLiveOpenWireFrame,
  encodeEditableArtifactLiveServerWireFrame,
  inspectEditableArtifactLiveWireEnvelope,
  type EditableArtifactLiveServerFrame,
} from "../../src";

const artifactId = editableArtifactId("00000000000000010000000000000001");
const replicaId = editableArtifactReplicaId("0000000000000001");
const stateHash = editableArtifactStateHash(`sha256:${"1".repeat(64)}`);

describe("editable artifact binary live wire", () => {
  test("round-trips a one-use open frame without putting its token in a URL", () => {
    const encoded = encodeEditableArtifactLiveOpenWireFrame({
      type: "open",
      protocolVersion: 1,
      artifactId,
      token: "t".repeat(43),
      resume: {
        localCursor: 3,
        localStateHash: stateHash,
        localCausalFrontier: [{ replicaId, counter: 3 }],
        requireSnapshot: false,
      },
    });

    expect(decodeEditableArtifactLiveClientWireFrame(encoded)).toEqual({
      type: "open",
      protocolVersion: 1,
      artifactId,
      token: "t".repeat(43),
      resume: {
        localCursor: 3,
        localStateHash: stateHash,
        localCausalFrontier: [{ replicaId, counter: 3 }],
        requireSnapshot: false,
      },
    });
  });

  test("carries exact OGATX bytes and rejects a mismatched request hash", () => {
    const authored = hashEditableArtifactMutationIntent({
      envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
      protocolVersion: 1,
      modelSchemaVersion: 1,
      commandProtocolVersion: 1,
      artifactId,
      clientTransactionId: "client-1",
      replicaId,
      replicaCounter: 1,
      previousLocalTransactionId: null,
      observedHeadSequence: 0,
      causalBase: [],
      selectiveUndoOperationIds: [],
      commandBytes: new Uint8Array([1, 2, 3]),
    });
    const encoded = encodeEditableArtifactLiveMutationWireFrame({
      type: "mutation",
      protocolVersion: 1,
      artifactId,
      streamEpoch: "live_epoch_1",
      requestHash: editableArtifactRequestHash(authored.requestHash),
      intentBytes: authored.bytes,
    });
    const decoded = decodeEditableArtifactLiveClientWireFrame(encoded);
    expect(decoded).toMatchObject({
      type: "mutation",
      artifactId,
      requestHash: authored.requestHash,
    });
    expect(decoded.type === "mutation" && decoded.intentBytes).toEqual(authored.bytes);

    const corrupted = encoded.slice();
    corrupted[corrupted.length - 1] ^= 1;
    expect(() => decodeEditableArtifactLiveClientWireFrame(corrupted)).toThrow(
      "request hash does not match",
    );
  });

  test("rejects trailing bytes, noncanonical metadata, and payload-bearing ACKs", () => {
    const applied = encodeEditableArtifactLiveAppliedWireFrame({
      type: "applied",
      protocolVersion: 1,
      artifactId,
      streamEpoch: "live_epoch_1",
      sequence: 0,
      stateHash,
    });
    const trailing = new Uint8Array(applied.length + 1);
    trailing.set(applied);
    expect(() => decodeEditableArtifactLiveClientWireFrame(trailing)).toThrow("length mismatch");

    const withPayload = applied.slice();
    new DataView(withPayload.buffer).setUint32(16, 1, true);
    const expanded = new Uint8Array(withPayload.length + 1);
    expanded.set(withPayload);
    expect(() => decodeEditableArtifactLiveClientWireFrame(expanded)).toThrow(
      "must not carry a binary payload",
    );

    const envelope = inspectEditableArtifactLiveWireEnvelope(applied);
    expect(envelope.metadata.type).toBe("applied");
  });

  test("sends snapshot and canonical transaction bytes as binary payloads", () => {
    const transactionBytes = new Uint8Array([0x4f, 0x47, 0x41, 0x43, 0x4f, 1, 2, 3]);
    const frame: EditableArtifactLiveServerFrame = {
      type: "transaction",
      protocolVersion: 1,
      artifactId,
      streamEpoch: "live_epoch_1",
      transaction: {
        artifactId,
        transactionId: "00000000000000020000000000000002" as never,
        requestHash: `sha256:${"2".repeat(64)}` as never,
        startSequence: 1,
        endSequence: 1,
        priorStateHash: `sha256:${"3".repeat(64)}` as never,
        stateHash,
        causalFrontier: [{ replicaId, counter: 1 }],
        protocolVersion: 1,
        committedTransactionBytes: transactionBytes,
      },
    };
    const encoded = encodeEditableArtifactLiveServerWireFrame(frame);
    const inspected = inspectEditableArtifactLiveWireEnvelope(encoded);
    expect(inspected.payload).toEqual(transactionBytes);
    expect(inspected.metadata).toMatchObject({
      type: "transaction",
      transaction: { startSequence: 1, endSequence: 1 },
    });
  });
});
