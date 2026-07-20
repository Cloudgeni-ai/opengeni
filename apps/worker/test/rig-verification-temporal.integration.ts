import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database, SandboxEphemeralOwner } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import {
  createTurnToolCancellationController,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import { testSettings, waitFor } from "@opengeni/testing";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  createRigVerificationActivityLifecycle,
  runWithOwnedRigVerificationSandbox,
  type RigVerificationOwnershipDependencies,
} from "../src/activities/rig-verification";

const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

const settings = testSettings({
  sandboxBackend: "modal",
  modalTokenId: "test-token-id",
  modalTokenSecret: "test-token-secret",
  modalAppName: "opengeni-rig-verification-temporal-test",
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

function waitForSignalAbort(signal: AbortSignal, events: string[]): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      events.push("activity:abort");
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function failureChainMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    messages.push(
      current instanceof Error ? `${current.name}: ${current.message}` : String(current),
    );
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return messages;
}

function lifecycleDependencies(
  events: string[],
  terminateDelayMs: number,
): RigVerificationOwnershipDependencies {
  return {
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    now: () => Date.now(),
    establish: async (_settings, _envelope, options) => {
      const sandbox = established("sb-temporal");
      await options.onSandboxCreated?.(sandbox);
      events.push("establish:return");
      return sandbox;
    },
    register: async (_db, input) => {
      events.push("owner:register");
      return {
        ...input,
        active: true,
        deactivatedAt: null,
      } as SandboxEphemeralOwner;
    },
    deactivate: async () => {
      events.push("owner:deactivate");
      return true;
    },
    tag: async () => {
      events.push("provider:tag");
      return true;
    },
    terminate: async () => {
      events.push("provider:terminate:start");
      await Bun.sleep(terminateDelayMs);
      events.push("provider:terminate:end");
    },
    createCancellationController: createTurnToolCancellationController,
  };
}

function verifierActivity(events: string[], terminateDelayMs: number): () => Promise<void> {
  const dependencies = lifecycleDependencies(events, terminateDelayMs);
  const observability = {
    warn: (message: string, context: Record<string, unknown>) => {
      events.push(`warn:${message}:${String(context.operation ?? "unknown")}`);
    },
  } as unknown as Observability;
  return async () => {
    const lifecycle = createRigVerificationActivityLifecycle();
    try {
      await runWithOwnedRigVerificationSandbox(
        {
          settings,
          db,
          observability,
          accountId: ACCOUNT_ID,
          workspaceId: WORKSPACE_ID,
          sessionIdPrefix: "rig-verification-temporal",
          lifecycle,
        },
        async (_sandbox, context) => {
          events.push("activity:work:start");
          await waitForSignalAbort(context.signal, events);
        },
        dependencies,
      );
    } finally {
      lifecycle.dispose();
    }
  };
}

describe("rig verification real Temporal cancellation and deadline cleanup", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { log: { format: "pretty", level: "warn" } },
    });
  }, 300_000);

  afterAll(async () => {
    await environment?.teardown();
  }, 60_000);

  test("production workflow cancellation waits for exact deactivation and provider termination", async () => {
    const taskQueue = `rig-verification-cancel-${crypto.randomUUID()}`;
    const events: string[] = [];
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace ?? "default",
      taskQueue,
      workflowsPath: new URL("./fixtures/rig-verification-temporal-workflows.ts", import.meta.url)
        .pathname,
      activities: {
        verifyRigVersion: verifierActivity(events, 250),
        verifyRigChange: verifierActivity(events, 250),
        runRigVerificationDeadlineProbe: verifierActivity(events, 250),
      },
    });
    const workerRun = worker.run();
    try {
      const handle = await environment.client.workflow.start("rigVerificationWorkflow", {
        taskQueue,
        workflowId: `rig-verification-cancel-${crypto.randomUUID()}`,
        args: [{ workspaceId: WORKSPACE_ID, versionId: crypto.randomUUID() }],
      });
      await waitFor(() => events.includes("activity:work:start"));
      let resultSettled = false;
      const result = handle.result().finally(() => {
        resultSettled = true;
      });
      void result.catch(() => undefined);

      await handle.cancel();
      await waitFor(() => events.includes("provider:terminate:start"));
      await Bun.sleep(50);
      expect(resultSettled).toBe(false);
      expect(events).toContain("owner:deactivate");
      expect(events).not.toContain("provider:terminate:end");

      await expect(result).rejects.toThrow();
      expect(events).toContain("provider:terminate:end");
      expect(events.indexOf("provider:terminate:end")).toBeGreaterThan(
        events.indexOf("activity:abort"),
      );
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("activity-local deadline completes cleanup before the real server start-to-close timeout", async () => {
    const taskQueue = `rig-verification-deadline-${crypto.randomUUID()}`;
    const events: string[] = [];
    const eventTimes = new Map<string, number>();
    const recordEvents = new Proxy(events, {
      get(target, property, receiver) {
        if (property === "push") {
          return (...items: string[]) => {
            for (const item of items) eventTimes.set(item, Date.now());
            return Array.prototype.push.apply(target, items);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace ?? "default",
      taskQueue,
      workflowsPath: new URL("./fixtures/rig-verification-temporal-workflows.ts", import.meta.url)
        .pathname,
      activities: {
        verifyRigVersion: verifierActivity(recordEvents, 700),
        verifyRigChange: verifierActivity(recordEvents, 700),
        runRigVerificationDeadlineProbe: verifierActivity(recordEvents, 700),
      },
    });
    const workerRun = worker.run();
    try {
      const handle = await environment.client.workflow.start(
        "rigVerificationDeadlineProbeWorkflow",
        {
          taskQueue,
          workflowId: `rig-verification-deadline-${crypto.randomUUID()}`,
        },
      );
      await waitFor(() => events.includes("activity:work:start"));
      const result = handle.result();
      void result.catch(() => undefined);
      let failure: unknown;
      try {
        await result;
      } catch (error) {
        failure = error;
      }
      expect(failureChainMessages(failure).join("\n")).toContain("activity-local deadline");

      expect(events).toContain("activity:abort");
      expect(events).toContain("owner:deactivate");
      expect(events).toContain("provider:terminate:end");
      const workStartedAt = eventTimes.get("activity:work:start")!;
      const providerTerminationStartedAt = eventTimes.get("provider:terminate:start")!;
      const providerTerminatedAt = eventTimes.get("provider:terminate:end")!;
      // Cleanup itself spans more than the workflow's 500ms heartbeat timeout.
      // The activity can survive this only if it keeps heartbeating after the
      // local deadline has aborted verifier work.
      expect(providerTerminatedAt - providerTerminationStartedAt).toBeGreaterThan(500);
      expect(providerTerminatedAt - workStartedAt).toBeLessThan(5_000);

      const history = await handle.fetchHistory();
      const serverTimedOut = (history.events ?? []).some(
        (event) => event.activityTaskTimedOutEventAttributes != null,
      );
      expect(serverTimedOut).toBe(false);
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);
});
