import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { Database, SandboxEphemeralOwner } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import {
  createTurnToolCancellationController,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import type { Context } from "@temporalio/activity";
import {
  createRigVerificationActivityLifecycle,
  RigVerificationActivityDeadlineError,
  RIG_VERIFICATION_OWNER_TTL_MS,
  RIG_VERIFICATION_OWNERS_DISABLED_MESSAGE,
  runWithOwnedRigVerificationSandbox,
  type RigVerificationActivityLifecycle,
  type RigVerificationOwnershipDependencies,
  type RigVerificationSandboxRunContext,
} from "../src/activities/rig-verification";

const EXECUTION_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const NOW_MS = Date.parse("2026-07-19T12:00:00.000Z");

const settings = testSettings({
  sandboxBackend: "modal",
  modalTokenId: "test-token-id",
  modalTokenSecret: "test-token-secret",
  modalAppName: "opengeni-rig-verification-ownership-test",
  rigVerificationEphemeralOwnersEnabled: true,
});
const db = {} as Database;

function established(instanceId: string): EstablishedSandboxSession {
  return {
    client: {},
    session: {},
    sessionState: { sandboxId: instanceId },
    instanceId,
    backendId: "modal",
  } as EstablishedSandboxSession;
}

function owner(input: {
  executionId: string;
  accountId: string;
  workspaceId: string;
  kind: "rig_verification";
  backend: string;
  instanceId: string;
  expiresAt: Date;
}): SandboxEphemeralOwner {
  return {
    ...input,
    active: true,
    deactivatedAt: null,
  };
}

function harness(
  options: {
    tagError?: Error;
    deactivateResult?: boolean;
    deactivateError?: Error;
    terminateError?: Error;
    establishErrorAfterCreate?: Error;
    registerError?: Error;
    registerCommitsThenError?: Error;
    replacementInstanceId?: string;
    ownersEnabled?: boolean;
    establishWaitBeforeCreate?: Promise<void>;
    deactivateNeverSettles?: boolean;
  } = {},
) {
  const events: string[] = [];
  const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
  const registered: Array<Parameters<RigVerificationOwnershipDependencies["register"]>[1]> = [];
  const deactivated: Array<Parameters<RigVerificationOwnershipDependencies["deactivate"]>[1]> = [];
  const tagged: Array<Parameters<RigVerificationOwnershipDependencies["tag"]>[2]> = [];
  const terminated: Array<EstablishedSandboxSession | null> = [];
  let activeOwnerInstanceId: string | null = null;

  const observability = {
    warn: (message: string, context: Record<string, unknown>) => {
      warnings.push({ message, context });
    },
  } as unknown as Observability;

  const dependencies: RigVerificationOwnershipDependencies = {
    randomUUID: () => EXECUTION_ID,
    now: () => NOW_MS,
    establish: async (_settings, _envelope, establishOptions) => {
      events.push("establish:start");
      await options.establishWaitBeforeCreate;
      const first = established("sb-first");
      await establishOptions.onSandboxCreated?.(first);
      if (options.replacementInstanceId) {
        await establishOptions.onSandboxCreated?.(established(options.replacementInstanceId));
      }
      if (options.establishErrorAfterCreate) {
        throw options.establishErrorAfterCreate;
      }
      events.push("establish:return");
      return options.replacementInstanceId ? established(options.replacementInstanceId) : first;
    },
    register: async (_db, input) => {
      events.push(`register:${input.instanceId}`);
      registered.push(input);
      if (options.registerError) throw options.registerError;
      activeOwnerInstanceId = input.instanceId;
      if (options.registerCommitsThenError) throw options.registerCommitsThenError;
      return owner(input);
    },
    tag: async (_settings, instanceId, input) => {
      events.push(`tag:${instanceId}`);
      tagged.push(input);
      if (options.tagError) throw options.tagError;
      return true;
    },
    deactivate: async (_db, input) => {
      events.push(`deactivate:${input.instanceId}`);
      deactivated.push(input);
      if (options.deactivateNeverSettles) await new Promise<never>(() => undefined);
      if (options.deactivateError) throw options.deactivateError;
      if (options.deactivateResult !== undefined) {
        if (options.deactivateResult && activeOwnerInstanceId === input.instanceId) {
          activeOwnerInstanceId = null;
        }
        return options.deactivateResult;
      }
      if (activeOwnerInstanceId !== input.instanceId) {
        return false;
      }
      activeOwnerInstanceId = null;
      return true;
    },
    terminate: async (target) => {
      events.push(`terminate:${target?.instanceId ?? "none"}`);
      terminated.push(target);
      if (options.terminateError) throw options.terminateError;
    },
    createCancellationController: createTurnToolCancellationController,
  };

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
          rigVerificationEphemeralOwnersEnabled: options.ownersEnabled ?? true,
        },
        db,
        observability,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        sessionIdPrefix: "rig-verification-test",
        ...(lifecycle ? { lifecycle } : {}),
      },
      callback,
      dependencies,
    );

  return {
    run,
    events,
    warnings,
    registered,
    deactivated,
    tagged,
    terminated,
    activeOwnerInstanceId: () => activeOwnerInstanceId,
  };
}

