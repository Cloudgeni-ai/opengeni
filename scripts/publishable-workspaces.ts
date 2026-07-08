import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PUBLISHED_DEP_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
export const ALL_DEP_FIELDS = [...PUBLISHED_DEP_FIELDS, "devDependencies"] as const;

type DepField = (typeof ALL_DEP_FIELDS)[number];

export type PackageJson = Record<string, unknown> & {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export type WorkspacePackage = {
  dir: string;
  packagePath: string;
  name: string;
  version: string;
  packageJson: PackageJson;
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readPackage(path: string): PackageJson | null {
  try {
    return readJson(path) as PackageJson;
  } catch {
    return null;
  }
}

export function changesetIgnoreSet(): Set<string> {
  const config = readJson(join(repoRoot, ".changeset", "config.json")) as { ignore?: string[] };
  return new Set(config.ignore ?? []);
}

export function workspacePackages(): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(repoRoot, group);
    let entries: string[];
    try {
      entries = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const packagePath = join(groupDir, entry, "package.json");
      const packageJson = readPackage(packagePath);
      if (!packageJson?.name || !packageJson.version) {
        continue;
      }
      packages.push({
        dir: relative(repoRoot, join(groupDir, entry)),
        packagePath,
        name: packageJson.name,
        version: packageJson.version,
        packageJson,
      });
    }
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

export function workspacePackageByName(): Map<string, WorkspacePackage> {
  return new Map(workspacePackages().map((pkg) => [pkg.name, pkg]));
}

export function workspaceVersionMap(): Map<string, string> {
  return new Map(workspacePackages().map((pkg) => [pkg.name, pkg.version]));
}

export function publishableWorkspacePackages(): WorkspacePackage[] {
  const ignored = changesetIgnoreSet();
  return workspacePackages().filter(
    (pkg) =>
      pkg.name.startsWith("@opengeni/") &&
      pkg.packageJson.private !== true &&
      !ignored.has(pkg.name),
  );
}

export function workspaceDependencyNames(
  pkg: WorkspacePackage,
  fields: readonly DepField[] = PUBLISHED_DEP_FIELDS,
): string[] {
  const workspaceNames = workspacePackageByName();
  const names = new Set<string>();
  for (const field of fields) {
    const deps = pkg.packageJson[field] as Record<string, string> | undefined;
    for (const depName of Object.keys(deps ?? {})) {
      if (workspaceNames.has(depName)) {
        names.add(depName);
      }
    }
  }
  return [...names].sort();
}

export function topologicallySortedPackages(
  packages: readonly WorkspacePackage[],
  fields: readonly DepField[] = ALL_DEP_FIELDS,
): WorkspacePackage[] {
  const selected = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const ordered: WorkspacePackage[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(pkg: WorkspacePackage): void {
    if (visited.has(pkg.name)) {
      return;
    }
    if (visiting.has(pkg.name)) {
      throw new Error(`Workspace dependency cycle detected at ${pkg.name}`);
    }
    visiting.add(pkg.name);
    for (const depName of workspaceDependencyNames(pkg, fields)) {
      const dep = selected.get(depName);
      if (dep) {
        visit(dep);
      }
    }
    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  }

  for (const pkg of packages) {
    visit(pkg);
  }
  return ordered;
}
