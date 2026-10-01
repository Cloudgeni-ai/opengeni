#!/usr/bin/env bun
/**
 * Complement the release-train consumer proof with one package at a time and
 * registry-only dependencies. No sibling tarballs, workspace links or overrides
 * are admitted. Candidate manifests use the actual publication transformers.
 *
 * This is a bounded client/CLI smoke, not proof for every semver version,
 * conditional export, optional peer, dynamic import or server/native package.
 * A not-yet-published dependency is a failure, not permission to substitute a
 * workspace build. Publish prerequisites first or run the published mode after
 * the release train; keep the existing train proof for pre-publication testing.
 */
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { rewriteEntryPointsToDist } from "./rewrite-entry-points";
import { rewriteWorkspaceDependenciesToConcrete } from "./rewrite-workspace-deps";
import {
  publishableWorkspacePackages,
  repoRoot,
  workspaceVersionMap,
  type PackageJson,
  type WorkspacePackage,
} from "./publishable-workspaces";

export type SmokeManifest = PackageJson & {
  name: string;
  version: string;
  exports?: Record<string, unknown>;
};

export const registryExportProfiles = {
  "@opengeni/connect": { browser: ["."], node: ["."] },
  "@opengeni/contracts": { browser: ["."], node: ["."] },
  "@opengeni/sdk": {
    browser: [".", "./browser", "./realtime", "./site", "./interaction"],
    node: [".", "./core", "./realtime"],
  },
  "@opengeni/react": {
    browser: [".", "./connect", "./session", "./session-ui", "./realtime"],
    node: [],
    namedBrowser: { "./session-ui": ["OpenGeniProvider"] },
  },
  "@opengeni/codemode": { browser: [], node: ["."] },
} satisfies Record<string, Profile>;

export type Profile = {
  browser: readonly string[];
  node: readonly string[];
  namedBrowser?: Readonly<Record<string, readonly string[]>>;
};
type Packument = {
  "dist-tags": Record<string, string>;
  versions: Record<string, SmokeManifest>;
};

export function lowestPublishedVersion(range: string, versions: readonly string[]): string {
  const matching = versions.filter((version) => Bun.semver.satisfies(version, range));
  matching.sort(Bun.semver.order);
  if (!matching[0]) throw new Error(`No published version satisfies declared range ${range}`);
  return matching[0];
}

export function consumerManifest(
  manifest: SmokeManifest,
  packageSpec: string,
  minimums: Record<string, string> = {},
): PackageJson {
  for (const [field, deps] of Object.entries({
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
  })) {
    for (const [name, range] of Object.entries(deps ?? {})) {
      if (/^(workspace:|file:|link:|portal:)/u.test(range)) {
        throw new Error(`${manifest.name} ${field}.${name} is not a registry dependency: ${range}`);
      }
    }
  }
  return {
    name: "opengeni-registry-dependency-export-proof",
    private: true,
    type: "module",
    // Peers come from their declared ranges, never from the workspace. Optional
    // peers are installed so the selected entrypoints can exercise their imports.
    dependencies: {
      ...manifest.peerDependencies,
      ...minimums,
      [manifest.name]: packageSpec,
    },
  };
}

