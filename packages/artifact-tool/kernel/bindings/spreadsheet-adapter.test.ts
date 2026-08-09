import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ArtifactCommandBatchCodec, type ArtifactCommandBatch } from "../../src/kernel";
import { lowerSpreadsheetOperationEnvelope } from "./spreadsheet-adapter";

describe("public spreadsheet operation to kernel ABI lowering", () => {
  test("matches the direct Rust command envelope byte-for-byte", async () => {
    const fixture = await directKernelFixture();
    const namespace = 0x0123_4567_89ab_cdefn;
    const sheetId = `${namespace.toString(16).padStart(16, "0")}${50n.toString(16).padStart(16, "0")}`;
    const operation: ArtifactCommandBatch = {
      schemaVersion: 1,
      artifactId: "artifact/conformance",
      modality: "spreadsheet",
      transactionId: "transaction/conformance",
      actorId: "actor/conformance",
      baseSequence: 41,
      baseVector: { "actor/conformance": 8, peer: 5 },
      commands: [
        {
          code: "sheet.create",
          targetId: sheetId,
          precondition: { exists: false },
          payload: { name: "Conformance ✓" },
        },
        {
          code: "cells.set",
          targetId: sheetId,
          precondition: { objectRevision: 7, exists: true },
          payload: {
            row: 255,
            column: 255,
            values: [
              ["Revenue", 12.5, true],
              [{ formula: "=B1*2", cached: 25 }, { error: "#N/A" }, "done"],
            ],
          },
        },
      ],
    };

    const operationEnvelope = ArtifactCommandBatchCodec.encode(operation);
    const lowered = lowerSpreadsheetOperationEnvelope(operationEnvelope);
    const optimistic = lowered.commandEnvelopeForOptimisticApply();
    expect(toHex(optimistic)).toBe(fixture.command);
    optimistic.fill(0);
    expect(toHex(lowered.commandEnvelopeForOptimisticApply())).toBe(fixture.command);
    await lowered.authorizeAndApply((transaction) => {
      expect(transaction.operation).toEqual(operation);
      expect(transaction.operationEnvelope).toEqual(operationEnvelope);
      expect(toHex(transaction.commandEnvelope)).toBe(fixture.command);
      expect(transaction.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      return crypto.subtle
        .digest("SHA-256", Uint8Array.from(operationEnvelope).buffer)
        .then((expected) => {
          expect(transaction.requestHash).toBe(`sha256:${toHex(new Uint8Array(expected))}`);
        });
    });
  });

  test("rejects unsupported modality, commands, malformed ids, and unordered ranges", () => {
    const base: ArtifactCommandBatch = {
      schemaVersion: 1,
      artifactId: "artifact",
      modality: "spreadsheet",
      transactionId: "transaction",
      actorId: "actor",
      baseSequence: 0,
      baseVector: {},
      commands: [],
    };
    const lower = (commands: ArtifactCommandBatch["commands"], modality = "spreadsheet") =>
      lowerSpreadsheetOperationEnvelope(
        ArtifactCommandBatchCodec.encode({
          ...base,
          modality: modality as ArtifactCommandBatch["modality"],
          commands,
        }),
      );
    expect(() => lower([{ code: "unknown" }], "document")).toThrow("cannot lower document");
    expect(() => lower([{ code: "unknown" }])).toThrow("unsupported spreadsheet command");
    expect(() =>
      lower([{ code: "sheet.create", targetId: "bad", payload: { name: "Sheet" } }]),
    ).toThrow("StableId");
    expect(() =>
      lower([
        {
          code: "range.clear",
          targetId: "00000000000000010000000000000001",
          payload: { start: { row: 2, column: 0 }, end: { row: 1, column: 0 } },
        },
      ]),
    ).toThrow("endpoints must be ordered");
    expect(() =>
      lower([
        {
          code: "sheet.create",
          targetId: "00000000000000010000000000000001",
          payload: { name: "Sheet", futureField: true },
        },
      ]),
    ).toThrow("payload keys must be exactly");
    expect(() =>
      lower([
        {
          code: "sheet.create",
          targetId: "00000000000000010000000000000001",
          payload: { name: "bad\ud800" },
        },
      ]),
    ).toThrow("unpaired surrogates");
    expect(() =>
      lower([
        {
          code: "sheet.create",
          targetId: "00000000000000010000000000000001",
          payload: { name: "😀\ud800" },
        },
      ]),
    ).toThrow("unpaired surrogates");
    for (const targetId of [
      "00000000000000000000000000000001",
      "00000000000000010000000000000000",
    ]) {
      expect(() => lower([{ code: "sheet.create", targetId, payload: { name: "Sheet" } }])).toThrow(
        "nonzero namespace and counter",
      );
    }
  });

  test("rejects alternate public encodings and exposes no constructible guard", async () => {
    const operation: ArtifactCommandBatch = {
      schemaVersion: 1,
      artifactId: "artifact",
      modality: "spreadsheet",
      transactionId: "transaction",
      actorId: "actor",
      baseSequence: 0,
      baseVector: {},
      commands: [
        {
          code: "sheet.delete",
          targetId: "00000000000000010000000000000001",
          precondition: { exists: true },
        },
      ],
    };
    const noncanonical = ArtifactCommandBatchCodec.encode(operation).slice();
    noncanonical[noncanonical.length - 1] = 2;
    expect(() => lowerSpreadsheetOperationEnvelope(noncanonical)).toThrow("canonical encoding");

    const module = await import("./spreadsheet-adapter");
    expect("PreparedSpreadsheetKernelTransaction" in module).toBe(false);
  });
});

async function directKernelFixture(): Promise<{ command: string }> {
  const process = Bun.spawn(
    [
      "cargo",
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      resolve(import.meta.dir, "protocol", "Cargo.toml"),
      "--bin",
      "conformance_fixture",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new Error("Rust conformance fixture failed");
  return JSON.parse(output) as { command: string };
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
