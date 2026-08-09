import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import packageJson from "../../package.json" with { type: "json" };
import {
  ArtifactKernelRuntime,
  ArtifactRuntimeError,
  artifactRuntimeTarget,
  type ArtifactKernelPackageManifest,
  type ArtifactRuntimeTarget,
} from "../../src/runtime";
import {
  canonicalArtifactKernelBuildReceiptBytes,
  validateArtifactKernelBuildReceipt,
  type ArtifactKernelBuildReceipt,
} from "../../src/runtime-receipt";
import { resolveCurrentArtifactRuntimeTarget } from "../../src/runtime-cli";

export {
  canonicalArtifactKernelBuildReceiptBytes,
  validateArtifactKernelBuildReceipt,
  type ArtifactKernelBuildReceipt,
} from "../../src/runtime-receipt";

export const ARTIFACT_KERNEL_BUILD_RECEIPT = "artifact-kernel-build-receipt.json";
const NATIVE_ASSET = "opengeni_artifact_kernel.node";
const WASM_ASSET = "artifact_kernel_bg.wasm";
const WASM_GLUE = "artifact_kernel.js";
const WASM_RUNTIME_FILES = [
  WASM_GLUE,
  WASM_ASSET,
  "artifact_kernel_document.js",
  "artifact_kernel_document_bg.wasm",
  "artifact_kernel_presentation.js",
  "artifact_kernel_presentation_bg.wasm",
  "artifact_kernel_spreadsheet.js",
  "artifact_kernel_spreadsheet_bg.wasm",
] as const;
const MAX_RECEIPT_BYTES = 256 * 1024;

type ReceiptBinding = Readonly<{
  buildIdentity(): Uint8Array;
  capabilities(): Uint8Array;
}>;

/** Runs the actual target binding and returns a deterministic build receipt. */
export async function createArtifactKernelBuildReceipt(
  target: ArtifactRuntimeTarget,
  assetRoot: string,
): Promise<ArtifactKernelBuildReceipt> {
  const descriptor = artifactRuntimeTarget(target);
  const directory = artifactKernelTargetAssetDirectory(target, assetRoot);
  const runtimeFileNames = target === "wasm-web" ? WASM_RUNTIME_FILES : [NATIVE_ASSET];
  const runtimeFiles = await Promise.all(
    runtimeFileNames.map(async (path) =>
      fileDescriptor(path, await exactFile(join(directory, path))),
    ),
  );
  let binding: ReceiptBinding;
  if (target === "wasm-web") {
    const module = (await import(
      `${pathToFileURL(join(directory, WASM_GLUE)).href}?build-receipt=${Date.now()}`
    )) as ReceiptBinding & {
      default(input: { module_or_path: ArrayBuffer }): Promise<unknown>;
    };
    const wasmFile = await readFile(join(directory, WASM_ASSET));
    const wasmBytes = wasmFile.buffer.slice(
      wasmFile.byteOffset,
      wasmFile.byteOffset + wasmFile.byteLength,
    ) as ArrayBuffer;
    await module.default({ module_or_path: wasmBytes });
    binding = module;
  } else {
    const hostTarget = resolveCurrentArtifactRuntimeTarget();
    if (hostTarget !== target) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_UNSUPPORTED_TARGET",
        `Native receipt ${target} must be produced by a matching host; current host is ${hostTarget}`,
      );
    }
    binding = createRequire(import.meta.url)(join(directory, NATIVE_ASSET)) as ReceiptBinding;
  }

  const identityBytes = binding.buildIdentity();
  const capabilitiesBytes = binding.capabilities();
  if (!(identityBytes instanceof Uint8Array) || !(capabilitiesBytes instanceof Uint8Array)) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      "Target smoke did not return byte identity/capabilities",
    );
  }
  const buildIdentity = new TextDecoder("utf-8", { fatal: true }).decode(identityBytes);
  const manifest: ArtifactKernelPackageManifest = {
    schemaVersion: 1,
    target,
    kind: descriptor.kind,
    packageName: descriptor.packageName,
    packageVersion: packageJson.version,
    artifactToolVersion: packageJson.version,
    buildIdentity,
    entrypoint: fileDescriptor("receipt-probe.js", new Uint8Array([1])),
    asset: runtimeFiles.find(
      ({ path }) => path === (target === "wasm-web" ? WASM_ASSET : NATIVE_ASSET),
    )!,
    supportFiles: runtimeFiles.filter(
      ({ path }) => path !== (target === "wasm-web" ? WASM_ASSET : NATIVE_ASSET),
    ),
  };
  // This validates the complete ABI/capability surface and exact build identity
  // against the binding that produced the receipt, then immediately discards
  // the probe wrapper without creating model state.
  const validatedRuntime = new ArtifactKernelRuntime(descriptor.kind, binding, manifest);
  void validatedRuntime;
  return validateArtifactKernelBuildReceipt(
    {
      schemaVersion: 1,
      producer: "opengeni-artifact-kernel-smoke-v1",
      target,
      kind: descriptor.kind,
      buildIdentity,
      capabilities: {
        bytes: capabilitiesBytes.byteLength,
        sha256: sha256(capabilitiesBytes),
      },
      runtimeFiles,
    },
    target,
  );
}

export async function writeArtifactKernelBuildReceipt(
  target: ArtifactRuntimeTarget,
  assetRoot: string,
): Promise<string> {
  const receipt = await createArtifactKernelBuildReceipt(target, assetRoot);
  const directory = artifactKernelTargetAssetDirectory(target, assetRoot);
  await mkdir(directory, { recursive: true });
  const path = join(directory, ARTIFACT_KERNEL_BUILD_RECEIPT);
  await writeFile(path, canonicalArtifactKernelBuildReceiptBytes(receipt));
  return path;
}

export async function readArtifactKernelBuildReceipt(
  target: ArtifactRuntimeTarget,
  assetRoot: string,
): Promise<ArtifactKernelBuildReceipt> {
  const path = join(
    artifactKernelTargetAssetDirectory(target, assetRoot),
    ARTIFACT_KERNEL_BUILD_RECEIPT,
  );
  let bytes: Uint8Array;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_RECEIPT_BYTES) {
      throw new Error("receipt size is invalid");
    }
    bytes = new Uint8Array(await readFile(path));
    if (bytes.byteLength !== metadata.size) throw new Error("receipt changed while reading");
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      `Target build receipt is missing: ${path}`,
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      `Target build receipt is not strict UTF-8 JSON: ${path}`,
      { cause },
    );
  }
  const receipt = validateArtifactKernelBuildReceipt(parsed, target);
  if (!sameBytes(bytes, canonicalArtifactKernelBuildReceiptBytes(receipt))) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      `Target build receipt is not canonical: ${path}`,
    );
  }
  return receipt;
}

export function artifactKernelTargetAssetDirectory(
  target: ArtifactRuntimeTarget,
  assetRoot: string,
): string {
  return target === "wasm-web" ? join(assetRoot, "wasm-web") : join(assetRoot, "native", target);
}

async function exactFile(path: string): Promise<Uint8Array> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 512 * 1024 * 1024) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      `Receipt input is invalid: ${path}`,
    );
  }
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength !== metadata.size) {
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_INTEGRITY", `Receipt input changed: ${path}`);
  }
  return bytes;
}

function fileDescriptor(path: string, bytes: Uint8Array) {
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}
