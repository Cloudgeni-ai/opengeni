#!/usr/bin/env bun
/**
 * Prove that the release-shaped runtime loads from a host whose root remains on
 * Zod 3. OpenAI Agents uses Zod 4 internally; that implementation must stay
 * inside the runtime bundle instead of resolving against the host's root.
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
const keepArtifacts = process.env.OPENGENI_KEEP_RUNTIME_CONSUMER === "1";
const packageDirectories = [
  "packages/agent-proto",
  "packages/contracts",
  "packages/codex",
  "packages/config",
  "packages/runtime",
] as const;

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
): Promise<{ name: string; tarball: string }> {
  const sourceRoot = join(repoRoot, packageDirectory);
  const sourceManifest = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  const destination = join(stagingRoot, sourceManifest.name.replace("@opengeni/", ""));
  await mkdir(destination, { recursive: true });
  for (const item of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES", "dist", "src"]) {
    const source = join(sourceRoot, item);
    if (existsSync(source)) await cp(source, join(destination, item), { recursive: true });
  }
  const manifest = releaseShape(sourceManifest, versions);
  await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = await run(
    ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", tarballRoot],
    destination,
    true,
  );
  const filename = (JSON.parse(packed) as Array<{ filename?: string }>)[0]?.filename;
  if (!filename) throw new Error(`npm pack did not report a filename for ${manifest.name}`);
  return { name: manifest.name, tarball: join(tarballRoot, basename(filename)) };
}

const tempRoot = await mkdtemp(join(tmpdir(), "opengeni-runtime-consumer-"));
let passed = false;
try {
  const stagingRoot = join(tempRoot, "packages");
  const tarballRoot = join(tempRoot, "tarballs");
  const consumerRoot = join(tempRoot, "consumer");
  await Promise.all(
    [stagingRoot, tarballRoot, consumerRoot].map((path) => mkdir(path, { recursive: true })),
  );

  const versions = await workspaceVersions();
  const staged = [];
  for (const packageDirectory of packageDirectories) {
    staged.push(await stageTarball(packageDirectory, stagingRoot, tarballRoot, versions));
  }
  const files = Object.fromEntries(staged.map(({ name, tarball }) => [name, `file:${tarball}`]));
  await Promise.all([
    writeFile(
      join(consumerRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "opengeni-runtime-embedding-proof",
          version: "0.0.0",
          private: true,
          type: "module",
          dependencies: { "@opengeni/runtime": files["@opengeni/runtime"], zod: "3.25.76" },
          overrides: files,
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(consumerRoot, "probe.mjs"),
      'import { createRequire } from "node:module";\nimport { extractResponseOutputText } from "@opengeni/runtime";\nconst require = createRequire(import.meta.url);\nconst rootZod = require("zod/package.json").version;\nif (!rootZod.startsWith("3.")) throw new Error(`expected host Zod 3, got ${rootZod}`);\nif (typeof extractResponseOutputText !== "function") throw new Error("runtime export missing");\nconsole.log(`RUNTIME_EMBED_OK root_zod=${rootZod}`);\n',
    ),
  ]);

  process.stdout.write("[runtime-consumer] installing release-shaped runtime closure\n");
  await run(["bun", "install"], consumerRoot);
  await rm(join(consumerRoot, "node_modules"), { recursive: true, force: true });
  process.stdout.write("[runtime-consumer] repeating install from the frozen lock\n");
  await run(["bun", "install", "--frozen-lockfile"], consumerRoot);
  await run(["bun", "probe.mjs"], consumerRoot);
  await rm(join(consumerRoot, "node_modules"), { recursive: true, force: true });
  process.stdout.write("[runtime-consumer] installing with npm for a Node host\n");
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot);
  await run(["node", "probe.mjs"], consumerRoot);
  await rm(join(consumerRoot, "node_modules"), { recursive: true, force: true });
  process.stdout.write("[runtime-consumer] repeating npm install from package-lock\n");
  await run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot);
  await run(["node", "probe.mjs"], consumerRoot);
  passed = true;
  process.stdout.write(
    "[runtime-consumer] PASS release runtime is isolated from host Zod 3 under Bun and Node.\n",
  );
} finally {
  if (passed && !keepArtifacts) {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`[runtime-consumer] artifacts retained at ${tempRoot}\n`);
  }
}
