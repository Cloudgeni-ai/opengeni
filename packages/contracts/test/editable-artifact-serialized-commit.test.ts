import { describe, expect, test } from "bun:test";

import {
  EDITABLE_ARTIFACT_SERIALIZED_COMMIT_MAX_BYTES,
  decodeEditableArtifactSerializedCommit,
  encodeEditableArtifactSerializedCommit,
} from "@opengeni/contracts/editable-artifact-serialized-commit";
import {
  decodeEditableArtifactMutationIntent,
  encodeEditableArtifactMutationIntent,
  hashEditableArtifactMutationIntentBytes,
} from "@opengeni/contracts/editable-artifacts";
import { encodeDocumentArtifactCommandBatch } from "@opengeni/contracts/document-artifact-commands";
import { encodePresentationArtifactCommandBatch } from "@opengeni/contracts/presentation-artifact-commands";
import {
  ArtifactBinaryWriter,
  encodeCountedEnvelope,
  fnv1a64,
} from "../src/editable-artifact-binary";

const TRANSACTION_ID = "1".repeat(32);
const ARTIFACT_ID = "2".repeat(32);
const REPLICA_ID = "3".repeat(16);
const PRIOR_HASH = `sha256:${"4".repeat(64)}`;
const STATE_HASH = `sha256:${"5".repeat(64)}`;

