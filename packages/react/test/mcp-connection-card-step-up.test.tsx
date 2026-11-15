import { expect, test } from "bun:test";

// Radix caches DOM availability on import. Keep portal tests separate from
// server-rendering tests, matching the console's dialog regression harness.
test("a connect card's passkey step-up has a working action", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./mcp-connection-card-step-up.dom-fixture.tsx"],
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}, 15_000);
