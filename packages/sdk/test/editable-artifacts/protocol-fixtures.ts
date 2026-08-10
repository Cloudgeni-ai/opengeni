import { createHash } from "node:crypto";
import {
  EDITABLE_ARTIFACT_INTENT_VERSION,
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  decodeSpreadsheetArtifactCommandBatch,
  editableArtifactStableId,
  encodeSpreadsheetArtifactCommandBatch,
  hashEditableArtifactMutationIntent,
  spreadsheetSheetId,
} from "@opengeni/contracts/editable-artifacts";
import type {
  EditableArtifactCausalFrontier,
  EditableArtifactSpreadsheetCommittedTransaction,
  EditableArtifactSpreadsheetPendingTransaction,
} from "../../src/editable-artifacts/types";

const encoder = new TextEncoder();
const TEST_SHEET_ID = spreadsheetSheetId("10000000000000010000000000000001");
const TEST_SHEET_CREATION_ID = editableArtifactStableId("20000000000000010000000000000001");

export function testStateHash(value: string | number): string {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

export function testStableId(value: string | number): string {
  const digest = createHash("sha256").update(String(value)).digest("hex").slice(0, 32).split("");
  if (digest.slice(0, 16).every((character) => character === "0")) digest[0] = "1";
  if (digest.slice(16).every((character) => character === "0")) digest[16] = "1";
  return digest.join("");
}

export function testCommand(input: number | Uint8Array): Uint8Array {
  const values = typeof input === "number" ? new Uint8Array([input]) : input;
  if (values.byteLength === 0) throw new TypeError("test command requires at least one value");
  return encodeSpreadsheetArtifactCommandBatch({
    version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
    commands: [
      {
        kind: "cells.set",
        sheet: {
          kind: "generation",
          sheetId: TEST_SHEET_ID,
          creationOperationId: TEST_SHEET_CREATION_ID,
        },
        anchor: { row: 0, column: 0 },
        rows: 1,
        columns: values.byteLength,
        cells: [...values],
      },
    ],
  });
}

export function testCommandFirstValue(bytes: Uint8Array): number {
  const command = decodeSpreadsheetArtifactCommandBatch(bytes).commands[0];
  if (command?.kind !== "cells.set" || typeof command.cells[0] !== "number") {
    throw new TypeError("test command is not the expected numeric cell write");
  }
  return command.cells[0];
}

export function testPending(input: {
  artifactId: string;
  clientTransactionId: string;
  replicaId: string;
  replicaCounter: number;
  previousLocalTransactionId?: string | null;
  observedHeadSequence?: number;
  causalBase?: EditableArtifactCausalFrontier;
  selectiveUndoTargets?: readonly string[];
  commandBytes?: Uint8Array;
  protocolVersion?: number;
  modelSchemaVersion?: number;
  commandVersion?: number;
  createdAt?: number;
}): EditableArtifactSpreadsheetPendingTransaction {
  const commandBytes = input.commandBytes ?? testCommand(input.replicaCounter & 0xff);
  const protocolVersion = input.protocolVersion ?? 1;
  const modelSchemaVersion = input.modelSchemaVersion ?? 1;
  const commandVersion = input.commandVersion ?? 1;
  const causalBase = input.causalBase ?? [];
  const selectiveUndoTargets = input.selectiveUndoTargets ?? [];
  const previousLocalTransactionId = input.previousLocalTransactionId ?? null;
  const authored = hashEditableArtifactMutationIntent({
    envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
    protocolVersion,
    modelSchemaVersion,
    commandProtocolVersion: commandVersion,
    artifactId: input.artifactId,
    clientTransactionId: input.clientTransactionId,
    replicaId: input.replicaId,
    replicaCounter: input.replicaCounter,
    previousLocalTransactionId,
    observedHeadSequence: input.observedHeadSequence ?? 0,
    causalBase,
    selectiveUndoOperationIds: selectiveUndoTargets,
    commandBytes,
  });
  return {
    modality: "spreadsheet",
    artifactId: input.artifactId,
    clientTransactionId: input.clientTransactionId,
    requestHash: authored.requestHash,
    protocolVersion,
    modelSchemaVersion,
    commandVersion,
    replicaId: input.replicaId,
    replicaCounter: input.replicaCounter,
    previousLocalTransactionId,
    observedHeadSequence: input.observedHeadSequence ?? 0,
    causalBase: causalBase.map((entry) => ({ ...entry })),
    selectiveUndoTargets: [...selectiveUndoTargets],
    commandBytes: commandBytes.slice(),
    intentBytes: authored.bytes,
    createdAt: input.createdAt ?? input.replicaCounter,
  };
}

export function testCommitted(input: {
  artifactId: string;
  transactionId?: string;
  requestHash?: string;
  startSequence: number;
  endSequence: number;
  priorStateHash: string;
  stateHash: string;
  causalFrontier: EditableArtifactCausalFrontier;
  dot?: Readonly<{ replicaId: string; counter: number }>;
  resolvedCausalBase?: EditableArtifactCausalFrontier;
  protocolVersion?: number;
}): EditableArtifactSpreadsheetCommittedTransaction {
  const transactionId =
    input.transactionId && /^(?!0{32}$)[a-f0-9]{32}$/u.test(input.transactionId)
      ? input.transactionId
      : testStableId(input.transactionId ?? `transaction:${input.startSequence}`);
  const dot = input.dot ??
    input.causalFrontier.at(-1) ?? { replicaId: "0000000000000001", counter: 1 };
  const committedTransactionBytes = encodeTestCommittedTransaction({
    transactionId,
    dot,
    resolvedCausalBase: input.resolvedCausalBase ?? [],
    operationIds: [testStableId(`operation:${transactionId}`)],
    priorStateHash: input.priorStateHash,
    resultingCausalFrontier: input.causalFrontier,
    stateHash: input.stateHash,
  });
  return {
    modality: "spreadsheet",
    artifactId: input.artifactId,
    transactionId,
    requestHash: input.requestHash ?? testStateHash(`request:${input.startSequence}`),
    startSequence: input.startSequence,
    endSequence: input.endSequence,
    priorStateHash: input.priorStateHash,
    stateHash: input.stateHash,
    causalFrontier: input.causalFrontier.map((entry) => ({ ...entry })),
    protocolVersion: input.protocolVersion ?? 1,
    committedTransactionBytes,
  };
}

type TestCommittedTransactionInput = Readonly<{
  transactionId: string;
  dot: Readonly<{ replicaId: string; counter: number }>;
  resolvedCausalBase: EditableArtifactCausalFrontier;
  operationIds: readonly string[];
  priorStateHash: string;
  resultingCausalFrontier: EditableArtifactCausalFrontier;
  stateHash: string;
}>;

/** Test-only OGACO encoder. Production authors these bytes only in Rust. */
export function encodeTestCommittedTransaction(input: TestCommittedTransactionInput): Uint8Array {
  const payload = new TestCommittedWriter()
    .stableId(input.transactionId)
    .u64(BigInt(`0x${input.dot.replicaId}`))
    .u64(BigInt(input.dot.counter))
    .frontier(input.resolvedCausalBase)
    .hash(input.priorStateHash);
  for (const operationId of input.operationIds) {
    payload.stableId(operationId).u8(5).stableId(operationId);
  }
  payload.frontier(input.resultingCausalFrontier).hash(input.stateHash);
  const payloadBytes = payload.finish();
  const envelope = new TestCommittedWriter()
    .raw(encoder.encode("OGACO001"))
    .u16(1)
    .u16(0)
    .u32(input.operationIds.length)
    .u64(BigInt(payloadBytes.byteLength))
    .raw(payloadBytes)
    .raw(new Uint8Array(8))
    .finish();
  const payloadEnd = envelope.byteLength - 8;
  new DataView(envelope.buffer).setBigUint64(
    payloadEnd,
    fnv1a64(envelope.subarray(0, payloadEnd)),
    true,
  );
  return envelope;
}

class TestCommittedWriter {
  private readonly bytes: number[] = [];
  raw(bytes: Uint8Array): this {
    this.bytes.push(...bytes);
    return this;
  }
  u8(value: number): this {
    this.bytes.push(value & 0xff);
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
    return this.u32(Number(value & 0xffff_ffffn)).u32(Number((value >> 32n) & 0xffff_ffffn));
  }
  stableId(value: string): this {
    return this.u64(BigInt(`0x${value.slice(16)}`)).u64(BigInt(`0x${value.slice(0, 16)}`));
  }
  frontier(entries: EditableArtifactCausalFrontier): this {
    this.u32(entries.length);
    for (const entry of entries) {
      this.u64(BigInt(`0x${entry.replicaId}`)).u64(BigInt(entry.counter));
    }
    return this;
  }
  hash(value: string): this {
    const hex = value.slice("sha256:".length);
    for (let index = 0; index < hex.length; index += 2) {
      this.bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
    }
    return this;
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function fnv1a64(bytes: Uint8Array): bigint {
  let digest = 0xcbf2_9ce4_8422_2325n;
  for (const byte of bytes) {
    digest ^= BigInt(byte);
    digest = (digest * 0x100_0000_01b3n) & 0xffff_ffff_ffff_ffffn;
  }
  return digest;
}