describe("OGAST001 authoritative serialized commits", () => {
  test.each(["document", "presentation"] as const)(
    "round-trips exact canonical %s intent and native receipt bytes",
    (modality) => {
      const value = fixture(modality);
      const bytes = encodeEditableArtifactSerializedCommit(value);
      const original = bytes.slice();

      const decoded = decodeEditableArtifactSerializedCommit(bytes, modality);

      expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("OGAST001");
      expect(decoded).toEqual({
        commitProtocolVersion: 1,
        modality,
        transactionId: TRANSACTION_ID,
        parentHeadSequence: 12,
        resultHeadSequence: 13,
        priorNativeRevision: 20,
        priorStateHash: PRIOR_HASH,
        stateHash: STATE_HASH,
        requestHash: hashEditableArtifactMutationIntentBytes(value.intentBytes),
        intent: decodeEditableArtifactMutationIntent(value.intentBytes),
        intentBytes: value.intentBytes,
        nativeReceiptBytes: value.nativeReceiptBytes,
        nativeReceipt:
          modality === "document"
            ? { modality, revision: 21, commandCount: 1, createdIdCount: 0 }
            : { modality, revision: 21, commandCount: 1 },
      });
      expect(bytes).toEqual(original);
      expect(encodeEditableArtifactSerializedCommit(decoded)).toEqual(bytes);
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(decoded.nativeReceipt)).toBe(true);

      const padded = new Uint8Array(bytes.byteLength + 9);
      padded.set(bytes, 4);
      expect(
        decodeEditableArtifactSerializedCommit(padded.subarray(4, 4 + bytes.byteLength), modality),
      ).toEqual(decoded);
    },
  );

  test("pins the exact document and presentation wire bytes", () => {
    expect(hex(encodeEditableArtifactSerializedCommit(fixture("document")))).toBe(DOCUMENT_GOLDEN);
    expect(hex(encodeEditableArtifactSerializedCommit(fixture("presentation")))).toBe(
      PRESENTATION_GOLDEN,
    );
  });

  test("selects the durable modality before accepting nested commands or receipts", () => {
    const document = fixture("document");
    const presentation = fixture("presentation");

    expect(() =>
      decodeEditableArtifactSerializedCommit(
        encodeEditableArtifactSerializedCommit(document),
        "presentation",
      ),
    ).toThrow("durable artifact");
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...document,
        intentBytes: presentation.intentBytes,
      }),
    ).toThrow("magic");
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...document,
        nativeReceiptBytes: presentation.nativeReceiptBytes,
      }),
    ).toThrow("magic");
  });

  test("rejects CRDT semantics and stale or multi-step serialized heads", () => {
    const value = fixture("document");
    expect(() =>
      encodeEditableArtifactSerializedCommit({ ...value, resultHeadSequence: 14 }),
    ).toThrow("exactly once");
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...value,
        parentHeadSequence: 11,
        resultHeadSequence: 12,
      }),
    ).toThrow("observed head");
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...value,
        intentBytes: documentIntent({
          causalBase: [{ replicaId: "6".repeat(16), counter: 1 }],
        }),
      }),
    ).toThrow("cannot carry CRDT");
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...value,
        intentBytes: documentIntent({
          selectiveUndoOperationIds: ["7".repeat(32)],
        }),
      }),
    ).toThrow("selective undo");
  });

  test("validates native receipt version, checksum, and exact command count", () => {
    const document = fixture("document");
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...document,
        intentBytes: documentIntent({
          commandBytes: encodeDocumentArtifactCommandBatch({
            version: 1,
            commands: [],
          }),
        }),
        nativeReceiptBytes: documentReceipt(20, 0),
      }),
    ).toThrow("non-empty");
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...document,
        nativeReceiptBytes: documentReceipt(21, 0),
      }),
    ).toThrow("command count");
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...document,
        nativeReceiptBytes: documentReceipt(22, 1),
      }),
    ).toThrow("prior native revision");
    expect(
      decodeEditableArtifactSerializedCommit(
        encodeEditableArtifactSerializedCommit({
          ...document,
          priorStateHash: STATE_HASH,
          nativeReceiptBytes: documentReceipt(20, 1),
        }),
        "document",
      ).nativeReceipt.revision,
    ).toBe(20);
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...document,
        nativeReceiptBytes: documentReceipt(20, 1),
      }),
    ).toThrow("no-op");
    expect(
      decodeEditableArtifactSerializedCommit(
        encodeEditableArtifactSerializedCommit({
          ...document,
          nativeReceiptBytes: documentReceipt(21, 1, [{ tag: 1, namespace: 0n, counter: 1n }]),
        }),
        "document",
      ).nativeReceipt,
    ).toMatchObject({ createdIdCount: 1 });
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...document,
        nativeReceiptBytes: documentReceipt(21, 1, [{ tag: 1, namespace: 0n, counter: 0n }]),
      }),
    ).toThrow("id counter");

    const presentation = fixture("presentation");
    const badVersion = presentation.nativeReceiptBytes.slice();
    new DataView(badVersion.buffer).setUint16(8, 2, true);
    rewriteChecksum(badVersion);
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...presentation,
        nativeReceiptBytes: badVersion,
      }),
    ).toThrow("version");

    const badChecksum = presentation.nativeReceiptBytes.slice();
    badChecksum[badChecksum.length - 1] = badChecksum[badChecksum.length - 1]! ^ 1;
    expect(() =>
      encodeEditableArtifactSerializedCommit({
        ...presentation,
        nativeReceiptBytes: badChecksum,
      }),
    ).toThrow("checksum");
  });

  test("rejects corruption, truncation, trailing bytes, shared memory, and oversize", () => {
    const bytes = encodeEditableArtifactSerializedCommit(fixture("presentation"));
    const badMagic = bytes.slice();
    badMagic[0] = badMagic[0]! ^ 1;
    expect(() => decodeEditableArtifactSerializedCommit(badMagic, "presentation")).toThrow("magic");
    const badVersion = mutateOuter(bytes, (view) => view.setUint16(8, 2, true));
    expect(() => decodeEditableArtifactSerializedCommit(badVersion, "presentation")).toThrow(
      "version",
    );
    const badFlags = mutateOuter(bytes, (view) => view.setUint16(10, 1, true));
    expect(() => decodeEditableArtifactSerializedCommit(badFlags, "presentation")).toThrow("flags");
    const badChecksum = bytes.slice();
    badChecksum[badChecksum.length - 1] = badChecksum[badChecksum.length - 1]! ^ 1;
    expect(() => decodeEditableArtifactSerializedCommit(badChecksum, "presentation")).toThrow(
      "checksum",
    );
    expect(() =>
      decodeEditableArtifactSerializedCommit(bytes.subarray(0, bytes.length - 1), "presentation"),
    ).toThrow("truncated");
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeEditableArtifactSerializedCommit(trailing, "presentation")).toThrow(
      "trailing",
    );
    expect(() =>
      decodeEditableArtifactSerializedCommit(
        new Uint8Array(EDITABLE_ARTIFACT_SERIALIZED_COMMIT_MAX_BYTES + 1),
        "presentation",
      ),
    ).toThrow("byte limit");
    if (typeof SharedArrayBuffer !== "undefined") {
      expect(() =>
        decodeEditableArtifactSerializedCommit(
          new Uint8Array(new SharedArrayBuffer(64)),
          "presentation",
        ),
      ).toThrow("shared mutable memory");
    }
  });
});

function fixture(modality: "document" | "presentation") {
  return {
    modality,
    transactionId: TRANSACTION_ID,
    parentHeadSequence: 12,
    resultHeadSequence: 13,
    priorNativeRevision: 20,
    priorStateHash: PRIOR_HASH,
    stateHash: STATE_HASH,
    intentBytes: modality === "document" ? documentIntent() : presentationIntent(),
    nativeReceiptBytes:
      modality === "document" ? documentReceipt(21, 1) : presentationReceipt(21, 1),
  } as const;
}

