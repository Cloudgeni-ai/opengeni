import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { Database, LeaseSnapshot } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import type { EstablishedSandboxSession } from "@opengeni/runtime";
import {
  RIG_VERIFICATION_OWNERS_DISABLED_MESSAGE,
  runWithOwnedRigVerificationSandbox,
  type RigVerificationActivityLifecycle,
  type RigVerificationOwnershipDependencies,
  type RigVerificationSandboxRunContext,
} from "../src/activities/rig-verification";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const HOLDER_UUID = "55555555-5555-4555-8555-555555555555";
const db = {} as Database;

const settings = testSettings({
  sandboxBackend: "modal",
  modalTokenId: "test-token-id",
  modalTokenSecret: "test-token-secret",
  modalAppName: "opengeni-rig-verification-test",
  modalImageRef: "example.invalid/opengeni:test",
  rigVerificationLeaseOwnershipEnabled: true,
});

function snapshot(overrides: Partial<LeaseSnapshot> = {}): LeaseSnapshot {
  return {
    id: "lease-1",
    sandboxGroupId: GROUP_ID,
    liveness: "warming",
    refcount: 1,
    turnHolders: 1,
    viewerHolders: 0,
    instanceId: null,
    backend: "modal",
    os: "linux",
    image: settings.modalImageRef ?? null,
    rigVersionId: VERSION_ID,
    dataPlaneUrl: null,
    terminalDataPlaneUrl: null,
    leaseEpoch: 7,
    resumeBackendId: null,
    resumeState: null,
    expiresAt: new Date("2026-07-19T12:20:00.000Z"),
    ...overrides,
  };
}

function established(instanceId = "sb-verifier"): EstablishedSandboxSession {
  return {
    client: {},
    session: {},
    sessionState: { sandboxId: instanceId },
    instanceId,
    backendId: "modal",
    origin: "created",
  };
}

