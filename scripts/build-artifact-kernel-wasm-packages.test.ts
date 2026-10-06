import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertCanonicalArtifactKernelWasmRebuildHost,
  buildArtifactKernelWasmPackages,
  checkArtifactKernelWasmPackages,
  refreshArtifactKernelWasmPackageIdentities,
} from "./build-artifact-kernel-wasm-packages";

const repoRoot = resolve(import.meta.dir, "..");
const modalities = ["spreadsheet", "document", "presentation"] as const;
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

test("materializes deterministic, executable, modality-only browser packages", async () => {
  const first = await fixture();
  const second = await fixture();
  const firstBuilds = await buildArtifactKernelWasmPackages({
    assetRoot: first.assetRoot,
    outputPackagesRoot: first.packagesRoot,
  });
  const secondBuilds = await buildArtifactKernelWasmPackages({
    assetRoot: second.assetRoot,
    outputPackagesRoot: second.packagesRoot,
  });

  expect(firstBuilds.map(({ modality }) => modality)).toEqual(modalities);
  for (const [index, build] of firstBuilds.entries()) {
    const modality = modalities[index]!;
    const secondBuild = secondBuilds[index]!;
    expect(await digestTree(build.outputRoot)).toEqual(await digestTree(secondBuild.outputRoot));
    const files = await readdir(build.outputRoot);
    expect(files.sort()).toEqual(
      [
        "artifact-kernel-runtime.json",
        `artifact_kernel_${modality}.d.ts`,
        `artifact_kernel_${modality}.js`,
        `artifact_kernel_${modality}_bg.wasm`,
        `artifact_kernel_${modality}_bg.wasm.d.ts`,
        "index.d.ts",
        "index.js",
      ].sort(),
    );
    for (const other of modalities.filter((candidate) => candidate !== modality)) {
      expect(files.some((file) => file.includes(`artifact_kernel_${other}`))).toBe(false);
    }

    const entry = (await import(
      `${pathToFileURL(join(build.outputRoot, "index.js")).href}?test=${Date.now()}-${modality}`
    )) as {
      artifactKernelRuntimeIdentity: Readonly<Record<string, unknown>>;
      editableArtifactKernelRuntime: Readonly<Record<string, unknown>>;
      loadArtifactKernelBinding(): Promise<{ buildIdentity(): Uint8Array }>;
    };
    expect(entry.artifactKernelRuntimeIdentity).toEqual(build.identity);
    expect(entry.editableArtifactKernelRuntime).toMatchObject({
      modality,
      kernelVersion: build.identity.kernelVersion,
      protocolVersion: build.identity.protocolVersion,
      modelSchemaVersion: build.identity.modelSchemaVersion,
      commandVersion: build.identity.commandVersion,
    });
    const binding = await entry.loadArtifactKernelBinding();
    expect(new TextDecoder("utf-8", { fatal: true }).decode(binding.buildIdentity())).toBe(
      build.identity.buildIdentity,
    );

    const manifest = JSON.parse(await readFile(build.manifestPath, "utf8")) as {
      runtimeIdentity: unknown;
      files: Array<{ path: string; bytes: number; sha256: string }>;
      sizeBudget: { wasmBytes: number; wasmGzipBytes: number; glueBytes: number };
    };
    expect(manifest.runtimeIdentity).toEqual(build.identity);
    expect(manifest.files).toHaveLength(6);
    expect(manifest.files.every((file) => file.sha256.startsWith("sha256:"))).toBe(true);
    expect(
      manifest.files.find((file) => file.path.endsWith("_bg.wasm"))!.bytes,
    ).toBeLessThanOrEqual(manifest.sizeBudget.wasmBytes);
  }
});

