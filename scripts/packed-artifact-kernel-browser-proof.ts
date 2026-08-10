import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";

const repoRoot = resolve(import.meta.dir, "..");

export async function provePackedArtifactKernelBrowser(consumerRoot: string): Promise<void> {
  await writeFile(
    join(consumerRoot, "index.html"),
    '<!doctype html><html><body data-status="loading"><script type="module" src="/browser.ts"></script></body></html>\n',
  );
  await writeFile(join(consumerRoot, "browser.ts"), `${browserProofSource()}\n`);
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

  const distRoot = resolve(consumerRoot, "dist");
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const path = resolve(distRoot, relativePath);
      if (path !== distRoot && !path.startsWith(`${distRoot}${sep}`)) {
        return new Response("Not found", { status: 404 });
      }
      const file = Bun.file(path);
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
    const report = await page.textContent("body");
    if (status !== "ok") throw new Error(`Packed WASM browser proof failed: ${report}`);
    if (
      report !==
      "PACKED_SDK_WORKER_WASM_OK spreadsheet:ok,document:ok,presentation:ok missing:kernel_failed,corrupt:kernel_failed,mismatch:runtime_identity_mismatch"
    ) {
      throw new Error(`Packed WASM browser proof returned an incomplete report: ${report}`);
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
}

function browserProofSource(): string {
  return [
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
    "    const binding = await pkg.loadArtifactKernelBinding();",
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
    "  const negatives: string[] = [];",
    "  negatives.push(await expectInitializationFailure({ ...spreadsheetPackage.editableArtifactKernelRuntime, wasmGlueUrl: new URL('/missing-kernel.js', location.origin) }, 'missing', 'kernel_failed'));",
    "  negatives.push(await expectInitializationFailure({ ...documentPackage.editableArtifactKernelRuntime, wasmBinaryUrl: new URL('/corrupt.wasm', location.origin) }, 'corrupt', 'kernel_failed'));",
    "  negatives.push(await expectInitializationFailure({ ...presentationPackage.editableArtifactKernelRuntime, kernelVersion: `${presentationPackage.editableArtifactKernelRuntime.kernelVersion}-mismatch` }, 'mismatch', 'runtime_identity_mismatch'));",
    '  document.body.dataset.status = "ok";',
    "  document.body.textContent = `PACKED_SDK_WORKER_WASM_OK ${results.join(',')} ${negatives.join(',')}`;",
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
    "async function expectInitializationFailure(runtime: any, label: string, expectedCode: string) { const kernel = createBrowserEditableArtifactWorkerKernel({ ...runtime, workerUrl, applicationOrigin: location.origin }); try { try { await kernel.reset(); } catch (error) { const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''; if (code !== expectedCode) throw new Error(`${label} failed with ${code || 'no stable code'}, expected ${expectedCode}`); return `${label}:${code}`; } throw new Error(`${label} was accepted`); } finally { await kernel.dispose(); } }",
  ].join("\n");
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
}
