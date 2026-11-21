import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { binOnlyManifest, isNewer } from "./publish-cli-only";

const root = join(import.meta.dir, "..");
const cli = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));

describe("CLI-only publication", () => {
  test("publishes a bin-only manifest without any dependency", () => {
    const manifest = binOnlyManifest(cli);
    expect(manifest.name).toBe("opengeni");
    expect(manifest.bin).toEqual({ opengeni: "./dist/bin/opengeni.cjs" });
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "scripts",
      "exports",
      "main",
    ])
      expect(manifest[field]).toBeUndefined();
  });

  test("refuses any other package", () => {
    expect(() => binOnlyManifest({ ...cli, name: "@opengeni/sdk" })).toThrow();
    expect(() => binOnlyManifest({ ...cli, version: "6.35.1-canary.1" })).toThrow();
  });

  test("never moves latest backwards", () => {
    expect(isNewer("6.35.0", null)).toBe(true);
    expect(isNewer("6.35.0", "6.8.0")).toBe(true);
    expect(isNewer("6.35.0", "6.35.0")).toBe(false);
    expect(isNewer("6.9.0", "6.35.0")).toBe(false);
    expect(isNewer("7.0.0", "6.35.1")).toBe(true);
  });

  test("the workflow publishes only through this script, from main, behind package-release", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/publish-cli.yml"), "utf8"));
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const job = workflow.jobs.publish;
    expect(job.environment).toBe("package-release");
    const text = JSON.stringify(job.steps);
    expect(text).not.toContain("changeset");
    expect(text).not.toContain("release:publish");
    expect(text).not.toContain("publish-stable");
    expect(text).toContain("bun scripts/publish-cli-only.ts publish");
    const admission = job.steps.find((step: any) => step.name === "Verify exact main source");
    expect(admission.run).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(admission.run).toContain('git merge-base --is-ancestor "$SOURCE_SHA" origin/main');
  });
});
