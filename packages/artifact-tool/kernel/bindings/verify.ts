import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ArtifactKernelRuntime,
  artifactRuntimeTarget,
  encodeArtifactReplicaNamespace,
  type ArtifactKernelPackageManifest,
  type ArtifactRuntimeTarget,
} from "../../src/runtime";
import { resolveCurrentArtifactRuntimeTarget } from "../../src/runtime-cli";
import packageJson from "../../package.json" with { type: "json" };

const root = import.meta.dir;
const nativePath = process.env.OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH;
const wasmDirectory = process.env.OPENGENI_ARTIFACT_KERNEL_WASM_WEB_DIR;
if (!nativePath || !wasmDirectory) {
  throw new Error(
    "Set OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH and OPENGENI_ARTIFACT_KERNEL_WASM_WEB_DIR, or run bindings/build.ts.",
  );
}

const fixtureProcess = Bun.spawn(
  [
    "cargo",
    "run",
    "--locked",
    "--quiet",
    "--manifest-path",
    resolve(root, "protocol", "Cargo.toml"),
    "--bin",
    "conformance_fixture",
  ],
  { cwd: root, stdout: "pipe", stderr: "inherit" },
);
const fixtureText = await new Response(fixtureProcess.stdout).text();
if ((await fixtureProcess.exited) !== 0) throw new Error("Direct-kernel fixture generation failed");
const fixture = JSON.parse(fixtureText) as Record<
  | "buildIdentity"
  | "namespace"
  | "command"
  | "initial"
  | "expected"
  | "negativeZeroSnapshot"
  | "formulaNamespace"
  | "formulaInitialCommand"
  | "formulaIncrementalCommand"
  | "formulaInitial"
  | "formulaAfterInitial"
  | "formulaAfterIncremental",
  string
>;
const command = fromHex(fixture.command);
const directInitial = fromHex(fixture.initial);
const directExpected = fromHex(fixture.expected);
const negativeZeroSnapshot = fromHex(fixture.negativeZeroSnapshot);
const formulaNamespace = fromHex(fixture.formulaNamespace);
const formulaInitialCommand = fromHex(fixture.formulaInitialCommand);
const formulaIncrementalCommand = fromHex(fixture.formulaIncrementalCommand);
const formulaInitial = fromHex(fixture.formulaInitial);
const formulaAfterInitial = fromHex(fixture.formulaAfterInitial);
const formulaAfterIncremental = fromHex(fixture.formulaAfterIncremental);

const native = createRequire(import.meta.url)(resolve(nativePath));
const wasmModuleUrl = `${pathToFileURL(resolve(wasmDirectory, "artifact_kernel.js")).href}?verify=${Date.now()}`;
const wasm = await import(wasmModuleUrl);
const wasmBytes = await Bun.file(resolve(wasmDirectory, "artifact_kernel_bg.wasm")).arrayBuffer();
await wasm.default({ module_or_path: wasmBytes });

assertBytesEqual("native identity == wasm", native.buildIdentity(), wasm.buildIdentity());
assertBytesEqual(
  "native identity == direct Rust",
  native.buildIdentity(),
  fromHex(fixture.buildIdentity),
);
const buildIdentity = new TextDecoder("utf-8", { fatal: true }).decode(native.buildIdentity());
const nativeRuntime = new ArtifactKernelRuntime(
  "native",
  native,
  probeManifest(resolveCurrentArtifactRuntimeTarget(), buildIdentity),
);
const wasmRuntime = new ArtifactKernelRuntime(
  "wasm",
  wasm,
  probeManifest("wasm-web", buildIdentity),
);
assert.equal(nativeRuntime.capabilities.abiVersion, wasmRuntime.capabilities.abiVersion);
assert.ok(nativeRuntime.capabilities.maxSnapshotBytes > wasmRuntime.capabilities.maxSnapshotBytes);
const nativeCapabilities = JSON.parse(new TextDecoder().decode(native.capabilities())) as Record<
  string,
  unknown
>;
const wasmCapabilities = JSON.parse(new TextDecoder().decode(wasm.capabilities())) as Record<
  string,
  unknown
