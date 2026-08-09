import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalArtifactKernelBuildReceiptBytes } from "../kernel/bindings/package-receipt";
import {
  ARTIFACT_RUNTIME_ENVIRONMENT,
  artifactRuntimeTarget,
  type ArtifactKernelPackageManifest,
  type NativeArtifactRuntimeTarget,
} from "../src/runtime";
import { resolveCurrentArtifactRuntimeTarget } from "../src/runtime-cli";
import {
  DEVELOPMENT_ARTIFACT_RUNTIME_ENVIRONMENT,
  canonicalDevelopmentArtifactRuntimeManifestBytes,
  canonicalDevelopmentArtifactToolIdentityBytes,
  doctorVerifiedDevelopmentArtifactRuntime,
  isArtifactRuntimeConfigured,
  locateVerifiedDevelopmentArtifactRuntime,
  runConfiguredArtifactRuntimeCli,
  type DevelopmentArtifactRuntimeManifest,
} from "../src/runtime-development";

const roots: string[] = [];
const version = "1.2.3";
const buildIdentity = "opengeni-artifact-kernel/development-fixture;abi=1";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("current-host development artifact runtime", () => {
  test("distinguishes an absent runtime from every explicit or partial configuration", () => {
    expect(isArtifactRuntimeConfigured({})).toBe(false);
    expect(
      isArtifactRuntimeConfigured({ [ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: "/runtime.json" }),
    ).toBe(true);
    expect(isArtifactRuntimeConfigured({ [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: "" })).toBe(
      true,
    );
    expect(
      isArtifactRuntimeConfigured({
        [DEVELOPMENT_ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: "/development.json",
      }),
    ).toBe(true);
  });

  test("locates and doctors the separate canonical development chain", async () => {
    const fixture = await createFixture();
    const location = await locateVerifiedDevelopmentArtifactRuntime({
      environment: fixture.environment,
      expectedTarget: fixture.target,
    });
    expect(location).toMatchObject({
      mode: "development-current-host",
      target: fixture.target,
      artifactTool: { packageVersion: version },
    });
    expect(location.materializerExecutable).toBe(await realpath(fixture.materializerPath));
    const calls: string[] = [];
    await doctorVerifiedDevelopmentArtifactRuntime({
      environment: fixture.environment,
      expectedTarget: fixture.target,
      importer(specifier) {
        calls.push(specifier);
        return { marker: true };
      },
      probe(module) {
        expect(module.marker).toBe(true);
      },
    });
    expect(calls).toHaveLength(1);
    expect(
      JSON.parse(await runConfiguredArtifactRuntimeCli(["locate", "--json"], fixture.environment)),
    ).toMatchObject({ mode: "development-current-host", target: fixture.target });
  });

  test("can never activate in production or alongside a production manifest", async () => {
    const fixture = await createFixture();
    await expect(
      locateVerifiedDevelopmentArtifactRuntime({
        environment: { ...fixture.environment, NODE_ENV: "production" },
        expectedTarget: fixture.target,
      }),
    ).rejects.toThrow("forbidden when NODE_ENV=production");
    await expect(
      locateVerifiedDevelopmentArtifactRuntime({
        environment: {
          ...fixture.environment,
          [ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: join(fixture.root, "production.json"),
        },
        expectedTarget: fixture.target,
      }),
    ).rejects.toThrow("cannot both be configured");
    await expect(
      locateVerifiedDevelopmentArtifactRuntime({
        environment: fixture.environment,
        expectedTarget: fixture.target === "linux-x64-gnu" ? "linux-arm64-gnu" : "linux-x64-gnu",
      }),
    ).rejects.toThrow("does not match");
  });

  test("remains valid after the complete root is relocated", async () => {
    const fixture = await createFixture();
    const relocated = `${fixture.root}-relocated`;
    await rename(fixture.root, relocated);
    roots.push(relocated);
    const environment = {
      [DEVELOPMENT_ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: join(
        relocated,
        "installation.development.json",
      ),
      [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: join(relocated, "skill-facade-entry.mjs"),
      NODE_ENV: "development",
    };
    const location = await locateVerifiedDevelopmentArtifactRuntime({
      environment,
      expectedTarget: fixture.target,
    });
    expect(location.manifestPath).toBe(
      await realpath(join(relocated, "installation.development.json")),
    );
    expect(location.materializerExecutable).toBe(
      await realpath(join(relocated, "opengeni-artifact-materializer")),
    );
  });

  test("rejects noncanonical manifests and tampered receipt/facade bytes before import", async () => {
    const noncanonical = await createFixture();
    await writeFile(noncanonical.manifestPath, JSON.stringify(noncanonical.manifest));
    await expect(
      locateVerifiedDevelopmentArtifactRuntime({
        environment: noncanonical.environment,
        expectedTarget: noncanonical.target,
      }),
    ).rejects.toThrow("not canonical");

    const receipt = await createFixture();
    await chmod(receipt.receiptPath, 0o644);
    await writeFile(receipt.receiptPath, "tampered");
    await expect(
      locateVerifiedDevelopmentArtifactRuntime({
        environment: receipt.environment,
        expectedTarget: receipt.target,
      }),
    ).rejects.toThrow("differs from the development manifest");

    const facade = await createFixture();
    await chmod(facade.facadePath, 0o644);
    await writeFile(facade.facadePath, "tampered");
    let imported = false;
    await expect(
      doctorVerifiedDevelopmentArtifactRuntime({
        environment: facade.environment,
        expectedTarget: facade.target,
        importer() {
          imported = true;
          return {};
        },
      }),
    ).rejects.toThrow("differs from the development manifest");
    expect(imported).toBe(false);

    const executable = await createFixture();
    await chmod(executable.materializerPath, 0o644);
    await writeFile(executable.materializerPath, "tampered");
    await expect(
      locateVerifiedDevelopmentArtifactRuntime({
        environment: executable.environment,
        expectedTarget: executable.target,
      }),
    ).rejects.toThrow("differs from the development manifest");
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "opengeni-development-runtime-"));
  roots.push(root);
  const target = currentTarget();
  const kernelRoot = join(root, "kernel");
  await mkdir(kernelRoot, { recursive: true });
  const entrypointBytes = text("export const fixture = true;\n");
  const assetBytes = text("native-development-fixture");
  const facadeBytes = text("export const configured = true;\n");
  const materializerBytes = text("development-materializer-fixture");
  const artifactTool = Object.freeze({
    packageName: "@opengeni/artifact-tool" as const,
    packageVersion: version,
  });
  const identityBytes = canonicalDevelopmentArtifactToolIdentityBytes(artifactTool);
  const kernel: ArtifactKernelPackageManifest = {
    schemaVersion: 1,
    target,
    kind: "native",
    packageName: artifactRuntimeTarget(target).packageName,
    packageVersion: version,
    artifactToolVersion: version,
    buildIdentity,
    entrypoint: descriptor("index.js", entrypointBytes),
    asset: descriptor("opengeni_artifact_kernel.node", assetBytes),
    supportFiles: [],
  };
  const receiptBytes = canonicalArtifactKernelBuildReceiptBytes({
    schemaVersion: 1,
    producer: "opengeni-artifact-kernel-smoke-v1",
    target,
    kind: "native",
    buildIdentity,
    capabilities: descriptor("capabilities", text("capabilities"), false),
    runtimeFiles: [kernel.asset],
  });
  const identityPath = join(root, "artifact-tool-identity.json");
  const receiptPath = join(root, "artifact-kernel-build-receipt.json");
  const facadePath = join(root, "skill-facade-entry.mjs");
  const materializerPath = join(root, "opengeni-artifact-materializer");
  await Promise.all([
    writeFile(join(kernelRoot, "index.js"), entrypointBytes),
    writeFile(join(kernelRoot, "opengeni_artifact_kernel.node"), assetBytes),
    writeFile(identityPath, identityBytes),
    writeFile(receiptPath, receiptBytes),
    writeFile(facadePath, facadeBytes),
    writeFile(materializerPath, materializerBytes, { mode: 0o755 }),
  ]);
  const manifest: DevelopmentArtifactRuntimeManifest = {
    schemaVersion: 1,
    mode: "development-current-host",
    target,
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    artifactTool,
    artifactToolIdentity: descriptor("artifact-tool-identity.json", identityBytes),
    receipt: descriptor("artifact-kernel-build-receipt.json", receiptBytes),
    skillFacadeEntrypoint: descriptor("skill-facade-entry.mjs", facadeBytes),
    materializerExecutable: descriptor("opengeni-artifact-materializer", materializerBytes),
    kernelPackageRoot: "kernel",
    kernel,
  };
  const manifestPath = join(root, "installation.development.json");
  await writeFile(manifestPath, canonicalDevelopmentArtifactRuntimeManifestBytes(manifest));
  const environment = Object.freeze({
    [DEVELOPMENT_ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: manifestPath,
    [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: facadePath,
    NODE_ENV: "development",
  });
  return {
    root,
    target,
    manifest,
    manifestPath,
    receiptPath,
    facadePath,
    materializerPath,
    environment,
  };
}

function currentTarget(): NativeArtifactRuntimeTarget {
  const target = resolveCurrentArtifactRuntimeTarget();
  if (target === "wasm-web") throw new Error("native test host required");
  return target;
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
