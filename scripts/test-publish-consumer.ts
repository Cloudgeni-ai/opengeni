#!/usr/bin/env bun
/**
 * Prove the built SDK + artifact engine + React package artifacts from an
 * external consumer.
 *
 * The workspace itself resolves package source directly, so ordinary unit/type
 * checks cannot catch a broken published exports map, missing CSS declaration,
 * cross-tarball declaration drift, or a client-only global reached during SSR.
 * This gate stages release-shaped tarballs, installs them twice (the second time
 * from the frozen Bun lock), typechecks with stable TypeScript 7, builds the root and session
 * subpaths through Vite, verifies the packed runtime skill-library subpath, and
 * server-renders populated embedded host surfaces without a DOM. A second
 * consumer installs only the session subpath's required peers. A third imports
 * only the public SDK/React realtime subpaths, renders both batteries-included
 * composer controls without a provider, and bundles them as an external host.
 */
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteEntryPointsToDist } from "./rewrite-entry-points";
import { rewriteWorkspaceDependenciesToConcrete } from "./rewrite-workspace-deps";
import type { PackageJson } from "./publishable-workspaces";

type PackageManifest = {
  name: string;
  version: string;
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  exports?: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  sideEffects?: boolean | string[];
};

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const keepArtifacts = process.env.OPENGENI_KEEP_PUBLISH_CONSUMER === "1";

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

process.stdout.write("[publish-consumer] rebuilding the publishable package closure\n");
await run(["bun", "run", "build:packages"], repoRoot);

function staticRelativeJavaScriptImports(source: string): string[] {
  const imports = new Set<string>();
  const pattern = /(?:\bfrom\s*|\bimport\s*)["'](\.[^"']+\.js)["']/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) imports.add(match[1]);
  }
  return [...imports];
}

async function staticBrowserChunkClosure(entryPath: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const queue = [entryPath];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (files.has(path)) continue;
    const source = await readFile(path, "utf8");
    files.set(path, source);
    for (const imported of staticRelativeJavaScriptImports(source)) {
      queue.push(resolve(path, "..", imported));
    }
  }
  return files;
}

function releaseShape(
  source: PackageManifest,
  workspaceVersionByName: ReadonlyMap<string, string>,
): PackageManifest {
  const manifest = structuredClone(source);
  delete manifest.devDependencies;

  rewriteWorkspaceDependenciesToConcrete(manifest as PackageJson, workspaceVersionByName);
  rewriteEntryPointsToDist(manifest as PackageJson);
  return manifest;
}

async function workspaceVersions(): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  for (const group of ["apps", "packages"]) {
    for (const entry of await readdir(join(repoRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(repoRoot, group, entry.name, "package.json");
      if (!existsSync(path)) continue;
      const manifest = JSON.parse(await readFile(path, "utf8")) as Partial<PackageManifest>;
      if (manifest.name && manifest.version) versions.set(manifest.name, manifest.version);
    }
  }
  return versions;
}

async function stageTarball(
  packageDirectory: string,
  stagingRoot: string,
  tarballRoot: string,
  versions: ReadonlyMap<string, string>,
): Promise<{ manifest: PackageManifest; tarball: string }> {
  const sourceRoot = join(repoRoot, packageDirectory);
  const sourceManifest = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  const destination = join(stagingRoot, sourceManifest.name.replace("@opengeni/", ""));
  await mkdir(destination, { recursive: true });

  for (const item of ["LICENSE", "README.md", "dist", "src", "styles"]) {
    const source = join(sourceRoot, item);
    if (!existsSync(source)) continue;
    await cp(source, join(destination, item), { recursive: true });
  }

  const manifest = releaseShape(sourceManifest, versions);
  await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = await run(
    ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballRoot],
    destination,
    true,
  );
  const filename = packed
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!filename) throw new Error(`bun pm pack did not report a filename for ${manifest.name}`);
  return { manifest, tarball: join(tarballRoot, basename(filename)) };
}

const tempRoot = await mkdtemp(join(tmpdir(), "opengeni-publish-consumer-"));
let passed = false;

