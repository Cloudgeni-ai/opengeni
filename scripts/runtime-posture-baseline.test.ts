import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBaselineAdvanceScope,
  assertPromotionBaselineAdvanceScope,
  parseLiveProductionRevision,
  parseRuntimePostureBaseline,
} from "./runtime-posture-baseline";

test("only a full reported commit counts as the live production revision", () => {
  const sha = "6327db2c8b9fd642cb1dbfe3c51e11f45d327a2b";
  expect(parseLiveProductionRevision({ deploymentRevision: sha, ok: true })).toBe(sha);
  for (const value of [
    null,
    {},
    { deploymentRevision: "6327db2c" },
    { deploymentRevision: "main" },
  ]) {
    expect(parseLiveProductionRevision(value)).toBeNull();
  }
});

test("a migration cannot move its own previous-binary goalposts", () => {
  const pin = "scripts/runtime-posture-baseline.json";
  expect(() =>
    assertBaselineAdvanceScope([pin, "packages/db/drizzle/9999_example.sql"], true),
  ).toThrow();
  expect(() =>
    assertBaselineAdvanceScope([pin, "packages/db/src/runtime-posture.ts"], true),
  ).toThrow();
  expect(() =>
    assertBaselineAdvanceScope([pin, "docs/migrations-expand-contract.md"], true),
  ).not.toThrow();
  expect(() =>
    assertBaselineAdvanceScope(["packages/db/drizzle/9999_example.sql"], true),
  ).not.toThrow();
  expect(() =>
    assertBaselineAdvanceScope([pin, "packages/db/src/runtime-posture.ts"], false),
  ).not.toThrow();
});

test("the compatibility baseline cannot silently follow HEAD or a moving production tag", () => {
  for (const sourceCommit of ["HEAD", "main", "production", "v4.2.0", "a".repeat(39), ""]) {
    expect(() =>
      parseRuntimePostureBaseline({
        schemaVersion: 1,
        status: "bootstrap",
        sourceCommit,
        release: null,
      }),
    ).toThrow();
  }
  expect(
    parseRuntimePostureBaseline({
      schemaVersion: 1,
      status: "bootstrap",
      sourceCommit: "a".repeat(40),
      release: null,
    }).status,
  ).toBe("bootstrap");
  expect(() =>
    parseRuntimePostureBaseline({
      schemaVersion: 1,
      status: "production",
      sourceCommit: "a".repeat(40),
      release: null,
    }),
  ).toThrow();
  expect(
    parseRuntimePostureBaseline({
      schemaVersion: 1,
      status: "production",
      sourceCommit: "a".repeat(40),
      release: "release receipt",
    }).status,
  ).toBe("production");
});

test("a promotion checks each pin advance as the commit it landed as", () => {
  const pin = "scripts/runtime-posture-baseline.json";
  const sourceOnly = { sha: "a".repeat(40), changedPaths: ["apps/api/src/app.ts"], onMain: true };
  const pinOnly = { sha: "b".repeat(40), changedPaths: [pin], onMain: true };
  const mixed = {
    sha: "c".repeat(40),
    changedPaths: [pin, "packages/db/src/runtime-posture.ts"],
    onMain: true,
  };
  const offMain = { sha: "d".repeat(40), changedPaths: [pin], onMain: false };
  expect(() => assertPromotionBaselineAdvanceScope([sourceOnly, pinOnly], true)).not.toThrow();
  expect(() => assertPromotionBaselineAdvanceScope([], true)).not.toThrow();
  expect(() => assertPromotionBaselineAdvanceScope([pinOnly, mixed], true)).toThrow(mixed.sha);
  expect(() => assertPromotionBaselineAdvanceScope([offMain], true)).toThrow("not on main");
});

const scriptPath = join(import.meta.dir, "runtime-posture-baseline.ts");

function pinFile(sourceCommit: string) {
  return `${JSON.stringify(
    { schemaVersion: 1, status: "production", sourceCommit, release: "release receipt" },
    null,
    2,
  )}\n`;
}

/**
 * A repository whose main branch is ahead of production by `mainCommits`; the
 * promotion head adds `headOnlyCommits` that never landed on main (a hotfix or
 * promote/* branch).
 */
function promotionRepository(
  mainCommits: Array<Record<string, string>>,
  headOnlyCommits: Array<Record<string, string>> = [],
) {
  const root = mkdtempSync(join(tmpdir(), "runtime-posture-promotion-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "production");
  commit(
    { "scripts/runtime-posture-baseline.json": pinFile("1".repeat(40)), "app.ts": "1" },
    "base",
  );
  const base = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "main");
  mainCommits.forEach((files, index) => commit(files, `main ${index}`));
  git("checkout", "-q", "-b", "promotion");
  headOnlyCommits.forEach((files, index) => commit(files, `head only ${index}`));
  const run = (baseRef: string) =>
    spawnSync("bun", [scriptPath, base, baseRef], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RUNTIME_POSTURE_MAIN_REF: "main" },
    });
  return { run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a promotion pull request with a pin-only advance passes the scope check", () => {
  const repository = promotionRepository([
    { "app.ts": "2", "docs/notes.md": "x" },
    { "scripts/runtime-posture-baseline.json": pinFile("2".repeat(40)) },
    { "app.ts": "3" },
  ]);
  try {
    const promotion = repository.run("production");
    expect(promotion.stderr).toBe("");
    expect(promotion.status).toBe(0);
    // The same diff into main still needs a separate pin-only pull request.
    const intoMain = repository.run("main");
    expect(intoMain.status).not.toBe(0);
    expect(intoMain.stderr).toContain("separate pin-only PR");
  } finally {
    repository.cleanup();
  }
}, 30_000);

test("a promotion pull request still refuses a pin advance mixed with source", () => {
  const repository = promotionRepository([
    { "scripts/runtime-posture-baseline.json": pinFile("2".repeat(40)), "app.ts": "2" },
  ]);
  try {
    const promotion = repository.run("production");
    expect(promotion.status).not.toBe(0);
    expect(promotion.stderr).toContain("separate pin-only PR");
  } finally {
    repository.cleanup();
  }
}, 30_000);

test("a promotion pull request refuses a pin advance that never landed on main", () => {
  // Splitting a pin+source change into two commits off main must not pass.
  const repository = promotionRepository(
    [{ "app.ts": "2" }],
    [{ "scripts/runtime-posture-baseline.json": pinFile("2".repeat(40)) }, { "app.ts": "3" }],
  );
  try {
    const promotion = repository.run("production");
    expect(promotion.status).not.toBe(0);
    expect(promotion.stderr).toContain("not on main");
  } finally {
    repository.cleanup();
  }
}, 30_000);
