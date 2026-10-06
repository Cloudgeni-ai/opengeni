import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { Connection, isGrpcCancelledError, isGrpcDeadlineError } from "@temporalio/client";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { startTurnCapacityMonitor } from "../src/observability-metrics";
import { createTurnTaskQueueStatsReader } from "../src/turn-task-queue-reader";
import { turnTaskQueue } from "../src/workflows/activities";
import { deferred } from "./fixtures/telemetry-clock";

// Use the gRPC/protobuf implementations shipped in the pinned client, not a new
// dependency or another SDK version. The product reader uses only public APIs.
const sdkRequire = createRequire(import.meta.resolve("@temporalio/client"));
const grpc = sdkRequire("@grpc/grpc-js");
const proto = sdkRequire("@temporalio/proto").temporal.api.workflowservice.v1;
const request = proto.DescribeTaskQueueRequest;
const response = proto.DescribeTaskQueueResponse;
const identity = {
  temporalNamespace: "actual-test-namespace",
  taskQueue: turnTaskQueue("actual-base"),
};

async function serverFixture(
  handler: (call: any, reply: (error: unknown, response?: unknown) => void) => void,
) {
  const server = new grpc.Server();
  server.addService(
    {
      describeTaskQueue: {
        path: "/temporal.api.workflowservice.v1.WorkflowService/DescribeTaskQueue",
        requestStream: false,
        responseStream: false,
        requestSerialize: (value: unknown) => Buffer.from(request.encode(value).finish()),
        requestDeserialize: (value: Buffer) => request.decode(value),
        responseSerialize: (value: unknown) => Buffer.from(response.encode(value).finish()),
        responseDeserialize: (value: Buffer) => response.decode(value),
      },
    },
    { describeTaskQueue: handler },
  );
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error: unknown, boundPort: number) => {
        if (error) reject(error);
        else resolve(boundPort);
      },
    );
  });
  const connection = Connection.lazy({ address: `127.0.0.1:${port}` });
  return {
    connection,
    read: createTurnTaskQueueStatsReader(connection, identity),
    async close() {
      await connection.close();
      server.forceShutdown();
    },
  };
}

describe("pinned SDK native task-queue RPC bounds", () => {
  test("sends the actual ACTIVITY queue identity and normalizes wire protobuf stats", async () => {
    const observed = deferred<any>();
    const f = await serverFixture((call, reply) => {
      observed.resolve(call.request);
      reply(null, {
        stats: {
          approximateBacklogCount: 7,
          approximateBacklogAge: { seconds: 12, nanos: 500_000_000 },
          tasksAddRate: 2.5,
          tasksDispatchRate: 1,
        },
      });
    });
    try {
      expect(
        await f.read({ signal: new AbortController().signal, deadline: Date.now() + 5_000 }),
      ).toEqual({
        eligibleBacklog: 7,
        oldestBacklogAgeSeconds: 12.5,
        tasksAddRate: 2.5,
        tasksDispatchRate: 1,
      });
      expect(await observed.promise).toMatchObject({
        namespace: identity.temporalNamespace,
        taskQueue: { name: identity.taskQueue },
        taskQueueType: 2,
        reportStats: true,
      });
    } finally {
      await f.close();
    }
  });

  test("AbortController really cancels a hung server-side DescribeTaskQueue RPC", async () => {
    const received = deferred<void>();
    const cancelled = deferred<void>();
    const f = await serverFixture((call) => {
      call.on("cancelled", () => cancelled.resolve());
      received.resolve(); // Deliberately never reply.
    });
    try {
      const controller = new AbortController();
      const reading = f.read({ signal: controller.signal, deadline: Date.now() + 5_000 });
      const outcome = reading.catch((error) => error);
      await received.promise;
      controller.abort();
      expect(isGrpcCancelledError(await outcome)).toBe(true);
      await cancelled.promise;
    } finally {
      await f.close();
    }
  });

  test("native gRPC deadline reaches the server and cancels without a JS Promise.race", async () => {
    const seenDeadline = deferred<number>();
    const cancelled = deferred<void>();
    const f = await serverFixture((call) => {
      seenDeadline.resolve(Number(call.getDeadline()));
      call.on("cancelled", () => cancelled.resolve());
    });
    try {
      const deadline = Date.now() + 1_000;
      const outcome = f
        .read({ signal: new AbortController().signal, deadline })
        .catch((error) => error);
      // gRPC serializes a remaining timeout; allow scheduling/rounding in local
      // transport while still proving the native deadline was installed.
      expect(Math.abs((await seenDeadline.promise) - deadline)).toBeLessThanOrEqual(50);
      expect(isGrpcDeadlineError(await outcome)).toBe(true);
      await cancelled.promise;
    } finally {
      await f.close();
    }
  });

  test("rejects a pre-aborted signal before starting any native request", async () => {
    let calls = 0;
    const f = await serverFixture((_call, reply) => {
      calls++;
      reply(null, { stats: { approximateBacklogCount: 0 } });
    });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        f.read({ signal: controller.signal, deadline: Date.now() + 5_000 }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      // The failed read's call context cannot leak into other work on the shared
      // signaler connection. Another legitimate read still succeeds.
      expect(
        (await f.read({ signal: new AbortController().signal, deadline: Date.now() + 5_000 }))
          .eligibleBacklog,
      ).toBe(0);
      expect(calls).toBe(1);
    } finally {
      await f.close();
    }
  });

  test("server responses omitting stats fail instead of producing a fresh zero", async () => {
    const f = await serverFixture((_call, reply) => reply(null, {}));
    try {
      await expect(
        f.read({ signal: new AbortController().signal, deadline: Date.now() + 5_000 }),
      ).rejects.toThrow("omitted required stats");
    } finally {
      await f.close();
    }
  });

  test("monitor close delivers native cancellation to its hung queue call", async () => {
    const received = deferred<void>();
    const cancelled = deferred<void>();
    const f = await serverFixture((call) => {
      call.on("cancelled", () => cancelled.resolve());
      received.resolve();
    });
    const observability = createObservability(testSettings(), { component: "worker-turn" });
    const monitor = startTurnCapacityMonitor({ observability, identity, read: f.read });
    try {
      await received.promise;
      await monitor.close();
      await cancelled.promise;
      const metrics = await observability.prometheusMetrics();
      expect(metrics).not.toMatch(/^opengeni_turn_eligible_backlog\{/m);
      const fresh = metrics
        .split("\n")
        .find((line) => line.startsWith("opengeni_turn_capacity_monitor_fresh{"));
      expect(fresh).toEndWith("} 0");
    } finally {
      await monitor.close();
      await f.close();
    }
  });
});
