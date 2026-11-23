import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  publishableWorkspacePackages,
  repoRoot,
  workspacePackageByName,
  type WorkspacePackage,
} from "./publishable-workspaces";

/** The lowest Node a simple `>=X[.Y[.Z]]` range admits, or null for any other range. */
export function nodeFloor(range: string | undefined): string | null {
  const match = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/u.exec(range ?? "");
  return match ? `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}` : null;
}

function installedPackageJson(fromDir: string, name: string): Record<string, unknown> | null {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const path = join(dir, "node_modules", name, "package.json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (dir === dirname(dir) || dir === dirname(repoRoot)) return null;
  }
}

/**
 * Third-party runtime dependencies, reached through the package and its
 * workspace dependencies, whose own `engines.node` refuses the package's
 * declared Node floor. An installer that enforces engines (Yarn 1, or npm and
 * pnpm with engine-strict) refuses the package on that Node version.
 */
export function enginesFloorViolations(
  pkg: WorkspacePackage,
  byName: Map<string, WorkspacePackage>,
): string[] {
  const floor = nodeFloor((pkg.packageJson.engines as { node?: string } | undefined)?.node);
  if (!floor) return [];
  const violations: string[] = [];
  const seen = new Set<string>();
  const visit = (current: WorkspacePackage) => {
    if (seen.has(current.name)) return;
    seen.add(current.name);
    const deps = {
      ...current.packageJson.dependencies,
      ...current.packageJson.optionalDependencies,
    };
    for (const name of Object.keys(deps)) {
      const workspace = byName.get(name);
      if (workspace) {
        visit(workspace);
        continue;
      }
      const installed = installedPackageJson(current.dir, name);
      const range = (installed?.engines as { node?: string } | undefined)?.node;
      if (typeof range === "string" && !Bun.semver.satisfies(floor, range)) {
        violations.push(
          `${name}@${String(installed?.version)} needs node ${range} (via ${current.name})`,
        );
      }
    }
  };
  visit(pkg);
  return violations;
}

describe("published engines.node floors", () => {
  test("parses simple floors only", () => {
    expect(nodeFloor(">=22.15")).toBe("22.15.0");
    expect(nodeFloor(">=18")).toBe("18.0.0");
    expect(nodeFloor("^18 || >=20")).toBeNull();
  });

  // Only deliberate modern floors (Node 22+) are checked; the older `>=18`
  // declarations are historical defaults.
  test("no runtime dependency refuses a package's declared Node 22+ floor", () => {
    const byName = workspacePackageByName();
    const violations = publishableWorkspacePackages()
      .filter((pkg) => {
        const floor = nodeFloor((pkg.packageJson.engines as { node?: string } | undefined)?.node);
        return floor !== null && Number(floor.split(".")[0]) >= 22;
      })
      .flatMap((pkg) => enginesFloorViolations(pkg, byName).map((line) => `${pkg.name}: ${line}`));
    expect(violations).toEqual([]);
  });
});
