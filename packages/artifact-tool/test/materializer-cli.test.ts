import { afterAll, beforeAll, describe, expect, test as bunTest } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
  spreadsheetSheetId,
} from "@opengeni/contracts/editable-artifacts";

import packageJson from "../package.json" with { type: "json" };
import { NativeSpreadsheetSession } from "../src/native";
import { canonicalArtifactRuntimeReleaseManifestBytes } from "../src/runtime-cli";
import {
  ARTIFACT_RUNTIME_ENVIRONMENT,
  ARTIFACT_RUNTIME_MATRIX,
  artifactRuntimeTarget,
  type ArtifactKernelPackageIdentity,
  type ArtifactKernelPackageManifest,
  type ArtifactRuntimeInstallationManifest,
  type ArtifactRuntimeTarget,
} from "../src/runtime";
import { SpreadsheetXlsxCodec } from "../src/spreadsheet-xlsx-codec";
import {
  productionTestRuntime,
  productionTestRuntimeAvailable,
} from "./production-runtime-fixture";

const MATERIALIZE = "--opengeni-materialize-v1";
const VERIFY = "--opengeni-verify-materialization-v1";
const IDENTITY = "--opengeni-materializer-identity-v1";
const INPUT_MAGIC = text("OGAMI001");
const VERIFY_INPUT_MAGIC = text("OGAVI001");
const OUTPUT_MAGIC = "OGAMO001";
const VERIFY_OUTPUT_MAGIC = "OGAVO001";
const ERROR_MAGIC = "OGAME001";
const integrity = `sha512-${"a".repeat(86)}==` as const;

type Fixture = Readonly<{
  root: string;
  executable: string;
  environment: Readonly<Record<string, string>>;
  snapshot: Uint8Array;
  stateHash: string;
  headSequence: number;
  capabilities: Capability;
}>;

type Capability = Readonly<{
  protocol: "OGAMC001";
  runtimeTarget: string;
  kernelVersion: string;
  codecVersions: Readonly<Record<string, string>>;
  fontRegistryHash: string;
  policyHash: string;
}>;

type ParsedFrame = Readonly<{
  magic: string;
  metadata: Record<string, unknown>;
  payload: Uint8Array;
}>;

let fixture: Fixture;
const nativeRuntimeAvailable = productionTestRuntimeAvailable();
const test = nativeRuntimeAvailable ? bunTest : bunTest.skip;

beforeAll(async () => {
  if (!nativeRuntimeAvailable) return;
  fixture = await createFixture();
}, 120_000);

afterAll(async () => {
  if (fixture?.root) await rm(fixture.root, { recursive: true, force: true });
});

