import { describe, expect, test } from "bun:test";

import fixture from "./fixtures/editable-artifact-spreadsheet-v1.json";
import {
  SPREADSHEET_ARTIFACT_COMMAND_MAX_COMMANDS,
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  assertCanonicalSpreadsheetArtifactCommandBytes,
  decodeSpreadsheetArtifactCommandBatch,
  editableArtifactStableId,
  encodeEditableArtifactMutationIntent,
  encodeSpreadsheetArtifactCommandBatch,
  hashEditableArtifactMutationIntentBytes,
  spreadsheetSheetId,
  type SpreadsheetArtifactCommandBatch,
  type SpreadsheetSheetGeneration,
  type EditableArtifactMutationIntent,
} from "../src/editable-artifacts";

const concreteSheet = {
  kind: "generation",
  sheetId: spreadsheetSheetId("11111111111111110000000000000001"),
  creationOperationId: editableArtifactStableId("00000000000000002222222222222222"),
} satisfies SpreadsheetSheetGeneration;

const batch = (
  commands: SpreadsheetArtifactCommandBatch["commands"],
): SpreadsheetArtifactCommandBatch => ({
  version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  commands,
});

describe("canonical identity-free OGASC001 spreadsheet commands", () => {
  test("matches the shared TypeScript/Rust golden vector and nests exactly in OGATX001", () => {
    const semantic = fixture.commandBatch as unknown as SpreadsheetArtifactCommandBatch;
    const encoded = encodeSpreadsheetArtifactCommandBatch(semantic);
    expect(hex(encoded)).toBe(fixture.commandHex);
    expect(decodeSpreadsheetArtifactCommandBatch(encoded)).toEqual(semantic);
    expect(assertCanonicalSpreadsheetArtifactCommandBytes(encoded)).toBe(encoded);

    const intent = encodeEditableArtifactMutationIntent({
      ...fixture.intent,
      commandBytes: encoded,
    } as EditableArtifactMutationIntent);
    expect(hex(intent)).toBe(fixture.intentHex);
    expect(hashEditableArtifactMutationIntentBytes(intent)).toBe(fixture.expectedRequestHash);
    expect(fixture.expectedOperationIds).toHaveLength(
      semantic.commands.length + fixture.intent.selectiveUndoOperationIds.length,
    );
  });

  test("preserves concrete generations and prior-create preconditions without outer identity", () => {
    const sheetId = spreadsheetSheetId("123456789abcdef00000000000000001");
    const semantic = batch([
      { kind: "sheet.create", sheetId, name: "Sheet 1", after: concreteSheet },
      {
        kind: "cells.set",
        sheet: { kind: "created-in-batch", sheetId, createCommandIndex: 0 },
        anchor: { row: 0, column: 0 },
        rows: 1,
        columns: 1,
        cells: [true],
      },
    ]);
    const decoded = decodeSpreadsheetArtifactCommandBatch(
      encodeSpreadsheetArtifactCommandBatch(semantic),
    );
    expect(decoded).toEqual(semantic);
    expect(JSON.stringify(decoded)).not.toContain("artifactId");
    expect(JSON.stringify(decoded)).not.toContain("actorId");
    expect(JSON.stringify(decoded)).not.toContain("transactionId");
    expect(JSON.stringify(decoded)).not.toContain("causal");
  });

  test("normalizes authored negative zero and rejects negative-zero wire bytes", () => {
    const semantic = batch([
      {
        kind: "cells.set",
        sheet: concreteSheet,
        anchor: { row: 0, column: 0 },
        rows: 1,
        columns: 1,
        cells: [-0],
      },
    ]);
    const canonical = encodeSpreadsheetArtifactCommandBatch(semantic);
    const decoded = decodeSpreadsheetArtifactCommandBatch(canonical);
    const decodedValue =
      decoded.commands[0]?.kind === "cells.set" ? decoded.commands[0].cells[0] : null;
    expect(decodedValue).toBe(0);
    expect(Object.is(decodedValue, -0)).toBe(false);

    // Header 24 + command 1 + concrete generation 33 + geometry 16 +
    // formula/value tags 2 = first f64 payload at byte 76.
    const noncanonical = canonical.slice();
    new DataView(noncanonical.buffer).setBigUint64(76, 0x8000_0000_0000_0000n, true);
    rewriteChecksum(noncanonical);
    expect(() => decodeSpreadsheetArtifactCommandBatch(noncanonical)).toThrow(/positive sign/u);
  });

  test("round-trips canonical date instants and rejects ambiguous date strings", () => {
    const semantic = batch([
      {
        kind: "cells.set",
        sheet: concreteSheet,
        anchor: { row: 0, column: 0 },
        rows: 1,
        columns: 4,
        cells: [
          { date: "2026-08-09T12:34:56.789Z" },
          { formula: "=DATE(2026,8,9)", cached: { date: "2026-08-09T00:00:00.000Z" } },
          { date: "-271821-04-20T00:00:00.000Z" },
          { date: "+275760-09-13T00:00:00.000Z" },
        ],
      },
    ]);
    expect(
      decodeSpreadsheetArtifactCommandBatch(encodeSpreadsheetArtifactCommandBatch(semantic)),
    ).toEqual(semantic);

    for (const date of ["2026-08-09", "2026-08-09T12:34:56Z", "not-a-date"]) {
      expect(() =>
        encodeSpreadsheetArtifactCommandBatch(
          batch([
            {
              kind: "cells.set",
              sheet: concreteSheet,
              anchor: { row: 0, column: 0 },
              rows: 1,
              columns: 1,
              cells: [{ date }],
            },
          ]),
        ),
      ).toThrow(/canonical|ISO/u);
    }

    const validWire = encodeSpreadsheetArtifactCommandBatch(
      batch([
        {
          kind: "cells.set",
          sheet: concreteSheet,
          anchor: { row: 0, column: 0 },
          rows: 1,
          columns: 1,
          cells: [{ date: "2026-08-09T12:34:56.789Z" }],
        },
      ]),
    );
    for (const invalid of [-8_640_000_000_000_001n, 8_640_000_000_000_001n]) {
      const malformed = replaceUniqueI64(validWire, 1_786_278_896_789n, invalid);
      rewriteChecksum(malformed);
      expect(() => decodeSpreadsheetArtifactCommandBatch(malformed)).toThrow(/date.*range/iu);
    }
  });

  test("rejects malformed ids while permitting generic operation ids with one zero half", () => {
    expect(String(editableArtifactStableId("00000000000000002222222222222222"))).toBe(
      "00000000000000002222222222222222",
    );
    expect(String(editableArtifactStableId("22222222222222220000000000000000"))).toBe(
      "22222222222222220000000000000000",
    );
    expect(() => editableArtifactStableId("0".repeat(32))).toThrow();
    expect(() => spreadsheetSheetId("00000000000000002222222222222222")).toThrow(/namespace/u);
    expect(() => spreadsheetSheetId("22222222222222220000000000000000")).toThrow(/counter/u);
    expect(() => spreadsheetSheetId("A".repeat(32))).toThrow();
  });

  test("rejects forward, mismatched, duplicate, and non-create batch references", () => {
    const first = spreadsheetSheetId("11111111111111110000000000000002");
    const second = spreadsheetSheetId("11111111111111110000000000000003");
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "sheet.rename",
            sheet: {
              kind: "created-in-batch",
              sheetId: first,
              createCommandIndex: 1,
            },
            name: "Later",
          },
          { kind: "sheet.create", sheetId: first, name: "First", after: null },
        ]),
      ),
    ).toThrow(/earlier/u);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          { kind: "sheet.create", sheetId: first, name: "First", after: null },
          {
            kind: "sheet.rename",
            sheet: {
              kind: "created-in-batch",
              sheetId: second,
              createCommandIndex: 0,
            },
            name: "Wrong",
          },
        ]),
      ),
    ).toThrow(/match/u);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          { kind: "sheet.create", sheetId: first, name: "First", after: null },
          { kind: "sheet.create", sheetId: first, name: "Again", after: null },
        ]),
      ),
    ).toThrow(/more than once/u);
  });

  test("rejects malformed cells, geometry, names, extra fields, and sparse arrays", () => {
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "cells.set",
            sheet: concreteSheet,
            anchor: { row: 0xffff_ffff, column: 0 },
            rows: 2,
            columns: 1,
            cells: [null, null],
          },
        ]),
      ),
    ).toThrow(/extent/u);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "range.clear",
            sheet: concreteSheet,
            range: { start: { row: 2, column: 0 }, end: { row: 1, column: 0 } },
          },
        ]),
      ),
    ).toThrow(/ordered/u);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "cells.set",
            sheet: concreteSheet,
            anchor: { row: 0, column: 0 },
            rows: 1,
            columns: 1,
            cells: [Number.NaN],
          },
        ]),
      ),
    ).toThrow(/finite/u);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "cells.set",
            sheet: concreteSheet,
            anchor: { row: 0, column: 0 },
            rows: 1,
            columns: 1,
            cells: [{ formula: "", cached: null }],
          },
        ]),
      ),
    ).toThrow(/nonempty/u);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "sheet.create",
            sheetId: concreteSheet.sheetId,
            name: "bad/name",
            after: null,
          },
        ]),
      ),
    ).toThrow(/sheet name/u);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "sheet.delete",
            sheet: concreteSheet,
            future: true,
          } as never,
        ]),
      ),
    ).toThrow(/fields/u);
    const cells = new Array<null>(1);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "cells.set",
            sheet: concreteSheet,
            anchor: { row: 0, column: 0 },
            rows: 1,
            columns: 1,
            cells,
          },
        ]),
      ),
    ).toThrow(/dense/u);
  });

  test("rejects invalid UTF-8, flags, checksum, truncation, trailing bytes, and payload tails", () => {
    const canonical = encodeSpreadsheetArtifactCommandBatch(
      batch([
        {
          kind: "sheet.create",
          sheetId: spreadsheetSheetId("11111111111111110000000000000004"),
          name: "Sheet",
          after: null,
        },
      ]),
    );
    const invalidUtf8 = canonical.slice();
    // Header 24 + command tag 1 + id 16 + name length 4.
    invalidUtf8[45] = 0xff;
    rewriteChecksum(invalidUtf8);
    expect(() => decodeSpreadsheetArtifactCommandBatch(invalidUtf8)).toThrow();

    const flags = canonical.slice();
    flags[10] = 1;
    rewriteChecksum(flags);
    expect(() => decodeSpreadsheetArtifactCommandBatch(flags)).toThrow(/flags/u);

    const checksum = canonical.slice();
    checksum[checksum.length - 1]! ^= 1;
    expect(() => decodeSpreadsheetArtifactCommandBatch(checksum)).toThrow(/checksum/u);
    expect(() => decodeSpreadsheetArtifactCommandBatch(canonical.subarray(0, -1))).toThrow(
      /truncated/u,
    );

    const trailing = new Uint8Array(canonical.length + 1);
    trailing.set(canonical);
    expect(() => decodeSpreadsheetArtifactCommandBatch(trailing)).toThrow(/trailing/u);

    const payloadTail = canonical.slice();
    new DataView(payloadTail.buffer).setUint32(12, 0, true);
    rewriteChecksum(payloadTail);
    expect(() => decodeSpreadsheetArtifactCommandBatch(payloadTail)).toThrow(/count/u);
  });

  test("enforces command, cell, and strict-string bounds before allocation-heavy work", () => {
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch({
        version: 1,
        commands: new Array(SPREADSHEET_ARTIFACT_COMMAND_MAX_COMMANDS + 1).fill({
          kind: "sheet.delete",
          sheet: concreteSheet,
        }),
      }),
    ).toThrow(/count/u);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "cells.set",
            sheet: concreteSheet,
            anchor: { row: 0, column: 0 },
            rows: 1_000,
            columns: 1_001,
            cells: [],
          },
        ]),
      ),
    ).toThrow(/cell count/u);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "cells.set",
            sheet: concreteSheet,
            anchor: { row: 0, column: 0 },
            rows: 1,
            columns: 1,
            cells: ["x".repeat(1_048_577)],
          },
        ]),
      ),
    ).toThrow(/string/u);
    expect(() =>
      encodeSpreadsheetArtifactCommandBatch(
        batch([
          {
            kind: "sheet.create",
            sheetId: spreadsheetSheetId("11111111111111110000000000000005"),
            name: "bad\ud800",
            after: null,
          },
        ]),
      ),
    ).toThrow(/surrogate/u);
  });
});

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rewriteChecksum(bytes: Uint8Array): void {
  const checksumOffset = bytes.length - 8;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes.subarray(0, checksumOffset)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(
    checksumOffset,
    hash,
    true,
  );
}

function replaceUniqueI64(bytes: Uint8Array, expected: bigint, replacement: bigint): Uint8Array {
  const output = bytes.slice();
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const offsets: number[] = [];
  for (let offset = 0; offset <= output.byteLength - 8; offset += 1) {
    if (view.getBigInt64(offset, true) === expected) offsets.push(offset);
  }
  expect(offsets).toHaveLength(1);
  view.setBigInt64(offsets[0]!, replacement, true);
  return output;
}
