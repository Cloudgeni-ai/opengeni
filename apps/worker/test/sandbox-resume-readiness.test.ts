import { describe, expect, test } from "bun:test";
import type { EstablishedSandboxSession } from "@opengeni/runtime";
import {
  SandboxWarmingTimeoutError,
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
        return { output: "" };
      }),
      100,
    );
    expect(commands).toEqual(["true"]);
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