try {
  const stagingRoot = join(tempRoot, "packages");
  const tarballRoot = join(tempRoot, "tarballs");
  const consumerRoot = join(tempRoot, "consumer");
  const minimalSpreadsheetRoot = join(tempRoot, "minimal-spreadsheet-artifact-consumer");
  const minimalSessionRoot = join(tempRoot, "minimal-session-consumer");
  const minimalRealtimeRoot = join(tempRoot, "minimal-realtime-consumer");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(tarballRoot, { recursive: true }),
    mkdir(consumerRoot, { recursive: true }),
    mkdir(minimalSpreadsheetRoot, { recursive: true }),
    mkdir(minimalSessionRoot, { recursive: true }),
    mkdir(minimalRealtimeRoot, { recursive: true }),
  ]);

  const versions = await workspaceVersions();
  const sdk = await stageTarball("packages/sdk", stagingRoot, tarballRoot, versions);
  const sdkTarballContents = await run(["tar", "-tzf", sdk.tarball], consumerRoot, true);
  for (const artifact of [
    "package/dist/editable-artifacts.js",
    "package/dist/editable-artifacts.d.ts",
    "package/dist/editable-artifacts-worker.js",
    "package/dist/editable-artifacts-worker.d.ts",
  ]) {
    if (!sdkTarballContents.split("\n").includes(artifact)) {
      throw new Error(`SDK tarball is missing ${artifact}`);
    }
  }
  const sdkEditableExport = sdk.manifest.exports?.["./editable-artifacts"];
  if (
    !sdkEditableExport ||
    typeof sdkEditableExport === "string" ||
    sdkEditableExport.types !== "./dist/editable-artifacts.d.ts" ||
    sdkEditableExport.import !== "./dist/editable-artifacts.js"
  ) {
    throw new Error("SDK tarball has an invalid ./editable-artifacts export");
  }
  const core = await stageTarball("packages/core", stagingRoot, tarballRoot, versions);
  const coreTarballContents = await run(["tar", "-tzf", core.tarball], consumerRoot, true);
  for (const artifact of [
    "package/dist/editable-artifacts.js",
    "package/dist/editable-artifacts.d.ts",
    "package/dist/editable-artifact-live.js",
    "package/dist/editable-artifact-live.d.ts",
  ]) {
    if (!coreTarballContents.split("\n").includes(artifact)) {
      throw new Error(`core tarball is missing ${artifact}`);
    }
  }
  for (const [subpath, stem] of [
    ["./editable-artifacts", "editable-artifacts"],
    ["./editable-artifact-live", "editable-artifact-live"],
  ] as const) {
    const entry = core.manifest.exports?.[subpath];
    if (
      !entry ||
      typeof entry === "string" ||
      entry.types !== `./dist/${stem}.d.ts` ||
      entry.import !== `./dist/${stem}.js`
    ) {
      throw new Error(`core tarball has an invalid ${subpath} export`);
    }
  }
  const db = await stageTarball("packages/db", stagingRoot, tarballRoot, versions);
  const dbTarballContents = await run(["tar", "-tzf", db.tarball], consumerRoot, true);
  for (const artifact of [
    "package/dist/editable-artifacts.js",
    "package/dist/editable-artifacts.d.ts",
  ]) {
    if (!dbTarballContents.split("\n").includes(artifact)) {
      throw new Error(`db tarball is missing ${artifact}`);
    }
  }
  const dbArtifactExport = db.manifest.exports?.["./editable-artifacts"];
  if (
    !dbArtifactExport ||
    typeof dbArtifactExport === "string" ||
    dbArtifactExport.types !== "./dist/editable-artifacts.d.ts" ||
    dbArtifactExport.import !== "./dist/editable-artifacts.js"
  ) {
    throw new Error("db tarball has an invalid ./editable-artifacts export");
  }
  const artifactTool = await stageTarball(
    "packages/artifact-tool",
    stagingRoot,
    tarballRoot,
    versions,
  );
  const artifactTarballContents = await run(
    ["tar", "-tzf", artifactTool.tarball],
    consumerRoot,
    true,
  );
  for (const artifact of [
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/reference.js",
    "package/dist/reference.d.ts",
    "package/dist/native.js",
    "package/dist/native.d.ts",
    "package/dist/runtime.js",
    "package/dist/runtime.d.ts",
    "package/dist/runtime-cli.js",
    "package/dist/runtime-cli.d.ts",
    "package/dist/runtime-cli-entry.js",
    "package/dist/runtime-cli-entry.d.ts",
    "package/dist/materializer-cli-entry.js",
    "package/dist/materializer-cli-entry.d.ts",
    "package/dist/production-document.js",
    "package/dist/production-document.d.ts",
    "package/dist/production-presentation.js",
    "package/dist/production-presentation.d.ts",
    "package/dist/production-spreadsheet.js",
    "package/dist/production-spreadsheet.d.ts",
    "package/dist/document.js",
    "package/dist/document.d.ts",
    "package/dist/document-render.js",
    "package/dist/document-render.d.ts",
    "package/dist/document-docx-codec.js",
    "package/dist/document-docx-codec.d.ts",
    "package/dist/presentation.js",
    "package/dist/presentation.d.ts",
    "package/dist/presentation-render.js",
    "package/dist/presentation-render.d.ts",
    "package/dist/presentation-pptx.js",
    "package/dist/presentation-pptx.d.ts",
    "package/dist/spreadsheet.js",
    "package/dist/spreadsheet.d.ts",
    "package/dist/spreadsheet-render.js",
    "package/dist/spreadsheet-render.d.ts",
    "package/dist/spreadsheet-xlsx-codec.js",
    "package/dist/spreadsheet-xlsx-codec.d.ts",
  ]) {
    if (!artifactTarballContents.split("\n").includes(artifact)) {
      throw new Error(`artifact-tool tarball is missing ${artifact}`);
    }
  }
  if (
    typeof artifactTool.manifest.bin !== "object" ||
    artifactTool.manifest.bin?.["opengeni-artifact-runtime"] !== "./dist/runtime-cli-entry.js" ||
    artifactTool.manifest.bin?.["opengeni-artifact-materializer"] !==
      "./dist/materializer-cli-entry.js"
  ) {
    throw new Error("artifact-tool tarball has invalid artifact runtime executables");
  }
  for (const [subpath, entry] of Object.entries(artifactTool.manifest.exports ?? {})) {
    if (typeof entry === "string") continue;
    for (const condition of ["types", "import"] as const) {
      const target = entry[condition];
      if (!target?.startsWith("./dist/")) {
        throw new Error(`artifact-tool tarball export ${subpath} has no ${condition} dist target`);
      }
      if (!artifactTarballContents.split("\n").includes(`package/${target.slice(2)}`)) {
        throw new Error(`artifact-tool tarball export ${subpath} is missing ${target}`);
      }
    }
  }
  for (const packagedPath of artifactTarballContents.split("\n")) {
    if (
      packagedPath.startsWith("package/kernel/") ||
      packagedPath.endsWith(".node") ||
      packagedPath.endsWith(".wasm")
    ) {
      throw new Error(
        `artifact-tool advertised an incomplete native/WASM distribution asset: ${packagedPath}`,
      );
    }
  }
  const react = await stageTarball("packages/react", stagingRoot, tarballRoot, versions);
  if (
    !Array.isArray(react.manifest.sideEffects) ||
    !react.manifest.sideEffects.includes("**/*.css")
  ) {
    throw new Error("react tarball does not preserve the CSS side-effect allowlist");
  }
  const reactTarballContents = await run(["tar", "-tzf", react.tarball], consumerRoot, true);
  for (const artifact of [
    "package/dist/artifacts.js",
    "package/dist/artifacts.d.ts",
    "package/dist/artifacts-document.js",
    "package/dist/artifacts-document.d.ts",
    "package/dist/artifacts-presentation.js",
    "package/dist/artifacts-presentation.d.ts",
    "package/dist/artifacts-spreadsheet.js",
    "package/dist/artifacts-spreadsheet.d.ts",
    "package/styles/compiled.css",
    "package/styles/compiled.d.ts",
    "package/styles/effective-tokens.css",
    "package/styles/responsive.css",
    "package/styles/responsive.d.ts",
  ]) {
    if (!reactTarballContents.split("\n").includes(artifact)) {
      throw new Error(`react tarball is missing ${artifact}`);
    }
  }
  const runtime = await stageTarball("packages/runtime", stagingRoot, tarballRoot, versions);
  const runtimeLocalDependencies = await Promise.all(
    [
      "packages/agent-proto",
      "packages/codex",
      "packages/config",
      "packages/contracts",
      "packages/network",
    ].map((directory) => stageTarball(directory, stagingRoot, tarballRoot, versions)),
  );
  const runtimeLocalDependencyFiles = Object.fromEntries(
    runtimeLocalDependencies.map(({ manifest, tarball }) => [manifest.name, `file:${tarball}`]),
  );
  const contracts = runtimeLocalDependencies.find(
    ({ manifest }) => manifest.name === "@opengeni/contracts",
  );
  if (!contracts) throw new Error("runtime package closure did not stage @opengeni/contracts");
  if (sdk.manifest.dependencies?.["@opengeni/contracts"] !== `^${contracts.manifest.version}`) {
    throw new Error("SDK tarball does not declare the staged canonical contracts version");
  }
  const contractsTarballContents = await run(
    ["tar", "-tzf", contracts.tarball],
    consumerRoot,
    true,
  );
  for (const artifact of [
    "package/dist/editable-artifacts.js",
    "package/dist/editable-artifacts.d.ts",
    "package/dist/editable-artifact-live.js",
    "package/dist/editable-artifact-live.d.ts",
  ]) {
    if (!contractsTarballContents.split("\n").includes(artifact)) {
      throw new Error(`contracts tarball is missing ${artifact}`);
    }
  }
  const contractsLiveExport = contracts.manifest.exports?.["./editable-artifact-live"];
  if (
    !contractsLiveExport ||
    typeof contractsLiveExport === "string" ||
    contractsLiveExport.types !== "./dist/editable-artifact-live.d.ts" ||
    contractsLiveExport.import !== "./dist/editable-artifact-live.js"
  ) {
    throw new Error("contracts tarball has an invalid ./editable-artifact-live export");
  }
  const runtimeTarballContents = await run(["tar", "-tzf", runtime.tarball], consumerRoot, true);
  for (const artifact of [
    "package/dist/skill-library.js",
    "package/dist/skill-library.d.ts",
    "package/dist/mcp-network.js",
    "package/dist/mcp-network.d.ts",
  ]) {
    if (!runtimeTarballContents.split("\n").includes(artifact)) {
      throw new Error(`runtime tarball is missing ${artifact}`);
    }
  }
  const rootManifest = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  const reactSource = JSON.parse(
    await readFile(join(repoRoot, "packages/react/package.json"), "utf8"),
  ) as PackageManifest;

  const sdkFile = `file:${sdk.tarball}`;
  const artifactToolFile = `file:${artifactTool.tarball}`;
  const contractsFile = `file:${contracts.tarball}`;
  const consumerManifest = {
    name: "opengeni-clean-consumer-proof",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsc -p tsconfig.json --noEmit",
      "typecheck:nodenext": "tsc -p tsconfig.nodenext.json --noEmit",
      build: "vite build --logLevel warn",
      "build:session": "vite build --config session.vite.config.ts --logLevel warn",
      "build:worker-entry": "vite build --config worker.vite.config.ts --logLevel warn",
      ssr: "bun ssr.tsx",
      "artifact-contract": "bun artifact-contract.ts",
      "artifact-codecs": "bun artifact-codecs.ts",
    },
    dependencies: {
      ...(reactSource.peerDependencies ?? {}),
      "@opengeni/artifact-tool": artifactToolFile,
      "@opengeni/contracts": contractsFile,
      "@opengeni/react": `file:${react.tarball}`,
      "@opengeni/sdk": sdkFile,
      "@opengeni/runtime": `file:${runtime.tarball}`,
    },
    devDependencies: {
      "@types/node": "^24.10.1",
      "@types/react": reactSource.devDependencies?.["@types/react"],
      "@types/react-dom": reactSource.devDependencies?.["@types/react-dom"],
      typescript: rootManifest.devDependencies?.typescript,
      "@vitejs/plugin-react": reactSource.devDependencies?.["@vitejs/plugin-react"],
      vite: reactSource.devDependencies?.vite,
    },
    overrides: {
      "@opengeni/artifact-tool": artifactToolFile,
      "@opengeni/sdk": sdkFile,
      ...runtimeLocalDependencyFiles,
    },
  };

  await Promise.all([
    writeFile(join(consumerRoot, "package.json"), `${JSON.stringify(consumerManifest, null, 2)}\n`),
    writeFile(
      join(consumerRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ESNext",
            lib: ["ESNext", "DOM", "DOM.Iterable"],
            module: "ESNext",
            moduleResolution: "Bundler",
            jsx: "react-jsx",
            skipLibCheck: false,
            noEmit: true,
            types: ["node", "vite/client"],
          },
          include: [
            "browser.tsx",
            "artifact-contract.ts",
            "artifact-codecs.ts",
            "consumer.css",
            "presentation.tsx",
            "runtime-proof.ts",
            "sdk-types.ts",
            "session.ts",
            "session.vite.config.ts",
            "ssr.tsx",
            "vite.config.ts",
            "worker-entry.ts",
            "worker.vite.config.ts",
          ],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(consumerRoot, "tsconfig.nodenext.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ES2022",
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            jsx: "react-jsx",
            skipLibCheck: false,
            noEmit: true,
          },
          include: ["nodenext.ts"],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(consumerRoot, "nodenext.ts"),
      [
        'import type { Document, Workbook } from "@opengeni/artifact-tool";',
        'import type { ReferenceWorkbook } from "@opengeni/artifact-tool/reference";',
        'import type { NativeSpreadsheetSession } from "@opengeni/artifact-tool/native";',
        'import type { ArtifactKernelRuntime } from "@opengeni/artifact-tool/runtime";',
        'import type { locateVerifiedArtifactRuntime } from "@opengeni/artifact-tool/runtime/locator";',
        'import type { Document as DocumentEntry } from "@opengeni/artifact-tool/document";',
        'import type { renderDocument } from "@opengeni/artifact-tool/document/render";',
        'import type { exportDocx } from "@opengeni/artifact-tool/document/docx";',
        'import type { Presentation as PresentationEntry } from "@opengeni/artifact-tool/presentation";',
        'import type { executePresentationRender } from "@opengeni/artifact-tool/presentation/render";',
        'import type { exportPresentationPptx } from "@opengeni/artifact-tool/presentation/pptx";',
        'import type { Workbook as SpreadsheetEntry } from "@opengeni/artifact-tool/spreadsheet";',
        'import type { renderWorkbook } from "@opengeni/artifact-tool/spreadsheet/render";',
        'import type { SpreadsheetXlsxCodec } from "@opengeni/artifact-tool/spreadsheet/xlsx";',
        'import type { EditableArtifactMutationIntent, encodeEditableArtifactMutationIntent } from "@opengeni/contracts/editable-artifacts";',
        'import type { EditableArtifactLiveServerFrame, decodeEditableArtifactLiveServerWireFrame } from "@opengeni/contracts/editable-artifact-live";',
        'import type { DocumentEditorProps, SpreadsheetGridProps } from "@opengeni/react/artifacts";',
        'import type { DocumentEditorProps as DocumentOnlyProps } from "@opengeni/react/artifacts/document";',
        'import type { PresentationEditorProps as PresentationOnlyProps } from "@opengeni/react/artifacts/presentation";',
        'import type { SpreadsheetGridProps as SpreadsheetOnlyProps } from "@opengeni/react/artifacts/spreadsheet";',
        'import type { EditableArtifactSyncController, BrowserEditableArtifactWorkerKernel, CreateEditableArtifactHttpLiveTransportOptions } from "@opengeni/sdk/editable-artifacts";',
        'import type { OpenGeniClient as ArtifactApiClient, EditableArtifactResource } from "@opengeni/sdk/artifacts";',
        'import type { installBrowserArtifactWorkerEntry } from "@opengeni/sdk/editable-artifacts/worker";',
        "export type PackedNodeNextSurface = [Document, Workbook, ReferenceWorkbook, NativeSpreadsheetSession, ArtifactKernelRuntime, typeof locateVerifiedArtifactRuntime, DocumentEntry, typeof renderDocument, typeof exportDocx, PresentationEntry, typeof executePresentationRender, typeof exportPresentationPptx, SpreadsheetEntry, typeof renderWorkbook, SpreadsheetXlsxCodec, EditableArtifactMutationIntent, typeof encodeEditableArtifactMutationIntent, EditableArtifactLiveServerFrame, typeof decodeEditableArtifactLiveServerWireFrame, DocumentEditorProps, SpreadsheetGridProps, DocumentOnlyProps, PresentationOnlyProps, SpreadsheetOnlyProps, EditableArtifactSyncController, BrowserEditableArtifactWorkerKernel, CreateEditableArtifactHttpLiveTransportOptions, ArtifactApiClient, EditableArtifactResource, typeof installBrowserArtifactWorkerEntry];",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(consumerRoot, "vite.config.ts"),
      'import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [react()], build: { rollupOptions: { external: ["@resvg/resvg-js", "docx", "exceljs", "pptxgenjs", "sharp"] } } });\n',
    ),
    writeFile(
      join(consumerRoot, "session.vite.config.ts"),
      'import { defineConfig } from "vite";\nexport default defineConfig({ build: { emptyOutDir: true, lib: { entry: "session.ts", formats: ["es"], fileName: "session-consumer" }, outDir: "session-dist", rollupOptions: { external: ["react", "@opengeni/sdk"] } } });\n',
    ),
    writeFile(
      join(consumerRoot, "worker.vite.config.ts"),
      'import { defineConfig } from "vite";\nexport default defineConfig({ build: { emptyOutDir: true, lib: { entry: "worker-entry.ts", formats: ["es"], fileName: "editable-artifacts-worker" }, outDir: "worker-dist" } });\n',
    ),
    writeFile(
      join(consumerRoot, "worker-entry.ts"),
      'import "@opengeni/sdk/editable-artifacts/worker";\n',
    ),
    writeFile(
      join(consumerRoot, "index.html"),
      '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenGeni consumer proof</title></head><body><div id="root"></div><script type="module" src="/browser.tsx"></script></body></html>\n',
    ),
    writeFile(
      join(consumerRoot, "browser.tsx"),
      'import "./consumer.css";\nimport artifactWorkerUrl from "@opengeni/sdk/editable-artifacts/worker?worker&url";\nimport { OpenGeniProvider, SandboxWorkspace } from "@opengeni/react";\nimport { OpenGeniClient } from "@opengeni/sdk/artifacts";\nimport { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport { HostEmbeddedSurfaces } from "./presentation";\nconst root = document.getElementById("root");\nif (!root) throw new Error("missing #root");\nif (!artifactWorkerUrl) throw new Error("missing packed editable-artifact Worker URL");\nconst client = new OpenGeniClient({ baseUrl: "https://api.example.invalid" });\ncreateRoot(root).render(<StrictMode><OpenGeniProvider client={client} workspaceId="clean-consumer"><SandboxWorkspace sessionId="package-proof" events={[]} primary={<main><p>Clean consumer browser proof</p><HostEmbeddedSurfaces /></main>} /></OpenGeniProvider></StrictMode>);\n',
    ),
    writeFile(join(consumerRoot, "consumer.css"), '@import "@opengeni/react/compiled.css";\n'),
    writeFile(
      join(consumerRoot, "presentation.tsx"),
      [
        'import { ApprovalSurface, HumanInputForm, MessageTimeline, QueueSurface, SessionChrome, createDefaultToolRegistry, type QueueSurfaceProps, type ToolRendererProps, type UseTurnQueueResult } from "@opengeni/react";',
        "// Static browser fixtures use the explicitly non-production reference model. Live browser editing is SDK Worker + WASM owned.",
        'import { Document, DocumentFile, Presentation, PresentationFile, SpreadsheetFile, Workbook } from "@opengeni/artifact-tool/reference";',
        'import { DocumentArtifactSurface, PresentationArtifactSurface, SpreadsheetArtifactSurface, type SpreadsheetCommit } from "@opengeni/react/artifacts";',
        'import * as Composer from "@opengeni/react/composer";',
        'import { MemoryEditableArtifactStorage } from "@opengeni/sdk/editable-artifacts";',
        'import { useMemo, useRef, useState } from "react";',
        "",
        "const artifactWorkbook = Workbook.create();",
        'const artifactSheet = artifactWorkbook.worksheets.add("Proof");',
        'artifactSheet.getRange("A1:B2").values = [["Artifact package proof", 42], ["Ready", true]];',
        "const artifactCommits: SpreadsheetCommit[] = [];",
        "const artifactDocument = Document.create();",
        'artifactDocument.blocks.addHeading("Artifact document proof", 1);',
        'artifactDocument.blocks.addParagraph("Editable document surface from packed packages.");',
        "const artifactPresentation = Presentation.create({ slideSize: { width: 960, height: 540 } });",
        "const artifactSlide = artifactPresentation.slides.add();",
        'artifactSlide.title = "Artifact presentation proof";',
        'artifactSlide.shapes.add({ geometry: "textbox", name: "proof-title", position: { left: 48, top: 40, width: 600, height: 80 }, text: "Packed presentation surface" });',
        "const artifactStorage = new MemoryEditableArtifactStorage();",
        'const artifactSdkStatus = artifactStorage instanceof MemoryEditableArtifactStorage ? "Artifact sync SDK ready" : "Artifact sync SDK missing";',
        'const artifactCodecStatus = [DocumentFile.importDocx, PresentationFile.exportPptx, SpreadsheetFile.importXlsx].every((codec) => typeof codec === "function") ? "Artifact codecs lazy" : "Artifact codecs missing";',
        "",
        "function HostTool({ item }: ToolRendererProps) {",
        '  return <button type="button" data-host-tool={item.name}>Open host entity</button>;',
        "}",
        "",
        "function HostActionIcon() {",
        '  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 8h12" /></svg>;',
        "}",
        "",
        "export function HostEmbeddedSurfaces() {",
        '  const [value, setValue] = useState("");',
        "  const inputRef = useRef<HTMLTextAreaElement | null>(null);",
        "  const delivery = useMemo<Composer.ComposerDelivery>(",
        "    () => ({",
        "      value,",
        "      setValue,",
        "      send: async () => true,",
        "      steer: async () => true,",
        "      sending: false,",
        "      canSend: value.trim().length > 0,",
        "      error: null,",
        "      clearError: () => {},",
        "    }),",
        "    [value],",
        "  );",
        "  const controller = Composer.useChatComposerController({ delivery });",
        "  const toolRegistry = useMemo(",
        '    () => createDefaultToolRegistry({ entries: [{ match: "name", name: "host.entity", render: HostTool }] }),',
        "    [],",
        "  );",
        "  const queueState = useMemo<UseTurnQueueResult>(",
        "    () => ({",
        "      snapshot: null,",
        '      queue: [{ id: "turn-proof", workspaceId: "workspace-proof", sessionId: "session-proof", triggerEventId: "event-proof", temporalWorkflowId: "workflow-proof", status: "queued", source: "user", position: 1, prompt: "Review the queued host request", resources: [], tools: [], model: "host-model", reasoningEffort: "medium", latencyMode: "standard", sandboxBackend: "none", sandboxOs: null, metadata: {}, version: 1, executionGeneration: 0, activeAttemptId: null, lineage: {}, initiator: { kind: "service", subjectId: "host:proof" }, initiatorContext: {}, startedAt: null, finishedAt: null, createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z" }],',
        "      activePersonalConnections: [],",
        "      pendingInputs: [],",
        "      pendingInputAttachment: null,",
        "      effectiveControl: null,",
        "      stoppingPreviousAttempt: false,",
        "      loading: false,",
        "      error: null,",
        "      refresh: async () => {},",
        "      moveTurn: async () => true,",
        "      editTurn: async () => null,",
        "      steerTurn: async () => true,",
        "      removeTurn: async () => true,",
        "      pendingByTurn: {},",
        "      mutationFor: () => null,",
        "      mutating: false,",
        "      mutationError: null,",
        "      clearMutationError: () => {},",
        "    }),",
        "    [],",
        "  );",
        '  const requestComposerFocus: QueueSurfaceProps["onRequestComposerFocus"] = () => controller.focusInput();',
        "",
        "  return (",
        "    <section>",
        '      <SessionChrome queue={queueState} agentsSignal={{ count: 2, detail: "1 running" }} readOnly />',
        '      <MessageTimeline items={[{ kind: "tool-call", id: "tool-proof", turnId: "turn-proof", callId: "call-proof", name: "host.entity", arguments: { entityId: "entity-proof" }, output: { updated: true }, raw: null, status: "complete", occurredAt: "2026-07-23T00:00:00.000Z" }]} toolRegistry={toolRegistry} />',
        "      <QueueSurface queue={queueState} readOnly onRequestComposerFocus={requestComposerFocus} />",
        "      <ApprovalSurface",
        '        approvals={[{ id: "approval-proof", name: "host.entity.update", arguments: { entityId: "entity-proof" } }]}',
        "        onApprove={async () => {}}",
        "        onReject={async () => {}}",
        "      />",
        "      <HumanInputForm",
        '        request={{ id: "request-proof", questions: [{ id: "direction", kind: "text", prompt: "What should change?", options: [], required: true, allowOther: false }], allowSkip: true, expiresAt: null }}',
        "        onSubmit={async () => {}}",
        "        autoFocus={false}",
        '        messages={{ submit: "Continue in host" }}',
        "      />",
        "      <Composer.Root controller={controller}>",
        "        <Composer.Surface>",
        "          <Composer.Input ref={inputRef} autoFocus data-host-input />",
        "          <Composer.Footer>",
        "            <Composer.Controls>",
        '              <select aria-label="Host model selector"><option>Host model</option></select>',
        '              <button type="button" onClick={requestComposerFocus}><HostActionIcon />Host action</button>',
        "            </Composer.Controls>",
        "            <Composer.Actions>",
        "              <Composer.SendButton />",
        "            </Composer.Actions>",
        "          </Composer.Footer>",
        "        </Composer.Surface>",
        "      </Composer.Root>",
        '      <SpreadsheetArtifactSurface workbook={artifactWorkbook} title="Package workbook" readOnly rowCount={4} columnCount={4} onCommit={(commit) => artifactCommits.push(commit)} />',
        '      <DocumentArtifactSurface document={artifactDocument} title="Package document" readOnly viewportHeight={240} />',
        '      <PresentationArtifactSurface presentation={artifactPresentation} title="Package presentation" readOnly />',
        "      <p>{artifactSdkStatus}</p>",
        "      <p>{artifactCodecStatus}</p>",
        "    </section>",
        "  );",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(consumerRoot, "ssr.tsx"),
      'import { renderToStaticMarkup } from "react-dom/server";\nimport { HostEmbeddedSurfaces } from "./presentation";\nconst markup = renderToStaticMarkup(<HostEmbeddedSurfaces />);\nfor (const expected of ["2 agents", "1 running", "Open host entity", "Loading inputs…", "entity-proof", "What should change?", "Host model", "Package workbook", "Artifact package proof", "Package document", "Artifact document proof", "Package presentation", "1 slide", "Artifact sync SDK ready", "Artifact codecs lazy"]) { if (!markup.includes(expected)) throw new Error(`SSR output lost populated host surface: ${expected}`); }\nconsole.log(`SSR_OK bytes=${new TextEncoder().encode(markup).byteLength}`);\n',
    ),
    writeFile(
      join(consumerRoot, "artifact-contract.ts"),
      [
        'import { EDITABLE_ARTIFACT_INTENT_VERSION, decodeEditableArtifactMutationIntent, encodeEditableArtifactMutationIntent, hashEditableArtifactMutationIntent, hashEditableArtifactMutationIntentBytes, type EditableArtifactMutationIntent } from "@opengeni/contracts/editable-artifacts";',
        'import { decodeEditableArtifactLiveServerWireFrame, encodeEditableArtifactLiveServerWireFrame } from "@opengeni/contracts/editable-artifact-live";',
        'import { createEditableArtifactHttpLiveTransport } from "@opengeni/sdk/editable-artifacts";',
        "",
        "const intent: EditableArtifactMutationIntent = {",
        "  envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,",
        "  protocolVersion: 1,",
        "  modelSchemaVersion: 1,",
        "  commandProtocolVersion: 1,",
        '  artifactId: "11111111111111111111111111111111",',
        '  clientTransactionId: "packed-contract-proof",',
        '  replicaId: "2222222222222222",',
        "  replicaCounter: 1,",
        "  previousLocalTransactionId: null,",
        "  observedHeadSequence: 0,",
        "  causalBase: [],",
        "  selectiveUndoOperationIds: [],",
        "  commandBytes: new Uint8Array([0x4f, 0x47, 0x41, 0x52]),",
        "};",
        "const encoded = encodeEditableArtifactMutationIntent(intent);",
        "const decoded = decodeEditableArtifactMutationIntent(encoded);",
        "const reencoded = encodeEditableArtifactMutationIntent(decoded);",
        'if (encoded.length !== reencoded.length || !encoded.every((value, index) => value === reencoded[index])) throw new Error("packed OGATX codec is not canonical");',
        "const hashed = hashEditableArtifactMutationIntent(intent);",
        'if (hashed.requestHash !== hashEditableArtifactMutationIntentBytes(encoded)) throw new Error("packed OGATX hash helpers disagree");',
        'const liveEncoded = encodeEditableArtifactLiveServerWireFrame({ type: "watermark", protocolVersion: 1, artifactId: "11111111111111111111111111111111", streamEpoch: "packed-contract-proof", headSequence: 1 });',
        "const liveDecoded = decodeEditableArtifactLiveServerWireFrame(liveEncoded);",
        'if (liveDecoded.type !== "watermark" || liveDecoded.headSequence !== 1) throw new Error("packed OGALV codec round-trip failed");',
        'const liveTransport = createEditableArtifactHttpLiveTransport({ baseUrl: "http://127.0.0.1:3000", workspaceId: "packed-workspace", protocolVersion: 1, kernelVersion: "packed-kernel", modelSchemaVersion: 1, allowInsecureDevelopmentTransport: true });',
        'if (typeof liveTransport.mintTicket !== "function" || typeof liveTransport.openLive !== "function") throw new Error("packed SDK live transport is unavailable");',
        "console.log(`ARTIFACT_CONTRACT_OK bytes=${encoded.byteLength} liveBytes=${liveEncoded.byteLength} hash=${hashed.requestHash}`);",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(consumerRoot, "artifact-codecs.ts"),
      [
        "// This isolates lazy codec packaging; production skill facades require a manifest-pinned native runtime bootstrap.",
        'import { Document, DocumentFile, Presentation, PresentationFile, SpreadsheetFile, Workbook } from "@opengeni/artifact-tool/reference";',
        "",
        "const document = Document.create();",
        'document.blocks.addHeading("Packed DOCX codec", 1);',
        'document.blocks.addParagraph("Lazy codec round trip");',
        "const docx = await DocumentFile.exportDocx(document);",
        "const importedDocument = await DocumentFile.importDocx(docx);",
        'if (!importedDocument.blocks.items.some((block) => "text" in block && block.text.includes("Lazy codec round trip"))) throw new Error("packed DOCX lazy codec lost document content");',
        "",
        "const workbook = Workbook.create();",
        'workbook.worksheets.add("Proof").getRange("A1:B2").values = [["Packed XLSX codec", 7], ["Ready", true]];',
        "const xlsx = await SpreadsheetFile.exportXlsx(workbook);",
        "const importedWorkbook = await SpreadsheetFile.importXlsx(xlsx);",
        'if (importedWorkbook.worksheets.getItem("Proof").getRange("A1").values[0]?.[0] !== "Packed XLSX codec") throw new Error("packed XLSX lazy codec lost workbook content");',
        "",
        "const presentation = Presentation.create();",
        "const slide = presentation.slides.add();",
        'slide.shapes.add({ geometry: "textbox", name: "proof", position: { left: 40, top: 40, width: 500, height: 80 }, text: "Packed PPTX codec" });',
        "const pptx = await PresentationFile.exportPptx(presentation);",
        'if (String.fromCharCode(...new Uint8Array(await pptx.arrayBuffer()).slice(0, 2)) !== "PK") throw new Error("packed PPTX lazy codec did not emit OOXML");',
        "",
        "console.log(`ARTIFACT_CODECS_OK docx=${docx.size} xlsx=${xlsx.size} pptx=${pptx.size}`);",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(consumerRoot, "runtime-proof.ts"),
      'import { getSkillLibraryEntry, listSkillLibraryEntries } from "@opengeni/runtime/skill-library";\nconst entry = getSkillLibraryEntry("azure-verified-modules", "1.0.0");\nif (!entry) throw new Error("packed runtime skill-library entry was not available");\nif (!listSkillLibraryEntries().some((candidate) => candidate.id === entry.id && candidate.version === entry.version)) throw new Error("packed runtime skill-library list did not include the entry");\nconsole.log(`RUNTIME_SKILL_LIBRARY_OK version=${entry.version} hash=${entry.contentSha256}`);\n',
    ),
    writeFile(
      join(consumerRoot, "sdk-types.ts"),
      'import type { CreateSessionRequest, Session } from "@opengeni/sdk";\ntype Assert<T extends true> = T;\nexport type CreateSessionRequestExposesFirstPartyMcpTools = Assert<"firstPartyMcpTools" extends keyof CreateSessionRequest ? true : false>;\nexport type SessionExposesFirstPartyMcpTools = Assert<"firstPartyMcpTools" extends keyof Session ? true : false>;\n',
    ),
    writeFile(
      join(consumerRoot, "session.ts"),
      await readFile(join(repoRoot, "packages/react/test/fixtures/session-consumer.ts"), "utf8"),
    ),
  ]);

  const minimalSpreadsheetManifest = {
    name: "opengeni-minimal-spreadsheet-artifact-proof",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsc -p tsconfig.json --noEmit",
      build: "vite build --logLevel warn",
    },
    dependencies: {
      "@opengeni/artifact-tool": artifactToolFile,
      "@opengeni/react": `file:${react.tarball}`,
      "@opengeni/sdk": sdkFile,
      react: reactSource.peerDependencies?.react,
      "react-dom": reactSource.peerDependencies?.["react-dom"],
    },
    devDependencies: {
      "@types/node": "^24.10.1",
      "@types/react": reactSource.devDependencies?.["@types/react"],
      "@types/react-dom": reactSource.devDependencies?.["@types/react-dom"],
      typescript: rootManifest.devDependencies?.typescript,
      vite: reactSource.devDependencies?.vite,
    },
    overrides: {
      "@opengeni/artifact-tool": artifactToolFile,
      "@opengeni/contracts": contractsFile,
      "@opengeni/sdk": sdkFile,
    },
  };
  await Promise.all([
    writeFile(
      join(minimalSpreadsheetRoot, "package.json"),
      `${JSON.stringify(minimalSpreadsheetManifest, null, 2)}\n`,
    ),
    writeFile(
      join(minimalSpreadsheetRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ESNext",
            lib: ["ESNext", "DOM", "DOM.Iterable"],
            module: "ESNext",
            moduleResolution: "Bundler",
            jsx: "react-jsx",
            skipLibCheck: false,
            noEmit: true,
            types: ["node"],
          },
          include: ["spreadsheet.tsx", "vite.config.ts"],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(minimalSpreadsheetRoot, "vite.config.ts"),
      'import { defineConfig } from "vite";\nexport default defineConfig({ build: { emptyOutDir: true, lib: { entry: "spreadsheet.tsx", formats: ["es"], fileName: "spreadsheet-artifact" }, outDir: "dist", rollupOptions: { external: ["react", "react/jsx-runtime", "@opengeni/artifact-tool/reference"] } } });\n',
    ),
    writeFile(
      join(minimalSpreadsheetRoot, "spreadsheet.tsx"),
      [
        "// Static browser fixture; authoritative production edits execute in SDK Worker/WASM.",
        'import { Workbook } from "@opengeni/artifact-tool/reference";',
        'import { SpreadsheetArtifactSurface } from "@opengeni/react/artifacts/spreadsheet";',
        "",
        "const workbook = Workbook.create();",
        'workbook.worksheets.add("Only spreadsheet").getRange("A1:B2").values = [["Modality", "Spreadsheet"], ["Ready", true]];',
        "",
        "export function SpreadsheetOnlyArtifactSurface() {",
        '  return <SpreadsheetArtifactSurface workbook={workbook} title="Spreadsheet-only package proof" readOnly rowCount={4} columnCount={4} />;',
        "}",
        "",
      ].join("\n"),
    ),
  ]);

  const minimalSessionManifest = {
    name: "opengeni-minimal-session-proof",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsc -p tsconfig.json --noEmit",
      build: "vite build --logLevel warn",
    },
    dependencies: {
      "@opengeni/react": `file:${react.tarball}`,
      "@opengeni/sdk": sdkFile,
      react: reactSource.peerDependencies?.react,
      "react-dom": reactSource.peerDependencies?.["react-dom"],
    },
    devDependencies: {
      "@types/node": "^24.10.1",
      "@types/react": reactSource.devDependencies?.["@types/react"],
      "@types/react-dom": reactSource.devDependencies?.["@types/react-dom"],
      typescript: rootManifest.devDependencies?.typescript,
      vite: reactSource.devDependencies?.vite,
    },
    overrides: {
      "@opengeni/contracts": contractsFile,
      "@opengeni/sdk": sdkFile,
    },
  };
  await Promise.all([
    writeFile(
      join(minimalSessionRoot, "package.json"),
      `${JSON.stringify(minimalSessionManifest, null, 2)}\n`,
    ),
    writeFile(
      join(minimalSessionRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ESNext",
            lib: ["ESNext", "DOM", "DOM.Iterable"],
            module: "ESNext",
            moduleResolution: "Bundler",
            skipLibCheck: false,
            noEmit: true,
            types: ["node"],
          },
          include: ["session.ts", "vite.config.ts"],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(minimalSessionRoot, "vite.config.ts"),
      'import { defineConfig } from "vite";\nexport default defineConfig({ build: { emptyOutDir: true, lib: { entry: "session.ts", formats: ["es"], fileName: "session" }, rollupOptions: { external: ["react", "@opengeni/sdk"] } } });\n',
    ),
    writeFile(
      join(minimalSessionRoot, "session.ts"),
      'import { buildTimeline, type HumanInputSessionClientLike, type SessionClientLike, useHumanInputRequests, useSessionEvents } from "@opengeni/react/session";\nconst unused = (..._input: unknown[]): never => { throw new Error("type-only minimal session fixture"); };\nexport const client = { getSession: unused, listEvents: unused, streamEvents: unused, getComposerDraft: unused, saveComposerDraft: unused, sendMessage: unused, steerMessage: unused, getQueue: unused, moveQueueItem: unused, editQueueItem: unused, steerQueueItem: unused, deleteQueueItem: unused, pauseSession: unused, resumeSession: unused, sendApprovalDecision: unused } satisfies SessionClientLike;\nexport const humanInputClient = { getSession: unused, streamEvents: unused, listHumanInputRequests: unused, submitHumanInputResponse: unused } satisfies HumanInputSessionClientLike;\nexport const surface = [buildTimeline, useHumanInputRequests, useSessionEvents, client, humanInputClient];\n',
    ),
  ]);

  const minimalRealtimeManifest = {
    name: "opengeni-minimal-realtime-proof",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsc -p tsconfig.json --noEmit",
      build: "vite build --logLevel warn",
      ssr: "bun realtime.tsx",
    },
    dependencies: {
      "@opengeni/react": `file:${react.tarball}`,
      "@opengeni/sdk": sdkFile,
      react: reactSource.peerDependencies?.react,
      "react-dom": reactSource.peerDependencies?.["react-dom"],
    },
    devDependencies: {
      "@types/node": "^24.10.1",
      "@types/react": reactSource.devDependencies?.["@types/react"],
      "@types/react-dom": reactSource.devDependencies?.["@types/react-dom"],
      typescript: rootManifest.devDependencies?.typescript,
      vite: reactSource.devDependencies?.vite,
    },
    overrides: {
      "@opengeni/contracts": contractsFile,
      "@opengeni/sdk": sdkFile,
    },
  };
  await Promise.all([
    writeFile(
      join(minimalRealtimeRoot, "package.json"),
      `${JSON.stringify(minimalRealtimeManifest, null, 2)}\n`,
    ),
    writeFile(
      join(minimalRealtimeRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ESNext",
            lib: ["ESNext", "DOM", "DOM.Iterable"],
            module: "ESNext",
            moduleResolution: "Bundler",
            jsx: "react-jsx",
            skipLibCheck: false,
            noEmit: true,
            types: ["node"],
          },
          include: ["realtime.tsx", "vite.config.ts"],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(minimalRealtimeRoot, "vite.config.ts"),
      'import { defineConfig } from "vite";\nexport default defineConfig({ build: { emptyOutDir: true, lib: { entry: "realtime.tsx", formats: ["es"], fileName: "realtime" }, rollupOptions: { external: ["react", "react/jsx-runtime", "react-dom/server"] } } });\n',
    ),
    writeFile(
      join(minimalRealtimeRoot, "realtime.tsx"),
      [
        'import { createSessionRealtimeController, sessionRealtimeTransportKind, type SessionRealtimeClientLike } from "@opengeni/sdk/realtime";',
        'import { NewSessionRealtimeControl, SessionRealtimeControl, type EmbeddedRealtimeSessionClientLike } from "@opengeni/react/realtime";',
        'import { renderToStaticMarkup } from "react-dom/server";',
        "",
        'const unsupported = async (..._input: unknown[]): Promise<never> => { throw new Error("not called during SSR proof"); };',
        "const proxyClient = {",
        "  getWorkspaceRealtimeModelCatalog: unsupported,",
        "  beginSessionRealtime: unsupported,",
        "  heartbeatSessionRealtime: unsupported,",
        "  negotiateCodexRealtimeWebrtc: unsupported,",
        "  negotiateGatewayRealtime: unsupported,",
        "  activateCodexRealtimeConnection: unsupported,",
        "  syncSessionRealtimeLedger: unsupported,",
        "  endSessionRealtime: unsupported,",
        "} satisfies EmbeddedRealtimeSessionClientLike & SessionRealtimeClientLike;",
        "const effectiveControl = {",
        '  state: "active" as const,',
        "  controlVersion: 0,",
        '  controlEtag: "active-0",',
        '  directState: "active" as const,',
        "  primaryBlocker: null,",
        "  additionalBlockerCount: 0,",
        "  blockers: [],",
        "  resumeOptions: [],",
        "  override: null,",
        "  settlement: null,",
        "};",
        "",
        'if (sessionRealtimeTransportKind("gpt-live-1-boulder-alpha") !== "codex") throw new Error("Codex transport selection drifted");',
        'if (sessionRealtimeTransportKind("opengeni-gateway/openai/gpt-realtime-2.1") !== "gateway") throw new Error("Gateway transport selection drifted");',
        "void createSessionRealtimeController;",
        "const markup = renderToStaticMarkup(",
        "  <>",
        "    <SessionRealtimeControl",
        "      client={proxyClient}",
        '      workspaceId="workspace-proof"',
        '      sessionId="session-proof"',
        '      sessionStatus="idle"',
        "      effectiveControl={effectiveControl}",
        "      events={[]}",
        "      eventsReady={false}",
        "      codexConnected={true}",
        "    />",
        "    <NewSessionRealtimeControl",
        "      client={proxyClient}",
        '      workspaceId="workspace-proof"',
        "      codexConnected={true}",
        "      onStart={async () => true}",
        "    />",
        "  </>,",
        ");",
        'if ((markup.match(/aria-label="Start voice with Codex Live"/g) ?? []).length !== 2) throw new Error("SSR output lost public realtime composer controls");',
        'if (!markup.includes("Choose voice model and options")) throw new Error("SSR output lost realtime model picker ARIA copy");',
        "console.log(`REALTIME_SUBPATH_SSR_OK bytes=${new TextEncoder().encode(markup).byteLength}`);",
        "",
      ].join("\n"),
    ),
  ]);

  process.stdout.write("[publish-consumer] installing release-shaped tarballs\n");
  await run(["bun", "install"], consumerRoot);
  await rm(join(consumerRoot, "node_modules"), { recursive: true, force: true });
  process.stdout.write("[publish-consumer] repeating install from the frozen lock\n");
  await run(["bun", "install", "--frozen-lockfile"], consumerRoot);
  const locatorEnvironment = { ...process.env };
  delete locatorEnvironment.OPENGENI_ARTIFACT_RUNTIME_MANIFEST;
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
    throw new Error("Packed artifact runtime locator did not fail closed without an installation");
  }
  const locatorFailure = JSON.parse(locatorStderr) as { error?: { code?: string } };
  if (locatorFailure.error?.code !== "ARTIFACT_RUNTIME_UNAVAILABLE") {
    throw new Error("Packed artifact runtime locator did not emit its stable JSON error");
  }
  await run(["bun", "run", "typecheck"], consumerRoot);
  await run(["bun", "run", "typecheck:nodenext"], consumerRoot);
  await run(["bun", "run", "build"], consumerRoot);
  await run(["bun", "run", "build:session"], consumerRoot);
  await run(["bun", "run", "build:worker-entry"], consumerRoot);
  const bareWorkerEntryBundle = await readFile(
    join(consumerRoot, "worker-dist", "editable-artifacts-worker.js"),
    "utf8",
  );
  if (!bareWorkerEntryBundle.includes("artifact Worker is already initialized")) {
    throw new Error(
      "Packed SDK side-effect metadata let the editable-artifact Worker entry be tree-shaken",
    );
  }
  await run(["bun", "run", "ssr"], consumerRoot);
  await run(["bun", "run", "artifact-contract"], consumerRoot);
  await run(["bun", "run", "artifact-codecs"], consumerRoot);
  await run(["bun", "run", "runtime-proof.ts"], consumerRoot);
  process.stdout.write("[publish-consumer] installing spreadsheet-only artifact consumer\n");
  await run(["bun", "install"], minimalSpreadsheetRoot);
  await rm(join(minimalSpreadsheetRoot, "node_modules"), { recursive: true, force: true });
  await run(["bun", "install", "--frozen-lockfile"], minimalSpreadsheetRoot);
  await run(["bun", "run", "typecheck"], minimalSpreadsheetRoot);
  await run(["bun", "run", "build"], minimalSpreadsheetRoot);
  const spreadsheetOnlyBundle = await readFile(
    join(minimalSpreadsheetRoot, "dist", "spreadsheet-artifact.js"),
    "utf8",
  );
  if (!spreadsheetOnlyBundle.includes("This workbook has no worksheets.")) {
    throw new Error("Spreadsheet-only packed consumer did not include its editor runtime");
  }
  for (const forbidden of [
    "DocumentArtifactSurface",
    "Document editor",
    "PresentationArtifactSurface",
    "presentation-selection",
  ]) {
    if (spreadsheetOnlyBundle.includes(forbidden)) {
      throw new Error(
        `Spreadsheet-only packed consumer reached another artifact modality: ${forbidden}`,
      );
    }
  }
  process.stdout.write("[publish-consumer] installing minimal session-only consumer\n");
  await run(["bun", "install"], minimalSessionRoot);
  await rm(join(minimalSessionRoot, "node_modules"), { recursive: true, force: true });
  await run(["bun", "install", "--frozen-lockfile"], minimalSessionRoot);
  if (existsSync(join(minimalSessionRoot, "node_modules", "@opengeni", "artifact-tool"))) {
    throw new Error("Session-only consumer unexpectedly installed optional artifact tooling");
  }
  await run(["bun", "run", "typecheck"], minimalSessionRoot);
  await run(["bun", "run", "build"], minimalSessionRoot);
  process.stdout.write("[publish-consumer] installing minimal realtime-only consumer\n");
  await run(["bun", "install"], minimalRealtimeRoot);
  await rm(join(minimalRealtimeRoot, "node_modules"), { recursive: true, force: true });
  await run(["bun", "install", "--frozen-lockfile"], minimalRealtimeRoot);
  if (existsSync(join(minimalRealtimeRoot, "node_modules", "@opengeni", "artifact-tool"))) {
    throw new Error("Realtime-only consumer unexpectedly installed optional artifact tooling");
  }
  await run(["bun", "run", "typecheck"], minimalRealtimeRoot);
  await run(["bun", "run", "build"], minimalRealtimeRoot);
  await run(["bun", "run", "ssr"], minimalRealtimeRoot);

  const sessionBundle = await readFile(
    join(consumerRoot, "session-dist", "session-consumer.js"),
    "utf8",
  );
  for (const forbidden of [
    "function OpenGeniProvider",
    "streamWorkspaceControlEvents",
    "OpenGeni updated",
    "data-opengeni-api-contract-mismatch",
    "react/jsx-runtime",
    "@uiw/react-codemirror",
    "@xterm/",
    "@opengeni/artifact-tool",
    "@opengeni/sdk/editable-artifacts",
    "MemoryEditableArtifactStorage",
    "@resvg/resvg-js",
    "docx",
    "exceljs",
    "pptxgenjs",
    "sharp",
  ]) {
    if (sessionBundle.includes(forbidden)) {
      throw new Error(`Session-only tarball consumer reached forbidden runtime: ${forbidden}`);
    }
  }
  const sessionArtifacts = await readdir(join(consumerRoot, "session-dist"));
  if (sessionArtifacts.some((artifact) => artifact.endsWith(".css"))) {
    throw new Error("Session-only tarball consumer unexpectedly emitted CSS");
  }

  const assetRoot = join(consumerRoot, "dist", "assets");
  const browserHtml = await readFile(join(consumerRoot, "dist", "index.html"), "utf8");
  const browserEntry = /<script[^>]+src="\/?([^"]+\.js)"/u.exec(browserHtml)?.[1];
  if (!browserEntry) throw new Error("Vite output did not identify its browser entry chunk");
  const browserStaticClosure = await staticBrowserChunkClosure(
    join(consumerRoot, "dist", browserEntry),
  );
  const artifactCodecChunks = [
    ["DOCX", "document-docx-codec-"],
    ["XLSX", "spreadsheet-xlsx-codec-"],
    ["PPTX", "presentation-pptx-"],
  ] as const;
  const artifactWorkerMarker = "artifact Worker is already initialized";
  for (const [codec, chunkStem] of artifactCodecChunks) {
    if ([...browserStaticClosure.keys()].some((path) => path.includes(chunkStem))) {
      throw new Error(`${codec} codec leaked into the initial packed browser chunk closure`);
    }
  }
  if ([...browserStaticClosure.values()].some((source) => source.includes(artifactWorkerMarker))) {
    throw new Error("Editable-artifact Worker leaked into the initial browser chunk closure");
  }
  const browserJavaScriptFiles = (await readdir(assetRoot)).filter((file) => file.endsWith(".js"));
  const browserJavaScript = (
    await Promise.all(browserJavaScriptFiles.map((file) => readFile(join(assetRoot, file), "utf8")))
  ).join("\n");
  for (const [codec, chunkStem] of artifactCodecChunks) {
    if (!browserJavaScriptFiles.some((file) => file.includes(chunkStem))) {
      throw new Error(`Packed browser build did not emit the lazy ${codec} codec chunk`);
    }
  }
  if (!browserJavaScript.includes(artifactWorkerMarker)) {
    throw new Error("Packed browser build did not emit the editable-artifact Worker chunk");
  }
  const cssFiles = (await readdir(assetRoot)).filter((file) => file.endsWith(".css"));
  const compiledCss = (
    await Promise.all(cssFiles.map((file) => readFile(join(assetRoot, file), "utf8")))
  ).join("\n");
  if (
    !compiledCss.includes("--og-color-bg") ||
    !compiledCss.includes(":where(.og-root).bg-og-surface-1")
  ) {
    throw new Error("Vite output is missing OpenGeni tokens or scoped compiled utilities");
  }
  for (const forbidden of ["@tailwind", "@theme", "@source", "@utility"]) {
    if (compiledCss.includes(forbidden)) {
      throw new Error(`Vite output retained an uncompiled Tailwind directive: ${forbidden}`);
    }
  }

  passed = true;
  process.stdout.write(
    `[publish-consumer] PASS ${sdk.manifest.name}@${sdk.manifest.version} + ${artifactTool.manifest.name}@${artifactTool.manifest.version} + ${react.manifest.name}@${react.manifest.version} + ${runtime.manifest.name}@${runtime.manifest.version}; strict types, compiler-free scoped browser CSS, CSS-free session and realtime-only bundles, SSR, and packed artifacts are clean.\n`,
  );
} finally {
  if (passed && !keepArtifacts) {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`[publish-consumer] artifacts retained at ${tempRoot}\n`);
  }
}