export async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: {
      ...process.env,
      NODE_PATH: "",
      NODE_OPTIONS: "",
      BUN_INSTALL_CACHE_DIR: join(cwd, ".bun-cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code})\n${stdout}\n${stderr}`);
  return stdout;
}

function specifier(name: string, subpath: string): string {
  return subpath === "." ? name : `${name}/${subpath.slice(2)}`;
}

export async function proveInstalledConsumer(
  root: string,
  manifest: SmokeManifest,
  profile: Profile,
): Promise<void> {
  for (const subpath of [...profile.browser, ...profile.node]) {
    if (!manifest.exports || !(subpath in manifest.exports)) {
      throw new Error(
        `${manifest.name}@${manifest.version} is missing smoke entrypoint ${subpath}`,
      );
    }
  }
  if (profile.browser.length) {
    // Use the same pinned Vite as the existing React consumer proof. Only the
    // builder is loaded from the workspace; all package imports resolve at root.
    const reactRequire = createRequire(join(repoRoot, "packages/react/package.json"));
    const { build } = await import(reactRequire.resolve("vite"));
    let contents = profile.browser
      .map(
        (subpath, i) =>
          `import * as p${i} from ${JSON.stringify(specifier(manifest.name, subpath))};\nconsole.log(p${i});`,
      )
      .join("\n");
    for (const [subpath, names] of Object.entries(profile.namedBrowser ?? {})) {
      contents += `\nimport { ${names.join(", ")} } from ${JSON.stringify(specifier(manifest.name, subpath))};\nconsole.log(${names.join(", ")});`;
    }
    const entry = join(root, "browser-smoke.js");
    await writeFile(entry, contents);
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        lib: { entry, formats: ["es"] },
        // Unused imports must not hide a broken edge. No package is external.
        rollupOptions: { treeshake: false },
      },
    });
  }
  if (profile.node.length) {
    const source = profile.node
      .map(
        (subpath) =>
          `console.log(Object.keys(await import(${JSON.stringify(specifier(manifest.name, subpath))})));`,
      )
      .join("\n");
    const probe = join(root, "node-smoke.mjs");
    await writeFile(probe, source);
    await run(["node", probe], root);
  }
}

export function candidateManifest(
  source: PackageJson,
  versions: Map<string, string>,
): SmokeManifest {
  const manifest = structuredClone(source) as SmokeManifest;
  delete manifest.devDependencies;
  rewriteWorkspaceDependenciesToConcrete(manifest, versions);
  rewriteEntryPointsToDist(manifest);
  return manifest;
}

