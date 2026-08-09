import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
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
  const nativePath = join(
    import.meta.dir,
    "..",
    "kernel",
    "bindings",
    "dist",
    "native",
    `${process.platform}-${process.arch}`,
    "opengeni_artifact_kernel.node",
  );
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

function localTarget(): ArtifactRuntimeTarget {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64-msvc";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64-gnu";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  throw new Error(`Unsupported production test target: ${process.platform}-${process.arch}`);
}
