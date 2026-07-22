#!/usr/bin/env bun
/**
 * Prove the built SDK + React package artifacts from an external consumer.
 *
 * The workspace itself resolves package source directly, so ordinary unit/type
 * checks cannot catch a broken published exports map, missing CSS declaration,
 * cross-tarball declaration drift, or a client-only global reached during SSR.
 * This gate stages release-shaped tarballs, installs them twice (the second time
 * from the frozen Bun lock), typechecks with tsgo, builds the root and session
 * subpaths through Vite, and server-renders the real root surface without a DOM.
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
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(tarballRoot, { recursive: true }),
    mkdir(consumerRoot, { recursive: true }),
  ]);

  const versions = await workspaceVersions();
  const sdk = await stageTarball("packages/sdk", stagingRoot, tarballRoot, versions);
  const react = await stageTarball("packages/react", stagingRoot, tarballRoot, versions);
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
    overrides: { "@opengeni/sdk": sdkFile },
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
      'import "./app.css";\nimport { OpenGeniProvider, SandboxWorkspace } from "@opengeni/react";\nimport { OpenGeniClient } from "@opengeni/sdk";\nimport { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nconst root = document.getElementById("root");\nif (!root) throw new Error("missing #root");\nconst client = new OpenGeniClient({ baseUrl: "https://api.example.invalid" });\ncreateRoot(root).render(<StrictMode><OpenGeniProvider client={client} workspaceId="clean-consumer"><SandboxWorkspace sessionId="package-proof" events={[]} primary={<main>Clean consumer browser proof</main>} /></OpenGeniProvider></StrictMode>);\n',
    ),
    writeFile(
      join(consumerRoot, "ssr.tsx"),
      'import { OpenGeniProvider, SandboxWorkspace } from "@opengeni/react";\nimport { OpenGeniClient } from "@opengeni/sdk";\nimport { renderToStaticMarkup } from "react-dom/server";\nconst client = new OpenGeniClient({ baseUrl: "https://api.example.invalid" });\nconst markup = renderToStaticMarkup(<OpenGeniProvider client={client} workspaceId="clean-consumer"><SandboxWorkspace sessionId="package-proof" events={[]} primary={<main>Clean consumer SSR proof</main>} collapsed /></OpenGeniProvider>);\nif (!markup.includes("Clean consumer SSR proof")) throw new Error("SSR output lost the primary pane");\nconsole.log(`SSR_OK bytes=${new TextEncoder().encode(markup).byteLength}`);\n',
    ),
    writeFile(
      join(consumerRoot, "session.ts"),
      'import { buildTimeline, type SessionClientLike, useComposer, useSessionControl, useSessionEvents, useTurnQueue } from "@opengeni/react/session";\nconst unused = (..._input: unknown[]): never => { throw new Error("type-only session client fixture"); };\nexport const sessionClient = { getSession: unused, listEvents: unused, streamEvents: unused, getComposerDraft: unused, saveComposerDraft: unused, sendMessage: unused, steerMessage: unused, getQueue: unused, moveQueueItem: unused, editQueueItem: unused, steerQueueItem: unused, deleteQueueItem: unused, pauseSession: unused, resumeSession: unused, sendApprovalDecision: unused } satisfies SessionClientLike;\nexport const sessionSurface = [sessionClient, buildTimeline, useComposer, useSessionControl, useSessionEvents, useTurnQueue];\n',
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
    `[publish-consumer] PASS ${sdk.manifest.name}@${sdk.manifest.version} + ${react.manifest.name}@${react.manifest.version}; strict types, session-only bundle, browser CSS, and SSR are clean.\n`,
  );
} finally {
  if (passed && !keepArtifacts) {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`[publish-consumer] artifacts retained at ${tempRoot}\n`);
  }
}
