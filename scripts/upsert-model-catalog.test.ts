import { describe, expect, test } from "bun:test";

const repoRoot = new URL("..", import.meta.url).pathname;

describe("model catalog operator CLI", () => {
  test("prints help without a stack trace or database requirement failure", () => {
    const result = Bun.spawnSync([process.execPath, "scripts/upsert-model-catalog.ts", "--help"], {
      cwd: repoRoot,
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "Usage: bun run model-catalog:upsert -- --file <catalog.json>",
    );
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects incomplete arguments without exposing a stack trace", () => {
    const result = Bun.spawnSync([process.execPath, "scripts/upsert-model-catalog.ts", "--file"], {
      cwd: repoRoot,
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Usage: bun run model-catalog:upsert -- --file <catalog.json>",
    );
    expect(result.stderr.toString()).not.toContain(" at ");
  });
});
