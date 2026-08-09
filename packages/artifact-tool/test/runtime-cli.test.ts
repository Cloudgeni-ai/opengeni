import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  canonicalArtifactRuntimeReleaseManifestBytes,
  doctorVerifiedArtifactRuntime,
  locateVerifiedArtifactRuntime,
  resolveCurrentArtifactRuntimeTarget,
  resolveLinuxLibcFromRuntimeEvidence,
  runArtifactRuntimeCli,
} from "../src/runtime-cli";
import {
  ARTIFACT_RUNTIME_ENVIRONMENT,
  ARTIFACT_RUNTIME_MATRIX,
  artifactRuntimeTarget,
  type ArtifactKernelPackageManifest,
  type ArtifactRuntimeInstallationManifest,
} from "../src/runtime";

const roots: string[] = [];
const packageVersion = packageJson.version;
const integrity = `sha512-${"a".repeat(86)}==` as const;
const buildIdentity = `opengeni-artifact-kernel/${packageVersion};abi=1;source=runtime-cli-test`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact runtime locator executable", () => {
  test("verifies the complete exact chain without evaluating package code or using a network", async () => {
    const fixture = await createRuntimeFixture();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("runtime verification must never fetch");
    }) as unknown as typeof fetch;
    try {
      const location = await locateVerifiedArtifactRuntime({
        environment: fixture.environment,
        expectedTarget: "darwin-arm64",
      });
      expect(location.target).toBe("darwin-arm64");
      expect(location.skillFacadeEntrypoint).toBe(fixture.facadePath);
      expect(location.kernel.asset).toBe(fixture.assetPath);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects tampering before evaluating the skill bootstrap", async () => {
    const fixture = await createRuntimeFixture();
    await writeFile(fixture.assetPath, "tampered-kernel-asset");
    let imported = false;
    await expect(
      doctorVerifiedArtifactRuntime({
        environment: fixture.environment,
        expectedTarget: "darwin-arm64",
        importer: () => {
          imported = true;
          return {};
        },
      }),
    ).rejects.toThrow("ARTIFACT_RUNTIME_INTEGRITY");
    expect(imported).toBe(false);
  });

  test("verifies every portable facade support byte and packed package before import", async () => {
    const fixture = await createRuntimeFixture({ portable: true });
    const location = await locateVerifiedArtifactRuntime({
      environment: fixture.environment,
      expectedTarget: "darwin-arm64",
    });
    expect(location.artifactToolArchive).toBe(fixture.archivePath);
    expect(location.skillFacadeSupportFiles).toEqual([fixture.supportPath!]);

    await writeFile(fixture.supportPath!, "tampered-support-file");
    let imported = false;
    await expect(
      doctorVerifiedArtifactRuntime({
        environment: fixture.environment,
        expectedTarget: "darwin-arm64",
        importer: () => {
          imported = true;
          return {};
        },
      }),
    ).rejects.toThrow("ARTIFACT_RUNTIME_INTEGRITY");
    expect(imported).toBe(false);

    const archiveTamper = await createRuntimeFixture({ portable: true });
    await writeFile(archiveTamper.archivePath!, "tampered-packed-tool");
    await expect(
      locateVerifiedArtifactRuntime({
        environment: archiveTamper.environment,
        expectedTarget: "darwin-arm64",
      }),
    ).rejects.toThrow("ARTIFACT_RUNTIME_INTEGRITY");
  });

  test("rejects wrong target, wrong facade authority, and noncanonical release bytes", async () => {
    const wrongTarget = await createRuntimeFixture();
    await expect(
      locateVerifiedArtifactRuntime({
        environment: wrongTarget.environment,
        expectedTarget: "darwin-x64",
      }),
    ).rejects.toThrow("does not match darwin-x64");

    const wrongFacade = await createRuntimeFixture();
    const unrelated = join(wrongFacade.root, "other-entry.js");
    await writeFile(unrelated, "export const unrelated = true;\n");
    await expect(
      locateVerifiedArtifactRuntime({
        environment: {
          ...wrongFacade.environment,
          [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: unrelated,
        },
        expectedTarget: "darwin-arm64",
      }),
    ).rejects.toThrow("does not name the manifest-pinned");

    const noncanonical = await createRuntimeFixture({ canonicalRelease: false });
    await expect(
      locateVerifiedArtifactRuntime({
        environment: noncanonical.environment,
        expectedTarget: "darwin-arm64",
      }),
    ).rejects.toThrow("canonical deterministic form");
  });

  test("doctor imports only after verification and probes the configured exact runtime", async () => {
    const fixture = await createRuntimeFixture();
    const calls: string[] = [];
    const location = await doctorVerifiedArtifactRuntime({
      environment: fixture.environment,
      expectedTarget: "darwin-arm64",
      importer: (specifier) => {
        calls.push(specifier);
        return { marker: true };
      },
      probe: (module) => {
        expect(module.marker).toBe(true);
        calls.push("probe");
      },
    });
    expect(location.kernel.buildIdentity).toBe(buildIdentity);
    expect(calls).toEqual([new URL(`file://${fixture.facadePath}`).href, "probe"]);
  });

  test("CLI is JSON-only and fails closed without an explicitly installed runtime", async () => {
    const target = resolveCurrentArtifactRuntimeTarget();
    const fixture = await createRuntimeFixture({ target });
    const output = await runArtifactRuntimeCli(["locate", "--json"], fixture.environment);
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, target });
    await expect(runArtifactRuntimeCli(["locate", "--json"], {})).rejects.toThrow(
      "never downloads or guesses",
    );
    await expect(runArtifactRuntimeCli(["locate"], fixture.environment)).rejects.toThrow("Usage:");
  });

  test("imports Office bytes and writes one exclusive canonical publication snapshot", async () => {
    const target = resolveCurrentArtifactRuntimeTarget();
    const fixture = await createRuntimeFixture({ target, publication: true });
    const sourcePath = join(fixture.root, "source.xlsx");
    const snapshotPath = join(fixture.root, "publication.snapshot");
    const sourceBytes = new TextEncoder().encode("exact-office-source");
    await writeFile(sourcePath, sourceBytes);

    const output = await runArtifactRuntimeCli(
      [
        "prepare-publication",
        "--json",
        "--modality",
        "spreadsheet",
        "--input",
        sourcePath,
        "--snapshot-output",
        snapshotPath,
      ],
      fixture.environment,
    );
    const result = JSON.parse(output);
    expect(result).toMatchObject({
      schemaVersion: 1,
      modality: "spreadsheet",
      source: {
        byteSize: sourceBytes.byteLength,
        contentHash: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      snapshot: {
        modality: "spreadsheet",
        coveredHeadSequence: 0,
        stateHash: `sha256:${"1".repeat(64)}`,
        modelSchemaVersion: 1,
        kernelVersion: buildIdentity,
        operationProtocolVersion: 1,
        crdtStateVersion: 1,
      },
    });
    expect(new Uint8Array(await readFile(snapshotPath))).toEqual(
      new TextEncoder().encode("canonical-publication-snapshot"),
    );
    await expect(
      runArtifactRuntimeCli(
        [
          "prepare-publication",
          "--json",
          "--modality",
          "spreadsheet",
          "--input",
          sourcePath,
          "--snapshot-output",
          snapshotPath,
        ],
        fixture.environment,
      ),
    ).rejects.toThrow("written exclusively");

    const wrongExtension = join(fixture.root, "source.docx");
    await writeFile(wrongExtension, sourceBytes);
    await expect(
      runArtifactRuntimeCli(
        [
          "prepare-publication",
          "--json",
          "--modality",
          "spreadsheet",
          "--input",
          wrongExtension,
          "--snapshot-output",
          join(fixture.root, "wrong.snapshot"),
        ],
        fixture.environment,
      ),
    ).rejects.toThrow("must have the .xlsx extension");
  });
});

