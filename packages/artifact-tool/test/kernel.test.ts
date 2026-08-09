import { describe, expect, test } from "bun:test";
import {
  ArtifactCommandBatchCodec,
  ArtifactKernelRegistry,
  type ArtifactCommandBatch,
  type ArtifactKernel,
  type ArtifactKernelCapabilities,
  type ArtifactModality,
} from "../src/kernel";

describe("artifact command batch codec", () => {
  const batch: ArtifactCommandBatch = {
    schemaVersion: 1,
    artifactId: "artifact-1",
    modality: "spreadsheet",
    transactionId: "tx-1",
    actorId: "actor-a",
    baseSequence: 42,
    baseVector: { "actor-b": 3, "actor-a": 8 },
    commands: [
      {
        code: "cell.set",
        targetId: "cell/A1",
        precondition: { objectRevision: 2, exists: true },
        payload: { formula: "=SUM(B1:B3)", style: { bold: true } },
      },
    ],
  };

  test("is deterministic and round-trips canonical command payloads", () => {
    const first = ArtifactCommandBatchCodec.encode(batch);
    const second = ArtifactCommandBatchCodec.encode({
      ...batch,
      baseVector: { "actor-a": 8, "actor-b": 3 },
      commands: [
        { ...batch.commands[0]!, payload: { style: { bold: true }, formula: "=SUM(B1:B3)" } },
      ],
    });
    expect(first).toEqual(second);
    expect(ArtifactCommandBatchCodec.decode(first)).toEqual({
      ...batch,
      baseVector: { "actor-a": 8, "actor-b": 3 },
    });
  });

  test("round-trips causal actor names without prototype mutation", () => {
    const prototypeSafeBatch: ArtifactCommandBatch = {
      schemaVersion: 1,
      artifactId: "artifact-1",
      modality: "spreadsheet",
      transactionId: "transaction-1",
      actorId: "actor-1",
      baseSequence: 0,
      baseVector: Object.fromEntries([
        ["__proto__", 7],
        ["constructor", 3],
      ]),
      commands: [{ code: "sheet.add", payload: { name: "Safe" } }],
    };

    const decoded = ArtifactCommandBatchCodec.decode(
      ArtifactCommandBatchCodec.encode(prototypeSafeBatch),
    );

    expect(Object.getPrototypeOf(decoded.baseVector)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded.baseVector, "__proto__")).toBe(true);
    expect(decoded.baseVector.__proto__).toBe(7);
    expect(decoded.baseVector["constructor"]).toBe(3);
  });

  test("rejects trailing bytes and malformed magic", () => {
    const encoded = ArtifactCommandBatchCodec.encode(batch);
    expect(() => ArtifactCommandBatchCodec.decode(new Uint8Array([...encoded, 0]))).toThrow();
    const malformed = encoded.slice();
    malformed[0] = 0;
    expect(() => ArtifactCommandBatchCodec.decode(malformed)).toThrow("magic");
  });

  test("rejects deeply nested command JSON before recursive exhaustion", () => {
    let payload: unknown = "leaf";
    for (let depth = 0; depth < 70; depth += 1) payload = [payload];

    expect(() =>
      ArtifactCommandBatchCodec.encode({
        schemaVersion: 1,
        artifactId: "artifact-1",
        modality: "spreadsheet",
        transactionId: "transaction-1",
        actorId: "actor-1",
        baseSequence: 0,
        baseVector: {},
        commands: [{ code: "cell.set", payload }],
      }),
    ).toThrow("operation JSON depth");
  });
});

describe("artifact kernel registry", () => {
  test("prefers native and negotiates required capabilities", () => {
    const registry = new ArtifactKernelRegistry();
    registry.register(kernel("reference", false));
    registry.register(kernel("native", true));
    expect(registry.select("spreadsheet", { collaboration: true }).kernel.kind).toBe("native");
    expect(registry.select("spreadsheet").kernel.kind).toBe("native");
  });

  test("never silently selects the TypeScript reference backend", () => {
    const registry = new ArtifactKernelRegistry();
    registry.register(kernel("reference", true));
    expect(() => registry.select("spreadsheet")).toThrow("required kernel capabilities");
    expect(registry.select("spreadsheet", {}, ["reference"]).kernel.kind).toBe("reference");
  });
});

describe("legacy operation authority fence", () => {
  test("exports OGAR only from the explicit reference entry", async () => {
    const production = await import("../src/index");
    const reference = await import("../src/reference");
    expect("ArtifactCommandBatchCodec" in production).toBe(false);
    expect("ArtifactCommandBatchCodec" in reference).toBe(true);
  });
});

function kernel(kind: ArtifactKernel["kind"], collaboration: boolean): ArtifactKernel {
  return {
    kind,
    version: "test",
    capabilities(modality: ArtifactModality): ArtifactKernelCapabilities {
      return {
        modality,
        modelSchemaVersion: 1,
        operationSchemaVersion: 1,
        inspect: true,
        calculate: modality === "spreadsheet",
        layout: true,
        renderFormats: ["png"],
        importFormats: [],
        exportFormats: [],
        collaboration,
      };
    },
    async open() {
      throw new Error("not needed");
    },
  };
}
