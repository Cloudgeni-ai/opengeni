import { describe, expect, test } from "bun:test";
import { type EstablishedSandboxSession, SandboxExecReadinessError } from "@opengeni/runtime";
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
): EstablishedSandboxSession {
  return {
    backendId,
    client: {},
    instanceId: "sandbox-1",
    session: { exec },
    sessionState: {},
  };
}

describe("sandbox exec readiness", () => {
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

  test("rejects a resolved Modal exec without an explicit completion status", async () => {
    await expect(
      waitForSandboxExecReadiness(
        established("modal", async () => ({ output: "" })),
        100,
      ),
    ).rejects.toBeInstanceOf(SandboxExecReadinessError);
  });

  test("bounds a Modal exec RPC that never returns", async () => {
    const pending = new Promise<never>(() => undefined);
    await expect(
      waitForSandboxExecReadiness(
        established("modal", () => pending),
        10,
      ),
    ).rejects.toBeInstanceOf(SandboxWarmingTimeoutError);
  });

  test("does not probe other backends", async () => {
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
