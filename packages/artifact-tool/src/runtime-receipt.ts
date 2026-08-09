import {
  ARTIFACT_RUNTIME_TARGETS,
  ArtifactRuntimeError,
  artifactRuntimeTarget,
  type ArtifactRuntimeTarget,
} from "./runtime";

const NATIVE_ASSET = "opengeni_artifact_kernel.node";
const WASM_RUNTIME_FILES = [
  "artifact_kernel.js",
  "artifact_kernel_bg.wasm",
  "artifact_kernel_document.js",
  "artifact_kernel_document_bg.wasm",
  "artifact_kernel_presentation.js",
  "artifact_kernel_presentation_bg.wasm",
  "artifact_kernel_spreadsheet.js",
  "artifact_kernel_spreadsheet_bg.wasm",
] as const;
const MAX_CAPABILITIES_BYTES = 1024 * 1024;

export type ArtifactKernelBuildReceipt = Readonly<{
  schemaVersion: 1;
  producer: "opengeni-artifact-kernel-smoke-v1";
  target: ArtifactRuntimeTarget;
  kind: "native" | "wasm";
  buildIdentity: string;
  capabilities: Readonly<{
    bytes: number;
    sha256: `sha256:${string}`;
  }>;
  runtimeFiles: readonly Readonly<{
    path: string;
    bytes: number;
    sha256: `sha256:${string}`;
  }>[];
}>;

export function validateArtifactKernelBuildReceipt(
  value: unknown,
  expectedTarget?: ArtifactRuntimeTarget,
): ArtifactKernelBuildReceipt {
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "producer",
      "target",
      "kind",
      "buildIdentity",
      "capabilities",
      "runtimeFiles",
    ],
    "target build receipt",
  );
  if (record.schemaVersion !== 1 || record.producer !== "opengeni-artifact-kernel-smoke-v1") {
    invalid("target build receipt schema/producer is invalid");
  }
  if (
    typeof record.target !== "string" ||
    !ARTIFACT_RUNTIME_TARGETS.includes(record.target as ArtifactRuntimeTarget)
  ) {
    invalid("target build receipt target is invalid");
  }
  const descriptor = artifactRuntimeTarget(record.target as ArtifactRuntimeTarget);
  if (expectedTarget !== undefined && descriptor.target !== expectedTarget) {
    invalid(`target build receipt ${descriptor.target} does not match ${expectedTarget}`);
  }
  if (record.kind !== descriptor.kind) invalid("target build receipt kind is invalid");
  if (
    typeof record.buildIdentity !== "string" ||
    record.buildIdentity.length === 0 ||
    record.buildIdentity.length > 512
  ) {
    invalid("target build receipt identity is invalid");
  }
  const capabilities = fileProof(record.capabilities, "target build capabilities", false);
  if (capabilities.bytes > MAX_CAPABILITIES_BYTES) {
    invalid("target build capabilities exceed their maximum size");
  }
  if (
    !Array.isArray(record.runtimeFiles) ||
    record.runtimeFiles.length === 0 ||
    record.runtimeFiles.length > 8
  ) {
    invalid("target build receipt runtimeFiles is invalid");
  }
  const runtimeFiles = record.runtimeFiles.map((entry, index) =>
    fileProof(entry, `target build runtime file ${index}`, true),
  );
  if (
    !runtimeFiles.every((entry, index) => index === 0 || runtimeFiles[index - 1]!.path < entry.path)
  ) {
    invalid("target build receipt runtimeFiles must be strictly sorted");
  }
  const expectedPaths = descriptor.kind === "native" ? [NATIVE_ASSET] : WASM_RUNTIME_FILES;
  if (JSON.stringify(runtimeFiles.map(({ path }) => path)) !== JSON.stringify(expectedPaths)) {
    invalid("target build receipt runtimeFiles do not match the target package");
  }
  return {
    schemaVersion: 1,
    producer: "opengeni-artifact-kernel-smoke-v1",
    target: descriptor.target,
    kind: descriptor.kind,
    buildIdentity: record.buildIdentity,
    capabilities: { bytes: capabilities.bytes, sha256: capabilities.sha256 },
    runtimeFiles,
  };
}

export function canonicalArtifactKernelBuildReceiptBytes(value: unknown): Uint8Array {
  const receipt = validateArtifactKernelBuildReceipt(value);
  return new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`);
}

function fileProof(
  value: unknown,
  name: string,
  includePath: true,
): { path: string; bytes: number; sha256: `sha256:${string}` };
function fileProof(
  value: unknown,
  name: string,
  includePath: false,
): { bytes: number; sha256: `sha256:${string}` };
function fileProof(value: unknown, name: string, includePath: boolean) {
  const record = exactRecord(
    value,
    includePath ? ["path", "bytes", "sha256"] : ["bytes", "sha256"],
    name,
  );
  const bytes = record.bytes;
  const digest = record.sha256;
  if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0) invalid(`${name} bytes is invalid`);
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    invalid(`${name} digest is invalid`);
  }
  if (!includePath) return { bytes: bytes as number, sha256: digest as `sha256:${string}` };
  const path = record.path;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("/") ||
    path.includes("\\") ||
    path === "." ||
    path === ".."
  ) {
    invalid(`${name} path is invalid`);
  }
  return { path, bytes: bytes as number, sha256: digest as `sha256:${string}` };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${name} is invalid`);
  }
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    invalid(`${name} has unexpected fields`);
  }
  return record;
}

function invalid(message: string): never {
  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_MANIFEST_INVALID", message);
}
