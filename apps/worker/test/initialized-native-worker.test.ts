import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Evidence of a pinned SDK limitation, NOT proof of safe close-before-run.
// A subprocess owns each leaked native worker so neither this test runner nor a
// shared production host is killed to reclaim the resources.
async function probe(mode: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./fixtures/initialized-native-worker-probe.ts", import.meta.url)),
      mode,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  // SDK signal handlers must not turn a diagnostic timeout into an open wait.
  const guard = setTimeout(() => child.kill("SIGKILL"), 12_000);
  try {
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    const line = stdout
      .split("\n")
      .find((value) => value.startsWith('{"probe":"initialized-native-worker"'));
    expect(line).toBeDefined();
    return JSON.parse(line!);
  } finally {
    clearTimeout(guard);
    child.kill("SIGKILL");
  }
}

describe("pinned native initialized-worker cleanup limitation", () => {
  test("shutdown cannot dispose INITIALIZED ownership without running", async () => {
    const result = await probe("initialized");
    expect(result.sdkVersion).toBe("1.22.0");
    expect(result.workerStates).toEqual(["INITIALIZED"]);
    expect(result.occupancy).toEqual([0]);
    expect(result.polls).toEqual({ activity: 0, workflow: 0 });
    expect(result.errors).toEqual([
      "Not running. Current state: INITIALIZED",
      "Cannot close connection while Workers hold a reference to it",
    ]);
  }, 15_000);

  test("actual service close-before-run fails and skips both JS client owners", async () => {
    const result = await probe("service-close");
    expect(result.workerStates).toEqual(["INITIALIZED"]);
    expect(result.polls).toEqual({ activity: 0, workflow: 0 });
    expect(result.serviceState).toBe("starting");
    expect(result.errors).toEqual(["worker shutdown request failed"]);
    expect(result.closeResult).toBe("service close skipped owned cleanup");
    expect(result.jsCloses).toBe(0);
    expect(result.nativeCloses).toBe(0);
  }, 15_000);

  test("HTTP construction fault closes JS clients but retains an actual initialized native worker", async () => {
    const result = await probe("startup-failure");
    expect(result.workerStates).toEqual(["INITIALIZED"]);
    expect(result.polls).toEqual({ activity: 0, workflow: 0 });
    expect(result.jsCloses).toBe(2);
    expect(result.nativeCloses).toBe(1);
    expect(result.errors).toContain("fixture HTTP startup failed");
    expect(result.errors).toContain("Cannot close connection while Workers hold a reference to it");
    expect(result.closeResult).toBe("startup error suppressed native close failure");
  }, 15_000);

  test("run then immediate shutdown reports SDK outstanding-poll state, not server RPC or admission proof", async () => {
    const result = await probe("immediate-shutdown");
    // Neither SDK status nor one server-counter snapshot guarantees no polling.
    expect(result.sdkPollOutstandingBeforeShutdown).toBe(true);
    expect(Number.isSafeInteger(result.polls.activity) && result.polls.activity >= 0).toBe(true);
    expect(result.polls.workflow).toBe(0);
    expect(result.workerStates).toEqual(["STOPPED"]);
    expect(result.errors).toEqual([]);
    expect(result.closeResult).toBe("closed after run and immediate shutdown");
    expect(result.nativeCloses).toBe(1);
  }, 15_000);
});
