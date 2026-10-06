import { expect, test } from "bun:test";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import { startTestServices } from "@opengeni/testing";
import type { SandboxMachineInventoryItem } from "@opengeni/db";
import {
  sandboxV2ControlTaskQueue,
  type SandboxV2RecoveryCursor,
} from "../../apps/worker/src/sandbox-v2-control";
import { sandboxLifecycleTaskQueue } from "../../apps/worker/src/sandbox-reaper-contract";

test("real Temporal: v2 isolates old workers and completes unequal inventories across continuation", async () => {
  const external = process.env.OPENGENI_TEST_TEMPORAL_HOST?.trim();
  const services = external
    ? { temporalHost: external, down: async () => {} }
    : await startTestServices({ temporal: true });
  let connection: Connection | undefined;
  let native: NativeConnection | undefined;
  const workers: Worker[] = [];
  const runs: Promise<void>[] = [];
  let releaseShort!: () => void;
  const shortDone = new Promise<void>((resolve) => {
    releaseShort = resolve;
  });
  try {
    connection = await Connection.connect({ address: services.temporalHost });
    native = await NativeConnection.connect({ address: services.temporalHost });
    const baseQueue = `machine-test-${crypto.randomUUID()}`;
    const queue = sandboxV2ControlTaskQueue(baseQueue);
    const oldQueue = sandboxLifecycleTaskQueue(baseQueue);
    expect(queue).not.toBe(oldQueue);
    const scope = {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      provider: "synthetic",
    };
    const target = (): SandboxMachineInventoryItem => ({
      ...scope,
      sandboxGroupId: crypto.randomUUID(),
      machineId: crypto.randomUUID(),
    });
    const long = target();
    const short = target();
    const calls: (SandboxMachineInventoryItem & SandboxV2RecoveryCursor)[] = [];
    const commandCursors = Array.from({ length: 32 }, () => crypto.randomUUID());
    const demandCursor = crypto.randomUUID();
    let inventoryCalls = 0;
    let legacyCalls = 0;
    const workflowsPath = new URL("../../apps/worker/src/workflows/sandbox-v2.ts", import.meta.url)
      .pathname;
    workers.push(
      await Worker.create({
        connection: native,
        namespace: "default",
        taskQueue: oldQueue,
        workflowsPath: new URL(
          "../../apps/worker/test/fixtures/legacy-machine-control-queue-workflow.ts",
          import.meta.url,
        ).pathname,
        activities: {
          legacyQueueProbe: async () => {
            legacyCalls++;
            return "legacy-ok";
          },
        },
      }),
    );
    workers.push(
      await Worker.create({
        connection: native,
        namespace: "default",
        taskQueue: queue,
        workflowsPath,
        maxConcurrentActivityTaskExecutions: 4,
        activities: {
          listSandboxV2Machines: async (input: { afterMachineId?: string }) => {
            expect(Context.current().info.taskQueue).toBe(queue);
            inventoryCalls++;
            if (inventoryCalls === 1) {
              expect(input).toEqual({});
              return { items: [long, short], nextMachineId: short.machineId };
            }
            expect(input).toEqual({ afterMachineId: short.machineId });
            return { items: [], nextMachineId: null };
          },
          reconcileSandboxV2Machine: async (
            input: SandboxMachineInventoryItem & SandboxV2RecoveryCursor,
          ) => {
            expect(Context.current().info.taskQueue).toBe(queue);
            if (input.machineId === short.machineId) {
              releaseShort();
              return { status: "reconciled", nextDemandId: null, nextOperationId: null };
            }
            expect(input.machineId).toBe(long.machineId);
            const page = calls.length;
            calls.push(structuredClone(input));
            if (page === 0) await shortDone; // Other machine makes progress independently.
            return {
              status: "reconciled",
              nextDemandId: page === 0 ? demandCursor : null,
              nextOperationId: commandCursors[page] ?? null,
            };
          },
        },
      }),
    );
    runs.push(...workers.map((worker) => worker.run()));
    const client = new Client({ connection });
    expect(
      await client.workflow.execute("legacyQueueProbeWorkflow", {
        taskQueue: oldQueue,
        workflowId: `legacy-test-${crypto.randomUUID()}`,
        args: [],
      }),
    ).toBe("legacy-ok");
    await client.workflow.execute("sandboxMachineSweepWorkflow", {
      taskQueue: queue,
      workflowId: `machine-sweep-test-${crypto.randomUUID()}`,
      args: [],
    });
    const handle = (item: SandboxMachineInventoryItem) =>
      client.workflow.getHandle(
        `sandbox-machine-v2:${item.accountId}:${item.workspaceId}:${item.machineId}`,
      );
    await Promise.all([handle(long).result(), handle(short).result()]);
    expect(legacyCalls).toBe(1);
    expect(inventoryCalls).toBe(2);
    expect(calls).toHaveLength(33);
    expect(calls[1]!.afterDemandId).toBe(demandCursor);
    for (const [page, input] of calls.entries()) {
      expect(input.machineId).toBe(long.machineId);
      expect(input.provider).toBe(long.provider);
      if (page >= 2) {
        expect(input.attemptsComplete).toBe(true);
        expect(input.afterDemandId).toBeUndefined();
      }
      if (page > 0) expect(input.afterOperationId).toBe(commandCursors[page - 1]);
    }
    const history = await handle(long).fetchHistory();
    const start = history.events?.find(
      (event) => event.workflowExecutionStartedEventAttributes,
    )?.workflowExecutionStartedEventAttributes;
    expect(start?.continuedExecutionRunId).toBeTruthy();
    await Worker.runReplayHistory({ workflowsPath }, history);
  } finally {
    releaseShort();
    for (const worker of workers) worker.shutdown();
    await Promise.allSettled(runs);
    await native?.close();
    await connection?.close();
    await services.down();
  }
}, 120_000);
