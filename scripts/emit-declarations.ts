#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { repoRoot, workspacePackages, type WorkspacePackage } from "./publishable-workspaces";

type PackageExportTarget = string | { types?: string; default?: string };

function packageAt(path: string): WorkspacePackage | undefined {
  const normalized = resolve(path);
  return workspacePackages().find((pkg) => resolve(repoRoot, pkg.dir) === normalized);
}

function declarationTarget(pkg: WorkspacePackage, target: string, source: boolean): string {
  const packageDir = resolve(repoRoot, pkg.dir);
  if (source) {
    return resolve(packageDir, target);
  }
  const sourceRelative = target.replace(/^\.\/src\//u, "").replace(/\.[cm]?tsx?$/u, ".d.ts");
  return resolve(packageDir, "dist", sourceRelative);
}

function packagePaths(pkg: WorkspacePackage, source: boolean): Record<string, string[]> {
  const exports = pkg.packageJson.exports as Record<string, PackageExportTarget> | undefined;
  const paths: Record<string, string[]> = {};
  for (const [subpath, value] of Object.entries(exports ?? {})) {
    const target = typeof value === "string" ? value : (value.types ?? value.default);
    if (!target) continue;
    const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//u, "")}`;
    paths[specifier] = [declarationTarget(pkg, target, source)];
  }
  if (Object.keys(paths).length === 0) {
    const target = String(pkg.packageJson.types ?? pkg.packageJson.main ?? "./src/index.ts");
    paths[pkg.name] = [declarationTarget(pkg, target, source)];
  }
  return paths;
}

const packageDir = resolve(process.cwd());
const current = packageAt(packageDir);
if (!current) {
  throw new Error(`emit-declarations must run from a workspace package directory: ${packageDir}`);
}

const sourceDir = join(packageDir, "src");
const outDir = join(packageDir, "dist");
const paths = Object.fromEntries(
  workspacePackages().flatMap((pkg) =>
    Object.entries(packagePaths(pkg, pkg.name === current.name)),
  ),
);
const configDir = join(repoRoot, ".opengeni", "declaration-configs");
mkdirSync(configDir, { recursive: true });
const assetTypesPath = join(configDir, "asset-modules.d.ts");
writeFileSync(
  assetTypesPath,
  ["woff", "woff2", "ttf", "otf", "svg", "png", "jpg", "jpeg", "webp", "avif"]
    .map(
      (extension) =>
        `declare module "*.${extension}" { const source: string; export default source; }`,
    )
    .join("\n") + "\n",
);
const configPath = join(
  configDir,
  `${basename(packageDir)}-${current.name.replace(/\W+/gu, "-")}.json`,
);
const packageTsconfig = join(packageDir, "tsconfig.json");
readFileSync(packageTsconfig, "utf8");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      extends: packageTsconfig,
      compilerOptions: {
        paths,
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        declarationMap: false,
        sourceMap: false,
        types: ["bun"],
        rootDir: sourceDir,
        outDir,
        incremental: false,
        composite: false,
      },
      include: [join(sourceDir, "**/*.ts"), join(sourceDir, "**/*.tsx"), assetTypesPath],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    },
    null,
    2,
  )}\n`,
);

const tsc = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);
const result = spawnSync(tsc, ["-p", configPath], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(
  `[emit-declarations] ${current.name}: ${relative(repoRoot, sourceDir)} -> ${relative(repoRoot, outDir)}`,
);