>;
assert.deepEqual(Object.keys(nativeCapabilities).sort(), Object.keys(wasmCapabilities).sort());
for (const key of Object.keys(nativeCapabilities)) {
  if (
    ![
      "maxCellsPerBatch",
      "maxCommandBytes",
      "maxDocumentCommandBytes",
      "maxDocumentSnapshotBytes",
      "maxPresentationSnapshotBytes",
      "maxSnapshotBytes",
      "maxTextLayoutFontBundleBytes",
      "maxTextLayoutRequestBytes",
      "maxTextLayoutResponseBytes",
    ].includes(key)
  ) {
    assert.equal(nativeCapabilities[key], wasmCapabilities[key], `capability ${key}`);
  }
}

assert.ok(
  (nativeCapabilities.maxTextLayoutFontBundleBytes as number) >
    (wasmCapabilities.maxTextLayoutFontBundleBytes as number),
);

const fontBundle = fromHex(
  (await Bun.file(resolve(root, "fixtures", "text-layout-font.hex")).text()).trim(),
);
const textRequest = fromHex(
  (await Bun.file(resolve(root, "fixtures", "text-layout-request.hex")).text()).trim(),
);
const expectedTextHash = (
  await Bun.file(resolve(root, "fixtures", "text-layout-response.sha256")).text()
).trim();
const nativeText = nativeRuntime.layoutText(fontBundle, textRequest);
const wasmText = wasmRuntime.layoutText(fontBundle, textRequest);
assertBytesEqual("native text layout == wasm", nativeText, wasmText);
assert.equal(await sha256Hex(nativeText), expectedTextHash);
const nativeTextSession = nativeRuntime.openTextLayoutSession(fontBundle);
const wasmTextSession = wasmRuntime.openTextLayoutSession(fontBundle);
try {
  assertBytesEqual(
    "native stateful text layout == stateless",
    nativeTextSession.layout(textRequest),
    nativeText,
  );
  assertBytesEqual(
    "wasm stateful text layout == stateless",
    wasmTextSession.layout(textRequest),
    wasmText,
  );
} finally {
  nativeTextSession.dispose();
  wasmTextSession.dispose();
}

const namespaceValue = 0x0123_4567_89ab_cdefn;
assertBytesEqual(
  "TypeScript namespace == direct Rust",
  encodeArtifactReplicaNamespace(namespaceValue),
  fromHex(fixture.namespace),
);
const namespace = encodeArtifactReplicaNamespace(namespaceValue);
const nativeInitial = native.createWorkbook(namespace);
const wasmInitial = wasm.createWorkbook(namespace);
assertBytesEqual("native initial == direct kernel", nativeInitial, directInitial);
assertBytesEqual("wasm initial == direct kernel", wasmInitial, directInitial);

const nativeStateless = native.applyCommands(nativeInitial, command);
const wasmStateless = wasm.applyCommands(wasmInitial, command);
assertBytesEqual("native stateless == direct kernel", nativeStateless, directExpected);
assertBytesEqual("wasm stateless == direct kernel", wasmStateless, directExpected);
assert.throws(
  () => native.canonicalizeSnapshot(negativeZeroSnapshot),
  /\[ARTIFACT_INVALID_SNAPSHOT\] .*negative zero/,
);
assert.throws(
  () => wasm.canonicalizeSnapshot(negativeZeroSnapshot),
  /\[ARTIFACT_INVALID_SNAPSHOT\] .*negative zero/,
);

const nativeSession = native.ArtifactKernelSession.open(nativeInitial);
const wasmSession = wasm.ArtifactKernelSession.open(wasmInitial);
try {
  assert.equal(nativeSession.stateHash(), wasmSession.stateHash());
  assert.equal(nativeSession.stateHash(), await sha256Text(directInitial));
  const nativeBranch = nativeSession.fork();
  const wasmBranch = wasmSession.fork();
  try {
    nativeBranch.applyCommands(command);
    wasmBranch.applyCommands(command);
    assert.equal(nativeBranch.stateHash(), wasmBranch.stateHash());
    assert.equal(nativeBranch.stateHash(), await sha256Text(directExpected));
    assertBytesEqual("native fork == direct kernel", nativeBranch.snapshot(), directExpected);
    assertBytesEqual("wasm fork == direct kernel", wasmBranch.snapshot(), directExpected);
    assertBytesEqual("native source unchanged after fork", nativeSession.snapshot(), directInitial);
    assertBytesEqual("wasm source unchanged after fork", wasmSession.snapshot(), directInitial);
  } finally {
    disposeRawSession(nativeBranch);
    disposeRawSession(wasmBranch);
  }
  const nativeReceipt = nativeSession.applyCommands(command);
  const wasmReceipt = wasmSession.applyCommands(command);
  assertBytesEqual("native receipt == wasm receipt", nativeReceipt, wasmReceipt);
  assert.equal(nativeReceipt.byteLength, 48);
  assert.equal(revisionBigInt(nativeSession.revision()), 1n);
  assert.equal(revisionBigInt(wasmSession.revision()), 1n);
  assertBytesEqual("native stateful == direct kernel", nativeSession.snapshot(), directExpected);
  assertBytesEqual("wasm stateful == direct kernel", wasmSession.snapshot(), directExpected);
  assert.equal(nativeSession.stateHash(), wasmSession.stateHash());
} finally {
  disposeRawSession(nativeSession);
  disposeRawSession(wasmSession);
}