export async function stageRegistryCandidate(
  pkg: WorkspacePackage,
  temporaryRoot: string,
  versions: Map<string, string>,
): Promise<{ manifest: SmokeManifest; tarball: string }> {
  const manifest = candidateManifest(pkg.packageJson, versions);
  const staging = join(temporaryRoot, "package");
  const tarballs = join(temporaryRoot, "tarballs");
  await mkdir(staging, { recursive: true });
  await mkdir(tarballs, { recursive: true });
  // Same payload directories as the existing clean release-train consumer.
  for (const path of ["dist", "src", "styles", "LICENSE", "README.md", "CHANGELOG.md"]) {
    try {
      await cp(join(repoRoot, pkg.dir, path), join(staging, path), { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path === "dist") throw error;
    }
  }
  await writeFile(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const output = await run(
    ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballs],
    staging,
  );
  const filename = output.trim().split("\n").at(-1);
  if (!filename) throw new Error(`No packed candidate for ${pkg.name}`);
  return { manifest, tarball: join(tarballs, basename(filename)) };
}

async function assertIsolatedPackage(root: string, name: string): Promise<string> {
  const directory = join(root, "node_modules", name);
  const actual = await realpath(directory);
  const inside = relative(join(root, "node_modules"), actual);
  if ((await lstat(directory)).isSymbolicLink() || inside.startsWith("..")) {
    throw new Error(`${name} resolved outside the isolated consumer: ${actual}`);
  }
  return directory;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const publishedSource = args.includes("--published-source");
  const published = args.includes("--published") || publishedSource;
  const packages: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--package") {
      const name = args[++i];
      if (!name) throw new Error("--package requires @opengeni/name or @opengeni/name@version");
      packages.push(name);
    } else if (!["--published", "--published-source", "--candidate"].includes(args[i]!)) {
      throw new Error(`Unknown argument ${args[i]}`);
    }
  }
  if (published && args.includes("--candidate"))
    throw new Error("Choose candidate or published mode");
  if (!packages.length) packages.push(...Object.keys(registryExportProfiles));
  const registry = "https://registry.npmjs.org/";
  const metadataCache = new Map<string, Packument>();
  async function packument(name: string): Promise<Packument> {
    const cached = metadataCache.get(name);
    if (cached) return cached;
    const response = await fetch(`${registry}${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`Registry metadata for ${name}: HTTP ${response.status}`);
    const body = (await response.json()) as Packument;
    metadataCache.set(name, body);
    return body;
  }
  const workspace = new Map(publishableWorkspacePackages().map((pkg) => [pkg.name, pkg]));
  const versions = workspaceVersionMap();
  const failures: string[] = [];
  for (const selection of packages) {
    const at = selection.lastIndexOf("@");
    const name = at > 0 ? selection.slice(0, at) : selection;
    const version = at > 0 ? selection.slice(at + 1) : undefined;
    const profile = registryExportProfiles[name as keyof typeof registryExportProfiles];
    if (!profile) throw new Error(`No explicit browser/Node smoke profile for ${name}`);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opengeni-registry-exports-"));
    let passed = false;
    try {
      let manifest: SmokeManifest;
      let packageSpec: string;
      if (published) {
        const metadata = await packument(name);
        if (publishedSource && version)
          throw new Error("--published-source pins the source version, not an override");
        const exact = publishedSource
          ? workspace.get(name)?.version
          : (version ?? metadata["dist-tags"].latest);
        const found = metadata.versions[exact!];
        if (!found) throw new Error(`${name}@${exact} is not published`);
        manifest = found;
        packageSpec = exact!;
      } else {
        if (version) throw new Error("Candidate selection takes a workspace name, not a version");
        const pkg = workspace.get(name);
        if (!pkg) throw new Error(`No publishable workspace ${name}`);
        const candidate = await stageRegistryCandidate(pkg, temporaryRoot, versions);
        manifest = candidate.manifest;
        packageSpec = `file:${candidate.tarball}`;
      }
      let packagePassed = true;
      for (const mode of ["resolved", "minimum"] as const) {
        try {
          const root = join(temporaryRoot, mode);
          await mkdir(root);
          const minimums: Record<string, string> = {};
          if (mode === "minimum") {
            for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
              if (!dependency.startsWith("@opengeni/")) continue;
              const metadata = await packument(dependency);
              minimums[dependency] = lowestPublishedVersion(range, Object.keys(metadata.versions));
            }
          }
          await writeFile(
            join(root, "package.json"),
            `${JSON.stringify(consumerManifest(manifest, packageSpec, minimums), null, 2)}\n`,
          );
          await run(["bun", "install", "--ignore-scripts", "--registry", registry], root);
          const installed = await assertIsolatedPackage(root, name);
          const actual = JSON.parse(
            await readFile(join(installed, "package.json"), "utf8"),
          ) as SmokeManifest;
          if (actual.name !== manifest.name || actual.version !== manifest.version) {
            throw new Error(`Installed identity differs from ${manifest.name}@${manifest.version}`);
          }
          const resolved: Record<string, string> = {};
          for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
            if (!dependency.startsWith("@opengeni/")) continue;
            const manifestPath = Bun.resolveSync(`${dependency}/package.json`, installed);
            const dep = JSON.parse(await readFile(manifestPath, "utf8")) as SmokeManifest;
            if (
              !Bun.semver.satisfies(dep.version, range) ||
              (minimums[dependency] && dep.version !== minimums[dependency])
            ) {
              throw new Error(
                `${name} resolves ${dependency}@${dep.version}, expected ${minimums[dependency] ?? range}`,
              );
            }
            resolved[dependency] = dep.version;
          }
          process.stdout.write(
            `[registry-exports] ${name}@${manifest.version} ${mode}: ${JSON.stringify(resolved)}\n`,
          );
          await proveInstalledConsumer(root, actual, profile);
        } catch (error) {
          packagePassed = false;
          failures.push(
            `${selection} ${mode}: ${error instanceof Error ? error.message : String(error)}\nConsumer retained at ${temporaryRoot}`,
          );
        }
      }
      passed = packagePassed;
    } catch (error) {
      failures.push(
        `${selection}: ${error instanceof Error ? error.message : String(error)}\nConsumer retained at ${temporaryRoot}`,
      );
    } finally {
      if (passed) await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
  if (failures.length)
    throw new Error(`Registry dependency export smoke failed:\n${failures.join("\n\n")}`);
  process.stdout.write("[registry-exports] all selected registry dependency consumers passed\n");
}

if (import.meta.main) await main();
