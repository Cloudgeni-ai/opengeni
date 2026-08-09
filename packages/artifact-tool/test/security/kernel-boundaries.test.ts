import { describe, expect, test } from "bun:test";

import { ArtifactLimitError } from "../../src/errors";
import {
  ARTIFACT_OPERATION_MAX_COMMANDS,
  ARTIFACT_OPERATION_MAX_JSON_DEPTH,
  ARTIFACT_OPERATION_MAX_JSON_NODES,
  ARTIFACT_OPERATION_MAX_STRING_BYTES,
  ARTIFACT_OPERATION_MAX_VECTOR_ACTORS,
  ArtifactCommandBatchCodec,
  type ArtifactCommandBatch,
} from "../../src/kernel";

function batch(overrides: Partial<ArtifactCommandBatch> = {}): ArtifactCommandBatch {
  return {
    schemaVersion: 1,
    artifactId: "artifact/security",
    modality: "spreadsheet",
    transactionId: "transaction/security",
    actorId: "actor/security",
    baseSequence: 0,
    baseVector: {},
    commands: [{ code: "cell.set", payload: { value: "safe" } }],
    ...overrides,
  };
}

describe("artifact command boundary security", () => {
  test("rejects non-JSON objects, accessors, and non-finite numbers", () => {
    class HostObject {
      value = "not plain JSON";
    }

    expect(() =>
      ArtifactCommandBatchCodec.encode(
        batch({ commands: [{ code: "cell.set", payload: new HostObject() }] }),
      ),
    ).toThrow("plain JSON");
    expect(() =>
      ArtifactCommandBatchCodec.encode(
        batch({ commands: [{ code: "cell.set", payload: Object.create(null) }] }),
      ),
    ).toThrow("plain JSON");
    expect(() =>
      ArtifactCommandBatchCodec.encode(
        batch({ commands: [{ code: "cell.set", payload: { value: Number.POSITIVE_INFINITY } }] }),
      ),
    ).toThrow("non-finite");

    let getterCalls = 0;
    const accessorPayload = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must never execute";
      },
    });
    expect(() =>
      ArtifactCommandBatchCodec.encode(
        batch({ commands: [{ code: "cell.set", payload: accessorPayload }] }),
      ),
    ).toThrow(/data propert|accessor/i);
    expect(getterCalls).toBe(0);

    const sparsePayload = new Array(1);
    expect(() =>
      ArtifactCommandBatchCodec.encode(
        batch({ commands: [{ code: "cell.set", payload: sparsePayload }] }),
      ),
    ).toThrow(/dense|sparse/i);
  });

  test("round-trips reserved payload keys without prototype pollution", () => {
    const malicious = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
    ) as Record<string, unknown>;
    const decoded = ArtifactCommandBatchCodec.decode(
      ArtifactCommandBatchCodec.encode(
        batch({ commands: [{ code: "cell.set", payload: malicious }] }),
      ),
    );
    const payload = decoded.commands[0]!.payload as Record<string, unknown>;

    expect(Object.hasOwn(payload, "__proto__")).toBe(true);
    expect(Object.hasOwn(payload, "constructor")).toBe(true);
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("enforces byte, command, and causal-vector limits before serialization", () => {
    const oversizedUtf8 = "💣".repeat(Math.floor(ARTIFACT_OPERATION_MAX_STRING_BYTES / 4) + 1);
    expect(() =>
      ArtifactCommandBatchCodec.encode(
        batch({ commands: [{ code: "cell.set", payload: { value: oversizedUtf8 } }] }),
      ),
    ).toThrow(ArtifactLimitError);

    expect(() =>
      ArtifactCommandBatchCodec.encode(
        batch({
          commands: Array.from({ length: ARTIFACT_OPERATION_MAX_COMMANDS + 1 }, () => ({
            code: "cell.set",
          })),
        }),
      ),
    ).toThrow(ArtifactLimitError);

    expect(() =>
      ArtifactCommandBatchCodec.encode(
        batch({
          baseVector: Object.fromEntries(
            Array.from({ length: ARTIFACT_OPERATION_MAX_VECTOR_ACTORS + 1 }, (_, index) => [
              `actor/${index}`,
              index,
            ]),
          ),
        }),
      ),
    ).toThrow(ArtifactLimitError);
  });

  test("rejects truncation, overlong varints, invalid UTF-8, and trailing bytes", () => {
    const encoded = ArtifactCommandBatchCodec.encode(batch());
    expect(() =>
      ArtifactCommandBatchCodec.decode(encoded.subarray(0, encoded.length - 1)),
    ).toThrow();
    expect(() => ArtifactCommandBatchCodec.decode(new Uint8Array([...encoded, 0]))).toThrow(
      "trailing bytes",
    );

    const overlongSchema = new Uint8Array([
      0x4f,
      0x47,
      0x41,
      0x52,
      ...new Array<number>(10).fill(0x80),
    ]);
    expect(() => ArtifactCommandBatchCodec.decode(overlongSchema)).toThrow(/varint|Truncated/);

    const minimallyEncodedSchema = encoded[4]!;
    const nonminimalSchema = new Uint8Array(encoded.length + 1);
    nonminimalSchema.set(encoded.subarray(0, 4), 0);
    nonminimalSchema[4] = minimallyEncodedSchema | 0x80;
    nonminimalSchema[5] = 0;
    nonminimalSchema.set(encoded.subarray(5), 6);
    expect(() => ArtifactCommandBatchCodec.decode(nonminimalSchema)).toThrow(
      /non-canonical|varint/i,
    );

    const invalidUtf8 = encoded.slice();
    // First length-prefixed string is artifactId. Preserve its byte length but
    // introduce an impossible UTF-8 continuation sequence.
    const artifactLengthOffset = 6;
    const artifactStart = artifactLengthOffset + 1;
    invalidUtf8[artifactStart] = 0xc3;
    invalidUtf8[artifactStart + 1] = 0x28;
    expect(() => ArtifactCommandBatchCodec.decode(invalidUtf8)).toThrow();
  });

  test("rejects noncanonical boolean bytes instead of aliasing them to false", () => {
    const encoded = ArtifactCommandBatchCodec.encode(
      batch({
        commands: [
          {
            code: "cell.set",
            precondition: { exists: false },
          },
        ],
      }),
    );
    const booleanOffset = encoded.length - 1;
    expect(encoded[booleanOffset]).toBe(0);
    encoded[booleanOffset] = 2;
    expect(() => ArtifactCommandBatchCodec.decode(encoded)).toThrow(/boolean|non-canonical/i);
  });

  test("SEC-001 preserves a causal actor literally named __proto__", () => {
    const baseVector = JSON.parse('{"__proto__":7}') as Record<string, number>;
    const decoded = ArtifactCommandBatchCodec.decode(
      ArtifactCommandBatchCodec.encode(batch({ baseVector })),
    );
    expect(decoded.baseVector).toEqual(baseVector);
  });

  test("rejects payloads beyond canonical JSON depth and node budgets", () => {
    let deeplyNested: unknown = "leaf";
    for (let depth = 0; depth <= ARTIFACT_OPERATION_MAX_JSON_DEPTH; depth += 1) {
      deeplyNested = [deeplyNested];
    }
    expect(() =>
      ArtifactCommandBatchCodec.encode(
        batch({ commands: [{ code: "cell.set", payload: deeplyNested }] }),
      ),
    ).toThrow(ArtifactLimitError);

    const tooManyNodes = new Array<null>(ARTIFACT_OPERATION_MAX_JSON_NODES).fill(null);
    expect(() =>
      ArtifactCommandBatchCodec.encode(
        batch({ commands: [{ code: "cell.set", payload: tooManyNodes }] }),
      ),
    ).toThrow(ArtifactLimitError);
  });
});
