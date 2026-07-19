import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, startProcess, stopStartedProcesses, waitFor } from "../src/process";

test("process teardown attempts every stop and reports all supervisor failures", async () => {
  const stopped: string[] = [];
  const firstFailure = new Error("control process survived");

  await expect(
    stopStartedProcesses([
      {
        stop: async () => {
          stopped.push("control");
          throw firstFailure;
        },
      },
      {
        stop: async () => {
          stopped.push("turns");
        },
      },
    ]),
  ).rejects.toEqual(
    expect.objectContaining({
      errors: [firstFailure],
      message: "1 test process stop operation(s) failed",
    }),
  );
  expect(stopped).toEqual(["control", "turns"]);
});

test("waitFor enforces its deadline when one predicate attempt never settles", async () => {
  const startedAt = Date.now();

  await expect(
    waitFor(() => new Promise<boolean>(() => undefined), {
      timeoutMs: 25,
      intervalMs: 1,
    }),
  ).rejects.toThrow("Timed out waiting for condition");
  expect(Date.now() - startedAt).toBeLessThan(500);
});

test("a successful waitFor does not retain its deadline timer", () => {
  const processModule = new URL("../src/process.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import { waitFor } from ${JSON.stringify(processModule)}; await waitFor(() => true, { timeoutMs: 10_000 });`,
    ],
    { encoding: "utf8", timeout: 1_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
});

describe("runCommand", () => {
  test("times out the whole owned process group without leaking descendants", async () => {
    const result = await runCommand(wrapperWithDescendantCommand(), { timeoutMs: 100 });
    const childPid = Number(result.stdout.match(/child:(\d+)/)?.[1]);

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    await waitFor(() => !processIsAlive(childPid), { timeoutMs: 5_000 });
    expect(processIsAlive(childPid)).toBe(false);
  }, 15_000);

  test("times out a descendant that creates its own process group and holds the output pipe", async () => {
    const result = await runCommand(wrapperWithDetachedDescendantCommand(), { timeoutMs: 100 });
    const childPid = Number(result.stdout.match(/child:(\d+)/)?.[1]);

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    await waitFor(() => !processIsAlive(childPid), { timeoutMs: 5_000 });
    expect(processIsAlive(childPid)).toBe(false);
  }, 15_000);

  test("reports a normally completed command without a false timeout", async () => {
    const result = await runCommand(["bun", "-e", 'console.log("done")'], {
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ stdout: "done\n", stderr: "", exitCode: 0, timedOut: false });
  });

  test("fails closed instead of hanging when an exited command leaves an output pipe open", async () => {
    const startedAt = Date.now();
    let failure: unknown;
    try {
      await runCommand(wrapperThatExitsWithDetachedPipeOwner(), { timeoutMs: 5_000 });
    } catch (error) {
      failure = error;
    }
    const message = String(failure);
    const childPid = Number(message.match(/child:(\d+)/)?.[1]);

    expect(message).toContain("command exited but its output streams remained open");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    try {
      process.kill(childPid, "SIGKILL");
      await waitFor(() => !processIsAlive(childPid), { timeoutMs: 5_000 });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
    }
  }, 15_000);
});

describe("startProcess", () => {
  test("stops the owned wrapper and its descendant process", async () => {
    const started = await startProcess(wrapperWithDescendantCommand());
    let startedLogs = started.logs();
    await waitFor(
      () => {
        startedLogs = started.logs();
        return startedLogs.includes("child:");
      },
      { timeoutMs: 5_000 },
    );
    const childPid = Number(startedLogs.match(/child:(\d+)/)?.[1]);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(processIsAlive(childPid)).toBe(true);

    // A rejection must retain the supervisor's exact failure instead of being
    // collapsed into a boolean, otherwise a saturated hosted run is
    // impossible to diagnose.
    const concurrentStops = await Promise.allSettled([started.stop(), started.stop()]);
    const stopFailures = concurrentStops.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (stopFailures.length > 0) {
      throw new AggregateError(stopFailures, "concurrent process teardown failed");
    }
    await started.stop();
    await waitFor(() => !processIsAlive(childPid), { timeoutMs: 5_000 });
    expect(processIsAlive(childPid)).toBe(false);
  }, 15_000);

  test("cleans up the whole process group when readiness times out", async () => {
    let failure: unknown;
    try {
      await startProcess(wrapperWithDescendantCommand(), {
        ready: async () => false,
        timeoutMs: 100,
      });
    } catch (error) {
      failure = error;
    }

    const message = String(failure);
    const childPid = Number(message.match(/child:(\d+)/)?.[1]);
    expect(message).toContain("Timed out waiting for condition");
    expect(Number.isSafeInteger(childPid)).toBe(true);
    await waitFor(() => !processIsAlive(childPid), { timeoutMs: 5_000 });
    expect(processIsAlive(childPid)).toBe(false);
  }, 15_000);
});

test("stopping a Vite process releases its supervised stream handles", () => {
  if (process.platform !== "linux") return;
  const root = mkdtempSync(join(tmpdir(), "opengeni-vite-stop-"));
  const fixture = join(root, "probe.ts");
  const processModule = new URL("../src/process.ts", import.meta.url).href;
  const webRoot = new URL("../../../apps/web", import.meta.url).pathname;
  writeFileSync(
    fixture,
    `import { startProcess } from ${JSON.stringify(processModule)};
const listener = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { data() {} },
});
const port = listener.port;
listener.stop(true);
const started = await startProcess(
  ["bun", "run", "vite", "dev", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
  {
    cwd: ${JSON.stringify(webRoot)},
    env: { VITE_API_BASE_URL: "http://127.0.0.1:1" },
    ready: async () => (await fetch(\`http://127.0.0.1:\${port}\`).catch(() => null))?.ok === true,
    timeoutMs: 10_000,
  },
);
await started.stop();
console.log("stopped");
`,
  );
  try {
    const result = spawnSync(process.execPath, [fixture], {
      cwd: new URL("../../..", import.meta.url).pathname,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

function wrapperWithDescendantCommand(): string[] {
  return [
    "bun",
    "-e",
    [
      'const child = Bun.spawn(["bun", "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], {',
      '  stdin: "ignore", stdout: "ignore", stderr: "ignore"',
      "});",
      "console.log(`child:${child.pid}`);",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    ].join("\n"),
  ];
}

function wrapperWithDetachedDescendantCommand(): string[] {
  return [
    "bun",
    "-e",
    [
      'const child = Bun.spawn(["setsid", "bun", "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], {',
      '  stdin: "ignore", stdout: "inherit", stderr: "inherit"',
      "});",
      "console.log(`child:${child.pid}`);",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    ].join("\n"),
  ];
}

function wrapperThatExitsWithDetachedPipeOwner(): string[] {
  return [
    "bun",
    "-e",
    [
      'const child = Bun.spawn(["setsid", "bun", "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], {',
      '  stdin: "ignore", stdout: "inherit", stderr: "inherit"',
      "});",
      "console.log(`child:${child.pid}`);",
      "child.unref();",
    ].join("\n"),
  ];
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A killed grandchild can remain briefly as an init-owned zombie under a
    // heavily loaded shared runner. It cannot execute or own a listener and is
    // therefore already stopped for this process-group contract.
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2];
    if (state === "Z") {
      return false;
    }
    return true;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
}
