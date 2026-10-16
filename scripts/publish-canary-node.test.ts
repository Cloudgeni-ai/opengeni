import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./publishable-workspaces";

test("native Node verifies the actual pinned Sigstore TUF root without weakening signatures", () => {
  const result = spawnSync("node", ["scripts/fixtures/canary-tuf-node.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 30_000,
  });
  expect(result.status, `${result.error ?? ""}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("real Sigstore TUF bootstrap verified; tampered root refused");
});

test("trusted bundled publisher executes on Node and still fails closed before unauthenticated work", () => {
  const directory = mkdtempSync(join(repoRoot, ".release-canary-node-test-"));
  try {
    const outfile = join(directory, "publish-canary.mjs");
    const build = spawnSync(
      process.execPath,
      [
        "build",
        "scripts/publish-canary-node.ts",
        "--target=node",
        "--packages=external",
        "--outfile",
        outfile,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
    );
    expect(build.status, build.stderr).toBe(0);
    const run = spawnSync("node", [outfile], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 30_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Canary protected-main controller identities must agree");
    expect(run.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    const wrongRuntime = spawnSync(process.execPath, [outfile], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 30_000,
    });
    expect(wrongRuntime.status).toBe(1);
    expect(wrongRuntime.stderr).toContain("requires native Node");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow selects pinned native Node, retains Bun builds and preserves signed failure evidence", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/publish-canary.yml"), "utf8");
  expect(workflow).toContain('node-version: "22.20.0"');
  expect(workflow).toContain(
    "bun build scripts/publish-canary-node.ts --target=node --packages=external --outfile .release/publish-canary.mjs",
  );
  expect(workflow).toContain("run: node .release/publish-canary.mjs");
  expect(workflow).toContain("path: .release/canary-provenance");
  const publisher = readFileSync(join(repoRoot, "scripts/publish-canary.ts"), "utf8");
  expect(publisher).toContain('run("bun", ["run", "build:packages"], repoRoot)');
  expect(publisher).toContain("signCanarySource(pkg.manifest, pkg.packed, provenanceDirectory)");
});

test("native Node publishes and confirms a synthetic cohort using default timers", () => {
  const directory = mkdtempSync(join(repoRoot, ".release-canary-node-test-"));
  try {
    const outfile = join(directory, "cohort.mjs");
    const build = spawnSync(
      process.execPath,
      [
        "build",
        "scripts/fixtures/canary-node-cohort.ts",
        "--target=node",
        "--packages=external",
        "--outfile",
        outfile,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
    );
    expect(build.status, build.stderr).toBe(0);
    const run = spawnSync("node", [outfile], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 30_000,
    });
    expect(run.status, `${run.error ?? ""}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(
      "native Node publication and confirmation passed with default timers",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
