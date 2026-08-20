import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import packageJson from "../packages/artifact-tool/package.json" with { type: "json" };
import {
  ARTIFACT_KERNEL_BUILD_RECEIPT,
  canonicalArtifactKernelBuildReceiptBytes,
} from "../packages/artifact-tool/kernel/bindings/package-receipt";
import type { NativeArtifactRuntimeTarget } from "../packages/artifact-tool/src/runtime";
import { resolveCurrentArtifactRuntimeTarget } from "../packages/artifact-tool/src/runtime-cli";
import {
  assertArtifactKernelRustcVersion,
  developmentArtifactRuntimeSourceFingerprint,
  prepareDevelopmentArtifactRuntime,
} from "./prepare-development-artifact-runtime";

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalDirectRustLog = process.env.FAKE_DIRECT_RUST_LOG;
let directRustLog = "";

beforeEach(async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "opengeni-development-rust-"));
  roots.push(root);
  const binRoot = join(root, "bin");
  const toolchainBinRoot = join(root, "toolchain-bin");
  directRustLog = join(root, "direct-rust.log");
  await Promise.all([
    mkdir(binRoot, { recursive: true }),
    mkdir(toolchainBinRoot, { recursive: true }),
  ]);
  for (const tool of ["cargo", "rustc"] as const) {
    const path = join(toolchainBinRoot, tool);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${tool} 1.97.0 (pinned fixture)'\n`);
    await chmod(path, 0o755);
  }
  const rustup = join(binRoot, "rustup");
  await writeFile(
    rustup,
    `#!/bin/sh
set -eu
if [ "$1" = run ] && [ "$3" = rustc ]; then
  printf '%s\\n' 'rustc 1.97.0 (pinned fixture)'
elif [ "$1" = run ] && [ "$3" = cargo ]; then
  printf '%s\\n' 'cargo 1.97.0 (pinned fixture)'
elif [ "$1" = which ] && [ "$2" = --toolchain ] && [ "$3" = 1.97.0 ]; then
  case "$4" in
    cargo) printf '%s\\n' '${join(toolchainBinRoot, "cargo")}' ;;
    rustc) printf '%s\\n' '${join(toolchainBinRoot, "rustc")}' ;;
    *) exit 2 ;;
  esac
elif [ "$1" = target ] && [ "$2" = list ]; then
  printf '%s\\n' 'wasm32-unknown-unknown'
else
  exit 2
fi
`,
  );
  await chmod(rustup, 0o755);
  for (const tool of ["cargo", "rustc"] as const) {
    const path = join(binRoot, tool);
    await writeFile(
      path,
      `#!/bin/sh\nprintf '%s\\n' '${tool}' >> "$FAKE_DIRECT_RUST_LOG"\nexit 97\n`,
    );
    await chmod(path, 0o755);
  }
  process.env.PATH = `${binRoot}${delimiter}${originalPath ?? ""}`;
  process.env.FAKE_DIRECT_RUST_LOG = directRustLog;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalDirectRustLog === undefined) delete process.env.FAKE_DIRECT_RUST_LOG;
  else process.env.FAKE_DIRECT_RUST_LOG = originalDirectRustLog;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("development artifact runtime preparation", () => {
  test("accepts only the exact pinned compiler identity", () => {
    expect(() =>
      assertArtifactKernelRustcVersion("rustc 1.97.0 (2d8144b78 2026-07-07)\n", "1.97.0"),
    ).not.toThrow();
    expect(() => assertArtifactKernelRustcVersion("rustc 1.96.0 (host default)", "1.97.0")).toThrow(
      "Artifact kernel requires Rust 1.97.0; pinned compiler reported rustc 1.96.0",
    );
  });

  test("assembles a clean output from a matching current-host receipt and reuses it exactly", async () => {
    const fixture = await createRepositoryFixture();
    const first = await prepareDevelopmentArtifactRuntime({
      repositoryRoot: fixture.repositoryRoot,
      assetRoot: fixture.assetRoot,
      outputRoot: fixture.outputRoot,
      buildIfNeeded: false,
      doctor: false,
    });
    expect(first).toMatchObject({ rebuiltKernel: false, reusedInstallation: false });
    expect(await Bun.file(first.manifestPath).exists()).toBe(true);
    expect(await Bun.file(first.skillFacadeEntrypoint).exists()).toBe(true);
    expect(await Bun.file(first.materializerExecutable).exists()).toBe(true);

    const second = await prepareDevelopmentArtifactRuntime({
      repositoryRoot: fixture.repositoryRoot,
      assetRoot: fixture.assetRoot,
      outputRoot: fixture.outputRoot,
      buildIfNeeded: false,
      doctor: false,
    });
    expect(second).toMatchObject({ rebuiltKernel: false, reusedInstallation: true });
    expect(second.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(await Bun.file(directRustLog).exists()).toBe(false);
  });

  test("detects changed source and refuses to reuse or fabricate a stale receipt", async () => {
    const fixture = await createRepositoryFixture();
    await prepareDevelopmentArtifactRuntime({
      repositoryRoot: fixture.repositoryRoot,
      assetRoot: fixture.assetRoot,
      outputRoot: fixture.outputRoot,
      buildIfNeeded: false,
      doctor: false,
    });
    await writeFile(
      join(fixture.repositoryRoot, "packages/artifact-tool/kernel/src/lib.rs"),
      "changed source",
    );
    await expect(
      prepareDevelopmentArtifactRuntime({
        repositoryRoot: fixture.repositoryRoot,
        assetRoot: fixture.assetRoot,
        outputRoot: fixture.outputRoot,
        buildIfNeeded: false,
        doctor: false,
      }),
    ).rejects.toThrow("absent or stale");
  });

  test("treats post-receipt native byte tampering as stale", async () => {
    const fixture = await createRepositoryFixture();
    await writeFile(
      join(fixture.assetRoot, "native", currentTarget(), "opengeni_artifact_kernel.node"),
      "tampered-after-smoke",
    );
    await expect(
      prepareDevelopmentArtifactRuntime({
        repositoryRoot: fixture.repositoryRoot,
        assetRoot: fixture.assetRoot,
        outputRoot: fixture.outputRoot,
        buildIfNeeded: false,
        doctor: false,
      }),
    ).rejects.toThrow("absent or stale");
  });

  test("refuses any destructive output outside the ignored local runtime root", async () => {
    const fixture = await createRepositoryFixture();
    for (const outputRoot of [
      fixture.repositoryRoot,
      join(fixture.repositoryRoot, ".opengeni"),
      join(fixture.repositoryRoot, "packages", "artifact-tool"),
    ]) {
      await expect(
        prepareDevelopmentArtifactRuntime({
          repositoryRoot: fixture.repositoryRoot,
          assetRoot: fixture.assetRoot,
          outputRoot,
          buildIfNeeded: false,
          doctor: false,
        }),
      ).rejects.toThrow("ignored .opengeni root");
    }
  });
});

async function createRepositoryFixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "opengeni-development-clean-"));
  roots.push(repositoryRoot);
  const files: Record<string, string> = {
    "bun.lock": '{"lockfileVersion":1,"configVersion":1,"workspaces":{}}\n',
    "tsconfig.base.json": "{}\n",
    "packages/artifact-tool/package.json": JSON.stringify({
      name: "@opengeni/artifact-tool",
      version: packageJson.version,
    }),
    "packages/artifact-tool/src/materializer-cli-entry.ts":
      '#!/usr/bin/env bun\nprocess.stdout.write("fixture");\n',
    "packages/artifact-tool/src/runtime-receipt.ts": "// fixture\n",
    "packages/contracts/package.json": JSON.stringify({
      name: "@opengeni/contracts",
      version: packageJson.version,
    }),
    "packages/contracts/src/index.ts": "export const fixture = true;\n",
    "packages/artifact-tool/kernel/Cargo.toml": "[workspace]\n",
    "packages/artifact-tool/kernel/Cargo.lock": "fixture\n",
    "packages/artifact-tool/kernel/rust-toolchain.toml": '[toolchain]\nchannel="1.97.0"\n',
    "packages/artifact-tool/kernel/src/lib.rs": "pub fn fixture() {}\n",
    "packages/artifact-tool/kernel/bindings/protocol/Cargo.toml": "[package]\nname='p'\n",
    "packages/artifact-tool/kernel/bindings/protocol/Cargo.lock": "fixture\n",
    "packages/artifact-tool/kernel/bindings/protocol/build.rs": "fn main() {}\n",
    "packages/artifact-tool/kernel/bindings/protocol/src/lib.rs": "pub fn fixture() {}\n",
    "packages/artifact-tool/kernel/bindings/napi/Cargo.toml": "[package]\nname='n'\n",
    "packages/artifact-tool/kernel/bindings/napi/Cargo.lock": "fixture\n",
    "packages/artifact-tool/kernel/bindings/napi/build.rs": "fn main() {}\n",
    "packages/artifact-tool/kernel/bindings/napi/src/lib.rs": "pub fn fixture() {}\n",
    "packages/artifact-tool/kernel/bindings/napi/scripts/smoke.mjs": "// fixture\n",
    "packages/artifact-tool/kernel/bindings/package-receipt.ts": "// fixture\n",
    "scripts/materialize-artifact-kernel-packages.ts": "// fixture\n",
    "scripts/artifact-kernel-rust.ts": "// fixture\n",
    "scripts/prepare-development-artifact-runtime.ts": "// fixture\n",
  };
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(repositoryRoot, path)), { recursive: true });
    await writeFile(join(repositoryRoot, path), contents);
  }
  const target = currentTarget();
  const assetRoot = join(repositoryRoot, "bindings-dist");
  const targetRoot = join(assetRoot, "native", target);
  await mkdir(targetRoot, { recursive: true });
  const native = new TextEncoder().encode("current-host-native-fixture");
  await writeFile(join(targetRoot, "opengeni_artifact_kernel.node"), native);
  await writeFile(
    join(targetRoot, ARTIFACT_KERNEL_BUILD_RECEIPT),
    canonicalArtifactKernelBuildReceiptBytes({
      schemaVersion: 2,
      producer: "opengeni-artifact-kernel-smoke-v2",
      target,
      kind: "native",
      buildIdentity: "opengeni-artifact-kernel/clean-fixture;abi=1",
      capabilities: proof(new TextEncoder().encode("capabilities"), false),
      spreadsheetFormulaProjectionCorpusSha256: `sha256:${"f".repeat(64)}`,
      runtimeFiles: [{ path: "opengeni_artifact_kernel.node", ...proof(native, false) }],
    }),
  );
  const sourceFingerprint = await developmentArtifactRuntimeSourceFingerprint(repositoryRoot);
  await writeFile(
    join(targetRoot, "artifact-kernel-development-source.json"),
    `${JSON.stringify({ schemaVersion: 1, target, sourceFingerprint })}\n`,
  );
  return {
    repositoryRoot,
    assetRoot,
    outputRoot: join(repositoryRoot, ".opengeni", "artifact-runtime-development"),
  };
}

function currentTarget(): NativeArtifactRuntimeTarget {
  const target = resolveCurrentArtifactRuntimeTarget();
  if (target === "wasm-web") throw new Error("native host required");
  return target;
}

function proof(
  bytes: Uint8Array,
  _includePath: false,
): { bytes: number; sha256: `sha256:${string}` } {
  return {
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
