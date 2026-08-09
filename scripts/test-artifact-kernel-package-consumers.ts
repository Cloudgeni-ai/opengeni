#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import packageJson from "../packages/artifact-tool/package.json" with { type: "json" };
import {
  readArtifactKernelBuildReceipt,
  writeArtifactKernelBuildReceipt,
} from "../packages/artifact-tool/kernel/bindings/package-receipt";
import {
  materializeArtifactKernelPackages,
  renderArtifactSkillFacadeBootstrap,
} from "./materialize-artifact-kernel-packages";
import { assembleArtifactRuntimeInstallation } from "./assemble-artifact-runtime-installation";
import {
  ARTIFACT_RUNTIME_ENVIRONMENT,
  ARTIFACT_RUNTIME_MATRIX,
  artifactRuntimeTarget,
  type ArtifactKernelPackageManifest,
} from "../packages/artifact-tool/src/runtime";
import { canonicalArtifactRuntimeReleaseManifestBytes } from "../packages/artifact-tool/src/runtime-cli";
import { rewriteEntryPointsToDist } from "./rewrite-entry-points";
import type { PackageJson } from "./publishable-workspaces";

const repoRoot = resolve(import.meta.dir, "..");
const bindingRoot = join(repoRoot, "packages", "artifact-tool", "kernel", "bindings", "dist");
const nativeTarget = `${process.platform}-${process.arch}`;
if (nativeTarget !== "darwin-arm64") {
  throw new Error(`This local execution proof requires darwin-arm64, received ${nativeTarget}`);
}
await writeArtifactKernelBuildReceipt("darwin-arm64", bindingRoot);
await writeArtifactKernelBuildReceipt("wasm-web", bindingRoot);
const nativeReceipt = await readArtifactKernelBuildReceipt("darwin-arm64", bindingRoot);
const wasmReceipt = await readArtifactKernelBuildReceipt("wasm-web", bindingRoot);
const buildIdentity = nativeReceipt.buildIdentity;
if (wasmReceipt.buildIdentity !== buildIdentity) {
  throw new Error("Actual Darwin and WASM binding build identities differ");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "opengeni-artifact-kernel-consumer-"));
