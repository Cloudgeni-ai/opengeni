import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  ARTIFACT_KERNEL_BUILD_RECEIPT,
  canonicalArtifactKernelBuildReceiptBytes,
} from "../packages/artifact-tool/kernel/bindings/package-receipt";
import {
  ARTIFACT_RUNTIME_ENVIRONMENT,
  ARTIFACT_RUNTIME_MATRIX,
  artifactRuntimeTarget,
  type ArtifactKernelPackageManifest,
} from "../packages/artifact-tool/src/runtime";
import {
  canonicalArtifactRuntimeReleaseManifestBytes,
  doctorVerifiedArtifactRuntime,
  locateVerifiedArtifactRuntime,
} from "../packages/artifact-tool/src/runtime-cli";
import { assembleArtifactRuntimeInstallation } from "./assemble-artifact-runtime-installation";

const roots: string[] = [];
const version = "1.2.3";
const target = "darwin-arm64" as const;
const buildIdentity = "opengeni-artifact-kernel/fixture;abi=1;source=fixture";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact runtime installation assembler", () => {
  test("assembles deterministic relocatable bytes and passes the strict locator and doctor", async () => {
    const fixture = await createFixture();
    const first = await assembleArtifactRuntimeInstallation(fixture.options);
    expect(first).toMatchObject({ target, artifactTool: { packageVersion: version } });
    const firstTree = await treeDigest(fixture.outputRoot);

    await assembleArtifactRuntimeInstallation(fixture.options);
    expect(await treeDigest(fixture.outputRoot)).toEqual(firstTree);

    const relocated = join(fixture.root, "relocated", "runtime");
    await mkdir(join(fixture.root, "relocated"), { recursive: true });
    await rename(fixture.outputRoot, relocated);
    const environment = {
      [ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: join(relocated, "installation.json"),
      [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: join(relocated, "skill-facade-entry.mjs"),
    };
    const location = await locateVerifiedArtifactRuntime({ environment, expectedTarget: target });
    expect(location.kernel.asset).toBe(
      await realpath(join(relocated, "kernel", "opengeni_artifact_kernel.node")),
    );
    const imports: string[] = [];
    await doctorVerifiedArtifactRuntime({
      environment,
      expectedTarget: target,
      importer(specifier) {
        imports.push(specifier);
        return { verified: true };
      },
      probe(module) {
        expect(module.verified).toBe(true);
      },
    });
    expect(imports).toHaveLength(1);
  });

  test("rejects tarball identity/version drift and every selected runtime tamper", async () => {
    const wrongTarget = await createFixture();
    await expect(
      assembleArtifactRuntimeInstallation({
        ...wrongTarget.options,
        target: "darwin-x64",
      }),
    ).rejects.toThrow("does not match darwin-x64");

    const wrongTarball = await createFixture({ packedArtifactToolVersion: "1.2.4" });
    await expect(assembleArtifactRuntimeInstallation(wrongTarball.options)).rejects.toThrow(
      "identity differs",
    );

    const wrongIntegrity = await createFixture();
    await writeFile(wrongIntegrity.artifactToolTarballPath, "tampered-tarball");
    await expect(assembleArtifactRuntimeInstallation(wrongIntegrity.options)).rejects.toThrow(
      "integrity differs",
    );

    const staleAsset = await createFixture();
    await writeFile(join(staleAsset.kernelPackageRoot, "opengeni_artifact_kernel.node"), "changed");
    await expect(assembleArtifactRuntimeInstallation(staleAsset.options)).rejects.toThrow(
      "differs from its package manifest",
    );

    const staleReceipt = await createFixture();
    const receiptPath = join(staleReceipt.kernelPackageRoot, ARTIFACT_KERNEL_BUILD_RECEIPT);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await writeFile(receiptPath, JSON.stringify(receipt));
    await expect(assembleArtifactRuntimeInstallation(staleReceipt.options)).rejects.toThrow(
      "receipt is not canonical",
    );
  });

  test("rejects symlink escapes and post-install tampering before evaluation", async () => {
    const escaped = await createFixture();
    const external = join(escaped.root, "external.node");
    await writeFile(external, "native-fixture");
    await rm(join(escaped.kernelPackageRoot, "opengeni_artifact_kernel.node"));
    await symlink(external, join(escaped.kernelPackageRoot, "opengeni_artifact_kernel.node"));
    await expect(assembleArtifactRuntimeInstallation(escaped.options)).rejects.toThrow("escapes");

    const tampered = await createFixture();
    await assembleArtifactRuntimeInstallation(tampered.options);
    const installedFacade = join(tampered.outputRoot, "skill-facade-entry.mjs");
    await chmod(installedFacade, 0o644);
    await writeFile(installedFacade, "tampered");
    let imported = false;
    await expect(
      doctorVerifiedArtifactRuntime({
        environment: {
          [ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: join(tampered.outputRoot, "installation.json"),
          [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: join(
            tampered.outputRoot,
            "skill-facade-entry.mjs",
          ),
        },
        expectedTarget: target,
        importer() {
          imported = true;
          return {};
        },
      }),
    ).rejects.toThrow("ARTIFACT_RUNTIME_INTEGRITY");
    expect(imported).toBe(false);
  });
});

async function createFixture(options: Readonly<{ packedArtifactToolVersion?: string }> = {}) {
  const root = await mkdtemp(join(tmpdir(), "opengeni-runtime-assembler-"));
  roots.push(root);
  const toolRoot = join(root, "artifact-tool");
  const tarballRoot = join(root, "tarballs");
  const materializedKernelRoot = join(root, "kernel-package");
  const extractedKernelRoot = join(root, "extracted-kernel");
  const outputRoot = join(root, "installation");
  await Promise.all([
    mkdir(toolRoot, { recursive: true }),
    mkdir(tarballRoot, { recursive: true }),
    mkdir(materializedKernelRoot, { recursive: true }),
    mkdir(extractedKernelRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(toolRoot, "package.json"),
      `${JSON.stringify({ name: "@opengeni/artifact-tool", version: options.packedArtifactToolVersion ?? version, files: ["index.js"], type: "module" }, null, 2)}\n`,
    ),
    writeFile(join(toolRoot, "index.js"), "export const fixture = true;\n"),
  ]);
  const packed = await run(
    ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballRoot],
    toolRoot,
  );
  const artifactToolTarballPath = join(tarballRoot, basename(packed.trim().split("\n").at(-1)!));
  const artifactToolTarball = new Uint8Array(await readFile(artifactToolTarballPath));
  const integrity =
    `sha512-${createHash("sha512").update(artifactToolTarball).digest("base64")}` as const;

  const entrypoint = text("export const artifactKernelPackageIdentity = {};\n");
  const asset = text("native-fixture");
  const selected = packageManifest(target, entrypoint, asset);
  const runtimeFiles = [selected.asset];
  await Promise.all([
    writeFile(join(materializedKernelRoot, "index.js"), entrypoint),
    writeFile(join(materializedKernelRoot, "opengeni_artifact_kernel.node"), asset),
    writeFile(
      join(materializedKernelRoot, "package.json"),
      `${JSON.stringify({ name: selected.packageName, version, type: "module" }, null, 2)}\n`,
    ),
    writeFile(
      join(materializedKernelRoot, "artifact-kernel-manifest.json"),
      `${JSON.stringify(selected, null, 2)}\n`,
    ),
    writeFile(
      join(materializedKernelRoot, ARTIFACT_KERNEL_BUILD_RECEIPT),
      canonicalArtifactKernelBuildReceiptBytes({
        schemaVersion: 1,
        producer: "opengeni-artifact-kernel-smoke-v1",
        target,
        kind: "native",
        buildIdentity,
        capabilities: descriptor("capabilities", text("capabilities"), false),
        runtimeFiles,
      }),
    ),
  ]);
  const packedKernel = await run(
    ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballRoot],
    materializedKernelRoot,
  );
  await run(
    ["tar", "-xzf", join(tarballRoot, basename(packedKernel.trim().split("\n").at(-1)!))],
    extractedKernelRoot,
  );
  const kernelPackageRoot = join(extractedKernelRoot, "package");

  const release = {
    schemaVersion: 1,
    artifactTool: {
      packageName: "@opengeni/artifact-tool" as const,
      packageVersion: version,
      integrity,
    },
    targets: ARTIFACT_RUNTIME_MATRIX.map(({ target: releaseTarget }, index) =>
      releaseTarget === target
        ? selected
        : packageManifest(releaseTarget, text(`entry-${index}`), text(`asset-${index}`)),
    ),
  } as const;
  const releaseManifestPath = join(root, "artifact-runtime-release-manifest.json");
  await writeFile(releaseManifestPath, canonicalArtifactRuntimeReleaseManifestBytes(release));
  return {
    root,
    outputRoot,
    kernelPackageRoot,
    artifactToolTarballPath,
    options: {
      releaseManifestPath,
      kernelPackageRoot,
      artifactToolTarballPath,
      outputRoot,
      target,
    } as const,
  };
}

