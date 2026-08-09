import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildArtifactKernelWasmPackages } from "./build-artifact-kernel-wasm-packages";

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
    "changeset version && bun scripts/build-artifact-kernel-wasm-packages.ts",
  );
  expect(
    changesetConfig.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH
      ?.onlyUpdatePeerDependentsWhenOutOfRange,
  ).toBe(true);
  expect(reactPackage.peerDependencies?.["@opengeni/artifact-tool"]).toBe(">=0.0.0 <0.2.0");
  expect(
    ciWorkflow.match(
      /@changesets\/cli\/bin\.js" version\n\s+bun scripts\/build-artifact-kernel-wasm-packages\.ts/gu,
    ),
  ).toHaveLength(2);
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
