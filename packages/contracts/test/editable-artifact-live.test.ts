import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/editable-artifact-live-v1.json";
import {
  decodeEditableArtifactLiveClientWireFrame,
  decodeEditableArtifactLiveServerWireFrame,
  encodeEditableArtifactLiveAppliedWireFrame,
  encodeEditableArtifactLiveOpenWireFrame,
  encodeEditableArtifactLiveServerWireFrame,
} from "../src/editable-artifact-live";

describe("OGALV001 shared live wire", () => {
  test("matches fixed client and server byte vectors exactly", () => {
    const open = encodeEditableArtifactLiveOpenWireFrame({
      type: "open",
      protocolVersion: 1,
      artifactId: fixture.artifactId,
      token: "fixture_ticket",
      resume: {
        localCursor: 3,
        localStateHash: fixture.stateHash,
        localCausalFrontier: [{ replicaId: fixture.replicaId, counter: 3 }],
        requireSnapshot: false,
      },
    });
    const applied = encodeEditableArtifactLiveAppliedWireFrame({
      type: "applied",
      protocolVersion: 1,
      artifactId: fixture.artifactId,
      streamEpoch: fixture.streamEpoch,
      sequence: 3,
      stateHash: fixture.stateHash,
    });
    const watermark = encodeEditableArtifactLiveServerWireFrame({
      type: "watermark",
      protocolVersion: 1,
      artifactId: fixture.artifactId,
      streamEpoch: fixture.streamEpoch,
      headSequence: 4,
    });
    expect(hex(open)).toBe(fixture.openHex);
    expect(hex(applied)).toBe(fixture.appliedHex);
    expect(hex(watermark)).toBe(fixture.watermarkHex);
    expect(decodeEditableArtifactLiveClientWireFrame(fromHex(fixture.openHex))).toMatchObject({
      type: "open",
      artifactId: fixture.artifactId,
      resume: { localCursor: 3 },
    });
    expect(decodeEditableArtifactLiveServerWireFrame(fromHex(fixture.watermarkHex))).toEqual({
      type: "watermark",
      protocolVersion: 1,
      artifactId: fixture.artifactId,
      streamEpoch: fixture.streamEpoch,
      headSequence: 4,
    });
  });

  test("strictly round-trips every metadata-only server frame", () => {
    const base = {
      protocolVersion: 1,
      artifactId: fixture.artifactId,
      streamEpoch: fixture.streamEpoch,
    } as const;
    const frames = [
      {
        type: "open",
        ...base,
        writable: true,
        headSequence: 4,
        minimumReplaySequence: 1,
        maxClientFrameBytes: 8_454_144,
        maxCommandBytes: 4_194_304,
        maxIntentBytes: 5_242_880,
        maxCommittedTransactionBytes: 8_388_608,
        maxSnapshotBytes: 67_108_864,
        maxInFlightTransactions: 256,
        maxInFlightBytes: 33_554_432,
      },
      { type: "barrier", ...base, sequence: 4, stateHash: fixture.stateHash },
      { type: "watermark", ...base, headSequence: 4 },
      { type: "applied", ...base, sequence: 4, stateHash: fixture.stateHash },
      { type: "authorizationChanged", ...base, writable: false },
      { type: "resyncRequired", ...base, reason: "retention_gap", headSequence: 4 },
      {
        type: "mutationAccepted",
        ...base,
        requestHash: fixture.stateHash,
        clientTransactionId: "fixture.1",
        transactionId: "20000000000000000000000000000002",
        startSequence: 4,
        endSequence: 4,
        stateHash: fixture.stateHash,
      },
      {
        type: "mutationRejected",
        ...base,
        requestHash: fixture.stateHash,
        code: "conflict",
        retryable: true,
      },
    ] as const;
    for (const frame of frames) {
      expect(
        decodeEditableArtifactLiveServerWireFrame(encodeEditableArtifactLiveServerWireFrame(frame)),
      ).toEqual(frame);
    }
  });

  test("round-trips explicit serialized modality, native revisions, and exact OGAST bytes", () => {
    const open = {
      type: "open" as const,
      protocolVersion: 1,
      artifactId: fixture.artifactId,
      token: "fixture_ticket",
      resume: {
        modality: "document" as const,
        localCursor: 3,
        localStateHash: fixture.stateHash,
        localNativeRevision: 3,
        requireSnapshot: false,
      },
    };
    expect(
      decodeEditableArtifactLiveClientWireFrame(encodeEditableArtifactLiveOpenWireFrame(open)),
    ).toEqual(open);

    const base = {
      protocolVersion: 1,
      artifactId: fixture.artifactId,
      streamEpoch: fixture.streamEpoch,
    } as const;
    const serializedOpen = {
      type: "open" as const,
      ...base,
      modality: "document" as const,
      writable: true,
      headSequence: 4,
      minimumReplaySequence: 1,
      maxClientFrameBytes: 8_454_144,
      maxCommandBytes: 4_194_304,
      maxIntentBytes: 5_242_880,
      maxCommittedTransactionBytes: 8_388_608,
      maxSnapshotBytes: 67_108_864,
      maxInFlightTransactions: 256,
      maxInFlightBytes: 33_554_432,
    };
    expect(
      decodeEditableArtifactLiveServerWireFrame(
        encodeEditableArtifactLiveServerWireFrame(serializedOpen),
      ),
    ).toEqual(serializedOpen);

    const snapshotBytes = new Uint8Array([7, 8, 9]);
    const snapshot = {
      type: "snapshot" as const,
      ...base,
      modality: "presentation" as const,
      sequence: 4,
      stateHash: fixture.stateHash,
      nativeRevision: 4,
      digest: fixture.stateHash,
      kernelVersion: "fixture-kernel-1",
      modelSchemaVersion: 1,
      offset: 0,
      totalBytes: snapshotBytes.byteLength,
      final: true,
      bytes: snapshotBytes,
    };
    expect(
      decodeEditableArtifactLiveServerWireFrame(
        encodeEditableArtifactLiveServerWireFrame(snapshot),
      ),
    ).toEqual(snapshot);

    const ogastBytes = new TextEncoder().encode("OGAST001-exact-fixture");
    const transaction = {
      type: "transaction" as const,
      ...base,
      transaction: {
        artifactId: fixture.artifactId,
        modality: "document" as const,
        transactionId: "20000000000000000000000000000002",
        requestHash: fixture.stateHash,
        startSequence: 4,
        endSequence: 4,
        priorStateHash: `sha256:${"0".repeat(64)}`,
        stateHash: fixture.stateHash,
        priorNativeRevision: 3,
        nativeRevision: 4,
        commitProtocolVersion: 1,
        committedTransactionBytes: ogastBytes,
      },
    };
    expect(
      decodeEditableArtifactLiveServerWireFrame(
        encodeEditableArtifactLiveServerWireFrame(transaction),
      ),
    ).toEqual(transaction);
  });

  test("canonicalizes spreadsheet snapshot metadata with its frontier in wire order", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const encoded = encodeEditableArtifactLiveServerWireFrame({
      type: "snapshot",
      protocolVersion: 1,
      artifactId: fixture.artifactId,
      streamEpoch: fixture.streamEpoch,
      modality: "spreadsheet",
      sequence: 4,
      stateHash: fixture.stateHash,
      causalFrontier: [{ replicaId: fixture.replicaId, counter: 4 }],
      digest: fixture.stateHash,
      kernelVersion: "fixture-kernel-1",
      modelSchemaVersion: 1,
      offset: 0,
      totalBytes: bytes.byteLength,
      final: true,
      bytes,
    });

    expect(decodeEditableArtifactLiveServerWireFrame(encoded)).toEqual({
      type: "snapshot",
      protocolVersion: 1,
      artifactId: fixture.artifactId,
      streamEpoch: fixture.streamEpoch,
      sequence: 4,
      stateHash: fixture.stateHash,
      causalFrontier: [{ replicaId: fixture.replicaId, counter: 4 }],
      digest: fixture.stateHash,
      kernelVersion: "fixture-kernel-1",
      modelSchemaVersion: 1,
      offset: 0,
      totalBytes: bytes.byteLength,
      final: true,
      bytes,
    });
  });

  test("rejects text-shaped, noncanonical, and payload-bearing server frames", () => {
    expect(() =>
      decodeEditableArtifactLiveServerWireFrame(new TextEncoder().encode("{}")),
    ).toThrow();
    const watermark = fromHex(fixture.watermarkHex);
    const trailing = new Uint8Array(watermark.byteLength + 1);
    trailing.set(watermark);
    expect(() => decodeEditableArtifactLiveServerWireFrame(trailing)).toThrow(/length mismatch/u);
  });
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new TypeError("hex fixture has odd length");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}