function packageManifest(
  runtimeTarget: (typeof ARTIFACT_RUNTIME_MATRIX)[number]["target"],
  entrypoint: Uint8Array,
  asset: Uint8Array,
): ArtifactKernelPackageManifest {
  const runtime = artifactRuntimeTarget(runtimeTarget);
  return {
    schemaVersion: 1,
    target: runtimeTarget,
    kind: runtime.kind,
    packageName: runtime.packageName,
    packageVersion: version,
    artifactToolVersion: version,
    buildIdentity,
    entrypoint: descriptor("index.js", entrypoint),
    asset: descriptor(
      runtimeTarget === "wasm-web" ? "artifact_kernel_bg.wasm" : "opengeni_artifact_kernel.node",
      asset,
    ),
    supportFiles: [],
  };
}

function descriptor(
  path: string,
  bytes: Uint8Array,
): {
  path: string;
  bytes: number;
  sha256: `sha256:${string}`;
};
function descriptor(
  path: string,
  bytes: Uint8Array,
  includePath: false,
): { bytes: number; sha256: `sha256:${string}` };
function descriptor(path: string, bytes: Uint8Array, includePath = true) {
  const proof = {
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
  };
  return includePath ? { path, ...proof } : proof;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function treeDigest(root: string): Promise<Record<string, string>> {
  const glob = new Bun.Glob("**/*");
  const result: Record<string, string> = {};
  for await (const relative of glob.scan({ cwd: root, onlyFiles: true })) {
    result[relative] = createHash("sha256")
      .update(await readFile(join(root, relative)))
      .digest("hex");
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || `${command.join(" ")} failed`);
  return stdout;
}