let passed = false;
try {
  const materializedRoot = join(temporaryRoot, "materialized");
  const tarballRoot = join(temporaryRoot, "tarballs");
  const stagingRoot = join(temporaryRoot, "staging");
  const consumerRoot = join(temporaryRoot, "consumer");
  await Promise.all([
    mkdir(materializedRoot, { recursive: true }),
    mkdir(tarballRoot, { recursive: true }),
    mkdir(stagingRoot, { recursive: true }),
    mkdir(consumerRoot, { recursive: true }),
  ]);
  const packages = await materializeArtifactKernelPackages({
    assetRoot: bindingRoot,
    outputRoot: materializedRoot,
    artifactToolVersion: packageJson.version,
    targets: ["darwin-arm64", "wasm-web"],
  });
  const tarballs = new Map<string, string>();
  for (const targetPackage of packages) {
    const packed = await run(
      ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballRoot],
      targetPackage.packageRoot,
      true,
    );
    const filename = packed.trim().split("\n").filter(Boolean).at(-1);
    if (!filename) throw new Error(`No tarball reported for ${targetPackage.packageName}`);
    const tarball = join(tarballRoot, basename(filename));
    tarballs.set(targetPackage.packageName, tarball);
    const contents = await run(["tar", "-tzf", tarball], consumerRoot, true);
    for (const required of [
      "package/package.json",
      "package/index.js",
      "package/index.d.ts",
      "package/artifact-kernel-manifest.json",
      "package/artifact-kernel-build-receipt.json",
      `package/${targetPackage.manifest.asset.path}`,
      ...targetPackage.manifest.supportFiles.map(({ path }) => `package/${path}`),
    ]) {
      if (!contents.split("\n").includes(required)) {
        throw new Error(`${targetPackage.packageName} tarball is missing ${required}`);
      }
    }
  }

  for (const modality of ["spreadsheet", "document", "presentation"] as const) {
    const packageRoot = join(repoRoot, "packages", `artifact-kernel-wasm-${modality}`);
    await run(["bun", "run", "build"], packageRoot);
    const manifest = JSON.parse(await Bun.file(join(packageRoot, "package.json")).text()) as {
      name: string;
    };
    const packed = await run(
      ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballRoot],
      packageRoot,
      true,
    );
    const filename = packed.trim().split("\n").filter(Boolean).at(-1);
    if (!filename) throw new Error(`No tarball reported for ${manifest.name}`);
    const tarball = join(tarballRoot, basename(filename));
    tarballs.set(manifest.name, tarball);
    const contents = (await run(["tar", "-tzf", tarball], consumerRoot, true)).split("\n");
    for (const required of [
      "package/package.json",
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/dist/artifact-kernel-runtime.json",
      `package/dist/artifact_kernel_${modality}.js`,
      `package/dist/artifact_kernel_${modality}_bg.wasm`,
    ]) {
      if (!contents.includes(required)) {
        throw new Error(`${manifest.name} tarball is missing ${required}`);
      }
    }
    for (const forbidden of [
      "artifact_kernel.js",
      ...(["spreadsheet", "document", "presentation"] as const)
        .filter((other) => other !== modality)
        .map((other) => `artifact_kernel_${other}.js`),
    ]) {
      if (contents.some((path) => path.endsWith(`/${forbidden}`))) {
        throw new Error(`${manifest.name} tarball includes unrelated runtime ${forbidden}`);
      }
    }
  }

  const nativeTarball = tarballs.get("@opengeni/artifact-kernel-darwin-arm64");
  const wasmTarball = tarballs.get("@opengeni/artifact-kernel-wasm-web");
  if (!nativeTarball || !wasmTarball) throw new Error("Local target tarballs were not produced");
  const contractsRoot = join(repoRoot, "packages", "contracts");
  const artifactToolRoot = join(repoRoot, "packages", "artifact-tool");
  const sdkRoot = join(repoRoot, "packages", "sdk");
  await run(["bun", "run", "build"], contractsRoot);
  await run(["bun", "run", "build"], artifactToolRoot);
  await run(["bun", "run", "build"], sdkRoot);
  const contractsTarball = await packBuiltWorkspace(contractsRoot, stagingRoot, tarballRoot);
  const contractsManifest = JSON.parse(
    await Bun.file(join(contractsRoot, "package.json")).text(),
  ) as PackageJson;
  const artifactToolTarball = await packBuiltWorkspace(artifactToolRoot, stagingRoot, tarballRoot, {
    "@opengeni/contracts": `^${contractsManifest.version}`,
  });
  const sdkTarball = await packBuiltWorkspace(sdkRoot, stagingRoot, tarballRoot, {
    "@opengeni/contracts": `^${contractsManifest.version}`,
  });
  const browserKernelTarballs = Object.fromEntries(
    ["spreadsheet", "document", "presentation"].map((modality) => {
      const name = `@opengeni/artifact-kernel-wasm-${modality}`;
      const tarball = tarballs.get(name);
      if (!tarball) throw new Error(`Missing packed browser kernel ${name}`);
      return [name, `file:${tarball}`];
    }),
  );
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "opengeni-artifact-kernel-clean-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@opengeni/artifact-tool": `file:${artifactToolTarball}`,
          "@opengeni/contracts": `file:${contractsTarball}`,
          "@opengeni/sdk": `file:${sdkTarball}`,
          "@opengeni/artifact-kernel-darwin-arm64": `file:${nativeTarball}`,
          "@opengeni/artifact-kernel-wasm-web": `file:${wasmTarball}`,
          ...browserKernelTarballs,
        },
        overrides: {
          "@opengeni/contracts": `file:${contractsTarball}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  await run(["bun", "install", "--ignore-scripts"], consumerRoot);
  const nativePackage = packages.find(({ target }) => target === "darwin-arm64");
  if (!nativePackage) throw new Error("Darwin target package was not materialized");
  const installedRuntimeRoot = join(consumerRoot, "installed-runtime");
  const releaseManifestPath = join(consumerRoot, "packed-release-fixture.json");
  const artifactToolIntegrity = `sha512-${createHash("sha512")
    .update(new Uint8Array(await Bun.file(artifactToolTarball).arrayBuffer()))
    .digest("base64")}` as const;
  const releaseManifest = {
    schemaVersion: 1,
    artifactTool: {
      packageName: "@opengeni/artifact-tool" as const,
      packageVersion: packageJson.version,
      integrity: artifactToolIntegrity,
    },
    targets: ARTIFACT_RUNTIME_MATRIX.map(({ target }, index) =>
      target === nativePackage.manifest.target
        ? nativePackage.manifest
        : packedReleaseFixtureTarget(target, buildIdentity, index),
    ),
  } as const;
  await writeFile(
    releaseManifestPath,
    canonicalArtifactRuntimeReleaseManifestBytes(releaseManifest),
  );
  await assembleArtifactRuntimeInstallation({
    releaseManifestPath,
    kernelPackageRoot: join(
      consumerRoot,
      "node_modules",
      "@opengeni",
      "artifact-kernel-darwin-arm64",
    ),
    artifactToolTarballPath: artifactToolTarball,
    outputRoot: installedRuntimeRoot,
    target: "darwin-arm64",
  });
  const relocatedRuntimeRoot = join(consumerRoot, "relocated-runtime");
  await rename(installedRuntimeRoot, relocatedRuntimeRoot);
  await runWithEnvironment(
    [
      "bun",
      join(consumerRoot, "node_modules", ".bin", "opengeni-artifact-runtime"),
      "doctor",
      "--json",
    ],
    consumerRoot,
    {
      [ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: join(relocatedRuntimeRoot, "installation.json"),
      [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: join(
        relocatedRuntimeRoot,
        "skill-facade-entry.mjs",
      ),
    },
  );
  const locatorEnvironment = { ...process.env };
  delete locatorEnvironment.OPENGENI_ARTIFACT_RUNTIME_MANIFEST;
  delete locatorEnvironment.OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST;
  delete locatorEnvironment.OPENGENI_ARTIFACT_TOOL_ENTRY;
  const locator = Bun.spawn({
    cmd: [
      "bun",
      join(consumerRoot, "node_modules", ".bin", "opengeni-artifact-runtime"),
      "locate",
      "--json",
    ],
    cwd: consumerRoot,
    env: locatorEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [locatorStdout, locatorStderr, locatorExit] = await Promise.all([
    new Response(locator.stdout).text(),
    new Response(locator.stderr).text(),
    locator.exited,
  ]);
  if (locatorExit === 0 || locatorStdout !== "") {
    throw new Error("Packed runtime locator did not fail closed without an installation");
  }
  const locatorFailure = JSON.parse(locatorStderr) as { error?: { code?: string } };
  if (locatorFailure.error?.code !== "ARTIFACT_RUNTIME_UNAVAILABLE") {
    throw new Error("Packed runtime locator did not return its stable JSON error");
  }
  await writeFile(
    join(consumerRoot, "artifact-facade-bootstrap.mjs"),
    renderArtifactSkillFacadeBootstrap(nativePackage.manifest),
  );
  await writeFile(
    join(consumerRoot, "facade-smoke.mjs"),
    [
      'import { Workbook, disposeArtifact, getArtifactCompositeDiagnostics, getConfiguredArtifactRuntime } from "./artifact-facade-bootstrap.mjs";',
      `const expectedIdentity = ${JSON.stringify(buildIdentity)};`,
      "const runtime = getConfiguredArtifactRuntime();",
      'if (runtime.kind !== "native" || runtime.target !== "darwin-arm64" || runtime.buildIdentity !== expectedIdentity) throw new Error("pinned root facade runtime mismatch");',
      "const workbook = Workbook.create();",
      "try {",
      '  const sheet = workbook.worksheets.add("Packed");',
      '  sheet.getRange("A1:B2").values = [["Pinned production facade", 1], ["Ready", true]];',
      "  const proof = getArtifactCompositeDiagnostics(workbook);",
      '  if (proof.runtimeTarget !== "darwin-arm64" || proof.runtimeBuildIdentity !== expectedIdentity || typeof proof.nativeStateHash !== "string") throw new Error("root facade native proof mismatch");',
      "} finally {",
      "  disposeArtifact(workbook);",
      "}",
      "console.log(`PACKED_FACADE_OK identity=${expectedIdentity}`);",
      "",
    ].join("\n"),
  );
  await run(["bun", "run", "facade-smoke.mjs"], consumerRoot);
  await writeFile(
    join(consumerRoot, "native-smoke.ts"),
    [
      'import { artifactKernelPackageIdentity, loadArtifactKernelBinding } from "@opengeni/artifact-kernel-darwin-arm64";',
      `const expectedIdentity = ${JSON.stringify(buildIdentity)};`,
      "const binding = await loadArtifactKernelBinding() as { buildIdentity(): Uint8Array; capabilities(): Uint8Array };",
      'const identity = new TextDecoder("utf-8", { fatal: true }).decode(binding.buildIdentity());',
      'if (identity !== expectedIdentity) throw new Error("packed native identity mismatch");',
      "const capabilities = JSON.parse(new TextDecoder().decode(binding.capabilities()));",
      'if (capabilities.safeRust !== true || capabilities.collaboration !== true) throw new Error("packed native capabilities missing");',
      'if (artifactKernelPackageIdentity.buildIdentity !== identity) throw new Error("packed native identity mismatch");',
      "console.log(`PACKED_NATIVE_OK target=${artifactKernelPackageIdentity.target} identity=${identity}`);",
      "",
    ].join("\n"),
  );
  await run(["bun", "run", "native-smoke.ts"], consumerRoot);

  await writeFile(
    join(consumerRoot, "index.html"),
    '<!doctype html><html><body data-status="loading"><script type="module" src="/browser.ts"></script></body></html>\n',
  );
  await writeFile(
    join(consumerRoot, "browser.ts"),
    [
      'import workerAssetUrl from "@opengeni/sdk/editable-artifacts/worker?worker&url";',
      'import { createBrowserEditableArtifactWorkerKernel, encodeDocumentArtifactCommandBatch, encodePresentationArtifactCommandBatch } from "@opengeni/sdk/editable-artifacts";',
      'import { encodeSpreadsheetArtifactCommandBatch } from "@opengeni/contracts/spreadsheet-artifact-commands";',
      'import * as spreadsheetPackage from "@opengeni/artifact-kernel-wasm-spreadsheet";',
      'import * as documentPackage from "@opengeni/artifact-kernel-wasm-document";',
      'import * as presentationPackage from "@opengeni/artifact-kernel-wasm-presentation";',
      "const workerUrl = new URL(workerAssetUrl, location.href).href;",
      "const packages = { spreadsheet: spreadsheetPackage, document: documentPackage, presentation: presentationPackage } as const;",
      "try {",
      "  const results: string[] = [];",
      '  for (const modality of ["spreadsheet", "document", "presentation"] as const) {',
      "    const pkg = packages[modality];",
      "    const identity = pkg.artifactKernelRuntimeIdentity;",
      "    if (identity.modality !== modality || identity.kernelVersion !== identity.buildIdentity) throw new Error(`${modality} static runtime identity mismatch`);",
      "    const binding = await pkg.loadArtifactKernelBinding() as any;",
      '    const actualBuild = new TextDecoder("utf-8", { fatal: true }).decode(binding.buildIdentity());',
      "    if (actualBuild !== identity.buildIdentity) throw new Error(`${modality} executable build identity mismatch`);",
      "    const namespace = encodeNamespace(BigInt(11 + results.length));",
      '    const sessionClass = modality === "spreadsheet" ? binding.ArtifactCollaborationSession : modality === "document" ? binding.ArtifactDocumentSession : binding.ArtifactPresentationSession;',
      "    const seed = sessionClass.create(namespace);",
      "    let snapshotBytes: Uint8Array;",
      "    let stateHash: string;",
      "    let nativeRevision = 0;",
      "    try {",
      "      snapshotBytes = seed.snapshot();",
      "      stateHash = seed.stateHash();",
      '      if (modality !== "spreadsheet") nativeRevision = Number(seed.revision());',
      "    } finally { seed.close?.(); seed.dispose?.(); seed.free(); }",
      "    const digest = await sha256(snapshotBytes);",
      "    const kernel = createBrowserEditableArtifactWorkerKernel({",
      "      ...pkg.editableArtifactKernelRuntime,",
      "      workerUrl,",
      "      applicationOrigin: location.origin,",
      "    });",
      "    try {",
      '      await kernel.loadSnapshot(modality === "spreadsheet" ? { modality, artifactId: artifactId(modality), sequence: 0, stateHash, digest, kernelVersion: identity.kernelVersion, modelSchemaVersion: identity.modelSchemaVersion, protocolVersion: identity.protocolVersion, causalFrontier: [], bytes: snapshotBytes } : { modality, artifactId: artifactId(modality), sequence: 0, stateHash, digest, kernelVersion: identity.kernelVersion, modelSchemaVersion: identity.modelSchemaVersion, nativeRevision, bytes: snapshotBytes });',
      '      if (modality === "spreadsheet") {',
      "        const before = await kernel.querySpreadsheetMetadata({ maxSheets: 8, maxBytes: 16_384 });",
      '        if (before.sheets.length !== 0) throw new Error("spreadsheet initial query mismatch");',
      '        const authored = await kernel.authorPending({ ...authorBase(modality, identity), causalBase: [], selectiveUndoTargets: [], commandBytes: encodeSpreadsheetArtifactCommandBatch({ version: identity.commandVersion, commands: [{ kind: "sheet.create", sheetId: "11111111111111110000000000000001", name: "Packed", after: null }] }) });',
      "        await kernel.replacePending([authored]);",
      "        const after = await kernel.querySpreadsheetMetadata({ maxSheets: 8, maxBytes: 16_384 });",
      '        if (after.sheets[0]?.name !== "Packed") throw new Error("spreadsheet edit did not change Worker state");',
      '      } else if (modality === "document") {',
      '        const before = await kernel.queryDocument({ kind: "summary" });',
      '        const beforeSummary = before.items.find((item) => item.kind === "summary");',
      '        if (!beforeSummary || beforeSummary.kind !== "summary" || beforeSummary.trackRevisions) throw new Error("document initial query mismatch");',
      '        const authored = await kernel.authorPending({ ...authorBase(modality, identity), observedNativeRevision: nativeRevision, commandBytes: encodeDocumentArtifactCommandBatch({ version: identity.commandVersion, commands: [{ kind: "document.flags.set", trackRevisions: true }] }) });',
      "        await kernel.replacePending([authored]);",
      '        const after = await kernel.queryDocument({ kind: "summary" });',
      '        const summary = after.items.find((item) => item.kind === "summary");',
      '        if (!summary || summary.kind !== "summary" || !summary.trackRevisions) throw new Error("document edit did not change Worker state");',
      "      } else {",
      '        const before = await kernel.queryPresentation({ kind: "metadata", maxBytes: 4_096 });',
      '        if (before.kind !== "metadata") throw new Error("presentation initial query mismatch");',
      '        const authored = await kernel.authorPending({ ...authorBase(modality, identity), observedNativeRevision: nativeRevision, commandBytes: encodePresentationArtifactCommandBatch({ version: identity.commandVersion, commands: [{ kind: "presentation.size.set", size: { width: 12_000_000, height: 7_000_000 } }] }) });',
      "        await kernel.replacePending([authored]);",
      '        const after = await kernel.queryPresentation({ kind: "metadata", maxBytes: 4_096 });',
      '        if (after.kind !== "metadata" || after.slideSize.width !== 12_000_000) throw new Error("presentation edit did not change Worker state");',
      "      }",
      "      results.push(`${modality}:ok`);",
      "    } finally { await kernel.dispose(); }",
      "  }",
      "  await expectInitializationFailure({ ...spreadsheetPackage.editableArtifactKernelRuntime, wasmGlueUrl: new URL('/missing-kernel.js', location.origin) }, 'missing glue');",
      "  await expectInitializationFailure({ ...documentPackage.editableArtifactKernelRuntime, wasmBinaryUrl: new URL('/corrupt.wasm', location.origin) }, 'corrupt wasm');",
      "  await expectInitializationFailure({ ...presentationPackage.editableArtifactKernelRuntime, kernelVersion: `${presentationPackage.editableArtifactKernelRuntime.kernelVersion}-mismatch` }, 'mismatched identity');",
      '  document.body.dataset.status = "ok";',
      "  document.body.textContent = `PACKED_SDK_WORKER_WASM_OK ${results.join(',')}`;",
      "} catch (error) {",
      '  document.body.dataset.status = "error";',
      "  document.body.textContent = error instanceof Error ? error.stack ?? error.message : String(error);",
      "}",
      "function authorBase(modality: 'spreadsheet' | 'document' | 'presentation', identity: { protocolVersion: number; kernelVersion: string; modelSchemaVersion: number; commandVersion: number }) {",
      "  return { modality, protocolVersion: identity.protocolVersion, kernelVersion: identity.kernelVersion, modelSchemaVersion: identity.modelSchemaVersion, commandVersion: identity.commandVersion, artifactId: artifactId(modality), clientTransactionId: `packed-${modality}-1`, replicaId: '0000000000000001', replicaCounter: 1, previousLocalTransactionId: null, observedHeadSequence: 0, createdAt: 1 };",
      "}",
      "function artifactId(modality: string) { return `${modality === 'spreadsheet' ? '1' : modality === 'document' ? '2' : '3'}0000000000000000000000000000000`; }",
      "function encodeNamespace(value: bigint) { const bytes = new Uint8Array(28); bytes.set(new TextEncoder().encode('OGAKN001')); const view = new DataView(bytes.buffer); view.setUint16(8, 1, true); view.setBigUint64(12, value, true); let hash = 0xcbf29ce484222325n; for (const byte of bytes.subarray(0, 20)) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); } view.setBigUint64(20, hash, true); return bytes; }",
      "async function sha256(bytes: Uint8Array) { const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); return `sha256:${[...hash].map((value) => value.toString(16).padStart(2, '0')).join('')}`; }",
      "async function expectInitializationFailure(runtime: any, label: string) { const kernel = createBrowserEditableArtifactWorkerKernel({ ...runtime, workerUrl, applicationOrigin: location.origin }); try { let failed = false; try { await kernel.reset(); } catch { failed = true; } if (!failed) throw new Error(`${label} was accepted`); } finally { await kernel.dispose(); } }",
      "",
    ].join("\n"),
  );
  await mkdir(join(consumerRoot, "public"), { recursive: true });
  await writeFile(join(consumerRoot, "public", "corrupt.wasm"), new Uint8Array([0, 97, 115]));
  await writeFile(
    join(consumerRoot, "vite.config.ts"),
    'export default { build: { target: "esnext", outDir: "dist", emptyOutDir: true }, optimizeDeps: { exclude: ["@opengeni/artifact-kernel-wasm-spreadsheet", "@opengeni/artifact-kernel-wasm-document", "@opengeni/artifact-kernel-wasm-presentation"] } };\n',
  );
  const viteModule = Bun.resolveSync("vite", join(repoRoot, "packages", "react"));
  const viteCli = resolve(dirname(viteModule), "..", "..", "bin", "vite.js");
  await run(
    ["bun", viteCli, "build", "--config", "vite.config.ts", "--logLevel", "warn"],
    consumerRoot,
  );
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = Bun.file(join(consumerRoot, "dist", requested));
      return (await file.exists())
        ? new Response(file)
        : new Response("Not found", { status: 404 });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => document.body.dataset.status !== "loading");
    const status = await page.getAttribute("body", "data-status");
    if (status !== "ok")
      throw new Error(`Packed WASM browser proof failed: ${await page.textContent("body")}`);
  } finally {
    await browser.close();
    server.stop(true);
  }
  passed = true;
  process.stdout.write(
    `${JSON.stringify({ native: "darwin-arm64 actual packed Bun consumer", wasm: "actual packed Chromium consumer", buildIdentity })}\n`,
  );
} finally {
  if (passed || process.env.OPENGENI_KEEP_ARTIFACT_KERNEL_CONSUMER !== "1") {
    await rm(temporaryRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Preserved failed artifact kernel consumer proof: ${temporaryRoot}\n`);
  }
}