type HarnessOptions = {
  ownersEnabled?: boolean;
  acquireRole?: "spawner" | "attached" | "rearmed" | "fenced";
  establishErrorBeforeCreate?: Error;
  recordError?: Error;
  recordResult?: boolean;
  commitError?: Error;
  commitResult?: boolean;
  terminateResult?: boolean;
  markError?: Error;
  failError?: Error;
  controllerFactory?: RigVerificationOwnershipDependencies["createCancellationController"];
};

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
  const markEpochs: number[] = [];
  const failEpochs: number[] = [];
  const releaseGrace: number[] = [];

  const observability = {
    warn: (message: string, context: Record<string, unknown>) => {
      warnings.push({ message, context });
    },
  } as unknown as Observability;

  const defaultControllerFactory = ((_signal?: AbortSignal) => ({
    runSandboxCommand: async (
      session: { exec?: (args: Record<string, unknown>) => Promise<unknown> },
      args: Record<string, unknown>,
    ) => {
      events.push("command");
      if (!session.exec) throw new Error("missing fake exec");
      return await session.exec(args);
    },
    cancel: () => {
      events.push("cancel");
    },
    waitForQuiescence: async () => {
      events.push("quiesce");
    },
  })) as unknown as RigVerificationOwnershipDependencies["createCancellationController"];

  const dependencies = {
    randomUUID: () => HOLDER_UUID,
    acquire: async (_db, input) => {
      events.push("acquire");
      expect(input.sandboxGroupId).toBe(GROUP_ID);
      expect(input.image).toBe(settings.modalImageRef);
      expect(input.rigVersionId).toBe(VERSION_ID);
      return {
        role: options.acquireRole ?? "spawner",
        lease: snapshot(),
      };
    },
    establish: async (_settings, _envelope, establishOptions) => {
      events.push("establish:start");
      if (options.establishErrorBeforeCreate) throw options.establishErrorBeforeCreate;
      const created = established();
      await establishOptions.onSandboxCreated?.(created);
      events.push("establish:return");
      return created;
    },
    recordCreated: async (_db, input) => {
      events.push("record");
      expect(input.expectedEpoch).toBe(7);
      expect(input.instanceId).toBe("sb-verifier");
      expect(input.resumeState).toBeNull();
      if (options.recordError) throw options.recordError;
      return {
        recorded: options.recordResult ?? true,
        lease: snapshot({ instanceId: input.instanceId }),
      };
    },
    commitWarm: async (_db, input) => {
      events.push("commit");
      expect(input.expectedEpoch).toBe(7);
      if (options.commitError) throw options.commitError;
      const committed = options.commitResult ?? true;
      return {
        committed,
        lease: committed
          ? snapshot({ liveness: "warm", instanceId: input.instanceId, leaseEpoch: 8 })
          : null,
      };
    },
    touchHolder: async () => true,
    releaseHolder: async (_db, input) => {
      events.push("release");
      releaseGrace.push(input.idleGraceMs);
      return { liveness: "cold" as const, refcount: 0 };
    },
    failWarming: async (_db, input) => {
      events.push("fail-warming");
      failEpochs.push(input.expectedEpoch);
      if (options.failError) throw options.failError;
    },
    markWarmLost: async (_db, input) => {
      events.push("mark-warm-lost");
      markEpochs.push(input.expectedEpoch);
      if (options.markError) throw options.markError;
      return { status: "marked" as const, lease: snapshot({ liveness: "cold" }) };
    },
    serialize: async () => null,
    tag: async (_settings, instanceId, attribution) => {
      events.push("tag");
      expect(instanceId).toBe("sb-verifier");
      expect(attribution).toEqual({
        leaseId: "lease-1",
        workspaceId: WORKSPACE_ID,
        sandboxGroupId: GROUP_ID,
      });
      return true;
    },
    terminate: async (target) => {
      events.push("terminate");
      expect(target?.instanceId).toBe("sb-verifier");
      return options.terminateResult ?? true;
    },
    createCancellationController: options.controllerFactory ?? defaultControllerFactory,
  } as unknown as RigVerificationOwnershipDependencies;

  const run = <T>(
    callback: (
      sandbox: EstablishedSandboxSession,
      context: RigVerificationSandboxRunContext,
    ) => Promise<T>,
    lifecycle?: RigVerificationActivityLifecycle,
  ) =>
    runWithOwnedRigVerificationSandbox(
      {
        settings: {
          ...settings,
          rigVerificationLeaseOwnershipEnabled: options.ownersEnabled ?? true,
        },
        db,
        observability,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        sandboxGroupId: GROUP_ID,
        rigVersionId: VERSION_ID,
        sessionIdPrefix: "rig-verification-test",
        ...(lifecycle ? { lifecycle } : {}),
      },
      callback,
      dependencies,
    );

  return { run, events, warnings, markEpochs, failEpochs, releaseGrace };
}

