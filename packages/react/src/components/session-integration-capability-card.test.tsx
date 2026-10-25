import { expect, test } from "bun:test";

// Radix caches DOM availability at import time. Other tests intentionally render
// without a DOM, so keep the card in an independent module graph.
test("integration Connect card connects in one click, shows admin approval and permission gates", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./session-integration-capability-card.dom-fixture.tsx"],
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
}, 30_000);
