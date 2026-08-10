import { describe, expect, test } from "bun:test";

import {
  decodeCommittedTransactionSummary,
  MAX_COMMITTED_TRANSACTION_BYTES,
} from "@opengeni/contracts/editable-artifact-committed-transaction";
import fixture from "./fixtures/editable-artifact-spreadsheet-v1.json";

const encoder = new TextEncoder();
const U32_MASK = 0xffff_ffffn;

describe("OGACO001 committed transaction metadata", () => {
  test("matches the exact shared Rust-authored OGACO001 golden", () => {
    const summary = decodeCommittedTransactionSummary(unhex(fixture.committedHex));

    expect(summary).toEqual({
      operationProtocolVersion: 1,
      transactionId: fixture.expectedTransactionId,
      dot: {
        replicaId: fixture.intent.replicaId,
        counter: fixture.intent.replicaCounter,
      },
      resolvedCausalBase: fixture.resolvedFrontier,
      operationIds: fixture.expectedOperationIds,
      priorStateHash: fixture.priorStateHash,
      resultingCausalFrontier: fixture.resultingFrontier,
      stateHash: fixture.resultingStateHash,
    });
  });

  test("validates every operation body and returns only frozen metadata", () => {
    const decodedFixture = canonicalFixture();
    const original = decodedFixture.bytes.slice();

    const summary = decodeCommittedTransactionSummary(decodedFixture.bytes);

    expect(summary).toEqual(decodedFixture.expected);
    expect(decodedFixture.bytes).toEqual(original);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.dot)).toBe(true);
    expect(Object.isFrozen(summary.operationIds)).toBe(true);
    expect(Object.isFrozen(summary.resolvedCausalBase)).toBe(true);
    expect(Object.isFrozen(summary.resultingCausalFrontier)).toBe(true);

    const padded = new Uint8Array(decodedFixture.bytes.length + 19);
    padded.set(decodedFixture.bytes, 11);
    expect(
      decodeCommittedTransactionSummary(padded.subarray(11, 11 + decodedFixture.bytes.length)),
    ).toEqual(decodedFixture.expected);
  });

  test("rejects envelope/header corruption before parsing payload metadata", () => {
    const { bytes } = canonicalFixture();

    const badMagic = bytes.slice();
    badMagic[0] = badMagic[0]! ^ 1;
    expect(() => decodeCommittedTransactionSummary(badMagic)).toThrow("magic");

    const badVersion = mutateAndChecksum(bytes, (view) => view.setUint16(8, 2, true));
    expect(() => decodeCommittedTransactionSummary(badVersion)).toThrow("version");

    const badFlags = mutateAndChecksum(bytes, (view) => view.setUint16(10, 1, true));
    expect(() => decodeCommittedTransactionSummary(badFlags)).toThrow("reserved");

    const zeroOperations = mutateAndChecksum(bytes, (view) => view.setUint32(12, 0, true));
    expect(() => decodeCommittedTransactionSummary(zeroOperations)).toThrow("operation count");

    const badChecksum = bytes.slice();
    badChecksum[badChecksum.length - 1] = badChecksum[badChecksum.length - 1]! ^ 1;
    expect(() => decodeCommittedTransactionSummary(badChecksum)).toThrow("checksum");

    expect(() => decodeCommittedTransactionSummary(bytes.subarray(0, bytes.length - 1))).toThrow(
      "truncated",
    );
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeCommittedTransactionSummary(trailing)).toThrow("trailing");
    expect(() =>
      decodeCommittedTransactionSummary(new Uint8Array(MAX_COMMITTED_TRANSACTION_BYTES + 1)),
    ).toThrow("byte limit");
  });

  test("uses generic stable ids for transactions/operations and strict ids for sheets", () => {
    const unsafeDot = envelope({ dotCounter: 9_007_199_254_740_992n });
    expect(() => decodeCommittedTransactionSummary(unsafeDot)).toThrow("safe integer");

    expect(
      decodeCommittedTransactionSummary(envelope({ transactionNamespace: 0n })).transactionId,
    ).toBe(stableText(0n, 0x800n));
    expect(
      decodeCommittedTransactionSummary(envelope({ transactionCounter: 0n })).transactionId,
    ).toBe(stableText(0x700n, 0n));
    expect(() =>
      decodeCommittedTransactionSummary(
        envelope({ transactionNamespace: 0n, transactionCounter: 0n }),
      ),
    ).toThrow("all-zero");

    expect(
      decodeCommittedTransactionSummary(envelope({ operationIds: [[0n, 1n]] })).operationIds,
    ).toEqual([stableText(0n, 1n)]);

    const invalidSheet = new FixtureWriter().u8(0).stableId(0n, 1n).string("Sheet").u8(0).finish();
    expectInvalidCommand(invalidSheet, "nonzero namespace and counter");

    const unsorted = envelope({
      base: [
        [2n, 1n],
        [1n, 1n],
      ],
    });
    expect(() => decodeCommittedTransactionSummary(unsorted)).toThrow("strictly ordered");

    const operation = undoCommand(0x99n, 1n);
    const duplicate = envelope({
      commands: [operation, operation],
      operationIds: [
        [0x44n, 1n],
        [0x44n, 1n],
      ],
    });
    expect(() => decodeCommittedTransactionSummary(duplicate)).toThrow("must be unique");
  });

  test("rejects malformed typed operations instead of skipping by guessed offsets", () => {
    expectInvalidCommand(new Uint8Array([0xff]), "command tag");

    const invalidUtf8 = new FixtureWriter()
      .u8(1)
      .generation(0x10n, 1n, 0x20n, 1n)
      .u32(1)
      .u8(0x80)
      .finish();
    expectInvalidCommand(invalidUtf8, "UTF-8");

    expectInvalidCommand(setOneNumber(-0), "negative zero");
    expectInvalidCommand(setOneNumber(Number.NaN), "finite");

    const zeroRows = setCellsHeader(0, 1).finish();
    expectInvalidCommand(zeroRows, "nonzero");

    const coordinateOverflow = new FixtureWriter()
      .u8(3)
      .generation(0x10n, 1n, 0x20n, 1n)
      .u32(0xffff_ffff)
      .u32(0)
      .u32(2)
      .u32(1)
      .finish();
    expectInvalidCommand(coordinateOverflow, "overflow");

    const reversedRange = new FixtureWriter()
      .u8(4)
      .generation(0x10n, 1n, 0x20n, 1n)
      .u32(2)
      .u32(4)
      .u32(1)
      .u32(5)
      .finish();
    expectInvalidCommand(reversedRange, "not normalized");
  });

  test("rejects shared mutable input", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const shared = new Uint8Array(new SharedArrayBuffer(64));
    expect(() => decodeCommittedTransactionSummary(shared)).toThrow("shared mutable memory");
  });
});