describe("rig verification canonical lease ownership", () => {
  test("the default-off rollout gate fails before lease acquire or provider create", async () => {
    const state = harness({ ownersEnabled: false });
    await expect(state.run(async () => true)).rejects.toThrow(
      RIG_VERIFICATION_OWNERS_DISABLED_MESSAGE,
    );
    expect(state.events).toEqual([]);
  });

  test("records the exact instance and commits warm before verifier work", async () => {
    const state = harness();
    await expect(
      state.run(async () => {
        state.events.push("run");
        return "passed";
      }),
    ).resolves.toBe("passed");
    expect(state.events.slice(0, 7)).toEqual([
      "acquire",
      "establish:start",
      "record",
      "tag",
      "establish:return",
      "commit",
      "run",
    ]);
    expect(state.events.indexOf("quiesce")).toBeLessThan(state.events.indexOf("terminate"));
    expect(state.markEpochs).toEqual([8]);
    expect(state.failEpochs).toEqual([7]);
    expect(state.releaseGrace).toEqual([1]);
  });

  test("registration failure still terminates, rolls back warming, and releases", async () => {
    const state = harness({ recordError: new Error("registration unavailable") });
    await expect(state.run(async () => true)).rejects.toThrow("registration unavailable");
    expect(state.events).not.toContain("commit");
    expect(state.events).toContain("terminate");
    expect(state.events).toContain("fail-warming");
    expect(state.events.at(-1)).toBe("release");
  });

  test("provider creation failure rolls back the exact warming epoch without waiting for TTL", async () => {
    const state = harness({ establishErrorBeforeCreate: new Error("provider create failed") });
    await expect(state.run(async () => true)).rejects.toThrow("provider create failed");
    expect(state.events).not.toContain("record");
    expect(state.events).not.toContain("terminate");
    expect(state.failEpochs).toEqual([7]);
    expect(state.events.at(-1)).toBe("release");
  });

  test("a warm-commit acknowledgement ambiguity cleans both possible lease states", async () => {
    const state = harness({ commitError: new Error("commit response lost") });
    await expect(state.run(async () => true)).rejects.toThrow("commit response lost");
    expect(state.markEpochs).toEqual([8]);
    expect(state.failEpochs).toEqual([7]);
    expect(state.events).toContain("terminate");
    expect(state.events.at(-1)).toBe("release");
  });

  test("never reuses an attached, rearmed, or fenced box for clean verification", async () => {
    for (const role of ["attached", "rearmed", "fenced"] as const) {
      const state = harness({ acquireRole: role });
      await expect(state.run(async () => true)).rejects.toThrow(`was ${role}`);
      expect(state.events).not.toContain("establish:start");
      expect(state.events.at(-1)).toBe("release");
    }
  });

  test("termination failure retains the lease pointer and still releases for reaper cleanup", async () => {
    const state = harness({ terminateResult: false });
    await expect(state.run(async () => true)).resolves.toBe(true);
    expect(state.events).toContain("terminate");
    expect(state.events).not.toContain("mark-warm-lost");
    expect(state.events).not.toContain("fail-warming");
    expect(state.events.at(-1)).toBe("release");
    expect(state.releaseGrace).toEqual([1]);
  });

  test("DB cleanup failures cannot suppress provider termination or holder release", async () => {
    const state = harness({
      markError: new Error("mark failed"),
      failError: new Error("rollback failed"),
    });
    await expect(state.run(async () => true)).resolves.toBe(true);
    expect(state.events.indexOf("terminate")).toBeLessThan(state.events.indexOf("mark-warm-lost"));
    expect(state.events.at(-1)).toBe("release");
    expect(state.warnings.map((warning) => warning.context.operation).sort()).toEqual([
      "fail_warming",
      "mark_warm_lost",
    ]);
  });

  test("cancellation quiesces active commands before provider teardown", async () => {
    const events: string[] = [];
    let rejectCommand: ((reason?: unknown) => void) | null = null;
    const controllerFactory = ((signal?: AbortSignal) => {
      const pending = new Promise<never>((_resolve, reject) => {
        rejectCommand = reject;
      });
      const cancel = (reason?: unknown) => {
        events.push("cancel-command");
        rejectCommand?.(reason);
      };
      signal?.addEventListener("abort", () => cancel(signal.reason), { once: true });
      return {
        runSandboxCommand: async () => {
          events.push("command:start");
          return await pending;
        },
        cancel,
        waitForQuiescence: async () => {
          events.push("quiesce-command");
          await pending.catch(() => undefined);
        },
      };
    }) as unknown as RigVerificationOwnershipDependencies["createCancellationController"];
    const state = harness({ controllerFactory });
    const abort = new AbortController();
    const lifecycle: RigVerificationActivityLifecycle = {
      signal: abort.signal,
      cleanupDeadlineAtMs: null,
      dispose: () => undefined,
    };
    const running = state.run(
      async (sandbox, context) =>
        await context.commandRunner(sandbox.session as never, { cmd: "sleep 600" }),
      lifecycle,
    );
    while (!events.includes("command:start")) await Bun.sleep(1);
    abort.abort(new Error("cancel verifier"));
    await expect(running).rejects.toThrow("cancel verifier");
    expect(events.indexOf("quiesce-command")).toBeGreaterThanOrEqual(0);
    expect(state.events.indexOf("terminate")).toBeGreaterThanOrEqual(0);
    expect(events).toContain("cancel-command");
  });
});

describe("rig verification workflow cancellation contract", () => {
  test("waits for cleanup completion and heartbeats inside the server deadline", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/workflows/rig-verification.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain('heartbeatTimeout: "10 seconds"');
    expect(source).toContain("ActivityCancellationType.WAIT_CANCELLATION_COMPLETED");
    expect(source).toContain('startToCloseTimeout: "15 minutes"');
  });
});