assertBytesEqual(
  "native formula initial == direct kernel",
  native.createWorkbook(formulaNamespace),
  formulaInitial,
);
assertBytesEqual(
  "wasm formula initial == direct kernel",
  wasm.createWorkbook(formulaNamespace),
  formulaInitial,
);
const nativeFormulaStateless = native.applyCommands(formulaInitial, formulaInitialCommand);
const wasmFormulaStateless = wasm.applyCommands(formulaInitial, formulaInitialCommand);
assertBytesEqual(
  "native cross-sheet formulas == direct kernel",
  nativeFormulaStateless,
  formulaAfterInitial,
);
assertBytesEqual(
  "wasm cross-sheet formulas == direct kernel",
  wasmFormulaStateless,
  formulaAfterInitial,
);
assertBytesEqual(
  "native incremental formulas == direct kernel",
  native.applyCommands(nativeFormulaStateless, formulaIncrementalCommand),
  formulaAfterIncremental,
);
assertBytesEqual(
  "wasm incremental formulas == direct kernel",
  wasm.applyCommands(wasmFormulaStateless, formulaIncrementalCommand),
  formulaAfterIncremental,
);
const nativeFormulaSession = native.ArtifactKernelSession.open(formulaInitial);
const wasmFormulaSession = wasm.ArtifactKernelSession.open(formulaInitial);
try {
  assertBytesEqual(
    "native formula initial receipt == wasm",
    nativeFormulaSession.applyCommands(formulaInitialCommand),
    wasmFormulaSession.applyCommands(formulaInitialCommand),
  );
  assertBytesEqual(
    "native formula incremental receipt == wasm",
    nativeFormulaSession.applyCommands(formulaIncrementalCommand),
    wasmFormulaSession.applyCommands(formulaIncrementalCommand),
  );
  assertBytesEqual(
    "native stateful formulas == direct kernel",
    nativeFormulaSession.snapshot(),
    formulaAfterIncremental,
  );
  assertBytesEqual(
    "wasm stateful formulas == direct kernel",
    wasmFormulaSession.snapshot(),
    formulaAfterIncremental,
  );
} finally {
  disposeRawSession(nativeFormulaSession);
  disposeRawSession(wasmFormulaSession);
}