function canonicalFixture(): {
  bytes: Uint8Array;
  expected: ReturnType<typeof decodeCommittedTransactionSummary>;
} {
  const sheetNamespace = 0x101n;
  const sheetCounter = 0x202n;
  const creationNamespace = 0x303n;
  const creationCounter = 0x404n;
  const commands = [
    new FixtureWriter()
      .u8(0)
      .stableId(sheetNamespace, sheetCounter)
      .string("Conformance ✓")
      .u8(1)
      .generation(sheetNamespace, sheetCounter, creationNamespace, creationCounter)
      .finish(),
    new FixtureWriter()
      .u8(1)
      .generation(sheetNamespace, sheetCounter, creationNamespace, creationCounter)
      .string("Renamed")
      .finish(),
    new FixtureWriter()
      .u8(2)
      .generation(sheetNamespace, sheetCounter, creationNamespace, creationCounter)
      .finish(),
    new FixtureWriter()
      .u8(3)
      .generation(sheetNamespace, sheetCounter, creationNamespace, creationCounter)
      .u32(255)
      .u32(255)
      .u32(2)
      .u32(4)
      .cell(null, 0)
      .cell(null, 1)
      .cell(null, 2)
      .cell(null, 3, 12.5)
      .cell(null, 4, "café")
      .cell(null, 5, 6)
      .cell("=A1*2", 3, 25)
      .cell(null, 5, { custom: "#CUSTOM!" })
      .finish(),
    new FixtureWriter()
      .u8(4)
      .generation(sheetNamespace, sheetCounter, creationNamespace, creationCounter)
      .u32(0)
      .u32(0)
      .u32(9)
      .u32(9)
      .finish(),
    undoCommand(creationNamespace, creationCounter),
  ];
  const operationIds = commands.map((_, index) => [0x500n, BigInt(index + 1)] as const);
  const priorHash = Uint8Array.from({ length: 32 }, (_, index) => index);
  const stateHash = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const base = [
    [0x11n, 5n],
    [0x22n, 9n],
  ] as const;
  const result = [...base, [0x33n, 1n] as const];
  const bytes = envelope({ commands, operationIds, base, result, priorHash, stateHash });
  return {
    bytes,
    expected: Object.freeze({
      operationProtocolVersion: 1,
      transactionId: stableText(0x700n, 0x800n),
      dot: Object.freeze({ replicaId: hex64(0x33n), counter: 1 }),
      resolvedCausalBase: Object.freeze(
        base.map(([replica, counter]) =>
          Object.freeze({ replicaId: hex64(replica), counter: Number(counter) }),
        ),
      ),
      operationIds: Object.freeze(
        operationIds.map(([namespace, counter]) => stableText(namespace, counter)),
      ),
      priorStateHash: `sha256:${hex(priorHash)}`,
      resultingCausalFrontier: Object.freeze(
        result.map(([replica, counter]) =>
          Object.freeze({ replicaId: hex64(replica), counter: Number(counter) }),
        ),
      ),
      stateHash: `sha256:${hex(stateHash)}`,
    }),
  };
}

