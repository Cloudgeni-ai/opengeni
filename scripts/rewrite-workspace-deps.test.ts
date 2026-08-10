import { describe, expect, test } from "bun:test";
import { rewriteWorkspaceDependenciesToConcrete } from "./rewrite-workspace-deps";
import type { PackageJson } from "./publishable-workspaces";

describe("release workspace dependency rewriting", () => {
  test("rewrites only workspace protocols and preserves intentional concrete peers", () => {
    const manifest = {
      name: "@opengeni/rewrite-fixture",
      dependencies: {
        "@opengeni/sdk": "workspace:*",
      },
      peerDependencies: {
        "@opengeni/artifact-tool": ">=0.0.0 <0.2.0",
        "@opengeni/react": "workspace:~",
      },
    } satisfies PackageJson;
    const versions = new Map([
      ["@opengeni/artifact-tool", "0.1.0"],
      ["@opengeni/react", "0.50.0"],
      ["@opengeni/sdk", "0.50.0"],
    ]);

    expect(rewriteWorkspaceDependenciesToConcrete(manifest, versions)).toEqual([
      {
        field: "dependencies",
        dependency: "@opengeni/sdk",
        before: "workspace:*",
        after: "^0.50.0",
      },
      {
        field: "peerDependencies",
        dependency: "@opengeni/react",
        before: "workspace:~",
        after: "~0.50.0",
      },
    ]);
    expect(manifest.peerDependencies?.["@opengeni/artifact-tool"]).toBe(">=0.0.0 <0.2.0");
    expect(rewriteWorkspaceDependenciesToConcrete(manifest, versions)).toEqual([]);
  });
});