describe("Linux libc runtime evidence", () => {
  test.each([
    ["arm64", "aarch64-musl", "musl"],
    ["x64", "x64", "gnu"],
    ["x64", "x64-musl-baseline", "musl"],
  ] as const)("accepts the exact official Bun archive for %s", (arch, archive, expected) => {
    expect(
      resolveLinuxLibcFromRuntimeEvidence({
        arch,
        versions: { bun: "1.3.14" },
        report: {
          header: {
            release: {
              sourceUrl: `https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-${archive}.zip`,
            },
          },
          sharedObjects: [],
        },
      }),
    ).toBe(expected);
  });

  test("retains direct runtime and loader evidence", () => {
    expect(resolveLinuxLibcFromRuntimeEvidence({ arch: "x64", versions: { musl: "1.2.5" } })).toBe(
      "musl",
    );
    expect(
      resolveLinuxLibcFromRuntimeEvidence({
        arch: "x64",
        versions: {},
        report: { header: { glibcVersionRuntime: "2.39" } },
      }),
    ).toBe("gnu");
    expect(
      resolveLinuxLibcFromRuntimeEvidence({
        arch: "arm64",
        versions: {},
        report: { sharedObjects: ["/lib/ld-musl-aarch64.so.1"] },
      }),
    ).toBe("musl");
  });

  test.each([
    undefined,
    "https://example.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-musl.zip",
    "https://github.com/oven-sh/bun/releases/download/bun-v1.3.13/bun-linux-x64-musl.zip",
    "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64-musl.zip",
    "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-musl-unknown.zip",
  ])("rejects absent, lookalike, stale, wrong-arch, or unknown Bun evidence", (sourceUrl) => {
    expect(() =>
      resolveLinuxLibcFromRuntimeEvidence({
        arch: "x64",
        versions: { bun: "1.3.14" },
        report: { header: { release: { sourceUrl } } },
      }),
    ).toThrow("Could not prove");
  });

  test("rejects conflicting evidence instead of guessing", () => {
    expect(() =>
      resolveLinuxLibcFromRuntimeEvidence({
        arch: "x64",
        versions: { bun: "1.3.14" },
        report: {
          header: {
            glibcVersionRuntime: "2.39",
            release: {
              sourceUrl:
                "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-musl.zip",
            },
          },
        },
      }),
    ).toThrow("Could not prove");
  });
});

