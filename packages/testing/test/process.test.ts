import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runCommand, startProcess, waitFor } from "../src/process";

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

    const concurrentStops = await Promise.allSettled([started.stop(), started.stop()]);
    expect(concurrentStops.every((result) => result.status === "fulfilled")).toBe(true);
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
