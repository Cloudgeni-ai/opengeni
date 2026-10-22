import { expect, test } from "bun:test";

// Radix caches DOM availability at import time. Other tests intentionally render
// without a DOM, so keep the card in an independent module graph.
test("Chrome setup card leads with one next step and continues the chat once Chrome connects", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./session-chrome-card.dom-fixture.tsx"],
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
}, 20_000);
