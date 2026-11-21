#!/usr/bin/env bun
/**
 * Publish ONLY the unscoped `opengeni` CLI to npm, as a self-contained,
 * bin-only tarball (`.github/workflows/publish-cli.yml`).
 *
 * The `opengeni` bin (`packages/cli/dist/bin/opengeni.cjs`) is one Bun bundle
 * with every dependency inlined, so `npx opengeni …` needs nothing else from
 * the registry. The library entry (`import { runCli } from "opengeni"`) imports
 * `@opengeni/contracts` at the same lockstep version, which only the full
 * stable release publishes. This path therefore ships the bin, schemas and
 * README without dependencies or library entry points, and never touches any
 * `@opengeni/*` package or dist-tag.
 *
 *   bun scripts/publish-cli-only.ts stage <out-dir>    build, stage, pack, smoke-test
 *   bun scripts/publish-cli-only.ts publish <out-dir>  npm publish the staged package (latest)
 *   bun scripts/publish-cli-only.ts verify <out-dir>   wait until npm serves it as latest
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const CLI_PACKAGE_NAME = "opengeni";
const repoRoot = resolve(import.meta.dir, "..");
const cliDir = join(repoRoot, "packages/cli");

type Manifest = Record<string, unknown> & { name: string; version: string };

/** The published manifest: bin-only, with no dependencies of any kind. */
export function binOnlyManifest(source: Manifest): Manifest {
  if (source.name !== CLI_PACKAGE_NAME)
    throw new Error(`expected ${CLI_PACKAGE_NAME}, got ${source.name}`);
  if (!/^\d+\.\d+\.\d+$/.test(source.version))
    throw new Error(`not a stable version: ${source.version}`);
  const bin = source.bin as Record<string, string> | undefined;
  if (bin?.[CLI_PACKAGE_NAME] !== "./dist/bin/opengeni.cjs")
    throw new Error("unexpected bin entry");
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    repository: source.repository,
    bin: { [CLI_PACKAGE_NAME]: "./dist/bin/opengeni.cjs" },
    files: ["dist/bin", "schemas"],
    engines: source.engines,
    publishConfig: { access: "public", provenance: true },
  };
}

function run(command: string, args: string[], cwd: string, env = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}`);
  }
  return result.stdout;
}

function stagedManifest(outDir: string): Manifest {
  return JSON.parse(readFileSync(join(outDir, "package/package.json"), "utf8")) as Manifest;
}

function stage(outDir: string): void {
  run("bun", ["run", "build"], cliDir);
  rmSync(outDir, { recursive: true, force: true });
  const packageDir = join(outDir, "package");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  cpSync(join(cliDir, "dist/bin"), join(packageDir, "dist/bin"), { recursive: true });
  cpSync(join(cliDir, "schemas"), join(packageDir, "schemas"), { recursive: true });
  for (const file of ["README.md", "LICENSE"])
    copyFileSync(join(cliDir, file), join(packageDir, file));
  const manifest = binOnlyManifest(JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")));
  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // The bundle must not require anything outside Node built-ins.
  const bundle = readFileSync(join(packageDir, "dist/bin/opengeni.cjs"), "utf8");
  const external = [...bundle.matchAll(/require\(["']([^"']+)["']\)/g)]
    .map((match) => match[1]!)
    .filter((name) => !name.startsWith("node:") && !BUILTINS.has(name.split("/")[0]!));
  if (external.length > 0)
    throw new Error(`bin requires non-builtin modules: ${[...new Set(external)].join(", ")}`);

  const tarball = run("npm", ["pack", "--json", "--pack-destination", outDir], packageDir);
  const [{ filename }] = JSON.parse(tarball) as [{ filename: string }];
  writeFileSync(join(outDir, "tarball"), `${join(outDir, filename)}\n`);

  // Install the exact tarball into an empty project, offline, and run it.
  const consumer = mkdtempSync(join(tmpdir(), "opengeni-cli-consumer-"));
  try {
    writeFileSync(join(consumer, "package.json"), '{"name":"consumer","private":true}\n');
    run(
      "npm",
      ["install", "--offline", "--no-audit", "--no-fund", join(outDir, filename)],
      consumer,
    );
    const bin = join(consumer, "node_modules/.bin/opengeni");
    const version = run(bin, ["--version"], consumer).trim();
    if (!version.includes(manifest.version)) throw new Error(`--version printed ${version}`);
    const help = run(bin, ["connect", "--help"], consumer);
    if (!help.includes("connect")) throw new Error("connect --help did not describe connect");
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
  console.log(`staged ${manifest.name}@${manifest.version} at ${join(outDir, filename)}`);
}

function publishedVersion(version: string): boolean {
  const result = spawnSync("npm", ["view", `${CLI_PACKAGE_NAME}@${version}`, "version"], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

function publish(outDir: string): void {
  const { version } = stagedManifest(outDir);
  if (publishedVersion(version)) {
    console.log(`${CLI_PACKAGE_NAME}@${version} is already published; nothing to do`);
    return;
  }
  const tarball = readFileSync(join(outDir, "tarball"), "utf8").trim();
  run("npm", ["publish", tarball, "--access", "public", "--provenance", "--tag", "latest"], outDir);
  console.log(`published ${CLI_PACKAGE_NAME}@${version}`);
}

async function verify(outDir: string): Promise<void> {
  const { version } = stagedManifest(outDir);
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync(
      "npm",
      ["view", CLI_PACKAGE_NAME, "dist-tags.latest", "--prefer-online"],
      {
        encoding: "utf8",
      },
    );
    if (result.status === 0 && result.stdout.trim() === version) {
      console.log(`npm serves ${CLI_PACKAGE_NAME}@${version} as latest`);
      return;
    }
    await Bun.sleep(10_000);
  }
  throw new Error(`npm does not serve ${CLI_PACKAGE_NAME}@${version} as latest after 10 minutes`);
}

const BUILTINS = new Set(
  (await import("node:module")).builtinModules.map(
    (name) => name.replace(/^node:/, "").split("/")[0]!,
  ),
);

if (import.meta.main) {
  const [phase, outDir] = process.argv.slice(2);
  if (!outDir) throw new Error("usage: publish-cli-only.ts <stage|publish|verify> <out-dir>");
  const directory = resolve(outDir);
  if (phase === "stage") stage(directory);
  else if (phase === "publish") publish(directory);
  else if (phase === "verify") await verify(directory);
  else throw new Error(`unknown phase ${phase}`);
}
