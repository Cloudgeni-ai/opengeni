import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishUnscopedFirst, type UnscopedPublisher } from "./publish-unscoped-first";
import { publicationOrder, repoRoot } from "./publishable-workspaces";

function publisher(
  packages: { name: string; version: string; dir: string }[],
  published: boolean,
): UnscopedPublisher & { publishes: string[] } {
  const publishes: string[] = [];
  return {
    publishes,
    packages: () => packages,
    published: () => published,
    publish: (directory) => {
      publishes.push(directory);
    },
    log: () => {},
  };
}

const cli = { name: "opengeni", version: "6.30.2", dir: "packages/cli" };
const sdk = { name: "@opengeni/sdk", version: "6.30.2", dir: "packages/sdk" };

describe("unscoped CLI publication", () => {
  test("publishes an unpublished CLI version from its package directory", () => {
    const target = publisher([sdk, cli], false);
    expect(publishUnscopedFirst(target)).toBe(true);
    expect(target.publishes).toEqual([join(repoRoot, "packages/cli")]);
  });

  test("skips a published version and a set without the CLI", () => {
    const published = publisher([sdk, cli], true);
    expect(publishUnscopedFirst(published)).toBe(false);
    expect(published.publishes).toEqual([]);
    const absent = publisher([sdk], false);
    expect(publishUnscopedFirst(absent)).toBe(false);
    expect(absent.publishes).toEqual([]);
  });

  test("a failed CLI write stops the release before changeset publish", () => {
    const target = publisher([cli], false);
    target.publish = () => {
      throw new Error("E403");
    };
    expect(() => publishUnscopedFirst(target)).toThrow("E403");
    const script = readFileSync(join(repoRoot, "scripts/release-publish.sh"), "utf8");
    const first = script.indexOf("bun scripts/publish-unscoped-first.ts");
    expect(first).toBeGreaterThan(script.indexOf("bun scripts/rewrite-entry-points.ts"));
    expect(first).toBeLessThan(script.indexOf("bun node_modules/@changesets/cli/bin.js publish"));
    expect(script).toContain("set -euo pipefail");
  });

  test("stable and canary publication put the CLI first and keep dependency order", () => {
    const order = publicationOrder([
      { name: "@opengeni/contracts" },
      { name: "@opengeni/sdk" },
      { name: "opengeni" },
    ]);
    expect(order.map((pkg) => pkg.name)).toEqual([
      "opengeni",
      "@opengeni/contracts",
      "@opengeni/sdk",
    ]);
    for (const path of ["scripts/publish-stable.ts", "scripts/publish-canary.ts"]) {
      expect(readFileSync(join(repoRoot, path), "utf8")).toContain(
        "publicationOrder(topologicallySortedPackages(publishableWorkspacePackages()))",
      );
    }
  });
});
