import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { encodeArtifactReplicaNamespace } from "../../../../src/runtime.ts";

const nativePath = process.env.OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH;
if (!nativePath) {
  throw new Error("OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH must point to a packaged .node addon");
}

const addon = createRequire(import.meta.url)(resolve(nativePath));
assert.deepEqual(Object.keys(addon).sort(), [
  "ArtifactCollaborationSession",
  "ArtifactDocumentSession",
  "ArtifactKernelSession",
  "ArtifactPresentationSession",
  "ArtifactTextLayoutSession",
  "applyCommands",
  "applyDocumentCommands",
  "applyPresentationCommands",
  "buildIdentity",
  "canonicalizeCollaborationSnapshot",
  "canonicalizeDocumentSnapshot",
  "canonicalizePresentationSnapshot",
  "canonicalizeRenderPatch",
  "canonicalizeRenderTile",
  "canonicalizeSnapshot",
  "capabilities",
  "createDocument",
  "createPresentation",
  "createWorkbook",
  "layoutText",
  "query",
  "queryDocument",
  "queryPresentation",
]);

const createSheetEnvelope = (namespace, counter, name) => {
  const encodedName = Buffer.from(name);
  const payload = Buffer.alloc(1 + 16 + 4 + encodedName.length);
  payload[0] = 0;
  payload.writeBigUInt64LE(counter, 1);
  payload.writeBigUInt64LE(namespace, 9);
  payload.writeUInt32LE(encodedName.length, 17);
  encodedName.copy(payload, 21);

  const envelope = Buffer.alloc(24 + payload.length + 8);
  envelope.write("OGAKC001", 0, "ascii");
  envelope.writeUInt16LE(1, 8);
  envelope.writeUInt32LE(1, 12);
  envelope.writeBigUInt64LE(BigInt(payload.length), 16);
  payload.copy(envelope, 24);
  envelope.writeBigUInt64LE(
    checksum(envelope.subarray(0, 24 + payload.length)),
    24 + payload.length,
  );
  return envelope;
};

const namespace = 42n;
const namespaceBytes = encodeArtifactReplicaNamespace(namespace);
const commandBytes = createSheetEnvelope(namespace, 2n, "Summary");
const metadataQuery = encodeMetadataQuery(16, 4096);
const collaborationIntent = Buffer.from(
  "4f47415458303031010001000100010020003131313131313131313131313131313131313131313131313131313131313131110062696e64696e672e7061726974792e76311000303030303030303030303030343534350100000000000000000000000000000000000000003c0000004f4741534330303101000000010000001c0000000000000000020000000000000045450000000000000600000050617269747900d2d2aa22ef1d9d0a",
  "hex",
);
const emptyFrontier = Buffer.from("4f4741434630303101000000000000003fb3b04f29ccf857", "hex");

const capabilities = JSON.parse(addon.capabilities().toString("utf8"));
assert.equal(capabilities.abiVersion, 1);
assert.equal(capabilities.transport, "bounded-uint8array");
assert.equal(capabilities.sessionForks, true);
assert.equal(capabilities.canonicalStateHash, "sha256:canonical-snapshot");
assert.equal(capabilities.textLayout, true);
assert.equal(capabilities.textLayoutStatefulSessions, true);
assert.ok(Buffer.isBuffer(addon.buildIdentity()));

const fontBundle = Buffer.from(
  readFileSync(new URL("../../fixtures/text-layout-font.hex", import.meta.url), "utf8").trim(),
  "hex",
);
const textRequest = Buffer.from(
  readFileSync(new URL("../../fixtures/text-layout-request.hex", import.meta.url), "utf8").trim(),
  "hex",
);
const expectedTextHash = readFileSync(
  new URL("../../fixtures/text-layout-response.sha256", import.meta.url),
  "utf8",
).trim();
const textLayout = addon.layoutText(fontBundle, textRequest);
assert.ok(Buffer.isBuffer(textLayout));
assert.equal(createHash("sha256").update(textLayout).digest("hex"), expectedTextHash);
const textSession = addon.ArtifactTextLayoutSession.open(fontBundle);
assert.deepEqual(textSession.layout(textRequest), textLayout);
textSession.close();
textSession.dispose();
assert.equal(textSession.isClosed(), true);
assert.throws(() => textSession.layout(textRequest), /\[ARTIFACT_SESSION_CLOSED\] /);

