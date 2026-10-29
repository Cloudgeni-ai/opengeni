import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkChangesetPlan, releasePlanError } from "./changeset-plan";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A tiny workspace with the repository's real ignore semantics, no git needed. */
function fixture(changesets: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "changeset-plan-"));
  directories.push(root);
  const write = (path: string, value: unknown) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  write("package.json", { name: "fixture", private: true, workspaces: ["packages/*"] });
  write("packages/sdk/package.json", { name: "@opengeni/sdk", version: "1.0.0" });
  write("packages/config/package.json", { name: "@opengeni/config", version: "1.0.0" });
  write("packages/deployment/package.json", {
    name: "@opengeni/deployment",
    version: "1.0.0",
    private: true,
  });
  write(".changeset/config.json", {
    changelog: false,
    commit: false,
    fixed: [],
    linked: [],
    access: "public",
    baseBranch: "main",
    updateInternalDependencies: "patch",
    ignore: ["@opengeni/deployment"],
  });
  for (const [name, releases] of Object.entries(changesets)) {
    const lines = Object.entries(releases).map(([pkg, type]) => `"${pkg}": ${type}`);
    write(`.changeset/${name}.md`, `---\n${lines.join("\n")}\n---\n\nRelease note.\n`);
  }
  return root;
}

test("passes valid pending changesets, including an explicit empty one", async () => {
  const cwd = fixture({ sdk: { "@opengeni/sdk": "minor" }, tests: {} });
  const output = join(cwd, "plan.json");
  expect(await checkChangesetPlan({ cwd, output })).toBeUndefined();
  expect(JSON.parse(readFileSync(output, "utf8")).releases).toContainEqual(
    expect.objectContaining({ name: "@opengeni/sdk", type: "minor" }),
  );
  expect(await checkChangesetPlan({ cwd: fixture({}) })).toBeUndefined();
});

test("fails a changeset naming a package that is not in the workspace (PR #6165)", async () => {
  const cwd = fixture({ "provider-unreachable-waits": { "@opengeni/worker": "patch" } });
  expect(await checkChangesetPlan({ cwd })).toContain(
    "Found changeset provider-unreachable-waits for package @opengeni/worker which is not in the workspace",
  );
});

test("fails a mixed ignored and not-ignored changeset (PR #6182)", async () => {
  const cwd = fixture({
    "signup-promotion-protection": {
      "@opengeni/config": "minor",
      "@opengeni/deployment": "minor",
      "@opengeni/sdk": "minor",
    },
  });
  const error = await checkChangesetPlan({ cwd });
  expect(error).toContain("Found mixed changeset signup-promotion-protection");
  expect(error).toContain("Found ignored packages: @opengeni/deployment");
});

test("fails pending releases that only target ignored packages", async () => {
  const cwd = fixture({ deploy: { "@opengeni/deployment": "patch" } });
  expect(await checkChangesetPlan({ cwd })).toBe("Pending changesets cannot produce a Version PR");
});

test("the CLI exits non-zero with a GitHub annotation on an invalid changeset", () => {
  const cwd = fixture({ broken: { "@opengeni/worker": "patch" } });
  const script = join(import.meta.dir, "changeset-plan.ts");
  const result = Bun.spawnSync(["bun", script], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(
    "::error::Invalid pending changeset: Found changeset broken",
  );
  const valid = Bun.spawnSync(["bun", script], {
    cwd: fixture({}),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(valid.exitCode).toBe(0);
});

test("release-plan verdicts match the Batch contract", () => {
  expect(releasePlanError({ changesets: [{ releases: [] }], releases: [] })).toBeUndefined();
  expect(releasePlanError({ changesets: [{ releases: [{}] }], releases: [{}] })).toBeUndefined();
  expect(releasePlanError({ changesets: [{ releases: [{}] }], releases: [] })).toBe(
    "Pending changesets cannot produce a Version PR",
  );
  expect(releasePlanError({} as never)).toBe("Changesets returned a malformed release plan");
});
