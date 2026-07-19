import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { Database, SandboxEphemeralOwner } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import type { EstablishedSandboxSession } from "@opengeni/runtime";
import {
  RIG_VERIFICATION_OWNER_TTL_MS,
  runWithOwnedRigVerificationSandbox,
  type RigVerificationOwnershipDependencies,
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
    replacementInstanceId?: string;
  } = {},
) {
  const events: string[] = [];
  const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
  const registered: Array<Parameters<RigVerificationOwnershipDependencies["register"]>[1]> = [];
  const deactivated: Array<Parameters<RigVerificationOwnershipDependencies["deactivate"]>[1]> = [];
  const tagged: Array<Parameters<RigVerificationOwnershipDependencies["tag"]>[2]> = [];
  const terminated: Array<EstablishedSandboxSession | null> = [];

  const observability = {
    warn: (message: string, context: Record<string, unknown>) => {
      warnings.push({ message, context });
    },
  } as unknown as Observability;

  const dependencies: RigVerificationOwnershipDependencies = {
    randomUUID: () => EXECUTION_ID,
    now: () => NOW_MS,
    establish: async (_settings, _envelope, establishOptions) => {
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
      if (options.deactivateError) throw options.deactivateError;
      return options.deactivateResult ?? true;
    },
    terminate: async (target) => {
      events.push(`terminate:${target?.instanceId ?? "none"}`);
      terminated.push(target);
      if (options.terminateError) throw options.terminateError;
    },
  };

  const run = <T>(callback: (sandbox: EstablishedSandboxSession) => Promise<T>) =>
    runWithOwnedRigVerificationSandbox(
      {
        settings,
        db,
        observability,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        sessionIdPrefix: "rig-verification-test",
      },
      callback,
      dependencies,
    );

  return { run, events, warnings, registered, deactivated, tagged, terminated };
}

describe("rig verification ephemeral ownership lifecycle", () => {
  test("persists exact ownership before tags and verifier setup, then cleans both resources", async () => {
    const state = harness();
    const result = await state.run(async (sandbox) => {
      state.events.push(`run:${sandbox.instanceId}`);
      return "passed";
    });

    expect(result).toBe("passed");
    expect(state.events).toEqual([
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

  for (const failure of [
    { name: "setup failure", errorName: "Error", message: "setup failed" },
    { name: "cancellation", errorName: "CancelledFailure", message: "cancelled" },
    { name: "timeout", errorName: "TimeoutFailure", message: "activity timed out" },
  ]) {
    test(`${failure.name} still deactivates ownership and terminates the provider`, async () => {
      const thrown = new Error(failure.message);
      thrown.name = failure.errorName;
      const state = harness();

      await expect(
        state.run(async () => {
          throw thrown;
        }),
      ).rejects.toBe(thrown);
      expect(state.deactivated.map((input) => input.instanceId)).toEqual(["sb-first"]);
      expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-first"]);
    });
  }

  test("establishment failure after create still cleans the registered exact instance", async () => {
    const establishError = new Error("manifest setup failed");
    const state = harness({ establishErrorAfterCreate: establishError });

    await expect(state.run(async () => true)).rejects.toBe(establishError);
    expect(state.deactivated.map((input) => input.instanceId)).toEqual(["sb-first"]);
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-first"]);
  });

  test("registration failure fails closed before tagging or setup and still terminates", async () => {
    const registerError = new Error("database unavailable");
    const state = harness({ registerError });

    await expect(state.run(async () => true)).rejects.toBe(registerError);
    expect(state.tagged).toEqual([]);
    expect(state.deactivated).toEqual([]);
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-first"]);
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
    expect(state.deactivated.map((input) => input.instanceId)).toEqual(["sb-replacement"]);
    expect(state.terminated.map((sandbox) => sandbox?.instanceId)).toEqual(["sb-replacement"]);
  });
});
