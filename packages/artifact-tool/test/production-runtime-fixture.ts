import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

import {
  ArtifactKernelRuntime,
  type ArtifactKernelPackageManifest,
  type ArtifactRuntimeTarget,
} from "../src/runtime";

const runtimeSymbol = Symbol.for("opengeni.artifact-tool.test.native-runtime");

type RuntimeGlobal = typeof globalThis & {
  [runtimeSymbol]?: ArtifactKernelRuntime;
};

export function productionTestRuntime(): ArtifactKernelRuntime {
  const shared = globalThis as RuntimeGlobal;
  if (shared[runtimeSymbol]) return shared[runtimeSymbol];
  const target = localTarget();
  const nativePath = productionTestNativeAssetPath();
  if (!existsSync(nativePath)) {
    throw new Error(`Production native test addon is missing: ${nativePath}`);
  }
  const binding = createRequire(import.meta.url)(nativePath) as {
    buildIdentity(): Uint8Array;
  };
  const buildIdentity = new TextDecoder("utf-8", { fatal: true }).decode(binding.buildIdentity());
  const runtime = new ArtifactKernelRuntime("native", binding, {
    schemaVersion: 1,
    target,
    kind: "native",
    packageName: `@opengeni/artifact-kernel-${target}`,
    packageVersion: packageJson.version,
    artifactToolVersion: packageJson.version,
    buildIdentity,
    entrypoint: {
      path: "index.js",
      bytes: 1,
      sha256: `sha256:${"1".repeat(64)}`,
    },
    asset: {
      path: "opengeni_artifact_kernel.node",
      bytes: 1,
      sha256: `sha256:${"2".repeat(64)}`,
    },
    supportFiles: [],
  } satisfies ArtifactKernelPackageManifest);
  shared[runtimeSymbol] = runtime;
  return runtime;
}

export function productionTestRuntimeAvailable(): boolean {
  const available = existsSync(productionTestNativeAssetPath());
  if (!available && process.env.OPENGENI_REQUIRE_ARTIFACT_NATIVE_TESTS === "1") {
    throw new Error(
      `Production native test addon is required but missing: ${productionTestNativeAssetPath()}`,
    );
  }
  return available;
}

export function productionTestNativeAssetPath(): string {
  const configured = process.env.OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH;
  if (configured !== undefined) {
    if (configured.length === 0 || !isAbsolute(configured)) {
      throw new Error("OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH must be a nonempty absolute path");
    }
    return configured;
  }
  return join(
    import.meta.dir,
    "..",
    "kernel",
    "bindings",
    "dist",
    "native",
    `${process.platform}-${process.arch}`,
    "opengeni_artifact_kernel.node",
  );
}

function localTarget(): ArtifactRuntimeTarget {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64-msvc";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64-gnu";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  throw new Error(`Unsupported production test target: ${process.platform}-${process.arch}`);
}
