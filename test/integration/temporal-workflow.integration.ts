import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { startTestServices, type TestServices, waitFor } from "@infra-agents/testing";

describe("Temporal workflow integration", () => {
  let services: TestServices;
  let connection: Connection;
  let nativeConnection: NativeConnection;

  beforeAll(async () => {
    services = await startTestServices({ temporal: true });
    connection = await Connection.connect({ address: services.temporalHost });
    nativeConnection = await NativeConnection.connect({ address: services.temporalHost });
  }, 300_000);

  afterAll(async () => {
    await connection?.close();
    await nativeConnection?.close();
    await services?.down();
  }, 60_000);

  test("dispatches initial and follow-up user message activities", async () => {
    const taskQueue = `workflow-test-${crypto.randomUUID()}`;
    const calls: unknown[] = [];
    const queuedTurns = [queuedTurn("event-1")];
    const worker = await testWorker(nativeConnection, taskQueue, {
      claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
      markSessionIdle: async () => undefined,
      runAgentSegment: async (input: unknown) => {
        calls.push(input);
        return { status: "idle" };
      },
      failSession: async () => undefined,
      cancelSession: async () => undefined,
    });
    const run = worker.run();
    try {
      const client = new Client({ connection });
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId: `wf-${crypto.randomUUID()}`,
        args: [{ sessionId: crypto.randomUUID(), initialEventId: "event-1" }],
      });
      await waitFor(() => calls.length === 1);
      queuedTurns.push(queuedTurn("event-2"));
      await handle.signal("userMessage", "event-2");
      await waitFor(() => calls.length === 2);
    } finally {
      worker.shutdown();
      await run;
    }
  });

  test("waits for approval before resuming a requires_action segment", async () => {
    const taskQueue = `workflow-test-${crypto.randomUUID()}`;
    const calls: unknown[] = [];
    const queuedTurns = [queuedTurn("event-1")];
    const worker = await testWorker(nativeConnection, taskQueue, {
      claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
      markSessionIdle: async () => undefined,
      runAgentSegment: async (input: unknown) => {
        calls.push(input);
        return { status: calls.length === 1 ? "requires_action" : "idle" };
      },
      failSession: async () => undefined,
      cancelSession: async () => undefined,
    });
    const run = worker.run();
    try {
      const client = new Client({ connection });
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId: `wf-${crypto.randomUUID()}`,
        args: [{ sessionId: crypto.randomUUID(), initialEventId: "event-1" }],
      });
      await waitFor(() => calls.length === 1);
      await Bun.sleep(300);
      expect(calls).toHaveLength(1);
      await handle.signal("approvalDecision", "approval-event");
      await waitFor(() => calls.length === 2);
    } finally {
      worker.shutdown();
      await run;
    }
  });

  test("does not retry failed agent activities", async () => {
    const taskQueue = `workflow-test-${crypto.randomUUID()}`;
    let attempts = 0;
    const failures: unknown[] = [];
    const queuedTurns = [queuedTurn("event-1")];
    const worker = await testWorker(nativeConnection, taskQueue, {
      claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
      markSessionIdle: async () => undefined,
      runAgentSegment: async () => {
        attempts += 1;
        throw new Error("boom");
      },
      failSession: async (input: unknown) => {
        failures.push(input);
      },
      cancelSession: async () => undefined,
    });
    const run = worker.run();
    try {
      const client = new Client({ connection });
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId: `wf-${crypto.randomUUID()}`,
        args: [{ sessionId: crypto.randomUUID(), initialEventId: "event-1" }],
      });
      await handle.result();
      expect(attempts).toBe(1);
      expect(failures).toHaveLength(1);
    } finally {
      worker.shutdown();
      await run;
    }
  });

  test("dispatches document index workflow activity", async () => {
    const taskQueue = `workflow-test-${crypto.randomUUID()}`;
    const calls: unknown[] = [];
    const worker = await testWorker(nativeConnection, taskQueue, {
      indexDocument: async (input: unknown) => {
        calls.push(input);
        return {
          id: "document-1",
          baseId: "base-1",
          fileId: "file-1",
          status: "ready",
          title: "runbook.txt",
          parser: "liteparse",
          chunkCount: 1,
          error: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      runAgentSegment: async () => ({ status: "idle" }),
      failSession: async () => undefined,
      cancelSession: async () => undefined,
    });
    const run = worker.run();
    try {
      const client = new Client({ connection });
      const handle = await client.workflow.start("documentIndexWorkflow", {
        taskQueue,
        workflowId: `wf-${crypto.randomUUID()}`,
        args: [{ documentId: "document-1" }],
      });
      const result = await handle.result();
      expect(calls).toEqual([{ documentId: "document-1" }]);
      expect(result).toMatchObject({ id: "document-1", status: "ready" });
    } finally {
      worker.shutdown();
      await run;
    }
  });

  test("scheduled task fire workflow starts a session child workflow", async () => {
    const taskQueue = `workflow-test-${crypto.randomUUID()}`;
    const dispatches: unknown[] = [];
    const runs: unknown[] = [];
    const queuedTurns: Array<{ id: string; triggerEventId: string }> = [];
    const sessionId = crypto.randomUUID();
    const triggerEventId = crypto.randomUUID();
    const childWorkflowId = `session-${sessionId}`;
    const worker = await testWorker(nativeConnection, taskQueue, {
      dispatchScheduledTaskRun: async (input: unknown) => {
        dispatches.push(input);
        queuedTurns.push(queuedTurn(triggerEventId));
        return {
          action: "start",
          sessionId,
          triggerEventId,
          workflowId: childWorkflowId,
        };
      },
      claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
      markSessionIdle: async () => undefined,
      runAgentSegment: async (input: unknown) => {
        runs.push(input);
        return { status: "idle" };
      },
      failSession: async () => undefined,
      cancelSession: async () => undefined,
    });
    const run = worker.run();
    try {
      const client = new Client({ connection });
      const handle = await client.workflow.start("scheduledTaskFireWorkflow", {
        taskQueue,
        workflowId: `scheduled-fire-${crypto.randomUUID()}`,
        args: [{ taskId: crypto.randomUUID(), triggerType: "scheduled" }],
      });
      await handle.result();
      await waitFor(() => runs.length === 1);
      const followUpEventId = crypto.randomUUID();
      queuedTurns.push(queuedTurn(followUpEventId));
      await client.workflow.getHandle(childWorkflowId).signal("userMessage", followUpEventId);
      await waitFor(() => runs.length === 2);
      expect(dispatches).toHaveLength(1);
      expect(runs[0]).toMatchObject({ sessionId, triggerEventId, workflowId: childWorkflowId });
    } finally {
      worker.shutdown();
      await run;
    }
  });

  test("scheduled task fire workflow signals a reusable session workflow", async () => {
    const taskQueue = `workflow-test-${crypto.randomUUID()}`;
    const calls: unknown[] = [];
    const sessionId = crypto.randomUUID();
    const workflowId = `session-${sessionId}`;
    const triggerEventId = crypto.randomUUID();
    const queuedTurns = [queuedTurn("event-1")];
    const worker = await testWorker(nativeConnection, taskQueue, {
      dispatchScheduledTaskRun: async () => {
        queuedTurns.push(queuedTurn(triggerEventId));
        return {
          action: "signal",
          sessionId,
          triggerEventId,
          workflowId,
        };
      },
      claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
      markSessionIdle: async () => undefined,
      runAgentSegment: async (input: unknown) => {
        calls.push(input);
        return { status: "idle" };
      },
      failSession: async () => undefined,
      cancelSession: async () => undefined,
    });
    const run = worker.run();
    try {
      const client = new Client({ connection });
      await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId,
        args: [{ sessionId, initialEventId: "event-1" }],
      });
      await waitFor(() => calls.length === 1);
      const fire = await client.workflow.start("scheduledTaskFireWorkflow", {
        taskQueue,
        workflowId: `scheduled-fire-${crypto.randomUUID()}`,
        args: [{ taskId: crypto.randomUUID(), triggerType: "manual" }],
      });
      await fire.result();
      await waitFor(() => calls.length === 2);
      expect(calls[1]).toMatchObject({ sessionId, triggerEventId });
    } finally {
      worker.shutdown();
      await run;
    }
  });
});

function queuedTurn(triggerEventId: string): { id: string; triggerEventId: string } {
  return {
    id: crypto.randomUUID(),
    triggerEventId,
  };
}

async function testWorker(nativeConnection: NativeConnection, taskQueue: string, activities: Record<string, (...args: any[]) => Promise<unknown>>): Promise<Worker> {
  return await Worker.create({
    connection: nativeConnection,
    namespace: "default",
    taskQueue,
    workflowsPath: new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname,
    activities,
  });
}
