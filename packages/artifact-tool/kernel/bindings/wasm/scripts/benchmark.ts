/* oxlint-disable eslint/no-shadow -- benchmark helper parameters intentionally mirror fixture coordinates. */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeArtifactReplicaNamespace } from "../../../../src/runtime";

const outputDirectory = resolve(Bun.argv[2] ?? "");
if (!Bun.argv[2]) {
  throw new Error("usage: bun run scripts/benchmark.ts <wasm-bindgen web output directory>");
}

const kernel = await import(
  `${pathToFileURL(resolve(outputDirectory, "artifact_kernel.js")).href}?benchmark=${Date.now()}`
);
const wasm = await Bun.file(resolve(outputDirectory, "artifact_kernel_bg.wasm")).arrayBuffer();
const instance = await kernel.default({ module_or_path: wasm });
const initialWasmHeapBytes = instance.memory.buffer.byteLength;

const namespace = 0x6265_6e63_686d_6172n;
const sheetCounter = 2n;
const viewportQuery = encodeViewportQuery(namespace, sheetCounter, 400, 0, 100, 100);
const session = kernel.ArtifactKernelSession.create(encodeArtifactReplicaNamespace(namespace));
try {
  session.applyCommands(encodeCreateAndBooleanBlock(namespace, sheetCounter, 0, 1_000, 500));
  report(session, instance.memory, viewportQuery, 500_000, 20, 5);
  session.applyCommands(encodeBooleanBlock(namespace, sheetCounter, 1_000, 1_000, 500));
  report(session, instance.memory, viewportQuery, 1_000_000, 20, 5);
  const pointEdit = encodeBooleanBlock(namespace, sheetCounter, 1_234, 1, 1);
  const editP95Ms = p95(1_000, () => {
    session.applyCommands(pointEdit);
  });
  console.log(
    JSON.stringify({
      name: "wasm_dense_random_edit_on_million_cells",
      runtime: "wasm-web",
      modelCells: 1_000_000,
      samples: 1_000,
      p95Ms: editP95Ms,
      initialWasmHeapBytes,
      wasmHeapBytes: instance.memory.buffer.byteLength,
    }),
  );
} finally {
  session.free();
}

function report(
  source: { fork(): { free(): void }; query(bytes: Uint8Array): Uint8Array; stateHash(): string },
  memory: WebAssembly.Memory,
  viewportQuery: Uint8Array,
  cells: number,
  forkSamples: number,
  hashSamples: number,
): void {
  const wasmHeapBeforeForkBytes = memory.buffer.byteLength;
  const forkP95 = p95(forkSamples, () => {
    const branch = source.fork();
    branch.free();
  });
  const hashP95 = p95(hashSamples, () => {
    if (!/^sha256:[0-9a-f]{64}$/.test(source.stateHash())) {
      throw new Error("invalid state hash");
    }
  });
  const viewportP95 = p95(50, () => {
    const response = source.query(viewportQuery);
    if (new TextDecoder().decode(response.subarray(0, 8)) !== "OGAKV001") {
      throw new Error("invalid viewport response");
    }
  });
  const retainedBranch = source.fork();
  const liveForkWasmHeapBytes = memory.buffer.byteLength;
  retainedBranch.free();
  console.log(
    JSON.stringify({
      name: "wasm_session_scale",
      cells,
      forkP95Ms: forkP95,
      hashP95Ms: hashP95,
      viewport10kP95Ms: viewportP95,
      wasmHeapBeforeForkBytes,
      wasmHeapBytes: memory.buffer.byteLength,
      liveForkWasmHeapBytes,
      runtime: "wasm-web",
    }),
  );
}

function encodeViewportQuery(
  namespace: bigint,
  sheetCounter: bigint,
  startRow: number,
  startColumn: number,
  rows: number,
  columns: number,
): Uint8Array {
  const envelope = new Uint8Array(68);
  const view = new DataView(envelope.buffer);
  envelope.set(new TextEncoder().encode("OGAKQ001"));
  view.setUint16(8, 1, true);
  view.setUint32(16, 262_144, true);
  view.setUint32(20, 8 * 1024 * 1024, true);
  view.setUint32(24, 32, true);
  writeStableId(view, 28, namespace, sheetCounter);
  view.setUint32(44, startRow, true);
  view.setUint32(48, startColumn, true);
  view.setUint32(52, rows, true);
  view.setUint32(56, columns, true);
  view.setBigUint64(60, checksum(envelope.subarray(0, 60)), true);
  return envelope;
}

function p95(samples: number, operation: () => void): number {
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now();
    operation();
    durations.push(performance.now() - start);
  }
  durations.sort((left, right) => left - right);
  return durations[Math.ceil(samples * 0.95) - 1]!;
}

function encodeCreateAndBooleanBlock(
  namespace: bigint,
  sheetCounter: bigint,
  row: number,
  rows: number,
  columns: number,
): Uint8Array {
  const name = new TextEncoder().encode("Scale");
  const create = new Uint8Array(1 + 16 + 4 + name.length);
  const createView = new DataView(create.buffer);
  create[0] = 0;
  writeStableId(createView, 1, namespace, sheetCounter);
  createView.setUint32(17, name.length, true);
  create.set(name, 21);
  return encodeEnvelope(2, [create, booleanBlock(namespace, sheetCounter, row, rows, columns)]);
}

function encodeBooleanBlock(
  namespace: bigint,
  sheetCounter: bigint,
  row: number,
  rows: number,
  columns: number,
): Uint8Array {
  return encodeEnvelope(1, [booleanBlock(namespace, sheetCounter, row, rows, columns)]);
}

function booleanBlock(
  namespace: bigint,
  sheetCounter: bigint,
  row: number,
  rows: number,
  columns: number,
): Uint8Array {
  const cells = rows * columns;
  const payload = new Uint8Array(1 + 16 + 16 + cells * 2);
  const view = new DataView(payload.buffer);
  payload[0] = 3;
  writeStableId(view, 1, namespace, sheetCounter);
  view.setUint32(17, row, true);
  view.setUint32(21, 0, true);
  view.setUint32(25, rows, true);
  view.setUint32(29, columns, true);
  for (let offset = 33; offset < payload.length; offset += 2) {
    payload[offset] = 0;
    payload[offset + 1] = 2;
  }
  return payload;
}

function encodeEnvelope(commandCount: number, payloads: readonly Uint8Array[]): Uint8Array {
  const payloadLength = payloads.reduce((total, payload) => total + payload.length, 0);
  const envelope = new Uint8Array(24 + payloadLength + 8);
  const view = new DataView(envelope.buffer);
  envelope.set(new TextEncoder().encode("OGAKC001"));
  view.setUint16(8, 1, true);
  view.setUint32(12, commandCount, true);
  view.setBigUint64(16, BigInt(payloadLength), true);
  let offset = 24;
  for (const payload of payloads) {
    envelope.set(payload, offset);
    offset += payload.length;
  }
  view.setBigUint64(offset, checksum(envelope.subarray(0, offset)), true);
  return envelope;
}

function writeStableId(view: DataView, offset: number, namespace: bigint, counter: bigint): void {
  view.setBigUint64(offset, counter, true);
  view.setBigUint64(offset + 8, namespace, true);
}

function checksum(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}