describe("rig verification ephemeral ownership lifecycle", () => {
  test("the default-off Phase-B gate rejects before provider establishment", async () => {
    const state = harness({ ownersEnabled: false });

    await expect(state.run(async () => true)).rejects.toThrow(
      RIG_VERIFICATION_OWNERS_DISABLED_MESSAGE,
    );
    expect(state.events).toEqual([]);
    expect(state.registered).toEqual([]);
    expect(state.deactivated).toEqual([]);
    expect(state.terminated).toEqual([]);
  });

  test("persists exact ownership before tags and verifier setup, then cleans both resources", async () => {
    const state = harness();
    const result = await state.run(async (sandbox) => {
      state.events.push(`run:${sandbox.instanceId}`);
      return "passed";
    });

    expect(result).toBe("passed");
    expect(state.events).toEqual([
      "establish:start",
      "register:sb-first",
      "tag:sb-first",
      "establish:return",
      "run:sb-first",
      "deactivate:sb-first",
      "terminate:sb-first",
    ]);
    expect(state.registered).toEqual([
      {
        executionId: EXECUTION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        kind: "rig_verification",
        backend: "modal",
        instanceId: "sb-first",
        expiresAt: new Date(NOW_MS + RIG_VERIFICATION_OWNER_TTL_MS),
      },
    ]);
    expect(state.tagged).toEqual([
      {
        ownerKind: "rig_verification",
        ownerId: EXECUTION_ID,
        workspaceId: WORKSPACE_ID,
      },
    ]);
    expect(state.deactivated).toHaveLength(1);
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-first"]);
    expect(state.warnings).toEqual([]);
  });

  test("provider tag failure is diagnostic only and never blocks verifier work", async () => {
    const state = harness({ tagError: new Error("tag write refused") });
    await expect(
      state.run(async () => {
        state.events.push("run:continued");
        return true;
      }),
    ).resolves.toBe(true);

    expect(state.events).toContain("run:continued");
    expect(state.deactivated).toHaveLength(1);
    expect(state.terminated).toHaveLength(1);
    expect(state.warnings).toEqual([
      {
        message: "rig verifier: Modal ownership tag failed",
        context: {
          executionId: EXECUTION_ID,
          instanceId: "sb-first",
          error: "tag write refused",
        },
      },
    ]);
  });

  test("setup failure still deactivates ownership and terminates the provider", async () => {
    const thrown = new Error("setup failed");
    const state = harness();

    await expect(
      state.run(async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(state.deactivated.map((input) => input.instanceId)).toEqual(["sb-first"]);
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-first"]);
  });

  test("activity cancellation drains an in-flight command before provider termination", async () => {
    const state = harness();
    const abort = new AbortController();
    const lifecycle: RigVerificationActivityLifecycle = {
      signal: abort.signal,
      cleanupDeadlineAtMs: Date.now() + 5_000,
      dispose: () => undefined,
    };
    let finishCommand!: (value: unknown) => void;
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    const commandResult = new Promise<unknown>((resolve) => {
      finishCommand = resolve;
    });
    const session = {
      supportsPty: () => false,
      exec: async () => {
        state.events.push("command:start");
        commandStarted();
        return await commandResult;
      },
      cancelExecCommand: async () => {
        state.events.push("command:cancel");
        finishCommand({ exitCode: 130, output: "cancelled" });
        return true;
      },
    };

    const operation = state.run(
      async (_sandbox, context) =>
        await context.commandRunner(session, { cmd: "sleep 60", yieldTimeMs: 60_000 }),
      lifecycle,
    );
    await started;
    const cancellation = new Error("real activity abort");
    abort.abort(cancellation);

    await expect(operation).rejects.toBe(cancellation);
    expect(state.events.indexOf("command:cancel")).toBeGreaterThan(-1);
    expect(state.events.indexOf("terminate:sb-first")).toBeGreaterThan(
      state.events.indexOf("command:cancel"),
    );
  });

  test("activity-local deadline aborts work and cleans before start-to-close", async () => {
    const heartbeats: unknown[] = [];
    const temporalCancellation = new AbortController();
    const startedAt = Date.now();
    const lifecycle = createRigVerificationActivityLifecycle({
      info: {
        startToCloseTimeoutMs: 400,
        heartbeatTimeoutMs: 150,
      },
      cancellationSignal: temporalCancellation.signal,
      heartbeat: (details: unknown) => heartbeats.push(details),
    } as unknown as Context);
    const state = harness();

    try {
      await expect(
        state.run(
          async (_sandbox, context) =>
            await new Promise<never>((_resolve, reject) => {
              const rejectOnAbort = () => reject(context.signal.reason);
              if (context.signal.aborted) rejectOnAbort();
              else context.signal.addEventListener("abort", rejectOnAbort, { once: true });
            }),
          lifecycle,
        ),
      ).rejects.toBeInstanceOf(RigVerificationActivityDeadlineError);
    } finally {
      lifecycle.dispose();
    }

    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(state.deactivated.map((input) => input.instanceId)).toEqual(["sb-first"]);
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-first"]);
  });

  test("a create callback returning after outer abort independently cleans its exact instance", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const state = harness({ establishWaitBeforeCreate: createGate });
    const abort = new AbortController();
    const lifecycle: RigVerificationActivityLifecycle = {
      signal: abort.signal,
      cleanupDeadlineAtMs: Date.now() + 25,
      dispose: () => undefined,
    };
    const operation = state.run(async () => true, lifecycle);
    while (!state.events.includes("establish:start")) await Bun.sleep(1);
    const cancellation = new Error("cancel before provider create returns");
    abort.abort(cancellation);
    await expect(operation).rejects.toBe(cancellation);

    releaseCreate();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        state.deactivated.some((input) => input.instanceId === "sb-first") &&
        state.terminated.some((sandbox) => sandbox?.instanceId === "sb-first")
      ) {
        break;
      }
      await Bun.sleep(2);
    }
    expect(state.deactivated.map((input) => input.instanceId)).toContain("sb-first");
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toContain("sb-first");
  });

  test("cleanup timeout is observable and cannot suppress sibling provider termination", async () => {
    const state = harness({ deactivateNeverSettles: true });
    const lifecycle: RigVerificationActivityLifecycle = {
      signal: new AbortController().signal,
      cleanupDeadlineAtMs: Date.now() + 30,
      dispose: () => undefined,
    };

    await expect(state.run(async () => true, lifecycle)).resolves.toBe(true);
    expect(state.deactivated).toHaveLength(1);
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-first"]);
    expect(state.warnings).toContainEqual({
      message: "rig verifier: ownership cleanup timed out",
      context: expect.objectContaining({ operation: "deactivate_and_terminate" }),
    });
  });

  test("establishment failure after create still cleans the registered exact instance", async () => {
    const establishError = new Error("manifest setup failed");
    const state = harness({ establishErrorAfterCreate: establishError });

    await expect(state.run(async () => true)).rejects.toBe(establishError);
    expect(state.deactivated.map((input) => input.instanceId)).toEqual(["sb-first"]);
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-first"]);
  });

  test("registration failure fails closed and still attempts exact deactivation and termination", async () => {
    const registerError = new Error("database unavailable");
    const state = harness({ registerError });

    await expect(state.run(async () => true)).rejects.toBe(registerError);
    expect(state.tagged).toEqual([]);
    expect(state.deactivated.map((input) => input.instanceId)).toEqual(["sb-first"]);
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-first"]);
    expect(state.activeOwnerInstanceId()).toBeNull();
    expect(state.warnings[0]?.context.operation).toBe("deactivate");
  });

  test("commit-then-lost registration response plus termination failure leaves no live owner", async () => {
    const responseLost = new Error("registration response lost after commit");
    const state = harness({
      registerCommitsThenError: responseLost,
      terminateError: new Error("provider unavailable"),
    });

    await expect(state.run(async () => true)).rejects.toBe(responseLost);
    expect(state.tagged).toEqual([]);
    expect(state.deactivated.map((input) => input.instanceId)).toEqual(["sb-first"]);
    expect(state.activeOwnerInstanceId()).toBeNull();
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-first"]);
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]?.context).toMatchObject({
      operation: "terminate",
      instanceId: "sb-first",
    });
  });

  test("deactivation failure cannot suppress provider termination", async () => {
    const state = harness({ deactivateError: new Error("database unavailable") });
    await expect(state.run(async () => true)).resolves.toBe(true);

    expect(state.deactivated).toHaveLength(1);
    expect(state.terminated).toHaveLength(1);
    expect(state.warnings[0]?.context.operation).toBe("deactivate");
  });

  test("provider termination failure cannot suppress durable deactivation", async () => {
    const state = harness({ terminateError: new Error("provider unavailable") });
    await expect(state.run(async () => true)).resolves.toBe(true);

    expect(state.deactivated).toHaveLength(1);
    expect(state.terminated).toHaveLength(1);
    expect(state.warnings[0]?.context.operation).toBe("terminate");
  });

  test("a false exact deactivation is surfaced and never followed by re-registration", async () => {
    const state = harness({ deactivateResult: false });
    await expect(state.run(async () => true)).resolves.toBe(true);

    expect(state.registered).toHaveLength(1);
    expect(state.deactivated).toHaveLength(1);
    expect(state.terminated).toHaveLength(1);
    expect(state.events.filter((event) => event.startsWith("register:"))).toEqual([
      "register:sb-first",
    ]);
    expect(state.warnings[0]?.context).toMatchObject({
      operation: "deactivate",
      instanceId: "sb-first",
    });
  });

  test("a replacement create callback rebinds ownership and cleanup to the latest instance", async () => {
    const state = harness({ replacementInstanceId: "sb-replacement" });
    await expect(state.run(async (sandbox) => sandbox.instanceId)).resolves.toBe("sb-replacement");

    expect(state.registered.map((input) => input.instanceId)).toEqual([
      "sb-first",
      "sb-replacement",
    ]);
    expect(state.deactivated.map((input) => input.instanceId)).toEqual([
      "sb-first",
      "sb-replacement",
    ]);
    expect(state.activeOwnerInstanceId()).toBeNull();
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-replacement"]);
  });
});