const initial = addon.createWorkbook(namespaceBytes);
const initialMetadata = addon.query(initial, metadataQuery);
assert.ok(Buffer.isBuffer(initialMetadata));
assert.equal(initialMetadata.subarray(0, 8).toString("ascii"), "OGAKV001");
const stateless = addon.applyCommands(initial, commandBytes);
assert.ok(Buffer.isBuffer(stateless));
assert.notDeepEqual(stateless, initial);
assert.deepEqual(addon.canonicalizeSnapshot(stateless), stateless);

const session = addon.ArtifactKernelSession.create(namespaceBytes);
const branch = session.fork();
assert.match(branch.stateHash(), /^sha256:[0-9a-f]{64}$/);
branch.applyCommands(commandBytes);
assert.equal(session.revision(), 0n);
assert.equal(branch.revision(), 1n);
assert.notEqual(branch.stateHash(), session.stateHash());
branch.dispose();
const receipt = session.applyCommands(commandBytes);
assert.ok(Buffer.isBuffer(receipt));
assert.ok(receipt.length > 0);
assert.equal(session.revision(), 1n);
assert.equal(session.closed, false);
assert.deepEqual(session.snapshot(), stateless);
assert.deepEqual(session.query(metadataQuery), addon.query(stateless, metadataQuery));
assert.match(session.stateHash(), /^sha256:[0-9a-f]{64}$/);
assert.deepEqual(addon.ArtifactKernelSession.open(stateless).snapshot(), stateless);
session.close();
session.dispose();
assert.equal(session.closed, true);
assert.throws(() => session.snapshot(), /\[ARTIFACT_SESSION_CLOSED\] /);

const collaborationNamespace = encodeArtifactReplicaNamespace(0x4545n);
const collaboration = addon.ArtifactCollaborationSession.create(collaborationNamespace);
const collaborationReplay = addon.ArtifactCollaborationSession.create(collaborationNamespace);
const committed = collaboration.authorTransaction(collaborationIntent, emptyFrontier);
collaborationReplay.applyCommitted(committed);
collaborationReplay.applyCommitted(committed);
assert.deepEqual(collaborationReplay.snapshot(), collaboration.snapshot());
assert.deepEqual(collaborationReplay.frontier(), collaboration.frontier());
assert.equal(collaborationReplay.stateHash(), collaboration.stateHash());
assert.deepEqual(collaborationReplay.query(metadataQuery), collaboration.query(metadataQuery));
const collaborationBranch = collaboration.fork();
assert.deepEqual(collaborationBranch.snapshot(), collaboration.snapshot());
collaborationBranch.dispose();
const collaborationSnapshot = collaboration.snapshot();
assert.deepEqual(
  addon.canonicalizeCollaborationSnapshot(collaborationSnapshot),
  collaborationSnapshot,
);
assert.equal(collaboration.revision(), 1n);
collaborationReplay.dispose();
collaboration.dispose();
assert.equal(collaboration.isClosed(), true);

const documentSession = addon.ArtifactDocumentSession.create(
  encodeArtifactReplicaNamespace(0x5151n),
);
assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(documentSession)).sort(), [
  "applyCommands",
  "close",
  "constructor",
  "dispose",
  "fork",
  "isClosed",
  "query",
  "revision",
  "snapshot",
  "stateHash",
]);
assert.equal(documentSession.revision(), 0n);
assert.match(documentSession.stateHash(), /^sha256:[0-9a-f]{64}$/);
const documentBranch = documentSession.fork();
assert.deepEqual(documentBranch.snapshot(), documentSession.snapshot());
documentBranch.dispose();
documentSession.close();
documentSession.dispose();
assert.equal(documentSession.isClosed(), true);
assert.throws(() => documentSession.snapshot(), /\[ARTIFACT_SESSION_CLOSED\] /);

assert.throws(
  () => addon.canonicalizeSnapshot(Buffer.from([0])),
  (error) => /^\[ARTIFACT_[A-Z_]+\] /.test(error.message),
);

function checksum(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function encodeMetadataQuery(maxSheets, maxBytes) {
  const envelope = Buffer.alloc(36);
  envelope.write("OGAKQ001", 0, "ascii");
  envelope.writeUInt16LE(1, 8);
  envelope[12] = 1;
  envelope.writeUInt32LE(maxSheets, 16);
  envelope.writeUInt32LE(maxBytes, 20);
  envelope.writeUInt32LE(0, 24);
  envelope.writeBigUInt64LE(checksum(envelope.subarray(0, 28)), 28);
  return envelope;
}

console.log(
  JSON.stringify({
    abiVersion: capabilities.abiVersion,
    exports: Object.keys(addon).sort(),
    receiptBytes: receipt.length,
    snapshotBytes: stateless.length,
    textLayoutBytes: textLayout.length,
  }),
);
