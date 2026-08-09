import { describe, expect, test } from "bun:test";

import fixture from "./fixtures/spreadsheet-artifact-query-v1.json";
import {
  assertCanonicalSpreadsheetArtifactKernelProjectionBytes,
  assertCanonicalSpreadsheetArtifactKernelQueryBytes,
  decodeSpreadsheetArtifactKernelProjection,
  decodeSpreadsheetArtifactKernelQuery,
  encodeSpreadsheetMetadataKernelProjection,
  encodeSpreadsheetMetadataKernelQuery,
  encodeSpreadsheetViewportKernelProjection,
  encodeSpreadsheetViewportKernelQuery,
  spreadsheetSheetId,
  type SpreadsheetArtifactMetadataProjection,
  type SpreadsheetArtifactViewportProjection,
  type SpreadsheetArtifactViewportQuery,
} from "../src/editable-artifacts";

const viewportQuery = Object.freeze({
  ...fixture.viewportQuery,
  sheetId: spreadsheetSheetId(fixture.viewportQuery.sheetId),
}) satisfies SpreadsheetArtifactViewportQuery;

const viewportProjection = Object.freeze({
  ...fixture.viewportProjection,
  revision: BigInt(fixture.viewportProjection.revision),
  sheetId: spreadsheetSheetId(fixture.viewportProjection.sheetId),
  generationId: spreadsheetSheetId(fixture.viewportProjection.generationId),
}) as SpreadsheetArtifactViewportProjection;

const metadataProjection = Object.freeze({
  ...fixture.metadataProjection,
  revision: BigInt(fixture.metadataProjection.revision),
  sheets: fixture.metadataProjection.sheets.map((sheet) =>
    Object.freeze({
      ...sheet,
      sheetId: spreadsheetSheetId(sheet.sheetId),
      generationId: spreadsheetSheetId(sheet.generationId),
    }),
  ),
}) as SpreadsheetArtifactMetadataProjection;

describe("canonical OGAKQ001/OGAKV001 spreadsheet projection ABI", () => {
  test("matches the immutable TypeScript/Rust golden byte for byte", () => {
    const encodedViewportQuery = encodeSpreadsheetViewportKernelQuery(viewportQuery);
    const encodedMetadataQuery = encodeSpreadsheetMetadataKernelQuery(fixture.metadataQuery);
    const encodedViewport = encodeSpreadsheetViewportKernelProjection(viewportProjection);
    const encodedMetadata = encodeSpreadsheetMetadataKernelProjection(metadataProjection);

    expect(hex(encodedViewportQuery)).toBe(fixture.viewportQueryHex);
    expect(hex(encodedMetadataQuery)).toBe(fixture.metadataQueryHex);
    expect(hex(encodedViewport)).toBe(fixture.viewportProjectionHex);
    expect(hex(encodedMetadata)).toBe(fixture.metadataProjectionHex);

    expect(decodeSpreadsheetArtifactKernelQuery(encodedViewportQuery)).toEqual({
      kind: "viewport",
      query: viewportQuery,
    });
    expect(decodeSpreadsheetArtifactKernelQuery(encodedMetadataQuery)).toEqual({
      kind: "workbook-metadata",
      query: fixture.metadataQuery,
    });
    expect(decodeSpreadsheetArtifactKernelProjection(encodedViewport)).toEqual({
      kind: "viewport",
      projection: viewportProjection,
    });
    expect(decodeSpreadsheetArtifactKernelProjection(encodedMetadata)).toEqual({
      kind: "workbook-metadata",
      projection: metadataProjection,
    });

    expect(assertCanonicalSpreadsheetArtifactKernelQueryBytes(encodedViewportQuery)).toBe(
      encodedViewportQuery,
    );
    expect(assertCanonicalSpreadsheetArtifactKernelProjectionBytes(encodedViewport)).toBe(
      encodedViewport,
    );
  });

  test("rejects checksum, reserved-bit, truncation, and trailing-byte drift", () => {
    const query = unhex(fixture.viewportQueryHex);
    const projection = unhex(fixture.viewportProjectionHex);

    const badQueryChecksum = query.slice();
    const checksumTail = badQueryChecksum.length - 1;
    badQueryChecksum[checksumTail] = badQueryChecksum[checksumTail]! ^ 1;
    expect(() => decodeSpreadsheetArtifactKernelQuery(badQueryChecksum)).toThrow("checksum");

    const badProjectionFlags = projection.slice();
    new DataView(badProjectionFlags.buffer).setUint16(10, 0x8000, true);
    rewriteChecksum(badProjectionFlags);
    expect(() => decodeSpreadsheetArtifactKernelProjection(badProjectionFlags)).toThrow("flags");

    expect(() => decodeSpreadsheetArtifactKernelQuery(query.subarray(0, query.length - 1))).toThrow(
      "truncated",
    );
    const trailing = new Uint8Array(projection.length + 1);
    trailing.set(projection);
    expect(() => decodeSpreadsheetArtifactKernelProjection(trailing)).toThrow("trailing");
  });

  test("round-trips canonical date projections without collapsing them into numbers", () => {
    const projection = {
      revision: 3n,
      sheetId: viewportQuery.sheetId,
      generationId: null,
      startRow: 0,
      startColumn: 0,
      rowCount: 1,
      columnCount: 1,
      cells: [
        {
          row: 0,
          column: 0,
          formula: "=DATE(2026,8,9)",
          value: { kind: "date", value: "2026-08-09T00:00:00.000Z" },
        },
      ],
    } satisfies SpreadsheetArtifactViewportProjection;
    expect(
      decodeSpreadsheetArtifactKernelProjection(
        encodeSpreadsheetViewportKernelProjection(projection),
      ),
    ).toEqual({ kind: "viewport", projection });

    expect(() =>
      encodeSpreadsheetViewportKernelProjection({
        ...projection,
        cells: [
          {
            ...projection.cells[0],
            value: { kind: "date", value: "2026-08-09" },
          },
        ],
      } as SpreadsheetArtifactViewportProjection),
    ).toThrow(/canonical/u);

    const validWire = encodeSpreadsheetViewportKernelProjection({
      ...projection,
      cells: [
        {
          row: 0,
          column: 0,
          formula: null,
          value: { kind: "date", value: "2026-08-09T12:34:56.789Z" },
        },
      ],
    });
    for (const invalid of [-8_640_000_000_000_001n, 8_640_000_000_000_001n]) {
      const malformed = replaceUniqueI64(validWire, 1_786_278_896_789n, invalid);
      rewriteChecksum(malformed);
      expect(() => decodeSpreadsheetArtifactKernelProjection(malformed)).toThrow(/date.*range/iu);
    }
  });
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function rewriteChecksum(bytes: Uint8Array): void {
  const checksumOffset = bytes.byteLength - 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let checksum = 0xcbf29ce484222325n;
  for (const byte of bytes.subarray(0, checksumOffset)) {
    checksum ^= BigInt(byte);
    checksum = BigInt.asUintN(64, checksum * 0x100000001b3n);
  }
  view.setBigUint64(checksumOffset, checksum, true);
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
