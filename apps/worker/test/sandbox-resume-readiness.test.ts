import { describe, expect, test } from "bun:test";
import {
  type EstablishedSandboxSession,
  MODAL_EXEC_READINESS_TIMEOUT_MS,
  SandboxExecReadinessError,
} from "@opengeni/runtime";
import {
  SandboxWarmingTimeoutError,
  isRetryableDegradedRestore,
  safeSnapshotError,
  waitForSandboxExecReadiness,
  waitForWarmSnapshot,
} from "../src/sandbox-resume";

function established(
  backendId: string,
  exec: (args: { cmd: string }) => Promise<unknown>,
  writeStdin?: (args: {
    sessionId: number;
    chars?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<unknown>,
): EstablishedSandboxSession {
  return {
    backendId,
    client: {},
    instanceId: "sandbox-1",
    session: { exec, ...(writeStdin ? { writeStdin } : {}) },
    sessionState: {},
  };
}

describe("sandbox exec readiness", () => {
  test("allows Modal cold restores up to the shared 60 second readiness budget", () => {
    expect(MODAL_EXEC_READINESS_TIMEOUT_MS).toBe(60_000);
  });

  test("probes Modal before the lease is published warm", async () => {
    const commands: string[] = [];
    await waitForSandboxExecReadiness(
      established("modal", async ({ cmd }) => {
        commands.push(cmd);
        return { output: "", exitCode: 0 };
      }),
      100,
    );
    expect(commands).toEqual(["true"]);
  });

  test("probes OpenSandbox before the lease is published warm", async () => {
    const commands: string[] = [];
    await waitForSandboxExecReadiness(
      established("opensandbox", async ({ cmd }) => {
        commands.push(cmd);
        return { output: "", exitCode: 0 };
      }),
      100,
    );
    expect(commands).toEqual(["true"]);
  });

  test("rejects a resolved Modal exec with a nonzero exit code", async () => {
    await expect(
      waitForSandboxExecReadiness(
        established("modal", async () => ({
          output: "true: not found",
          exitCode: 127,
        })),
        100,
      ),
    ).rejects.toBeInstanceOf(SandboxExecReadinessError);
  });

  test("retries a transient Modal exec response without a completion status", async () => {
    let calls = 0;
    await waitForSandboxExecReadiness(
      established("modal", async () => {
        calls += 1;
        return calls === 1 ? { output: "" } : { output: "", exitCode: 0 };
      }),
      500,
    );
    expect(calls).toBe(2);
  });

  test("polls an exact yielded Modal readiness process instead of rejecting it", async () => {
    const writes: Array<{
      sessionId: number;
      chars?: string;
      yieldTimeMs?: number;
      maxOutputTokens?: number;
    }> = [];
    await waitForSandboxExecReadiness(
      established(
        "modal",
        async () => "Chunk ID: readiness\nProcess running with session ID 7\nOutput:\n",
        async (args) => {
          writes.push(args);
          return "Chunk ID: readiness\nProcess exited with code 0\nOutput:\n";
        },
      ),
      500,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      sessionId: 7,
      chars: "",
      maxOutputTokens: 1_000,
    });
    expect(writes[0]!.yieldTimeMs).toBeGreaterThan(0);
    expect(writes[0]!.yieldTimeMs).toBeLessThanOrEqual(500);
  });

  test("polls an exact yielded OpenSandbox readiness process instead of rejecting it", async () => {
    const writes: Array<{
      sessionId: number;
      chars?: string;
      yieldTimeMs?: number;
      maxOutputTokens?: number;
    }> = [];
    await waitForSandboxExecReadiness(
      established(
        "opensandbox",
        async () => ({ output: "", sessionId: 11 }),
        async (args) => {
          writes.push(args);
          return { output: "", exitCode: 0 };
        },
      ),
      500,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      sessionId: 11,
      chars: "",
      maxOutputTokens: 1_000,
    });
    expect(writes[0]!.yieldTimeMs).toBeGreaterThan(0);
    expect(writes[0]!.yieldTimeMs).toBeLessThanOrEqual(500);
  });

  test("bounds repeated statusless Modal responses", async () => {
    let calls = 0;
    const error = await waitForSandboxExecReadiness(
      established("modal", async () => {
        calls += 1;
        return { output: "" };
      }),
      10,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxWarmingTimeoutError);
    expect(calls).toBe(1);
  });

  test("bounds a Modal exec RPC that never returns", async () => {
    const pending = new Promise<never>(() => undefined);
    const error = await waitForSandboxExecReadiness(
      established("modal", () => pending),
      10,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxWarmingTimeoutError);
    expect(error).toMatchObject({
      backend: "modal",
      timeoutMs: 10,
      stage: "exec_readiness",
    });
    expect((error as Error).message).toContain("command-ready within 1s");
    expect((error as Error).message).not.toContain("capacity");
  });

  test("bounds an OpenSandbox exec RPC that never returns", async () => {
    const pending = new Promise<never>(() => undefined);
    const error = await waitForSandboxExecReadiness(
      established("opensandbox", () => pending),
      10,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxWarmingTimeoutError);
    expect(error).toMatchObject({
      backend: "opensandbox",
      timeoutMs: 10,
      stage: "exec_readiness",
    });
  });

  test("does not probe synchronous backends", async () => {
    let called = false;
    await waitForSandboxExecReadiness(
      established("unix_local", async () => {
        called = true;
      }),
      10,
    );
    expect(called).toBe(false);
  });
});

describe("workspace snapshot cancellation", () => {
  test("public snapshot diagnostics omit exact provider content", () => {
    const sentinel = "synthetic-snapshot-provider-value-123456";
    const error = Object.assign(new Error(`snapshot failed: ${sentinel}`), {
      name: sentinel,
      code: sentinel,
      status: 503,
      responseBody: sentinel,
    });

    expect(safeSnapshotError(error)).toEqual({
      errorClass: "SnapshotOperationError",
      errorCode: "snapshot_operation_failed",
      status: 503,
      origin: "sandbox-resume",
    });
    expect(error.message).toContain(sentinel);
    expect(JSON.stringify(safeSnapshotError(error))).not.toContain(sentinel);
  });

  test("public snapshot status projection tolerates hostile proxies", () => {
    const sentinel = "synthetic-snapshot-hostile-status-123456";
    const source = new Error(`snapshot failed: ${sentinel}`);
    const hostile = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "status" || property === "statusCode") {
          throw new Error(`hostile snapshot status getter: ${sentinel}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(safeSnapshotError(hostile)).toEqual({
      errorClass: "SnapshotOperationError",
      errorCode: "snapshot_operation_failed",
      origin: "sandbox-resume",
    });
    expect(source.message).toContain(sentinel);
    expect(JSON.stringify(safeSnapshotError(hostile))).not.toContain(sentinel);
  });

  test("Steer/Pause preempts an in-flight snapshot wait instead of paying its timeout", async () => {
    const controller = new AbortController();
    const startedAt = performance.now();
    const waiting = waitForWarmSnapshot(
      new Promise<never>(() => undefined),
      60_000,
      controller.signal,
    );
    controller.abort(new Error("STEER"));

    await expect(waiting).resolves.toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});

describe("retryable degraded workspace restore", () => {
  test("only a retryable degraded restore re-enters sandbox admission", () => {
    expect(isRetryableDegradedRestore({ status: "degraded", retryable: true })).toBe(true);
    expect(isRetryableDegradedRestore({ status: "degraded", retryable: false })).toBe(false);
    expect(isRetryableDegradedRestore({ status: "unrecoverable", retryable: true })).toBe(false);
  });
});
