import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeArtifactReplicaNamespace } from "../../../../src/runtime";

const outputDirectory = resolve(Bun.argv[2] ?? "");
if (!Bun.argv[2]) {
  throw new Error("usage: bun run scripts/smoke.ts <wasm-bindgen web output directory>");
}

const moduleUrl = pathToFileURL(resolve(outputDirectory, "artifact_kernel.js")).href;
const kernel = await import(moduleUrl);
const wasm = await Bun.file(resolve(outputDirectory, "artifact_kernel_bg.wasm")).arrayBuffer();
await kernel.default({ module_or_path: wasm });

const namespace = encodeArtifactReplicaNamespace(7n);
const emptyCommands = encodeEmptyCommandBatch();
const metadataQuery = encodeMetadataQuery(16, 4096);
const collaborationIntent = unhex(
  "4f47415458303031010001000100010020003131313131313131313131313131313131313131313131313131313131313131110062696e64696e672e7061726974792e76311000303030303030303030303030343534350100000000000000000000000000000000000000003c0000004f4741534330303101000000010000001c0000000000000000020000000000000045450000000000000600000050617269747900d2d2aa22ef1d9d0a",
);
const emptyFrontier = unhex("4f4741434630303101000000000000003fb3b04f29ccf857");
const capabilities = kernel.capabilities();
const identity = kernel.buildIdentity();
const initial = kernel.createWorkbook(namespace);
const canonical = kernel.canonicalizeSnapshot(initial);
const statelessApplied = kernel.applyCommands(initial, emptyCommands);
const statelessMetadata = kernel.query(initial, metadataQuery);

assertBytes("capabilities", capabilities);
assertBytes("build identity", identity);
assertBytes("created snapshot", initial);
assertBytes("canonical snapshot", canonical);
assertBytes("stateless apply snapshot", statelessApplied);
assertBytes("stateless metadata projection", statelessMetadata);
assertEqualBytes("canonical round trip", initial, canonical);
assertEqualBytes("empty stateless apply", initial, statelessApplied);

const fontBundle = unhex(
  (await Bun.file(resolve(import.meta.dir, "../../fixtures/text-layout-font.hex")).text()).trim(),
);
const textRequest = unhex(
  (
    await Bun.file(resolve(import.meta.dir, "../../fixtures/text-layout-request.hex")).text()
  ).trim(),
);
const expectedTextHash = (
  await Bun.file(resolve(import.meta.dir, "../../fixtures/text-layout-response.sha256")).text()
).trim();
const textLayout = kernel.layoutText(fontBundle, textRequest);
assertBytes("text layout", textLayout);
if ((await sha256Hex(textLayout)) !== expectedTextHash) {
  throw new Error("text layout golden hash differs");
}
const textSession = kernel.ArtifactTextLayoutSession.open(fontBundle);
try {
  assertEqualBytes("stateful text layout", textLayout, textSession.layout(textRequest));
  textSession.close();
  textSession.dispose();
  if (!textSession.isClosed()) throw new Error("text layout session did not close");
} finally {
  textSession.free();
}

const session = kernel.ArtifactKernelSession.open(initial);
try {
  if (session.revision() !== 0n || session.isClosed()) {
    throw new Error("session revision/lifecycle ABI mismatch");
  }
  const receipt = session.applyCommands(emptyCommands);
  const branch = session.fork();
  try {
    if (branch.stateHash() !== session.stateHash()) {
      throw new Error("session fork state hash differs before mutation");
    }
  } finally {
    branch.free();
  }
  const sessionSnapshot = session.snapshot();
  const sessionMetadata = session.query(metadataQuery);
  assertBytes("session receipt", receipt);
  assertBytes("session snapshot", sessionSnapshot);
  assertEqualBytes("stateful metadata query", statelessMetadata, sessionMetadata);
  assertEqualBytes("stateful empty apply", initial, sessionSnapshot);
} finally {
  session.free();
}

