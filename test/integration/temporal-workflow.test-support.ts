import { Client, Connection } from "@temporalio/client";
import {
  bundleWorkflowCode,
  NativeConnection,
  Worker,
  type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { startTestServices, type TestServices } from "@opengeni/testing";
import { currentActivityContext } from "../../apps/worker/src/activities/streaming";

// An ungraceful worker death cannot be faked by throwing a TimeoutFailure
// from the activity (the worker coerces thrown activity errors into
// ApplicationFailure via ensureApplicationFailure), so the worker-death tests
// produce the REAL failure shape: the mock turn activity hangs without ever
// heartbeating and the Temporal server closes it with a heartbeat timeout
// (the session workflow's proxy sets heartbeatTimeout to 30s), delivering an
// ActivityFailure whose cause is a TimeoutFailure with timeoutType HEARTBEAT
// — exactly what a SIGKILLed worker produces. The hang resolves on the
// worker-shutdown cancellation so the test worker can drain at the end.
export async function hangWithoutHeartbeating(): Promise<{ status: string }> {
  await new Promise<void>((resolve) => {
    const signal = currentActivityContext()?.cancellationSignal;
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return { status: "cancelled" };
}

// Generous bound for the server to detect a missed-heartbeat activity
// (30s heartbeat window + detection slack) plus the rest of the test.
export const workerDeathTestTimeoutMs = 180_000;

export const temporalWorkflowTestTimeoutMs = 30_000;

// continueAsNew tests legitimately span a continueAsNew chain (the handle only
// resolves on the FINAL run) plus a possible 5s idle-wait window before the
// continued run re-claims the durable-queue turn that arrived after the
// boundary. Run last in the suite, on a server already warmed by 18 prior
// tests, the 30s default is too tight under CI load — a slow worker poll or
// bundle reload can blow it even though the workflow logic is correct. The
// generous bound removes that flakiness without weakening what the test proves.
export const continueAsNewTestTimeoutMs = 120_000;

export type TemporalTestActivity = (...args: never[]) => Promise<unknown>;
export type TemporalTestActivities = Record<string, TemporalTestActivity>;

export type TemporalWorkflowTestContext = {
  readonly services: TestServices;
  readonly connection: Connection;
  readonly nativeConnection: NativeConnection;
  // The bundle is compiled once per integration file and then passed by
  // reference to every isolated Worker.create in that file. It is immutable
  // for the lifetime of the context; never use workflowsPath in a test worker.
  readonly workflowBundle: WorkflowBundleWithSourceMap;
  readonly createWorker: (taskQueue: string, activities: TemporalTestActivities) => Promise<Worker>;
  readonly close: () => Promise<void>;
};

export async function createTemporalWorkflowTestContext(): Promise<TemporalWorkflowTestContext> {
  const workflowsPath = new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname;
  const workflowBundle = await bundleWorkflowCode({ workflowsPath });
  const externalTemporalHost = process.env.OPENGENI_TEST_TEMPORAL_HOST?.trim();
  const services = externalTemporalHost
    ? ({ temporalHost: externalTemporalHost, down: async () => undefined } as TestServices)
    : await startTestServices({ temporal: true });

  let connection: Connection | undefined;
  let nativeConnection: NativeConnection | undefined;
  try {
    connection = await Connection.connect({ address: services.temporalHost });
    nativeConnection = await NativeConnection.connect({ address: services.temporalHost });
  } catch (error) {
    await nativeConnection?.close();
    await connection?.close();
    await services.down();
    throw error;
  }

  const connectedConnection = connection;
  const connectedNativeConnection = nativeConnection;
  if (!connectedConnection || !connectedNativeConnection) {
    throw new Error("Temporal test connections were not initialized");
  }
  return {
    services,
    connection: connectedConnection,
    nativeConnection: connectedNativeConnection,
    workflowBundle,
    createWorker: async (taskQueue, activities) =>
      await Worker.create({
        connection: connectedNativeConnection,
        namespace: "default",
        taskQueue,
        workflowBundle,
        activities: {
          // Goal-less defaults; individual tests override these to exercise the
          // goal continuation loop.
          maybeContinueGoal: async () => ({ action: "none" }),
          pauseGoalForInterrupt: async () => undefined,
          getCodexCapacityWait: async () => null,
          reconcileCodexCapacityWait: async () => ({ action: "stale" }),
          ...activities,
          // Mirror production registration: the session workflow schedules the
          // LEGACY activity name (replay safety for in-flight multi-day
          // sessions), so the turn mock must answer to it as well.
          ...(activities.runAgentTurn ? { runAgentSegment: activities.runAgentTurn } : {}),
        },
      }),
    close: async () => {
      await connectedConnection.close();
      await connectedNativeConnection.close();
      await services.down();
    },
  };
}

export async function testWorker(
  context: TemporalWorkflowTestContext,
  taskQueue: string,
  activities: TemporalTestActivities,
): Promise<Worker> {
  return await context.createWorker(taskQueue, activities);
}

export function decodeContinuedInput(
  event:
    | {
        workflowExecutionContinuedAsNewEventAttributes?: {
          input?: { payloads?: unknown[] | null } | null;
        } | null;
      }
    | undefined,
): Record<string, unknown> {
  const payload = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0] as
    | { data?: Uint8Array }
    | undefined;
  if (!payload?.data) {
    throw new Error("continueAsNew event carried no input payload");
  }
  return JSON.parse(Buffer.from(payload.data).toString("utf8")) as Record<string, unknown>;
}

export function queuedTurn(triggerEventId: string): { id: string; triggerEventId: string } {
  return {
    id: crypto.randomUUID(),
    triggerEventId,
  };
}

export function workflowScope(): { accountId: string; workspaceId: string } {
  return {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
}

export { Client };