function documentIntent(
  overrides: Partial<{
    causalBase: readonly { replicaId: string; counter: number }[];
    selectiveUndoOperationIds: readonly string[];
    commandBytes: Uint8Array;
  }> = {},
): Uint8Array {
  return encodeEditableArtifactMutationIntent({
    envelopeVersion: 1,
    protocolVersion: 1,
    modelSchemaVersion: 1,
    commandProtocolVersion: 1,
    artifactId: ARTIFACT_ID,
    clientTransactionId: "document.13",
    replicaId: REPLICA_ID,
    replicaCounter: 13,
    previousLocalTransactionId: "document.12",
    observedHeadSequence: 12,
    causalBase: overrides.causalBase ?? [],
    selectiveUndoOperationIds: overrides.selectiveUndoOperationIds ?? [],
    commandBytes:
      overrides.commandBytes ??
      encodeDocumentArtifactCommandBatch({
        version: 1,
        commands: [
          {
            kind: "document.flags.set",
            evenAndOddHeaders: true,
            trackRevisions: null,
          },
        ],
      }),
  });
}

function presentationIntent(): Uint8Array {
  return encodeEditableArtifactMutationIntent({
    envelopeVersion: 1,
    protocolVersion: 1,
    modelSchemaVersion: 1,
    commandProtocolVersion: 1,
    artifactId: ARTIFACT_ID,
    clientTransactionId: "presentation.13",
    replicaId: REPLICA_ID,
    replicaCounter: 13,
    previousLocalTransactionId: "presentation.12",
    observedHeadSequence: 12,
    causalBase: [],
    selectiveUndoOperationIds: [],
    commandBytes: encodePresentationArtifactCommandBatch({
      version: 1,
      commands: [
        {
          kind: "master.create",
          id: "8".repeat(32),
          name: "Golden",
          background: { kind: "none" },
        },
      ],
    }),
  });
}

function documentReceipt(
  revision: number,
  commandCount: number,
  createdIds: readonly Readonly<{
    tag: number;
    namespace: bigint;
    counter: bigint;
  }>[] = [],
): Uint8Array {
  const payload = new ArtifactBinaryWriter(512 * 1024);
  payload.u64(revision);
  payload.u32(commandCount);
  payload.u32(createdIds.length);
  for (const id of createdIds) {
    payload.u8(id.tag);
    payload.u64(id.namespace);
    payload.u64(id.counter);
  }
  return encodeCountedEnvelope("OGADR001", 1, commandCount, payload.finish(), 512 * 1024);
}

function presentationReceipt(revision: number, commandCount: number): Uint8Array {
  const writer = new ArtifactBinaryWriter(32);
  writer.bytes(new TextEncoder().encode("OGAPR001"));
  writer.u16(1);
  writer.u16(0);
  writer.u64(revision);
  writer.u32(commandCount);
  writer.u64(fnv1a64(writer.view()));
  return writer.finish();
}

function rewriteChecksum(bytes: Uint8Array): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(
    bytes.byteLength - 8,
    fnv1a64(bytes.subarray(0, bytes.byteLength - 8)),
    true,
  );
}

function mutateOuter(bytes: Uint8Array, mutate: (view: DataView) => void): Uint8Array {
  const next = bytes.slice();
  mutate(new DataView(next.buffer));
  rewriteChecksum(next);
  return next;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const DOCUMENT_GOLDEN =
  "4f4741535430303101000000010000003a01000000000000111111111111111111111111111111110c000000000000000d000000000000001400000000000000444444444444444444444444444444444444444444444444444444444444444455555555555555555555555555555555555555555555555555555555555555559a000000300000004f474154583030310100010001000100200032323232323232323232323232323232323232323232323232323232323232320b00646f63756d656e742e31331000333333333333333333333333333333330d00000000000000010b00646f63756d656e742e31320c0000000000000000000000230000004f4741444330303101000000010000000300000000000000000301abf23e5c4596b8224f4741445230303101000000010000001000000000000000150000000000000001000000000000001b8555222d49619c7e7b4100289be16a";
const PRESENTATION_GOLDEN =
  "4f4741535430303101000000020000004b01000000000000111111111111111111111111111111110c000000000000000d00000000000000140000000000000044444444444444444444444444444444444444444444444444444444444444445555555555555555555555555555555555555555555555555555555555555555bb000000200000004f474154583030310100010001000100200032323232323232323232323232323232323232323232323232323232323232320f0070726573656e746174696f6e2e31331000333333333333333333333333333333330d00000000000000010f0070726573656e746174696f6e2e31320c00000000000000000000003c0000004f4741504330303101000000010000001c00000000000000008888888888888888888888888888888806000000476f6c64656e00d775509ba68ff8ad4f47415052303031010000001500000000000000010000003eeb3f9760a7d4f167cf8a2235c02cb0";