test("fails closed when a required executable is missing or corrupt", async () => {
  const missing = await fixture();
  await rm(join(missing.assetRoot, "artifact_kernel_presentation_bg.wasm"));
  await expect(
    buildArtifactKernelWasmPackages({
      assetRoot: missing.assetRoot,
      outputPackagesRoot: missing.packagesRoot,
      modalities: ["presentation"],
    }),
  ).rejects.toThrow("presentation WASM is missing");

  const corrupt = await fixture();
  await writeFile(
    join(corrupt.assetRoot, "artifact_kernel_document_bg.wasm"),
    new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  await expect(
    buildArtifactKernelWasmPackages({
      assetRoot: corrupt.assetRoot,
      outputPackagesRoot: corrupt.packagesRoot,
      modalities: ["document"],
    }),
  ).rejects.toThrow();
});

test("regenerates exact version-bearing metadata for a fixed Changesets release", async () => {
  const release = await fixture("0.1.0");
  const builds = await buildArtifactKernelWasmPackages({
    assetRoot: release.assetRoot,
    artifactToolPackagePath: release.artifactToolPackagePath,
    outputPackagesRoot: release.packagesRoot,
  });
  for (const build of builds) {
    expect(build.identity.packageVersion).toBe("0.1.0");
    expect(build.identity.artifactToolVersion).toBe("0.1.0");
    const generated = await import(
      `${pathToFileURL(join(build.outputRoot, "index.js")).href}?release-version=${build.modality}`
    );
    expect(generated.artifactKernelRuntimeIdentity.packageVersion).toBe("0.1.0");
  }
});

test("version automation regenerates WASM identity without forcing peer dependents major", async () => {
  const [rootPackageRaw, changesetConfigRaw, reactPackageRaw, ciWorkflow] = await Promise.all([
    readFile(join(repoRoot, "package.json"), "utf8"),
    readFile(join(repoRoot, ".changeset/config.json"), "utf8"),
    readFile(join(repoRoot, "packages/react/package.json"), "utf8"),
    readFile(join(repoRoot, ".github/workflows/ci.yml"), "utf8"),
  ]);
  const rootPackage = JSON.parse(rootPackageRaw) as { scripts?: Record<string, string> };
  const changesetConfig = JSON.parse(changesetConfigRaw) as {
    ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH?: {
      onlyUpdatePeerDependentsWhenOutOfRange?: boolean;
    };
  };
  const reactPackage = JSON.parse(reactPackageRaw) as {
    peerDependencies?: Record<string, string>;
  };

  expect(rootPackage.scripts?.["changeset:version"]).toBe(
    "changeset version && bun scripts/release/lockstep-version.ts && bun scripts/build-artifact-kernel-wasm-packages.ts --refresh-package-identities",
  );
  expect(
    changesetConfig.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH
      ?.onlyUpdatePeerDependentsWhenOutOfRange,
  ).toBe(true);
  expect(reactPackage.peerDependencies?.["@opengeni/artifact-tool"]).toBe("^1.0.0");
  expect(
    ciWorkflow.match(
      /@changesets\/cli\/bin\.js" version\n\s+bun scripts\/release\/lockstep-version\.ts\n\s+bun scripts\/build-artifact-kernel-wasm-packages\.ts --refresh-package-identities/gu,
    ),
  ).toHaveLength(2);
});

test("refreshes version identities from tracked package assets without raw Rust output", async () => {
  const versionFixture = await fixture("0.1.0");
  await buildArtifactKernelWasmPackages({
    assetRoot: versionFixture.assetRoot,
    artifactToolPackagePath: versionFixture.artifactToolPackagePath,
    outputPackagesRoot: versionFixture.packagesRoot,
  });
  const before = await Promise.all(
    modalities.map(async (modality) => {
      const wasm = join(
        versionFixture.packagesRoot,
        `artifact-kernel-wasm-${modality}`,
        "dist",
        `artifact_kernel_${modality}_bg.wasm`,
      );
      return createHash("sha256")
        .update(await readFile(wasm))
        .digest("hex");
    }),
  );
  await rm(versionFixture.assetRoot, { recursive: true, force: true });
  await writeFile(
    versionFixture.artifactToolPackagePath,
    `${JSON.stringify({ name: "@opengeni/artifact-tool", version: "0.2.0" })}\n`,
  );
  for (const modality of modalities) {
    const packagePath = join(
      versionFixture.packagesRoot,
      `artifact-kernel-wasm-${modality}`,
      "package.json",
    );
    await writeFile(
      packagePath,
      `${JSON.stringify({
        name: `@opengeni/artifact-kernel-wasm-${modality}`,
        version: "0.2.0",
      })}\n`,
    );
  }

  const builds = await refreshArtifactKernelWasmPackageIdentities({
    artifactToolPackagePath: versionFixture.artifactToolPackagePath,
    outputPackagesRoot: versionFixture.packagesRoot,
  });

  expect(builds.map(({ identity }) => identity.packageVersion)).toEqual([
    "0.2.0",
    "0.2.0",
    "0.2.0",
  ]);
  expect(builds.map(({ identity }) => identity.artifactToolVersion)).toEqual([
    "0.2.0",
    "0.2.0",
    "0.2.0",
  ]);
  const after = await Promise.all(
    modalities.map(async (modality) => {
      const wasm = join(
        versionFixture.packagesRoot,
        `artifact-kernel-wasm-${modality}`,
        "dist",
        `artifact_kernel_${modality}_bg.wasm`,
      );
      return createHash("sha256")
        .update(await readFile(wasm))
        .digest("hex");
    }),
  );
  expect(after).toEqual(before);
});

test("restricts exact Rust byte regeneration to the canonical builder host", () => {
  const canonicalRoot = "/tmp/opengeni-artifact-wasm-source-v1";
  expect(() =>
    assertCanonicalArtifactKernelWasmRebuildHost("linux", "x64", canonicalRoot),
  ).not.toThrow();
  expect(() =>
    assertCanonicalArtifactKernelWasmRebuildHost("darwin", "arm64", canonicalRoot),
  ).toThrow("canonical linux/x64 builder");
  expect(() =>
    assertCanonicalArtifactKernelWasmRebuildHost("linux", "arm64", canonicalRoot),
  ).toThrow("canonical linux/x64 builder");
  expect(() => assertCanonicalArtifactKernelWasmRebuildHost("linux", "x64", repoRoot)).toThrow(
    canonicalRoot,
  );
});

test("retains executable rebuild evidence for every modality and still fails the byte gate", async () => {
  const rebuilt = await fixture();
  const committed = await fixture();
  const builds = await buildArtifactKernelWasmPackages({
    assetRoot: rebuilt.assetRoot,
    outputPackagesRoot: rebuilt.packagesRoot,
  });
  await buildArtifactKernelWasmPackages({
    assetRoot: committed.assetRoot,
    outputPackagesRoot: committed.packagesRoot,
  });
  const changed = join(committed.packagesRoot, "artifact-kernel-wasm-spreadsheet/dist/index.js");
  await writeFile(changed, `${await readFile(changed, "utf8")}\n`);
  const before = await digestTree(
    join(committed.packagesRoot, "artifact-kernel-wasm-spreadsheet/dist"),
  );
  const diagnosticOutput = join(committed.root, "diagnostics");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { checkArtifactKernelWasmPackages } from ${JSON.stringify(join(repoRoot, "scripts/build-artifact-kernel-wasm-packages.ts"))};
await checkArtifactKernelWasmPackages(${JSON.stringify(builds)}, ${JSON.stringify({
        committedPackagesRoot: committed.packagesRoot,
        rebuilt: true,
        assetRoot: rebuilt.assetRoot,
        diagnosticOutput,
      })});`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).not.toBe(0);
  expect(stderr).toContain("committed package differs from a clean Rust rebuild");
  expect(
    await digestTree(join(committed.packagesRoot, "artifact-kernel-wasm-spreadsheet/dist")),
  ).toEqual(before);
  const comparison = JSON.parse(
    await readFile(join(diagnosticOutput, "comparison.json"), "utf8"),
  ) as {
    schemaVersion: number;
    packages: Array<{
      identity: unknown;
      matches: boolean;
      files: Array<{
        path: string;
        matches: boolean;
        rebuiltSha256: string;
        committedSha256: string;
      }>;
    }>;
  };
  expect(comparison.schemaVersion).toBe(1);
  expect(comparison.packages.map(({ matches }) => matches)).toEqual([false, true, true]);
  expect(
    comparison.packages[0]!.files.filter(({ matches }) => !matches).map(({ path }) => path),
  ).toEqual(["index.js"]);
  for (const [index, build] of builds.entries()) {
    expect(comparison.packages[index]!.identity).toEqual(build.identity);
    expect(
      await digestTree(
        join(diagnosticOutput, "packages", `artifact-kernel-wasm-${build.modality}`, "dist"),
      ),
    ).toEqual(await digestTree(build.outputRoot));
    const name = `artifact_kernel_${build.modality}_bg.wasm`;
    expect(await readFile(join(diagnosticOutput, "bindings", name))).toEqual(
      await readFile(join(rebuilt.assetRoot, name)),
    );
  }
  await rm(rebuilt.root, { recursive: true, force: true });
  expect(await readdir(join(diagnosticOutput, "bindings"))).toHaveLength(12);
  expect(await readFile(join(diagnosticOutput, "comparison.json"), "utf8")).toContain(
    "rebuiltSha256",
  );
});

test("successful byte checks do not retain diagnostics or accept non-rebuild diagnostic requests", async () => {
  const candidate = await fixture();
  const builds = await buildArtifactKernelWasmPackages({
    assetRoot: candidate.assetRoot,
    outputPackagesRoot: candidate.packagesRoot,
  });
  const diagnosticOutput = join(candidate.root, "diagnostics");
  await checkArtifactKernelWasmPackages(builds, {
    committedPackagesRoot: candidate.packagesRoot,
    rebuilt: true,
    assetRoot: candidate.assetRoot,
    diagnosticOutput,
  });
  expect(await Bun.file(join(diagnosticOutput, "comparison.json")).exists()).toBe(false);
  await expect(checkArtifactKernelWasmPackages(builds, { diagnosticOutput })).rejects.toThrow(
    "clean Rust rebuild",
  );
});

test("diagnostic retention refuses source destinations and never overwrites existing evidence", async () => {
  const candidate = await fixture();
  const committed = await fixture();
  const builds = await buildArtifactKernelWasmPackages({
    assetRoot: candidate.assetRoot,
    outputPackagesRoot: candidate.packagesRoot,
  });
  await buildArtifactKernelWasmPackages({
    assetRoot: committed.assetRoot,
    outputPackagesRoot: committed.packagesRoot,
  });
  await writeFile(
    join(committed.packagesRoot, "artifact-kernel-wasm-document/dist/index.js"),
    "mismatch",
  );
  const options = {
    committedPackagesRoot: committed.packagesRoot,
    rebuilt: true,
    assetRoot: candidate.assetRoot,
  };
  await expect(
    checkArtifactKernelWasmPackages(builds, { ...options, diagnosticOutput: candidate.assetRoot }),
  ).rejects.toThrow("outside the source and build");
  const diagnosticOutput = join(committed.root, "diagnostics");
  await mkdir(diagnosticOutput);
  await writeFile(join(diagnosticOutput, "keep.txt"), "prior evidence");
  await expect(
    checkArtifactKernelWasmPackages(builds, { ...options, diagnosticOutput }),
  ).rejects.toThrow("must be empty");
  expect(await readFile(join(diagnosticOutput, "keep.txt"), "utf8")).toBe("prior evidence");
  expect(await readdir(diagnosticOutput)).toEqual(["keep.txt"]);
});

async function fixture(version?: string): Promise<{
  root: string;
  assetRoot: string;
  artifactToolPackagePath: string;
  packagesRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-modality-wasm-package-"));
  temporaryRoots.add(root);
  const assetRoot = join(root, "assets");
  const packagesRoot = join(root, "packages");
  await Promise.all([
    mkdir(assetRoot, { recursive: true }),
    mkdir(packagesRoot, { recursive: true }),
  ]);
  const artifactTool = JSON.parse(
    await readFile(join(repoRoot, "packages/artifact-tool/package.json"), "utf8"),
  ) as { version: string };
  const packageVersion = version ?? artifactTool.version;
  const artifactToolPackagePath = join(root, "artifact-tool-package.json");
  await writeFile(
    artifactToolPackagePath,
    `${JSON.stringify({ name: "@opengeni/artifact-tool", version: packageVersion })}\n`,
  );
  for (const modality of modalities) {
    const packageRoot = join(packagesRoot, `artifact-kernel-wasm-${modality}`);
    const committedDist = join(repoRoot, "packages", `artifact-kernel-wasm-${modality}`, "dist");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: `@opengeni/artifact-kernel-wasm-${modality}`,
        version: packageVersion,
      })}\n`,
    );
    for (const suffix of [".js", ".d.ts", "_bg.wasm", "_bg.wasm.d.ts"]) {
      const name = `artifact_kernel_${modality}${suffix}`;
      await copyFile(join(committedDist, name), join(assetRoot, name));
    }
  }
  return { root, assetRoot, artifactToolPackagePath, packagesRoot };
}

async function digestTree(root: string): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile()) throw new Error(`unexpected generated entry ${entry.name}`);
    result[entry.name] = createHash("sha256")
      .update(await readFile(join(root, entry.name)))
      .digest("hex");
  }
  return result;
}