async function run(command: string[], cwd: string, capture = false): Promise<string> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: process.env,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    capture ? new Response(child.stdout).text() : Promise.resolve(""),
    capture ? new Response(child.stderr).text() : Promise.resolve(""),
    child.exited,
  ]);
  if (exitCode !== 0) {
    if (stdout) process.stderr.write(stdout);
    if (stderr) process.stderr.write(stderr);
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
  return stdout;
}

async function runWithEnvironment(
  command: string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const childEnvironment = { ...process.env, ...environment };
  delete childEnvironment.OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST;
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: childEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout || `${command.join(" ")} failed`);
}

function packedReleaseFixtureTarget(
  target: (typeof ARTIFACT_RUNTIME_MATRIX)[number]["target"],
  identity: string,
  index: number,
): ArtifactKernelPackageManifest {
  const runtime = artifactRuntimeTarget(target);
  const entrypoint = new TextEncoder().encode(`fixture-entry-${index}`);
  const asset = new TextEncoder().encode(`fixture-asset-${index}`);
  const proof = (path: string, bytes: Uint8Array) => ({
    path,
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
  });
  return {
    schemaVersion: 1,
    target,
    kind: runtime.kind,
    packageName: runtime.packageName,
    packageVersion: packageJson.version,
    artifactToolVersion: packageJson.version,
    buildIdentity: identity,
    entrypoint: proof("index.js", entrypoint),
    asset: proof(
      target === "wasm-web" ? "artifact_kernel_bg.wasm" : "opengeni_artifact_kernel.node",
      asset,
    ),
    supportFiles: [],
  };
}

async function packBuiltWorkspace(
  sourceRoot: string,
  stagingRoot: string,
  tarballRoot: string,
  dependencyOverrides: Readonly<Record<string, string>> = {},
): Promise<string> {
  const source = JSON.parse(await Bun.file(join(sourceRoot, "package.json")).text()) as PackageJson;
  const destination = join(stagingRoot, String(source.name).replace("@opengeni/", ""));
  await mkdir(destination, { recursive: true });
  for (const entry of ["LICENSE", "README.md", "dist"]) {
    if (!existsSync(join(sourceRoot, entry))) continue;
    await cp(join(sourceRoot, entry), join(destination, entry), { recursive: true });
  }
  const manifest = structuredClone(source);
  delete manifest.devDependencies;
  rewriteEntryPointsToDist(manifest);
  manifest.dependencies = { ...manifest.dependencies, ...dependencyOverrides };
  await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = await run(
    ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballRoot],
    destination,
    true,
  );
  const filename = packed.trim().split("\n").filter(Boolean).at(-1);
  if (!filename) throw new Error(`No tarball reported for ${source.name}`);
  return join(tarballRoot, basename(filename));
}