const collaborationIntent = fromHex(
  "4f47415458303031010001000100010020003131313131313131313131313131313131313131313131313131313131313131110062696e64696e672e7061726974792e76311000303030303030303030303030343534350100000000000000000000000000000000000000003c0000004f4741534330303101000000010000001c0000000000000000020000000000000045450000000000000600000050617269747900d2d2aa22ef1d9d0a",
);
const emptyFrontier = fromHex("4f4741434630303101000000000000003fb3b04f29ccf857");
const metadataQuery = fromHex(
  "4f47414b5130303101000000010000000700000000080000000000007ee599fc5e1006e6",
);
const nativeCollaboration = nativeRuntime.createCollaborationSession(0x4545n);
const wasmCollaboration = wasmRuntime.createCollaborationSession(0x4545n);
const nativeReplay = nativeRuntime.createCollaborationSession(0x4545n);
const wasmReplay = wasmRuntime.createCollaborationSession(0x4545n);
try {
  const nativeCommitted = nativeCollaboration.authorTransaction(collaborationIntent, emptyFrontier);
  const wasmCommitted = wasmCollaboration.authorTransaction(collaborationIntent, emptyFrontier);
  assertBytesEqual("native OGACO == wasm", nativeCommitted, wasmCommitted);
  nativeReplay.applyCommitted(nativeCommitted);
  wasmReplay.applyCommitted(wasmCommitted);
  nativeReplay.applyCommitted(nativeCommitted);
  wasmReplay.applyCommitted(wasmCommitted);
  assertBytesEqual(
    "native collaboration snapshot == wasm",
    nativeCollaboration.snapshot(),
    wasmCollaboration.snapshot(),
  );
  assertBytesEqual(
    "native replay snapshot == wasm",
    nativeReplay.snapshot(),
    wasmReplay.snapshot(),
  );
  assertBytesEqual(
    "native collaboration frontier == wasm",
    nativeCollaboration.frontier(),
    wasmCollaboration.frontier(),
  );
  assert.equal(nativeCollaboration.stateHash(), wasmCollaboration.stateHash());
  assert.equal(nativeCollaboration.revision(), wasmCollaboration.revision());
  assertBytesEqual(
    "native collaboration query == wasm",
    nativeCollaboration.query(metadataQuery),
    wasmCollaboration.query(metadataQuery),
  );
  assertBytesEqual(
    "native canonical collaboration snapshot == wasm",
    nativeRuntime.canonicalizeCollaborationSnapshot(nativeCollaboration.snapshot()),
    wasmRuntime.canonicalizeCollaborationSnapshot(wasmCollaboration.snapshot()),
  );
  const nativeBranch = nativeCollaboration.fork();
  const wasmBranch = wasmCollaboration.fork();
  try {
    assertBytesEqual(
      "native collaboration fork == wasm",
      nativeBranch.snapshot(),
      wasmBranch.snapshot(),
    );
    assertBytesEqual(
      "native collaboration fork frontier == wasm",
      nativeBranch.frontier(),
      wasmBranch.frontier(),
    );
  } finally {
    nativeBranch.dispose();
    wasmBranch.dispose();
  }
} finally {
  nativeCollaboration.dispose();
  wasmCollaboration.dispose();
  nativeReplay.dispose();
  wasmReplay.dispose();
}

const zeroNamespace = encodeUncheckedNamespace(0n);
assert.throws(() => native.createWorkbook(zeroNamespace), /\[ARTIFACT_INVALID_NAMESPACE\] /);
assert.throws(() => wasm.createWorkbook(zeroNamespace), /\[ARTIFACT_INVALID_NAMESPACE\] /);

console.log(
  JSON.stringify({
    collaboration: "byte-identical",
    formula: "cross-sheet-range-cycle-error-byte-identical",
    directSnapshotBytes: directExpected.byteLength,
    native: "byte-identical",
    sessionFork: "independent",
    stateHash: "byte-identical",
    statefulReceiptBytes: 48,
    textLayout: "byte-identical",
    wasm: "byte-identical",
  }),
);

function probeManifest(
  target: ArtifactRuntimeTarget,
  probedBuildIdentity: string,
): ArtifactKernelPackageManifest {
  const descriptor = artifactRuntimeTarget(target);
  const sha256 = `sha256:${"0".repeat(64)}` as const;
  return {
    schemaVersion: 1,
    target,
    kind: descriptor.kind,
    packageName: descriptor.packageName,
    packageVersion: packageJson.version,
    artifactToolVersion: packageJson.version,
    buildIdentity: probedBuildIdentity,
    entrypoint: { path: "probe.js", bytes: 1, sha256 },
    asset: { path: "probe.bin", bytes: 1, sha256 },
    supportFiles: [],
  };
}

function revisionBigInt(value: bigint | number): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Unsafe kernel revision");
  return BigInt(value);
}

function disposeRawSession(session: { close(): void; dispose?(): void; free?(): void }): void {
  try {
    if (typeof session.dispose === "function") session.dispose();
    else session.close();
  } finally {
    session.free?.();
  }
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) throw new Error("Invalid fixture hex");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function assertBytesEqual(label: string, actual: Uint8Array, expected: Uint8Array): void {
  assert.ok(actual instanceof Uint8Array, `${label}: output is not Uint8Array`);
  assert.equal(actual.byteLength, expected.byteLength, `${label}: length`);
  assert.ok(
    actual.every((byte, index) => byte === expected[index]),
    `${label}: content`,
  );
}

function encodeUncheckedNamespace(uncheckedNamespace: bigint): Uint8Array {
  const envelope = new Uint8Array(28);
  envelope.set(new TextEncoder().encode("OGAKN001"));
  const view = new DataView(envelope.buffer);
  view.setUint16(8, 1, true);
  view.setBigUint64(12, uncheckedNamespace, true);
  view.setBigUint64(20, checksum(envelope.subarray(0, 20)), true);
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

async function sha256Text(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
