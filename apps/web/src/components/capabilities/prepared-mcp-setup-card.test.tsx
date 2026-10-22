import { expect, test } from "bun:test";

test("prepared connection cards preserve secret, account and chat boundaries", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./prepared-mcp-setup-card.dom-fixture.tsx"],
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