type EnvelopeOptions = {
  transactionNamespace?: bigint;
  transactionCounter?: bigint;
  dotReplica?: bigint;
  dotCounter?: bigint;
  base?: readonly (readonly [bigint, bigint])[];
  priorHash?: Uint8Array;
  commands?: readonly Uint8Array[];
  operationIds?: readonly (readonly [bigint, bigint])[];
  result?: readonly (readonly [bigint, bigint])[];
  stateHash?: Uint8Array;
};

function envelope(options: EnvelopeOptions = {}): Uint8Array {
  const commands = options.commands ?? [undoCommand(0x99n, 1n)];
  const operationIds =
    options.operationIds ?? commands.map((_, index) => [0x44n, BigInt(index + 1)] as const);
  if (operationIds.length !== commands.length) throw new Error("fixture operation mismatch");
  const payload = new FixtureWriter()
    .stableId(options.transactionNamespace ?? 0x700n, options.transactionCounter ?? 0x800n)
    .u64(options.dotReplica ?? 0x33n)
    .u64(options.dotCounter ?? 1n)
    .frontier(options.base ?? [])
    .raw(options.priorHash ?? new Uint8Array(32));
  commands.forEach((command, index) => {
    const [namespace, counter] = operationIds[index]!;
    payload.stableId(namespace, counter).raw(command);
  });
  payload
    .frontier(options.result ?? [[options.dotReplica ?? 0x33n, options.dotCounter ?? 1n]])
    .raw(options.stateHash ?? new Uint8Array(32));
  const payloadBytes = payload.finish();
  const output = new FixtureWriter()
    .raw(encoder.encode("OGACO001"))
    .u16(1)
    .u16(0)
    .u32(commands.length)
    .u64(BigInt(payloadBytes.length))
    .raw(payloadBytes)
    .finish(CHECKSUM_PLACEHOLDER);
  refreshChecksum(output);
  return output;
}

