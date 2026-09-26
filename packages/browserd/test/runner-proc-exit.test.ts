import { expect, test } from "bun:test";

// Mock procfs only in a fresh subprocess: module mocks must not affect another
// runner test, and real child PIDs still prove the exact-profile cleanup fence.
for (const errorCode of ["ESRCH", "EIO"]) {
  test.skipIf(process.platform !== "linux")(
    `managed browser discovery handles a disappearing proc entry (${errorCode})`,
    async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          fixture,
          new URL("../src/runner.ts", import.meta.url).href,
          errorCode,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ stdout: stdout.trim(), stderr: stderr.trim(), exit }).toEqual({
        stdout:
          errorCode === "ESRCH" ? "owned stopped; unrelated alive" : "EIO preserved; both alive",
        stderr: "",
        exit: 0,
      });
    },
    15_000,
  );
}

const fixture = `
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
const original = { ...fs };
const ghost = "2147483647";
const code = process.argv[2];
mock.module("node:fs/promises", () => ({
  ...original,
  readdir: async (path, options) => path === "/proc"
    ? [{ name: ghost, isDirectory: () => true }, ...await original.readdir(path, options)]
    : original.readdir(path, options),
  readFile: async (path, ...args) => {
    if (path === "/proc/" + ghost + "/cmdline") {
      throw Object.assign(new Error("synthetic procfs read failure"), { code });
    }
    return original.readFile(path, ...args);
  },
}));
const { AgentBrowserJsonRunner } = await import(process.argv[1]);
const root = await original.mkdtemp("/tmp/og-proc-exit-");
const profileDirectory = join(root, "profile");
const runner = await AgentBrowserJsonRunner.create({
  namespace: "og", sessionName: "proc-exit",
  socketDirectory: join(root, "socket"), profileDirectory,
  downloadDirectory: join(root, "downloads"), screenshotDirectory: join(root, "screenshots"),
  headed: false, browserExecutablePath: process.execPath,
  binary: { path: process.execPath, name: "agent-browser-linux-x64", version: "0.33.2", sha256: "fixture" },
});
const spawn = (profile) => Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60000)", "--user-data-dir=" + profile], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
const owned = spawn(profileDirectory);
const unrelated = spawn(join(root, "unrelated-profile"));
try {
  if (code === "ESRCH") {
    await runner.terminate();
    assert.notEqual(await owned.exited, 0);
    assert.throws(() => process.kill(owned.pid, 0));
    process.kill(unrelated.pid, 0);
    console.log("owned stopped; unrelated alive");
  } else {
    await assert.rejects(runner.terminate(), (error) => error.code === "EIO");
    process.kill(owned.pid, 0);
    process.kill(unrelated.pid, 0);
    console.log("EIO preserved; both alive");
  }
} finally {
  for (const process of [owned, unrelated]) {
    if (process.exitCode === null) process.kill("SIGKILL");
    await process.exited;
  }
  await original.rm(root, { recursive: true, force: true });
}
`;
