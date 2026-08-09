import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_VERSION,
  assertEditableArtifactRequestHash,
  decodeEditableArtifactMutationIntent,
  encodeEditableArtifactMutationIntent,
  hashEditableArtifactMutationIntent,
  hashEditableArtifactMutationIntentBytes,
  type EditableArtifactMutationIntent,
} from "../src/editable-artifacts";

const intent = (
  overrides: Partial<EditableArtifactMutationIntent> = {},
): EditableArtifactMutationIntent => ({
  envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
  protocolVersion: 1,
  modelSchemaVersion: 1,
  commandProtocolVersion: 1,
  artifactId: "1".repeat(32),
  clientTransactionId: "offline.7",
  replicaId: "2".repeat(16),
  replicaCounter: 7,
  previousLocalTransactionId: "offline.6",
  observedHeadSequence: 41,
  causalBase: [
    { replicaId: "4".repeat(16), counter: 3 },
    { replicaId: "3".repeat(16), counter: 9 },
  ],
  selectiveUndoOperationIds: ["b".repeat(32), "a".repeat(32)],
  commandBytes: new Uint8Array([0, 1, 2, 255]),
  ...overrides,
});

describe("editable artifact canonical mutation intent", () => {
  test("keeps every document command locally encodable inside the durable command budget", () => {
    expect(DOCUMENT_ARTIFACT_COMMAND_MAX_BYTES).toBe(EDITABLE_ARTIFACT_COMMAND_MAX_BYTES);
  });

  test("normalizes semantic sets and round-trips one canonical binary envelope", () => {
    const first = encodeEditableArtifactMutationIntent(intent());
    const second = encodeEditableArtifactMutationIntent(
      intent({
        causalBase: [...intent().causalBase].reverse(),
        selectiveUndoOperationIds: [...intent().selectiveUndoOperationIds].reverse(),
      }),
    );
    expect(first).toEqual(second);
    expect(new TextDecoder().decode(first.subarray(0, 8))).toBe("OGATX001");
    const decoded = decodeEditableArtifactMutationIntent(first);
    expect(decoded.causalBase.map((entry) => entry.replicaId)).toEqual([
      "3".repeat(16),
      "4".repeat(16),
    ]);
    expect(decoded.selectiveUndoOperationIds).toEqual(["a".repeat(32), "b".repeat(32)]);
    expect(encodeEditableArtifactMutationIntent(decoded)).toEqual(first);
  });

  test("binds the exact canonical bytes to one prefixed request hash", () => {
    const hashed = hashEditableArtifactMutationIntent(intent());
    expect(hashed.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(hashEditableArtifactMutationIntentBytes(hashed.bytes)).toBe(hashed.requestHash);
    expect(assertEditableArtifactRequestHash(hashed.requestHash)).toBe(hashed.requestHash);
    const changed = hashed.bytes.slice();
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(hashEditableArtifactMutationIntentBytes(changed)).not.toBe(hashed.requestHash);
  });

  test("rejects malformed, ambiguous, duplicate, unsafe, and oversized identities", () => {
    expect(() =>
      encodeEditableArtifactMutationIntent(intent({ replicaId: "0".repeat(16) })),
    ).toThrow();
    expect(() =>
      encodeEditableArtifactMutationIntent(intent({ artifactId: "A".repeat(32) })),
    ).toThrow();
    expect(() =>
      encodeEditableArtifactMutationIntent(
        intent({
          causalBase: [
            { replicaId: "3".repeat(16), counter: 1 },
            { replicaId: "3".repeat(16), counter: 2 },
          ],
        }),
      ),
    ).toThrow(/duplicate/u);
    expect(() =>
      encodeEditableArtifactMutationIntent(
        intent({ selectiveUndoOperationIds: ["a".repeat(32), "a".repeat(32)] }),
      ),
    ).toThrow(/duplicate/u);
    expect(() =>
      encodeEditableArtifactMutationIntent(intent({ commandBytes: new Uint8Array() })),
    ).toThrow();
    expect(() => assertEditableArtifactRequestHash("a".repeat(64))).toThrow();
  });

  test("rejects noncanonical order, truncation, trailing bytes, and unsafe u64 values", () => {
    const canonical = encodeEditableArtifactMutationIntent(intent());
    expect(() =>
      decodeEditableArtifactMutationIntent(canonical.subarray(0, canonical.length - 1)),
    ).toThrow();
    const trailing = new Uint8Array(canonical.length + 1);
    trailing.set(canonical);
    expect(() => decodeEditableArtifactMutationIntent(trailing)).toThrow(/trailing/u);

    // The replica counter begins after fixed header + three length-prefixed ASCII strings.
    const hugeCounter = canonical.slice();
    let offset = 8 + 2 * 4;
    for (let field = 0; field < 3; field += 1) {
      const length = hugeCounter[offset]! | (hugeCounter[offset + 1]! << 8);
      offset += 2 + length;
    }
    hugeCounter.fill(0xff, offset, offset + 8);
    expect(() => decodeEditableArtifactMutationIntent(hugeCounter)).toThrow(/safe integer/u);
  });
});