type RuntimeFixture = Readonly<{
  root: string;
  manifestPath: string;
  facadePath: string;
  assetPath: string;
  environment: Readonly<Record<string, string>>;
  archivePath?: string;
  supportPath?: string;
}>;

async function createRuntimeFixture(
  options: Readonly<{
    canonicalRelease?: boolean;
    portable?: boolean;
    publication?: boolean;
    target?: (typeof ARTIFACT_RUNTIME_MATRIX)[number]["target"];
  }> = {},
): Promise<RuntimeFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opengeni-artifact-runtime-")));
  roots.push(root);
  const facadePath = join(root, "skill-facade.js");
  const releasePath = join(root, "release-manifest.json");
  const kernelRoot = join(root, "kernel");
  const kernelEntrypoint = join(kernelRoot, "index.js");
  const assetPath = join(kernelRoot, "opengeni_artifact_kernel.node");
  const manifestPath = join(root, "installation.json");
  const archivePath = join(root, "artifact-tool.tgz");
  const supportPath = join(root, "runtime-support.js");
  await mkdir(kernelRoot, { recursive: true });

  const target = options.target ?? "darwin-arm64";
  const facadeBytes = new TextEncoder().encode(
    options.publication ? publicationFixtureFacade(target) : "export const configured = true;\n",
  );
  const kernelBytes = new TextEncoder().encode("export const kernel = true;\n");
  const assetBytes = new TextEncoder().encode("verified-kernel-asset");
  const archiveBytes = new TextEncoder().encode("verified-packed-artifact-tool");
  const supportBytes = new TextEncoder().encode("verified-support-file");
  await Promise.all([
    writeFile(facadePath, facadeBytes),
    writeFile(kernelEntrypoint, kernelBytes),
    writeFile(assetPath, assetBytes),
    ...(options.portable
      ? [writeFile(archivePath, archiveBytes), writeFile(supportPath, supportBytes)]
      : []),
  ]);

  const artifactToolIntegrity = options.portable
    ? (`sha512-${createHash("sha512").update(archiveBytes).digest("base64")}` as const)
    : integrity;

  const selected = packageManifest(target, kernelBytes, assetBytes);
  const release = {
    schemaVersion: 1,
    artifactTool: {
      packageName: "@opengeni/artifact-tool",
      packageVersion,
      integrity: artifactToolIntegrity,
    },
    targets: ARTIFACT_RUNTIME_MATRIX.map((runtimeDescriptor, index) =>
      runtimeDescriptor.target === selected.target
        ? selected
        : packageManifest(
            runtimeDescriptor.target,
            new TextEncoder().encode(`entry-${index}`),
            new TextEncoder().encode(`asset-${index}`),
          ),
    ),
  } as const;
  const canonicalRelease = canonicalArtifactRuntimeReleaseManifestBytes(release);
  const releaseBytes =
    options.canonicalRelease === false
      ? new TextEncoder().encode(JSON.stringify(release))
      : canonicalRelease;
  await writeFile(releasePath, releaseBytes);

  const installation: ArtifactRuntimeInstallationManifest = {
    schemaVersion: 1,
    target: selected.target,
    releaseManifest: descriptor("release-manifest.json", releaseBytes),
    artifactTool: {
      packageName: "@opengeni/artifact-tool",
      packageVersion,
      integrity: artifactToolIntegrity,
    },
    ...(options.portable
      ? { artifactToolArchive: descriptor("artifact-tool.tgz", archiveBytes) }
      : {}),
    skillFacadeEntrypoint: descriptor("skill-facade.js", facadeBytes),
    ...(options.portable
      ? { skillFacadeSupportFiles: [descriptor("runtime-support.js", supportBytes)] }
      : {}),
    kernelPackageRoot: "kernel",
    kernel: selected,
  };
  await writeFile(manifestPath, `${JSON.stringify(installation, null, 2)}\n`);
  return {
    root,
    manifestPath,
    facadePath,
    assetPath,
    environment: {
      [ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: manifestPath,
      [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: facadePath,
    },
    ...(options.portable ? { archivePath, supportPath } : {}),
  };
}

function publicationFixtureFacade(
  target: (typeof ARTIFACT_RUNTIME_MATRIX)[number]["target"],
): string {
  return `
const runtime = Object.freeze({
  kind: "native",
  target: ${JSON.stringify(target)},
  buildIdentity: ${JSON.stringify(buildIdentity)},
  capabilities: Object.freeze({ spreadsheet: true, document: true, presentation: true }),
});
export function getConfiguredArtifactRuntime() { return runtime; }
export const Workbook = Object.freeze({ create() { return { modality: "spreadsheet" }; } });
export function getArtifactCompositeDiagnostics() {
  return { runtimeTarget: runtime.target, runtimeBuildIdentity: runtime.buildIdentity, nativeStateHash: "sha256:${"0".repeat(64)}" };
}
export class FileBlob {
  static fromBytes(bytes, options) { return { bytes: bytes.slice(), ...options }; }
}
export const SpreadsheetFile = Object.freeze({
  async importXlsx(blob) { return { modality: "spreadsheet", source: blob.bytes }; },
});
export const DocumentFile = Object.freeze({
  async importDocx(blob) { return { modality: "document", source: blob.bytes }; },
});
export const PresentationFile = Object.freeze({
  async importPptx(blob) { return { modality: "presentation", source: blob.bytes }; },
});
export function createArtifactPublicationSnapshot(artifact) {
  const common = {
    schemaVersion: 1,
    modality: artifact.modality,
    runtimeTarget: runtime.target,
    kernelVersion: runtime.buildIdentity,
    modelSchemaVersion: 1,
    snapshotVersion: 1,
    stateHash: "sha256:${"1".repeat(64)}",
    snapshotBytes: new TextEncoder().encode("canonical-publication-snapshot"),
  };
  return artifact.modality === "spreadsheet"
    ? { ...common, coveredCausalFrontierBytes: Uint8Array.from([79,71,65,67,70,48,48,49,1,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,78,192,196,13,215,35,182,146]), operationProtocolVersion: 1, crdtStateVersion: 1 }
    : { ...common, nativeRevision: 1 };
}
export function disposeArtifact(artifact) { artifact.disposed = true; }
`;
}

function packageManifest(
  target: (typeof ARTIFACT_RUNTIME_MATRIX)[number]["target"],
  entrypointBytes: Uint8Array,
  assetBytes: Uint8Array,
): ArtifactKernelPackageManifest {
  const targetDescriptor = artifactRuntimeTarget(target);
  return {
    schemaVersion: 1,
    target,
    kind: targetDescriptor.kind,
    packageName: targetDescriptor.packageName,
    packageVersion,
    artifactToolVersion: packageVersion,
    buildIdentity,
    entrypoint: descriptor("index.js", entrypointBytes),
    asset: descriptor(
      target === "wasm-web" ? "artifact_kernel_bg.wasm" : "opengeni_artifact_kernel.node",
      assetBytes,
    ),
    supportFiles: [],
  };
}

function descriptor(path: string, bytes: Uint8Array) {
  return {
    path,
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
  };
}
