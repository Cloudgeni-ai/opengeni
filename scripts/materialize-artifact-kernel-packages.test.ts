import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactKernelTargetBuildDefinitions,
  materializeArtifactKernelPackages,
  renderArtifactSkillFacadeBootstrap,
} from "./materialize-artifact-kernel-packages";
import {
  ARTIFACT_RUNTIME_MATRIX,
  validateCompleteArtifactRuntimeReleaseManifest,
  type ArtifactRuntimeTarget,
} from "../packages/artifact-tool/src/runtime";
import {
  ARTIFACT_KERNEL_BUILD_RECEIPT,
  artifactKernelTargetAssetDirectory,
  canonicalArtifactKernelBuildReceiptBytes,
} from "../packages/artifact-tool/kernel/bindings/package-receipt";

const roots: string[] = [];
const integrity = `sha512-${"a".repeat(86)}==` as const;
const fixtureIdentity = "artifact-kernel;abi=1;source=fixture";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact kernel target package materializer", () => {
  test("keeps one ordered reproducible cross-target build matrix", () => {
    const definitions = artifactKernelTargetBuildDefinitions();
    expect(definitions.map(({ target }) => target)).toEqual(
      ARTIFACT_RUNTIME_MATRIX.map(({ target }) => target),
    );
    expect(definitions.map(({ rustTarget }) => rustTarget)).toEqual([
      "x86_64-apple-darwin",
      "aarch64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
      "aarch64-unknown-linux-musl",
      "x86_64-pc-windows-msvc",
      "wasm32-unknown-unknown",
    ]);
  });

  test("materializes only requested local assets with exact supplied release version", async () => {
    const fixture = await createAssetFixture(["darwin-arm64", "wasm-web"]);
    const first = await materializeArtifactKernelPackages({
      assetRoot: fixture.assetRoot,
      outputRoot: fixture.outputRoot,
      artifactToolVersion: "2.3.4",
      targets: ["wasm-web", "darwin-arm64"],
    });
    expect(first.map(({ target }) => target)).toEqual(["darwin-arm64", "wasm-web"]);
    expect(first.every(({ manifest }) => manifest.packageVersion === "2.3.4")).toBe(true);
    expect(first.every(({ manifest }) => manifest.artifactToolVersion === "2.3.4")).toBe(true);
    expect(first[0]!.manifest.supportFiles).toEqual([]);
    expect(first[1]!.manifest.supportFiles.map(({ path }) => path)).toEqual([
      "artifact_kernel.js",
      "artifact_kernel_document.js",
      "artifact_kernel_document_bg.wasm",
      "artifact_kernel_presentation.js",
      "artifact_kernel_presentation_bg.wasm",
      "artifact_kernel_spreadsheet.js",
      "artifact_kernel_spreadsheet_bg.wasm",
    ]);
    const nativePackage = JSON.parse(
      await readFile(join(first[0]!.packageRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(nativePackage).toMatchObject({
      name: "@opengeni/artifact-kernel-darwin-arm64",
      version: "2.3.4",
      os: ["darwin"],
      cpu: ["arm64"],
    });
    expect(nativePackage.files).toContain(ARTIFACT_KERNEL_BUILD_RECEIPT);
    const wasmEntrypoint = await readFile(join(first[1]!.packageRoot, "index.js"), "utf8");
    expect(wasmEntrypoint).toContain("editableArtifactKernelAssets");
    expect(wasmEntrypoint).toContain("artifact_kernel_document_bg.wasm");
    expect(wasmEntrypoint).toContain("artifact_kernel_presentation_bg.wasm");
    expect(wasmEntrypoint).toContain("artifact_kernel_spreadsheet_bg.wasm");
    expect(await readdir(fixture.outputRoot)).not.toContain(
      "artifact-runtime-release-manifest.json",
    );

    const firstTree = await digestTree(fixture.outputRoot);
    await materializeArtifactKernelPackages({
      assetRoot: fixture.assetRoot,
      outputRoot: fixture.outputRoot,
      artifactToolVersion: "2.3.4",
      targets: ["darwin-arm64", "wasm-web"],
    });
    expect(await digestTree(fixture.outputRoot)).toEqual(firstTree);
  });

  test("emits a canonical release manifest only for the complete exact matrix", async () => {
    const partial = await createAssetFixture(["darwin-arm64"]);
    await expect(
      materializeArtifactKernelPackages({
        assetRoot: partial.assetRoot,
        outputRoot: partial.outputRoot,
        artifactToolVersion: "1.2.3",
        targets: ["darwin-arm64"],
        artifactToolIntegrity: integrity,
      }),
    ).rejects.toThrow("requires all eight");

    const allTargets = ARTIFACT_RUNTIME_MATRIX.map(({ target }) => target);
    const complete = await createAssetFixture(allTargets);
    const packages = await materializeArtifactKernelPackages({
      assetRoot: complete.assetRoot,
      outputRoot: complete.outputRoot,
      artifactToolVersion: "1.2.3",
      targets: allTargets,
      artifactToolIntegrity: integrity,
    });
    expect(packages).toHaveLength(8);
    const releaseBytes = await readFile(
      join(complete.outputRoot, "artifact-runtime-release-manifest.json"),
    );
    const release = validateCompleteArtifactRuntimeReleaseManifest(
      JSON.parse(releaseBytes.toString("utf8")),
    );
    expect(release.targets.map(({ target }) => target)).toEqual(allTargets);
    expect(release.artifactTool.packageVersion).toBe("1.2.3");
    expect(releaseBytes.toString("utf8")).toBe(`${JSON.stringify(release, null, 2)}\n`);
  });

  test("fails closed for missing assets and generates a literal pinned bootstrap", async () => {
    const fixture = await createAssetFixture(["darwin-arm64"]);
    await expect(
      materializeArtifactKernelPackages({
        assetRoot: fixture.assetRoot,
        outputRoot: fixture.outputRoot,
        artifactToolVersion: "1.2.3",
        targets: ["linux-x64-gnu"],
      }),
    ).rejects.toThrow("Target build receipt is missing");

    const [materialized] = await materializeArtifactKernelPackages({
      assetRoot: fixture.assetRoot,
      outputRoot: fixture.outputRoot,
      artifactToolVersion: "1.2.3",
      targets: ["darwin-arm64"],
    });
    const bootstrap = renderArtifactSkillFacadeBootstrap(materialized!.manifest);
    expect(bootstrap).toContain('from "@opengeni/artifact-kernel-darwin-arm64"');
    expect(bootstrap).toContain("configureArtifactRuntime(new ArtifactKernelRuntime");
    expect(bootstrap).not.toMatch(/latest|fetch\(|https?:|artifact-kernel-\$\{/u);

    const installedBootstrap = renderArtifactSkillFacadeBootstrap(materialized!.manifest, {
      kernelSpecifier: "./kernel/index.js",
    });
    expect(installedBootstrap).toContain('from "./kernel/index.js"');
    for (const kernelSpecifier of [
      "../kernel/index.js",
      "./kernel/../index.js",
      "./kernel/./index.js",
      "./kernel//index.js",
      "./kernel/index.ts",
      "./kernel/${target}.js",
      "https://example.com/kernel.js",
    ]) {
      expect(() =>
        renderArtifactSkillFacadeBootstrap(materialized!.manifest, { kernelSpecifier }),
      ).toThrow("kernel specifier");
    }
  });

  test("rejects missing, non-canonical, and stale smoke receipts", async () => {
    const missing = await createAssetFixture(["darwin-arm64"]);
    const receiptPath = join(
      artifactKernelTargetAssetDirectory("darwin-arm64", missing.assetRoot),
      ARTIFACT_KERNEL_BUILD_RECEIPT,
    );
    await rm(receiptPath);
    await expect(
      materializeArtifactKernelPackages({
        assetRoot: missing.assetRoot,
        outputRoot: missing.outputRoot,
        artifactToolVersion: "1.2.3",
        targets: ["darwin-arm64"],
      }),
    ).rejects.toThrow("Target build receipt is missing");

    const stale = await createAssetFixture(["darwin-arm64"]);
    await writeFile(
      join(stale.assetRoot, "native", "darwin-arm64", "opengeni_artifact_kernel.node"),
      "changed-after-smoke",
    );
    await expect(
      materializeArtifactKernelPackages({
        assetRoot: stale.assetRoot,
        outputRoot: stale.outputRoot,
        artifactToolVersion: "1.2.3",
        targets: ["darwin-arm64"],
      }),
    ).rejects.toThrow("differ from the smoke-produced receipt");

    const nonCanonical = await createAssetFixture(["darwin-arm64"]);
    const nonCanonicalPath = join(
      artifactKernelTargetAssetDirectory("darwin-arm64", nonCanonical.assetRoot),
      ARTIFACT_KERNEL_BUILD_RECEIPT,
    );
    const parsed = JSON.parse(await readFile(nonCanonicalPath, "utf8"));
    await writeFile(nonCanonicalPath, JSON.stringify(parsed));
    await expect(
      materializeArtifactKernelPackages({
        assetRoot: nonCanonical.assetRoot,
        outputRoot: nonCanonical.outputRoot,
        artifactToolVersion: "1.2.3",
        targets: ["darwin-arm64"],
      }),
    ).rejects.toThrow("not canonical");

    const mixed = await createAssetFixture(["darwin-arm64", "wasm-web"]);
    const mixedPath = join(
      artifactKernelTargetAssetDirectory("wasm-web", mixed.assetRoot),
      ARTIFACT_KERNEL_BUILD_RECEIPT,
    );
    const mixedReceipt = JSON.parse(await readFile(mixedPath, "utf8"));
    await writeFile(
      mixedPath,
      canonicalArtifactKernelBuildReceiptBytes({
        ...mixedReceipt,
        buildIdentity: `${fixtureIdentity}-different`,
      }),
    );
    await expect(
      materializeArtifactKernelPackages({
        assetRoot: mixed.assetRoot,
        outputRoot: mixed.outputRoot,
        artifactToolVersion: "1.2.3",
        targets: ["darwin-arm64", "wasm-web"],
      }),
    ).rejects.toThrow("one exact build identity");
  });
});

async function createAssetFixture(targets: readonly ArtifactRuntimeTarget[]) {
  const root = await mkdtemp(join(tmpdir(), "opengeni-artifact-kernel-packages-"));
  roots.push(root);
  const assetRoot = join(root, "assets");
  const outputRoot = join(root, "packages");
  for (const target of targets) {
    const runtimeFiles: Array<{ path: string; bytes: number; sha256: `sha256:${string}` }> = [];
    if (target === "wasm-web") {
      await mkdir(join(assetRoot, "wasm-web"), { recursive: true });
      for (const name of [
        "artifact_kernel.js",
        "artifact_kernel_bg.wasm",
        "artifact_kernel_document.js",
        "artifact_kernel_document_bg.wasm",
        "artifact_kernel_presentation.js",
        "artifact_kernel_presentation_bg.wasm",
        "artifact_kernel_spreadsheet.js",
        "artifact_kernel_spreadsheet_bg.wasm",
      ]) {
        const bytes = new TextEncoder().encode(
          name.endsWith(".wasm")
            ? `wasm-fixture-${name}`
            : "export default async function initialize() {}\n",
        );
        await writeFile(join(assetRoot, "wasm-web", name), bytes);
        runtimeFiles.push(fileProof(name, bytes));
      }
    } else {
      await mkdir(join(assetRoot, "native", target), { recursive: true });
      const native = new TextEncoder().encode(`native-${target}`);
      await writeFile(join(assetRoot, "native", target, "opengeni_artifact_kernel.node"), native);
      runtimeFiles.push(fileProof("opengeni_artifact_kernel.node", native));
    }
    const directory = artifactKernelTargetAssetDirectory(target, assetRoot);
    await writeFile(
      join(directory, ARTIFACT_KERNEL_BUILD_RECEIPT),
      canonicalArtifactKernelBuildReceiptBytes({
        schemaVersion: 1,
        producer: "opengeni-artifact-kernel-smoke-v1",
        target,
        kind: target === "wasm-web" ? "wasm" : "native",
        buildIdentity: fixtureIdentity,
        capabilities: fileProof(
          "capabilities",
          new TextEncoder().encode("fixture-capabilities"),
          false,
        ),
        runtimeFiles,
      }),
    );
  }
  return { root, assetRoot, outputRoot };
}

function fileProof(
  path: string,
  bytes: Uint8Array,
): { path: string; bytes: number; sha256: `sha256:${string}` };
function fileProof(
  path: string,
  bytes: Uint8Array,
  includePath: false,
): { bytes: number; sha256: `sha256:${string}` };
function fileProof(path: string, bytes: Uint8Array, includePath = true) {
  const proof = {
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
  };
  return includePath ? { path, ...proof } : proof;
}

async function digestTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = join(path, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child, relative);
      else
        result[relative] = createHash("sha256")
          .update(await readFile(child))
          .digest("hex");
    }
  }
  await visit(root, "");
  return result;
}
