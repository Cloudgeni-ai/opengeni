import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { AgentBrowserJsonRunner, reapManagedBrowserProcesses } from "../src/runner";

async function fixture() {
  const root = await mkdtemp("/tmp/og-linux-identity-");
  const sessionDirectory = join(root, "sessions", randomUUID());
  const profileDirectory = join(sessionDirectory, "profile");
  const executable = join(root, "chromium");
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o700);
  const runner = await AgentBrowserJsonRunner.create({
    namespace: "og",
    sessionName: "identity-fixture",
    socketDirectory: join(root, "socket"),
    profileDirectory,
    downloadDirectory: join(sessionDirectory, "downloads"),
    screenshotDirectory: join(sessionDirectory, "screenshots"),
    headed: false,
    browserExecutablePath: executable,
    binary: {
      path: process.execPath,
      name: "agent-browser-linux-x64",
      version: "0.33.2",
      sha256: "fixture",
    },
  });
  return { root, profileDirectory, executable, runner };
}

async function rewrittenBrowser(f: Awaited<ReturnType<typeof fixture>>, lockPidOffset = 0) {
  const title = `${f.executable} --no-first-run --user-data-dir=${f.profileDirectory}`;
  const child = Bun.spawn(
    [
      f.executable,
      "-e",
      `
import { dlopen, read, toArrayBuffer } from "bun:ffi";
import { readFileSync } from "node:fs";
const libc = dlopen("libc.so.6", { dlsym: { args: ["ptr", "ptr"], returns: "ptr" } });
const symbol = libc.symbols.dlsym(0, Buffer.from("program_invocation_name\\0"));
if (!symbol) throw new Error("fixture argv symbol unavailable");
const original = readFileSync("/proc/self/cmdline");
const memory = new Uint8Array(toArrayBuffer(read.ptr(symbol), 0, original.length));
if (!Buffer.from(memory).equals(original)) throw new Error("fixture argv storage mismatch");
const title = new TextEncoder().encode(${JSON.stringify(title)});
if (title.length >= memory.length) throw new Error("fixture argv storage insufficient");
// Mutate only this generated child's validated original argv allocation.
memory.fill(0);
memory.set(title);
process.stdout.write("ready\\n");
setInterval(() => {}, 60_000);
`,
      // Reserve enough original argv storage for the synthetic rewritten title.
      `--fixture-padding=${".".repeat(2048)}`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  try {
    const ready = child.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await ready.read()).value)).toBe("ready\n");
    } finally {
      ready.releaseLock();
    }
    expect(
      (await readFile(`/proc/${child.pid}/cmdline`, "utf8")).split("\0").filter(Boolean),
    ).toEqual([title]);
    await symlink(
      `${hostname()}-${child.pid + lockPidOffset}`,
      join(f.profileDirectory, "SingletonLock"),
    );
    return child;
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  }
}

async function stopFixture(child: Bun.Subprocess) {
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

describe.skipIf(process.platform !== "linux")("Linux managed browser cleanup", () => {
  for (const action of ["terminate", "recover"] as const) {
    test(`stops only the exact rewritten-title process during ${action}`, async () => {
      const f = await fixture();
      let child: Bun.Subprocess | undefined;
      try {
        child = await rewrittenBrowser(f);
        if (action === "terminate") await f.runner.terminate();
        else await reapManagedBrowserProcesses(f.root);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const exit = await Promise.race([
            child.exited,
            new Promise<number>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error("owned fixture browser was not stopped")),
                2_000,
              );
            }),
          ]);
          expect(exit).not.toBe(0);
        } finally {
          clearTimeout(timeout);
        }
        expect(() => process.kill(child!.pid, 0)).toThrow();
      } finally {
        if (child) await stopFixture(child);
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }

  test("does not signal a rewritten title whose private profile lock names another PID", async () => {
    const f = await fixture();
    let child: Bun.Subprocess | undefined;
    try {
      child = await rewrittenBrowser(f, 1);
      await f.runner.terminate();
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(child!.pid, 0)).not.toThrow();
    } finally {
      if (child) await stopFixture(child);
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("refuses multiple exact-profile roots without signaling either process", async () => {
    const f = await fixture();
    const children = [0, 1].map(() =>
      Bun.spawn(
        [
          f.executable,
          "-e",
          "process.stdout.write('ready\\n');setInterval(()=>{},60_000)",
          `--user-data-dir=${f.profileDirectory}`,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      ),
    );
    try {
      for (const child of children) {
        const ready = child.stdout.getReader();
        try {
          expect(new TextDecoder().decode((await ready.read()).value)).toBe("ready\n");
        } finally {
          ready.releaseLock();
        }
      }
      await expect(f.runner.terminate()).rejects.toThrow(
        "multiple managed browsers identify the exact private profile",
      );
      for (const child of children) {
        expect(child.exitCode).toBeNull();
        expect(() => process.kill(child.pid, 0)).not.toThrow();
      }
    } finally {
      await Promise.all(children.map(stopFixture));
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
