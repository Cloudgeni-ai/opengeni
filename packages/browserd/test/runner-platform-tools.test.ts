import { expect, test } from "bun:test";

test.skipIf(process.platform !== "linux")(
  "managed Chrome launches with stderr utilities installed outside FHS directories",
  async () => {
    // Isolate PATH and missing-FHS simulation from other runner tests.
    const child = Bun.spawn(
      [process.execPath, "-e", fixture, new URL("../src/runner.ts", import.meta.url).href],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timer));
    expect({ stdout: stdout.trim(), stderr: stderr.trim(), exit }).toEqual({
      stdout: "PATH utilities launched Chrome and drained stderr",
      stderr: "",
      exit: 0,
    });
  },
  15_000,
);

const fixture = `
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
const original = { ...fs };
const root = await original.mkdtemp("/tmp/og-platform-tools-");
const bin = join(root, "non-fhs-bin");
await original.mkdir(bin);
for (const name of ["mkfifo", "tail"]) {
  const installed = Bun.which(name);
  assert.ok(installed, name + " must be installed for the fixture");
  await original.symlink(installed, join(bin, name));
}
process.env.PATH = bin + ":" + process.env.PATH;
mock.module("node:fs/promises", () => ({
  ...original,
  access: async (path, ...args) => {
    if (/^\\/(usr\\/)?bin\\/(mkfifo|tail)$/.test(String(path))) {
      throw Object.assign(new Error("FHS utility absent"), { code: "ENOENT" });
    }
    return original.access(path, ...args);
  },
}));
const { AgentBrowserJsonRunner } = await import(process.argv[1]);
const browserPath = join(root, "chrome");
const binaryPath = join(root, "agent-browser");
await original.writeFile(browserPath, '#!/bin/sh\\nprintf "stderr drained\\\\n" >&2\\nprintf "chrome launched\\\\n"\\n', { mode: 0o700 });
await original.writeFile(binaryPath, "#!" + process.execPath + "\\nconsole.log(JSON.stringify({ success: true, data: process.env.AGENT_BROWSER_EXECUTABLE_PATH, error: null }));\\n", { mode: 0o700 });
let runner;
try {
  runner = await AgentBrowserJsonRunner.create({
    namespace: "og", sessionName: "platform-tools",
    socketDirectory: join(root, "socket"), profileDirectory: join(root, "profile"),
    downloadDirectory: join(root, "downloads"), screenshotDirectory: join(root, "screenshots"),
    headed: true, browserExecutablePath: browserPath,
    binary: { path: binaryPath, name: "agent-browser-linux-x64", version: "0.33.2", sha256: "fixture" },
  });
  const wrapper = await runner.run(["get", "cdp-url"]);
  assert.ok((await original.readFile(wrapper, "utf8")).includes(join(bin, "tail")));
  const browser = Bun.spawn([wrapper], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => browser.kill("SIGKILL"), 3_000);
  try {
    assert.equal(await browser.exited, 0);
    assert.equal(await new Response(browser.stdout).text(), "chrome launched\\n");
  } finally {
    clearTimeout(timer);
    if (browser.exitCode === null) browser.kill("SIGKILL");
    await browser.exited;
  }
  const log = join(root, "chrome-launch", "chrome-stderr.log");
  let content = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    content = await original.readFile(log, "utf8");
    if (content === "stderr drained\\n") break;
    await Bun.sleep(10);
  }
  assert.equal(content, "stderr drained\\n");
  console.log("PATH utilities launched Chrome and drained stderr");
} finally {
  if (runner) await runner.terminate();
  await original.rm(root, { recursive: true, force: true });
}
`;
