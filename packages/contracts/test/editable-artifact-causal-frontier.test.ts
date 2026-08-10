import { describe, expect, test } from "bun:test";

import {
  EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_REPLICAS,
  assertCanonicalEditableArtifactCausalFrontierBytes,
  decodeEditableArtifactCausalFrontier,
  encodeEditableArtifactCausalFrontier,
} from "../src/editable-artifact-causal-frontier";
import fixture from "./fixtures/editable-artifact-spreadsheet-v1.json";

const hex = (value: string): Uint8Array => Uint8Array.fromHex(value);

describe("OGACF001 causal frontier", () => {
  test("matches the immutable Rust vector byte-for-byte", () => {
    const encoded = encodeEditableArtifactCausalFrontier(fixture.resolvedFrontier);
    expect(encoded.toHex()).toBe(fixture.resolvedFrontierHex);
    expect(decodeEditableArtifactCausalFrontier(hex(fixture.resolvedFrontierHex))).toEqual(
      fixture.resolvedFrontier,
    );
    assertCanonicalEditableArtifactCausalFrontierBytes(encoded);
  });

  test("supports the canonical empty frontier", () => {
    const encoded = encodeEditableArtifactCausalFrontier([]);
    expect(decodeEditableArtifactCausalFrontier(encoded)).toEqual([]);
    expect(encoded.byteLength).toBe(24);
  });

  test("rejects malformed, unordered, unsafe, and noncanonical values", () => {
    expect(() =>
      encodeEditableArtifactCausalFrontier([{ replicaId: "0000000000000000", counter: 1 }]),
    ).toThrow();
    expect(() =>
      encodeEditableArtifactCausalFrontier([
        { replicaId: "0000000000000002", counter: 1 },
        { replicaId: "0000000000000001", counter: 1 },
      ]),
    ).toThrow();
    expect(() =>
      encodeEditableArtifactCausalFrontier([
        { replicaId: "0000000000000001", counter: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrow();

    const valid = encodeEditableArtifactCausalFrontier([
      { replicaId: "0000000000000001", counter: 1 },
    ]);
    for (const mutated of [
      valid.subarray(0, -1),
      Uint8Array.from([...valid, 0]),
      Uint8Array.from(valid, (byte, index) => (index === 10 ? 1 : byte)),
      Uint8Array.from(valid, (byte, index) => (index === 16 ? 0 : byte)),
      Uint8Array.from(valid, (byte, index) => (index === valid.length - 1 ? byte ^ 1 : byte)),
    ]) {
      expect(() => decodeEditableArtifactCausalFrontier(mutated)).toThrow();
    }
  });

  test("pins the effective Rust replica bound", () => {
    expect(EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_REPLICAS).toBe(1_024);
    const maximum = Array.from(
      { length: EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_REPLICAS },
      (_, index) => ({
        replicaId: (index + 1).toString(16).padStart(16, "0"),
        counter: index + 1,
      }),
    );
    expect(
      decodeEditableArtifactCausalFrontier(encodeEditableArtifactCausalFrontier(maximum)),
    ).toHaveLength(EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_REPLICAS);
    expect(() =>
      encodeEditableArtifactCausalFrontier([
        ...maximum,
        { replicaId: "0000000000000401", counter: 1 },
      ]),
    ).toThrow();
  });
});
