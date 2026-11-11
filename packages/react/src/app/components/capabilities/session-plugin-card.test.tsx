import { expect, test } from "bun:test";

// Radix caches DOM availability at import time. Other tests intentionally render
// without a DOM, so keep the card in an independent module graph.
test("plugin card shows what a plugin adds, installs it and continues the chat", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./session-plugin-card.dom-fixture.tsx"],
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