describe("compiled native artifact materializer", () => {
  test("materializes a real canonical Rust snapshot and independently reimports its XLSX", async () => {
    expect(new TextEncoder().encode(fixture.capabilities.kernelVersion).byteLength).toBeGreaterThan(
      128,
    );
    expect(
      new TextEncoder().encode(fixture.capabilities.kernelVersion).byteLength,
    ).toBeLessThanOrEqual(EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES);

    const materialized = await invoke(
      fixture,
      MATERIALIZE,
      framed(INPUT_MAGIC, manifest(), fixture.snapshot),
    );
    expect(materialized.exitCode).toBe(0);
    expect(materialized.stderr).toBe("");
    const output = parseFrame(materialized.stdout);
    expect(output.magic).toBe(OUTPUT_MAGIC);
    expect(output.metadata).toMatchObject({
      protocol: "OGAMR001",
      stateHash: fixture.stateHash,
      headSequence: fixture.headSequence,
      format: "xlsx",
      contentHash: sha256(output.payload),
    });
    expect(output.metadata.semanticHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const imported = await SpreadsheetXlsxCodec.importXlsx(output.payload, {
      unsupportedContent: "error",
    });
    expect(imported.worksheets.getItem("Summary").getRange("A1:C3").values).toEqual([
      ["Month", "Revenue", "Double"],
      ["Jan", 120, 240],
      ["Feb", 140, 280],
    ]);

    // A distinct executable process performs the durable-output verification.
    const verified = await invoke(
      fixture,
      VERIFY,
      framed(
        VERIFY_INPUT_MAGIC,
        {
          codecId: "opengeni.xlsx",
          codecVersion: codecVersion(),
          expectedSemanticHash: output.metadata.semanticHash,
          format: "xlsx",
          protocol: "OGAVJ001",
        },
        output.payload,
      ),
    );
    expect(verified.exitCode).toBe(0);
    expect(parseFrame(verified.stdout)).toMatchObject({
      magic: VERIFY_OUTPUT_MAGIC,
      metadata: {
        protocol: "OGAVR001",
        semanticHash: output.metadata.semanticHash,
      },
      payload: new Uint8Array(0),
    });
  }, 60_000);

  test("fails closed with typed build, fidelity, source-size, and output-corruption errors", async () => {
    const buildMismatch = parseFrame(
      (
        await invoke(
          fixture,
          MATERIALIZE,
          framed(INPUT_MAGIC, manifest({ kernelVersion: "wrong-build" }), fixture.snapshot),
        )
      ).stdout,
    );
    expect(buildMismatch).toMatchObject({
      magic: ERROR_MAGIC,
      metadata: { code: "kernel_incompatible", protocol: "OGAMERR1" },
    });

    const unsupported = parseFrame(
      (
        await invoke(
          fixture,
          MATERIALIZE,
          framed(INPUT_MAGIC, manifest({ modality: "document", format: "docx" }), fixture.snapshot),
        )
      ).stdout,
    );
    expect(unsupported).toMatchObject({
      magic: ERROR_MAGIC,
      metadata: { code: "unsupported_semantics", protocol: "OGAMERR1" },
    });

    const oversizedHeader = new Uint8Array(20);
    oversizedHeader.set(INPUT_MAGIC);
    const oversizedView = new DataView(oversizedHeader.buffer);
    oversizedView.setUint32(8, 2, true);
    oversizedView.setBigUint64(12, BigInt(512 * 1024 * 1024 + 1), true);
    const oversized = parseFrame((await invoke(fixture, MATERIALIZE, oversizedHeader)).stdout);
    expect(oversized).toMatchObject({
      magic: ERROR_MAGIC,
      metadata: { code: "unsupported_semantics", protocol: "OGAMERR1" },
    });

    const valid = parseFrame(
      (await invoke(fixture, MATERIALIZE, framed(INPUT_MAGIC, manifest(), fixture.snapshot)))
        .stdout,
    );
    const corrupt = valid.payload.slice();
    corrupt[0] = corrupt[0]! ^ 0xff;
    const verification = parseFrame(
      (
        await invoke(
          fixture,
          VERIFY,
          framed(
            VERIFY_INPUT_MAGIC,
            {
              codecId: "opengeni.xlsx",
              codecVersion: codecVersion(),
              expectedSemanticHash: valid.metadata.semanticHash,
              format: "xlsx",
              protocol: "OGAVJ001",
            },
            corrupt,
          ),
        )
      ).stdout,
    );
    expect(verification).toMatchObject({
      magic: ERROR_MAGIC,
      metadata: { code: "output_verification_failed", protocol: "OGAMERR1" },
    });
  }, 60_000);
});

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opengeni-real-materializer-")));
  const executable = join(root, "opengeni-artifact-materializer");
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "..", "src", "materializer-cli-entry.ts"),
      "--outfile",
      executable,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const buildError = new Response(build.stderr).text();
  if ((await build.exited) !== 0) throw new Error(await buildError);

  const runtime = productionTestRuntime();
  const source = NativeSpreadsheetSession.create(runtime, 0x0123456789abcdefn);
  const sheetId = spreadsheetSheetId("0123456789abcdef0000000000000002");
  try {
    source.authorCommands({
      intent: {
        artifactId: "11111111111111112222222222222222",
        clientTransactionId: "materializer.e2e.1",
        replicaId: "0123456789abcdef",
        replicaCounter: 1,
        previousLocalTransactionId: null,
        observedHeadSequence: 0,
        causalBase: [],
        selectiveUndoOperationIds: [],
      },
      commands: {
        version: 1,
        commands: [
          { kind: "sheet.create", sheetId, name: "Summary", after: null },
          {
            kind: "cells.set",
            sheet: { kind: "created-in-batch", sheetId, createCommandIndex: 0 },
            anchor: { row: 0, column: 0 },
            rows: 3,
            columns: 3,
            cells: [
              "Month",
              "Revenue",
              "Double",
              "Jan",
              120,
              { formula: "=B2*2", cached: 240 },
              "Feb",
              140,
              { formula: "=B3*2", cached: 280 },
            ],
          },
        ],
      },
      resolvedBaseBytes: source.frontier(),
    });
    const snapshot = source.snapshot();
    const stateHash = source.stateHash();
    const headSequence = Number(source.revision());
    const environment = await installRuntime(root, runtime.target, runtime.buildIdentity);
    const identity = await invoke({ root, executable, environment } as Fixture, IDENTITY);
    if (identity.exitCode !== 0 || identity.stderr !== "") {
      throw new Error(`materializer identity failed: ${identity.stderr}`);
    }
    const capabilities = JSON.parse(new TextDecoder().decode(identity.stdout)) as Capability;
    return Object.freeze({
      root,
      executable,
      environment,
      snapshot,
      stateHash,
      headSequence,
      capabilities,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    source.dispose();
  }
}

async function installRuntime(
  root: string,
  target: ArtifactRuntimeTarget,
  buildIdentity: string,
): Promise<Readonly<Record<string, string>>> {
  const runtimeRoot = join(root, "runtime");
  const kernelRoot = join(runtimeRoot, "kernel");
  await mkdir(kernelRoot, { recursive: true });
  const sourceAsset = join(
    import.meta.dir,
    "..",
    "kernel",
    "bindings",
    "dist",
    "native",
    `${process.platform}-${process.arch}`,
    "opengeni_artifact_kernel.node",
  );
  const assetPath = join(kernelRoot, "opengeni_artifact_kernel.node");
  await copyFile(sourceAsset, assetPath);
  const assetBytes = new Uint8Array(await readFile(assetPath));
  const identity: ArtifactKernelPackageIdentity = {
    schemaVersion: 1,
    target,
    kind: "native",
    packageName: artifactRuntimeTarget(target).packageName,
    packageVersion: packageJson.version,
    artifactToolVersion: packageJson.version,
    buildIdentity,
  };
  const entrypointBytes = text(
    [
      'import { createRequire } from "node:module";',
      'import { fileURLToPath } from "node:url";',
      `export const artifactKernelPackageIdentity = Object.freeze(${JSON.stringify(identity)});`,
      "const require = createRequire(import.meta.url);",
      "let binding;",
      "export function loadArtifactKernelBinding() {",
      '  binding ??= require(fileURLToPath(new URL("./opengeni_artifact_kernel.node", import.meta.url)));',
      "  return binding;",
      "}",
      "",
    ].join("\n"),
  );
  const facadeBytes = text("export const artifactRuntimeFixture = true;\n");
  const entrypointPath = join(kernelRoot, "index.js");
  const facadePath = join(runtimeRoot, "skill-facade.js");
  await Promise.all([
    writeFile(entrypointPath, entrypointBytes),
    writeFile(facadePath, facadeBytes),
  ]);

  const selected = packageManifest(target, buildIdentity, entrypointBytes, assetBytes);
  const release = {
    schemaVersion: 1,
    artifactTool: {
      packageName: "@opengeni/artifact-tool" as const,
      packageVersion: packageJson.version,
      integrity,
    },
    targets: ARTIFACT_RUNTIME_MATRIX.map((entry, index) =>
      entry.target === target
        ? selected
        : packageManifest(
            entry.target,
            buildIdentity,
            text(`unused-entry-${index}`),
            text(`unused-asset-${index}`),
          ),
    ),
  } as const;
  const releaseBytes = canonicalArtifactRuntimeReleaseManifestBytes(release);
  await writeFile(join(runtimeRoot, "release-manifest.json"), releaseBytes);
  const installation: ArtifactRuntimeInstallationManifest = {
    schemaVersion: 1,
    target,
    releaseManifest: descriptor("release-manifest.json", releaseBytes),
    artifactTool: release.artifactTool,
    skillFacadeEntrypoint: descriptor("skill-facade.js", facadeBytes),
    kernelPackageRoot: "kernel",
    kernel: selected,
  };
  const manifestPath = join(runtimeRoot, "installation.json");
  await writeFile(manifestPath, `${JSON.stringify(installation, null, 2)}\n`);
  return Object.freeze({
    [ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: manifestPath,
    [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: facadePath,
  });
}

function packageManifest(
  target: ArtifactRuntimeTarget,
  buildIdentity: string,
  entrypointBytes: Uint8Array,
  assetBytes: Uint8Array,
): ArtifactKernelPackageManifest {
  const targetIdentity = artifactRuntimeTarget(target);
  return {
    schemaVersion: 1,
    target,
    kind: targetIdentity.kind,
    packageName: targetIdentity.packageName,
    packageVersion: packageJson.version,
    artifactToolVersion: packageJson.version,
    buildIdentity,
    entrypoint: descriptor("index.js", entrypointBytes),
    asset: descriptor(
      target === "wasm-web" ? "artifact_kernel_bg.wasm" : "opengeni_artifact_kernel.node",
      assetBytes,
    ),
    supportFiles: [],
  };
}

function manifest(
  override: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    protocol: "OGAMJ001",
    artifactId: "11111111111111112222222222222222",
    jobId: "22222222222222223333333333333333",
    versionId: "33333333333333334444444444444444",
    modality: "spreadsheet",
    inputSnapshotId: "44444444444444445555555555555555",
    targetHeadSequence: fixture.headSequence,
    stateHash: fixture.stateHash,
    sourceByteSize: fixture.snapshot.byteLength,
    sourceContentHash: sha256(fixture.snapshot),
    modelSchemaVersion: 1,
    operationProtocolVersion: 1,
    snapshotProtocolVersion: 1,
    format: "xlsx",
    codecId: "opengeni.xlsx",
    normalizedOptions: {},
    optionsHash: sha256(text("{}")),
    codecVersion: codecVersion(),
    kernelVersion: fixture.capabilities.kernelVersion,
    fontRegistryHash: fixture.capabilities.fontRegistryHash,
    policyHash: fixture.capabilities.policyHash,
    ...override,
  };
}

function codecVersion(): string {
  return fixture.capabilities.codecVersions["opengeni.xlsx"]!;
}

function framed(magic: Uint8Array, metadata: unknown, payload: Uint8Array): Uint8Array {
  const metadataBytes = text(JSON.stringify(metadata));
  const output = new Uint8Array(20 + metadataBytes.byteLength + payload.byteLength);
  output.set(magic, 0);
  const view = new DataView(output.buffer);
  view.setUint32(8, metadataBytes.byteLength, true);
  view.setBigUint64(12, BigInt(payload.byteLength), true);
  output.set(metadataBytes, 20);
  output.set(payload, 20 + metadataBytes.byteLength);
  return output;
}

function parseFrame(value: Uint8Array): ParsedFrame {
  if (value.byteLength < 20) throw new Error("truncated materializer frame");
  const magic = new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(0, 8));
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const metadataLength = view.getUint32(8, true);
  const payloadLength = Number(view.getBigUint64(12, true));
  if (20 + metadataLength + payloadLength !== value.byteLength) {
    throw new Error("inconsistent materializer frame");
  }
  const metadata = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(20, 20 + metadataLength)),
  ) as Record<string, unknown>;
  return Object.freeze({
    magic,
    metadata,
    payload: value.slice(20 + metadataLength),
  });
}

async function invoke(
  target: Pick<Fixture, "executable" | "environment">,
  argument: string,
  input?: Uint8Array,
): Promise<Readonly<{ exitCode: number; stdout: Uint8Array; stderr: string }>> {
  const child = Bun.spawn([target.executable, argument], {
    env: { ...target.environment, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input) child.stdin.write(input);
  child.stdin.end();
  const stdout = new Response(child.stdout).arrayBuffer();
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;
  return Object.freeze({
    exitCode,
    stdout: new Uint8Array(await stdout),
    stderr: await stderr,
  });
}

function descriptor(path: string, value: Uint8Array) {
  return {
    path,
    bytes: value.byteLength,
    sha256: sha256(value),
  } as const;
}

function sha256(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
