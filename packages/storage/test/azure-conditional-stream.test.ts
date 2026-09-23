import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const scenario of [
  "partial-block",
  "multiple-blocks",
  "conflict",
  "producer-error",
  "stage-error",
  "commit-error",
]) {
  test(`Azure conditional stream uses the real SDK scheduler: ${scenario}`, () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./azure-conditional-stream.fixture.ts", import.meta.url)),
        scenario,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    // A scheduler event-handler exception must fail this isolated child, not the runner.
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      code: 0,
      stderr: "",
    });
    expect(result.stdout.toString()).toContain(`passed: ${scenario}`);
  }, 15_000);
}