const CHECKSUM_PLACEHOLDER = 8;

function expectInvalidCommand(command: Uint8Array, message: string): void {
  expect(() => decodeCommittedTransactionSummary(envelope({ commands: [command] }))).toThrow(
    message,
  );
}

function undoCommand(namespace: bigint, counter: bigint): Uint8Array {
  return new FixtureWriter().u8(5).stableId(namespace, counter).finish();
}

function setCellsHeader(rows: number, columns: number): FixtureWriter {
  return new FixtureWriter()
    .u8(3)
    .generation(0x10n, 1n, 0x20n, 1n)
    .u32(0)
    .u32(0)
    .u32(rows)
    .u32(columns);
}

function setOneNumber(value: number): Uint8Array {
  return setCellsHeader(1, 1).cell(null, 3, value).finish();
}

class FixtureWriter {
  readonly #bytes: number[] = [];

  raw(bytes: Uint8Array): this {
    this.#bytes.push(...bytes);
    return this;
  }

  u8(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value).u8(value >>> 8);
  }

  u32(value: number): this {
    return this.u8(value)
      .u8(value >>> 8)
      .u8(value >>> 16)
      .u8(value >>> 24);
  }

  u64(value: bigint): this {
    return this.u32(Number(value & U32_MASK)).u32(Number((value >> 32n) & U32_MASK));
  }

  stableId(namespace: bigint, counter: bigint): this {
    return this.u64(counter).u64(namespace);
  }

  generation(
    sheetNamespace: bigint,
    sheetCounter: bigint,
    operationNamespace: bigint,
    operationCounter: bigint,
  ): this {
    return this.stableId(sheetNamespace, sheetCounter).stableId(
      operationNamespace,
      operationCounter,
    );
  }

  frontier(entries: readonly (readonly [bigint, bigint])[]): this {
    this.u32(entries.length);
    for (const [replica, counter] of entries) this.u64(replica).u64(counter);
    return this;
  }

  string(value: string): this {
    const bytes = encoder.encode(value);
    return this.u32(bytes.length).raw(bytes);
  }

  f64(value: number): this {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return this.raw(bytes);
  }

  cell(
    formula: string | null,
    valueTag: number,
    value?: number | string | { custom: string },
  ): this {
    if (formula === null) this.u8(0);
    else this.u8(1).string(formula);
    this.u8(valueTag);
    if (valueTag === 3) this.f64(value as number);
    else if (valueTag === 4) this.string(value as string);
    else if (valueTag === 5) {
      if (typeof value === "object") this.u8(9).string(value.custom);
      else this.u8(value as number);
    }
    return this;
  }

  finish(trailingZeroBytes = 0): Uint8Array {
    return Uint8Array.from([...this.#bytes, ...new Array<number>(trailingZeroBytes).fill(0)]);
  }
}

function mutateAndChecksum(bytes: Uint8Array, mutate: (view: DataView) => void): Uint8Array {
  const result = bytes.slice();
  mutate(new DataView(result.buffer));
  refreshChecksum(result);
  return result;
}

function refreshChecksum(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLength = Number(view.getBigUint64(16, true));
  const payloadEnd = 24 + payloadLength;
  view.setBigUint64(payloadEnd, fnvBigInt(bytes.subarray(0, payloadEnd)), true);
}

function fnvBigInt(bytes: Uint8Array): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100_0000_01b3n) & 0xffff_ffff_ffff_ffffn;
  }
  return hash;
}

function stableText(namespace: bigint, counter: bigint): string {
  return `${hex64(namespace)}${hex64(counter)}`;
}

function hex64(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    throw new TypeError("test fixture must contain lowercase hexadecimal byte pairs");
  }
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}
