import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyInstallExit } from "./batch-setup";
test("only a concrete frozen-lockfile mismatch is a code verdict", () => {
  expect(classifyInstallExit(0, "")).toBe(0);
  expect(classifyInstallExit(1, "error: lockfile had changes, but lockfile is frozen")).toBe(1);
  for (const diagnostic of [
    "fetch failed",
    "ENOSPC",
    "registry unavailable",
    "unknown installer error",
  ])
    expect(classifyInstallExit(1, diagnostic)).toBe(75);
  expect(classifyInstallExit(137, "")).toBe(137);
  expect(classifyInstallExit(143, "")).toBe(143);
});

test("the pinned Bun frozen-lockfile diagnostic is classified from a real local install", async () => {
  const directory = mkdtempSync(join(tmpdir(), "batch-lockfile-"));
  try {
    for (const name of ["first", "second"]) {
      mkdirSync(join(directory, name));
      writeFileSync(
        join(directory, name, "package.json"),
        JSON.stringify({ name, version: "1.0.0" }),
      );
    }
    const manifest = (second: boolean) =>
      JSON.stringify({
        name: "fixture",
        private: true,
        dependencies: { first: "file:./first", ...(second ? { second: "file:./second" } : {}) },
      });
    writeFileSync(join(directory, "package.json"), manifest(false));
    const initial = Bun.spawn([process.execPath, "install"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await initial.exited).toBe(0);
    writeFileSync(join(directory, "package.json"), manifest(true));
    const frozen = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      (await new Response(frozen.stdout).text()) + (await new Response(frozen.stderr).text());
    expect(classifyInstallExit(await frozen.exited, output)).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
