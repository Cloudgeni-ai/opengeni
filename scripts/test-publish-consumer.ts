#!/usr/bin/env bun
/**
 * Prove the built SDK + React package artifacts from an external consumer.
 *
 * The workspace itself resolves package source directly, so ordinary unit/type
 * checks cannot catch a broken published exports map, missing CSS declaration,
 * cross-tarball declaration drift, or a client-only global reached during SSR.
 * This gate stages release-shaped tarballs, installs them twice (the second time
 * from the frozen Bun lock), typechecks with tsgo, builds the root and session
 * subpaths through Vite, verifies the packed runtime skill-library subpath, and
 * server-renders populated embedded host surfaces without a DOM. A second
 * consumer installs only the session subpath's required peers.
 */
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PackageManifest = {
  name: string;
  version: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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

function toDist(value: string, kind: "runtime" | "types"): string {
  if (!value.startsWith("./src/")) return value;
  return `./dist/${value
    .slice("./src/".length)
    .replace(/\.ts$/u, kind === "types" ? ".d.ts" : ".js")}`;
}

function releaseShape(
  source: PackageManifest,
  workspaceVersionByName: ReadonlyMap<string, string>,
): PackageManifest {
  const manifest = structuredClone(source);
  delete manifest.devDependencies;

  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = manifest[field];
    if (!dependencies) continue;
    for (const [name, range] of Object.entries(dependencies)) {
      if (!range.startsWith("workspace:")) continue;
      const version = workspaceVersionByName.get(name);
      if (!version) throw new Error(`No workspace version found for ${name}`);
      dependencies[name] = `^${version}`;
    }
  }

  if (manifest.main) manifest.main = toDist(manifest.main, "runtime");
  if (manifest.module) manifest.module = toDist(manifest.module, "runtime");
  if (manifest.types) manifest.types = toDist(manifest.types, "types");
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    if (typeof entry === "string") {
      manifest.exports![subpath] = toDist(entry, "runtime");
      continue;
    }
    const next = { ...entry };
    if (next.types) next.types = toDist(next.types, "types");
    const runtime = next.import ?? next.default;
    if (runtime) {
      next.import = toDist(runtime, "runtime");
      delete next.default;
    }
    manifest.exports![subpath] = next;
  }
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
    ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", tarballRoot],
    destination,
    true,
  );
  const receipt = JSON.parse(packed) as Array<{ filename?: string }>;
  const filename = receipt[0]?.filename;
  if (!filename) throw new Error(`npm pack did not report a filename for ${manifest.name}`);
  return { manifest, tarball: join(tarballRoot, basename(filename)) };
}

const tempRoot = await mkdtemp(join(tmpdir(), "opengeni-publish-consumer-"));
let passed = false;

