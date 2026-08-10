import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeArtifactReplicaNamespace } from "../../../../src/runtime";

const outputDirectory = resolve(Bun.argv[2] ?? "");
const modality = Bun.argv[3];
if (!Bun.argv[2] || !isModality(modality)) {
  throw new Error(
    "usage: bun run scripts/smoke-modality.ts <output directory> <spreadsheet|document|presentation>",
  );
}

const outputName = `artifact_kernel_${modality}`;
const moduleUrl = `${pathToFileURL(resolve(outputDirectory, `${outputName}.js`)).href}?smoke=${Date.now()}`;
const kernel = await import(moduleUrl);
const wasm = await Bun.file(resolve(outputDirectory, `${outputName}_bg.wasm`)).arrayBuffer();
await kernel.default({ module_or_path: wasm });

const capabilities = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(kernel.capabilities()),
) as Record<string, unknown>;
const expected = {
  collaboration: modality === "spreadsheet",
  document: modality === "document",
  documentStatefulSessions: modality === "document",
  presentation: modality === "presentation",
  presentationStatefulSessions: modality === "presentation",
  textLayout: false,
  textLayoutStatefulSessions: false,
  workbookMetadataQueries: modality === "spreadsheet",
};
for (const [name, value] of Object.entries(expected)) {
  if (capabilities[name] !== value) {
    throw new Error(`${modality} capability ${name} is not ${value}`);
  }
}
assertBytes("build identity", kernel.buildIdentity());

const namespace = encodeArtifactReplicaNamespace(0x4f47n);
const sessionClass =
  modality === "spreadsheet"
    ? kernel.ArtifactCollaborationSession
    : modality === "document"
      ? kernel.ArtifactDocumentSession
      : kernel.ArtifactPresentationSession;
const canonicalize =
  modality === "spreadsheet"
    ? kernel.canonicalizeCollaborationSnapshot
    : modality === "document"
      ? kernel.canonicalizeDocumentSnapshot
      : kernel.canonicalizePresentationSnapshot;
if (typeof sessionClass?.create !== "function" || typeof canonicalize !== "function") {
  throw new Error(`${modality} module lacks its stateful ABI`);
}
const session = sessionClass.create(namespace);
try {
  const snapshot = session.snapshot();
  assertBytes("snapshot", snapshot);
  assertEqualBytes("canonical snapshot", canonicalize(snapshot), snapshot);
  const branch = session.fork();
  try {
    if (branch.stateHash() !== session.stateHash()) {
      throw new Error(`${modality} fork hash differs`);
    }
  } finally {
    branch.free();
  }
  session.close();
  session.dispose();
  if (!session.isClosed()) throw new Error(`${modality} session did not close`);
} finally {
  session.free();
}

function isModality(value: unknown): value is "spreadsheet" | "document" | "presentation" {
  return value === "spreadsheet" || value === "document" || value === "presentation";
}

function assertBytes(label: string, value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`${label} is not a non-empty Uint8Array`);
  }
}

function assertEqualBytes(label: string, actual: Uint8Array, reference: Uint8Array): void {
  if (actual.byteLength !== reference.byteLength) throw new Error(`${label} length differs`);
  for (let index = 0; index < actual.byteLength; index += 1) {
    if (actual[index] !== reference[index]) throw new Error(`${label} differs at ${index}`);
  }
}