const collaborationNamespace = encodeArtifactReplicaNamespace(0x4545n);
const collaboration = kernel.ArtifactCollaborationSession.create(collaborationNamespace);
const collaborationReplay = kernel.ArtifactCollaborationSession.create(collaborationNamespace);
try {
  const committed = collaboration.authorTransaction(collaborationIntent, emptyFrontier);
  collaborationReplay.applyCommitted(committed);
  collaborationReplay.applyCommitted(committed);
  assertEqualBytes(
    "collaboration replay snapshot",
    collaborationReplay.snapshot(),
    collaboration.snapshot(),
  );
  assertEqualBytes(
    "collaboration replay frontier",
    collaborationReplay.frontier(),
    collaboration.frontier(),
  );
  if (collaborationReplay.stateHash() !== collaboration.stateHash()) {
    throw new Error("collaboration replay state hash differs");
  }
  const branch = collaboration.fork();
  try {
    assertEqualBytes("collaboration fork snapshot", branch.snapshot(), collaboration.snapshot());
  } finally {
    branch.free();
  }
  const collaborationSnapshot = collaboration.snapshot();
  assertEqualBytes(
    "collaboration canonical snapshot",
    collaborationSnapshot,
    kernel.canonicalizeCollaborationSnapshot(collaborationSnapshot),
  );
  assertEqualBytes(
    "collaboration metadata query",
    collaborationReplay.query(metadataQuery),
    collaboration.query(metadataQuery),
  );
  if (collaboration.revision() !== 1n) {
    throw new Error("collaboration revision ABI mismatch");
  }
} finally {
  collaborationReplay.free();
  collaboration.free();
}

const createdSession = kernel.ArtifactKernelSession.create(namespace);
try {
  assertEqualBytes("stateful create", initial, createdSession.snapshot());
  if (!/^sha256:[0-9a-f]{64}$/.test(createdSession.stateHash())) {
    throw new Error("session state hash ABI mismatch");
  }
  createdSession.close();
  createdSession.dispose();
  if (!createdSession.isClosed()) {
    throw new Error("session close/dispose is not idempotent");
  }
  let closedError = "";
  try {
    createdSession.snapshot();
  } catch (error) {
    closedError = error instanceof Error ? error.message : String(error);
  }
  if (!closedError.startsWith("[ARTIFACT_SESSION_CLOSED] ")) {
    throw new Error(`closed session error missing: ${JSON.stringify(closedError)}`);
  }
} finally {
  createdSession.free();
}

let errorMessage = "";
try {
  kernel.canonicalizeSnapshot(new Uint8Array([0xff]));
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
}
if (!/^\[[A-Z_]+\] /.test(errorMessage)) {
  throw new Error(`stable protocol error code missing: ${JSON.stringify(errorMessage)}`);
}

console.log(
  JSON.stringify({
    exports: Object.keys(kernel)
      .filter((name) => name !== "default")
      .sort(),
    capabilitiesBytes: capabilities.length,
    identityBytes: identity.length,
    snapshotBytes: initial.length,
    textLayoutBytes: textLayout.length,
  }),
);

function encodeEmptyCommandBatch(): Uint8Array {
  const envelope = new Uint8Array(32);
  envelope.set(new TextEncoder().encode("OGAKC001"));
  const view = new DataView(envelope.buffer);
  view.setUint16(8, 1, true);
  view.setUint32(12, 0, true);
  view.setBigUint64(16, 0n, true);
  view.setBigUint64(24, checksum(envelope.subarray(0, 24)), true);
  return envelope;
}

function unhex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function encodeMetadataQuery(maxSheets: number, maxBytes: number): Uint8Array {
  const envelope = new Uint8Array(36);
  envelope.set(new TextEncoder().encode("OGAKQ001"));
  const view = new DataView(envelope.buffer);
  view.setUint16(8, 1, true);
  envelope[12] = 1;
  view.setUint32(16, maxSheets, true);
  view.setUint32(20, maxBytes, true);
  view.setUint32(24, 0, true);
  view.setBigUint64(28, checksum(envelope.subarray(0, 28)), true);
  return envelope;
}

function checksum(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function assertBytes(label: string, value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new Error(`${label} is not a non-empty Uint8Array`);
  }
}

function assertEqualBytes(label: string, left: Uint8Array, right: Uint8Array): void {
  if (left.length !== right.length || !left.every((byte, index) => byte === right[index])) {
    throw new Error(`${label} differs`);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