try {
  const stagingRoot = join(tempRoot, "packages");
  const tarballRoot = join(tempRoot, "tarballs");
  const consumerRoot = join(tempRoot, "consumer");
  const minimalSessionRoot = join(tempRoot, "minimal-session-consumer");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(tarballRoot, { recursive: true }),
    mkdir(consumerRoot, { recursive: true }),
    mkdir(minimalSessionRoot, { recursive: true }),
  ]);

  const versions = await workspaceVersions();
  const sdk = await stageTarball("packages/sdk", stagingRoot, tarballRoot, versions);
  const react = await stageTarball("packages/react", stagingRoot, tarballRoot, versions);
  const runtime = await stageTarball("packages/runtime", stagingRoot, tarballRoot, versions);
  const runtimeLocalDependencies = await Promise.all(
    ["packages/agent-proto", "packages/codex", "packages/config", "packages/contracts"].map(
      (directory) => stageTarball(directory, stagingRoot, tarballRoot, versions),
    ),
  );
  const runtimeLocalDependencyFiles = Object.fromEntries(
    runtimeLocalDependencies.map(({ manifest, tarball }) => [manifest.name, `file:${tarball}`]),
  );
  const runtimeTarballContents = await run(["tar", "-tzf", runtime.tarball], consumerRoot, true);
  for (const artifact of ["package/dist/skill-library.js", "package/dist/skill-library.d.ts"]) {
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
  const consumerManifest = {
    name: "opengeni-clean-consumer-proof",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsgo -p tsconfig.json --noEmit",
      build: "vite build --logLevel warn",
      "build:session": "vite build --config session.vite.config.ts --logLevel warn",
      ssr: "bun ssr.tsx",
    },
    dependencies: {
      ...(reactSource.peerDependencies ?? {}),
      "@opengeni/react": `file:${react.tarball}`,
      "@opengeni/sdk": sdkFile,
      "@opengeni/runtime": `file:${runtime.tarball}`,
    },
    devDependencies: {
      "@tailwindcss/vite": reactSource.devDependencies?.["@tailwindcss/vite"],
      "@types/node": "^24.10.1",
      "@types/react": reactSource.devDependencies?.["@types/react"],
      "@types/react-dom": reactSource.devDependencies?.["@types/react-dom"],
      "@typescript/native-preview": rootManifest.devDependencies?.["@typescript/native-preview"],
      "@vitejs/plugin-react": reactSource.devDependencies?.["@vitejs/plugin-react"],
      tailwindcss: reactSource.devDependencies?.tailwindcss,
      vite: reactSource.devDependencies?.vite,
    },
    overrides: {
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
            "presentation.tsx",
            "runtime-proof.ts",
            "session.ts",
            "session.vite.config.ts",
            "ssr.tsx",
            "vite.config.ts",
          ],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(consumerRoot, "vite.config.ts"),
      'import tailwindcss from "@tailwindcss/vite";\nimport react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [react(), tailwindcss()] });\n',
    ),
    writeFile(
      join(consumerRoot, "session.vite.config.ts"),
      'import { defineConfig } from "vite";\nexport default defineConfig({ build: { emptyOutDir: true, lib: { entry: "session.ts", formats: ["es"], fileName: "session-consumer" }, outDir: "session-dist", rollupOptions: { external: ["react", "@opengeni/sdk"] } } });\n',
    ),
    writeFile(
      join(consumerRoot, "index.html"),
      '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenGeni consumer proof</title></head><body><div id="root"></div><script type="module" src="/browser.tsx"></script></body></html>\n',
    ),
    writeFile(
      join(consumerRoot, "app.css"),
      '@import "tailwindcss";\n@import "@opengeni/react/styles.css";\n@source "./node_modules/@opengeni/react/src";\n',
    ),
    writeFile(
      join(consumerRoot, "browser.tsx"),
      'import "./app.css";\nimport { OpenGeniProvider, SandboxWorkspace } from "@opengeni/react";\nimport { OpenGeniClient } from "@opengeni/sdk";\nimport { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport { HostEmbeddedSurfaces } from "./presentation";\nconst root = document.getElementById("root");\nif (!root) throw new Error("missing #root");\nconst client = new OpenGeniClient({ baseUrl: "https://api.example.invalid" });\ncreateRoot(root).render(<StrictMode><OpenGeniProvider client={client} workspaceId="clean-consumer"><SandboxWorkspace sessionId="package-proof" events={[]} primary={<main><p>Clean consumer browser proof</p><HostEmbeddedSurfaces /></main>} /></OpenGeniProvider></StrictMode>);\n',
    ),
    writeFile(
      join(consumerRoot, "presentation.tsx"),
      [
        'import { ApprovalSurface, HumanInputForm, MessageTimeline, QueueSurface, createDefaultToolRegistry, type QueueSurfaceProps, type ToolRendererProps, type UseTurnQueueResult } from "@opengeni/react";',
        'import * as Composer from "@opengeni/react/composer";',
        'import { useMemo, useRef, useState } from "react";',
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
        '      queue: [{ id: "turn-proof", workspaceId: "workspace-proof", sessionId: "session-proof", triggerEventId: "event-proof", temporalWorkflowId: "workflow-proof", status: "queued", source: "user", position: 1, prompt: "Review the queued host request", resources: [], tools: [], model: "host-model", reasoningEffort: "medium", sandboxBackend: "none", sandboxOs: null, metadata: {}, version: 1, executionGeneration: 0, activeAttemptId: null, lineage: {}, initiator: { kind: "service", subjectId: "host:proof" }, initiatorContext: {}, startedAt: null, finishedAt: null, createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z" }],',
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
        "    </section>",
        "  );",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(consumerRoot, "ssr.tsx"),
      'import { renderToStaticMarkup } from "react-dom/server";\nimport { HostEmbeddedSurfaces } from "./presentation";\nconst markup = renderToStaticMarkup(<HostEmbeddedSurfaces />);\nfor (const expected of ["Open host entity", "1 queued prompt", "entity-proof", "What should change?", "Host model"]) { if (!markup.includes(expected)) throw new Error(`SSR output lost populated host surface: ${expected}`); }\nconsole.log(`SSR_OK bytes=${new TextEncoder().encode(markup).byteLength}`);\n',
    ),
    writeFile(
      join(consumerRoot, "runtime-proof.ts"),
      'import { getSkillLibraryEntry, listSkillLibraryEntries } from "@opengeni/runtime/skill-library";\nconst entry = getSkillLibraryEntry("azure-verified-modules", "1.0.0");\nif (!entry) throw new Error("packed runtime skill-library entry was not available");\nif (!listSkillLibraryEntries().some((candidate) => candidate.id === entry.id && candidate.version === entry.version)) throw new Error("packed runtime skill-library list did not include the entry");\nconsole.log(`RUNTIME_SKILL_LIBRARY_OK version=${entry.version} hash=${entry.contentSha256}`);\n',
    ),
    writeFile(
      join(consumerRoot, "session.ts"),
      'import { buildTimeline, type HumanInputSessionClientLike, type SessionClientLike, useComposer, useHumanInputRequests, useSessionControl, useSessionEvents, useTurnQueue } from "@opengeni/react/session";\nconst unused = (..._input: unknown[]): never => { throw new Error("type-only session client fixture"); };\nexport const sessionClient = { getSession: unused, listEvents: unused, streamEvents: unused, getComposerDraft: unused, saveComposerDraft: unused, sendMessage: unused, steerMessage: unused, getQueue: unused, moveQueueItem: unused, editQueueItem: unused, steerQueueItem: unused, deleteQueueItem: unused, pauseSession: unused, resumeSession: unused, sendApprovalDecision: unused } satisfies SessionClientLike;\nexport const humanInputSessionClient = { ...sessionClient, listHumanInputRequests: unused, getHumanInputRequest: unused, submitHumanInputResponse: unused } satisfies HumanInputSessionClientLike;\nexport const sessionSurface = [sessionClient, humanInputSessionClient, buildTimeline, useComposer, useHumanInputRequests, useSessionControl, useSessionEvents, useTurnQueue];\n',
    ),
  ]);

  const minimalSessionManifest = {
    name: "opengeni-minimal-session-proof",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsgo -p tsconfig.json --noEmit",
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
      "@typescript/native-preview": rootManifest.devDependencies?.["@typescript/native-preview"],
      vite: reactSource.devDependencies?.vite,
    },
    overrides: {
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
      'import { buildTimeline, type HumanInputSessionClientLike, type SessionClientLike, useHumanInputRequests, useSessionEvents } from "@opengeni/react/session";\nconst unused = (..._input: unknown[]): never => { throw new Error("type-only minimal session fixture"); };\nexport const client = { getSession: unused, listEvents: unused, streamEvents: unused, getComposerDraft: unused, saveComposerDraft: unused, sendMessage: unused, steerMessage: unused, getQueue: unused, moveQueueItem: unused, editQueueItem: unused, steerQueueItem: unused, deleteQueueItem: unused, pauseSession: unused, resumeSession: unused, sendApprovalDecision: unused } satisfies SessionClientLike;\nexport const humanInputClient = { ...client, listHumanInputRequests: unused, getHumanInputRequest: unused, submitHumanInputResponse: unused } satisfies HumanInputSessionClientLike;\nexport const surface = [buildTimeline, useHumanInputRequests, useSessionEvents, client, humanInputClient];\n',
    ),
  ]);

  process.stdout.write("[publish-consumer] installing release-shaped tarballs\n");
  await run(["bun", "install"], consumerRoot);
  await rm(join(consumerRoot, "node_modules"), { recursive: true, force: true });
  process.stdout.write("[publish-consumer] repeating install from the frozen lock\n");
  await run(["bun", "install", "--frozen-lockfile"], consumerRoot);
  await run(["bun", "run", "typecheck"], consumerRoot);
  await run(["bun", "run", "build"], consumerRoot);
  await run(["bun", "run", "build:session"], consumerRoot);
  await run(["bun", "run", "ssr"], consumerRoot);
  await run(["bun", "run", "runtime-proof.ts"], consumerRoot);
  process.stdout.write("[publish-consumer] installing minimal session-only consumer\n");
  await run(["bun", "install"], minimalSessionRoot);
  await rm(join(minimalSessionRoot, "node_modules"), { recursive: true, force: true });
  await run(["bun", "install", "--frozen-lockfile"], minimalSessionRoot);
  await run(["bun", "run", "typecheck"], minimalSessionRoot);
  await run(["bun", "run", "build"], minimalSessionRoot);

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
  ]) {
    if (sessionBundle.includes(forbidden)) {
      throw new Error(`Session-only tarball consumer reached forbidden runtime: ${forbidden}`);
    }
  }

  const assetRoot = join(consumerRoot, "dist", "assets");
  const cssFiles = (await readdir(assetRoot)).filter((file) => file.endsWith(".css"));
  const compiledCss = (
    await Promise.all(cssFiles.map((file) => readFile(join(assetRoot, file), "utf8")))
  ).join("\n");
  if (!compiledCss.includes("--og-color-bg") || !compiledCss.includes(".bg-og-surface-1")) {
    throw new Error("Vite/Tailwind output is missing OpenGeni tokens or generated utilities");
  }

  passed = true;
  process.stdout.write(
    `[publish-consumer] PASS ${sdk.manifest.name}@${sdk.manifest.version} + ${react.manifest.name}@${react.manifest.version} + ${runtime.manifest.name}@${runtime.manifest.version}; strict types, session-only bundle, browser CSS, SSR, and packed skill-library imports are clean.\n`,
  );
} finally {
  if (passed && !keepArtifacts) {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`[publish-consumer] artifacts retained at ${tempRoot}\n`);
  }
}
