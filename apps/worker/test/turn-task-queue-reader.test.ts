import { describe, expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import {
  Connection,
  isGrpcCancelledError,
  isGrpcDeadlineError,
  isGrpcServiceError,
  makeGrpcRetryInterceptor,
  type ConnectionOptions,
} from "@temporalio/client";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { startTurnCapacityMonitor } from "../src/observability-metrics";
import { createWorkerWorkflowSignaler } from "../src";
import {
  createTurnTaskQueueStatsClient,
  createTurnTaskQueueStatsReader,
} from "../src/turn-task-queue-reader";
import { turnTaskQueue } from "../src/workflows/activities";
import { deferred, flushTelemetry, telemetryClock } from "./fixtures/telemetry-clock";

// Use the gRPC/protobuf implementations shipped in the pinned client, not a new
// dependency or another SDK version. The product reader uses only public APIs.
const sdkRequire = createRequire(import.meta.resolve("@temporalio/client"));
const grpc = sdkRequire("@grpc/grpc-js");
const proto = sdkRequire("@temporalio/proto").temporal.api.workflowservice.v1;
const request = proto.DescribeTaskQueueRequest;
const response = proto.DescribeTaskQueueResponse;
const systemInfoRequest = proto.GetSystemInfoRequest;
const systemInfoResponse = proto.GetSystemInfoResponse;
const identity = {
  temporalNamespace: "actual-test-namespace",
  taskQueue: turnTaskQueue("actual-base"),
};

async function serverFixture(
  handler: (call: any, reply: (error: unknown, response?: unknown) => void) => void,
  connectionOptions: Omit<ConnectionOptions, "address"> = {},
  systemInfoHandler = (_call: any, reply: (error: unknown, response?: unknown) => void) =>
    reply(null, {}),
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
      getSystemInfo: {
        path: "/temporal.api.workflowservice.v1.WorkflowService/GetSystemInfo",
        requestStream: false,
        responseStream: false,
        requestSerialize: (value: unknown) => Buffer.from(systemInfoRequest.encode(value).finish()),
        requestDeserialize: (value: Buffer) => systemInfoRequest.decode(value),
        responseSerialize: (value: unknown) =>
          Buffer.from(systemInfoResponse.encode(value).finish()),
        responseDeserialize: (value: Buffer) => systemInfoResponse.decode(value),
      },
    },
    { describeTaskQueue: handler, getSystemInfo: systemInfoHandler },
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
  const address = `127.0.0.1:${port}`;
  const connection = Connection.lazy({ address, ...connectionOptions });
  const diagnostic = createTurnTaskQueueStatsClient({ address, ...connectionOptions });
  return {
    address,
    connection,
    read: (options: Parameters<ReturnType<typeof createTurnTaskQueueStatsReader>>[0]) =>
      diagnostic.read(options, identity),
    retryingRead: createTurnTaskQueueStatsReader(connection, identity),
    async close() {
      await diagnostic.close();
      await connection.close();
      server.forceShutdown();
    },
  };
}

describe("pinned SDK native task-queue RPC bounds", () => {
  test("reproduces pinned SDK retry-backoff cancellation gap on a retrying connection", async () => {
    const backoff = deferred<void>();
    const replacement = deferred<void>();
    let calls = 0;
    const f = await serverFixture(
      (_call, reply) => {
        if (++calls === 1) reply({ code: grpc.status.UNAVAILABLE, details: "fixture transient" });
        else replacement.resolve(); // Replacement deliberately hangs.
      },
      {
        interceptors: [
          makeGrpcRetryInterceptor({
            retryableDecider: (attempt, status) =>
              attempt === 1 && status.code === grpc.status.UNAVAILABLE,
            delayFunction: () => {
              backoff.resolve();
              return 50;
            },
          }),
        ],
      },
    );
    try {
      const controller = new AbortController();
      const outcome = f
        .retryingRead({ signal: controller.signal, deadline: Date.now() + 400 })
        .catch((error) => error);
      await backoff.promise;
      controller.abort();
      await replacement.promise;
      expect(calls).toBe(2);
      // This is why diagnostic traffic cannot use SDK1.22's retry interceptor.
      expect(isGrpcDeadlineError(await outcome)).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      await f.close();
    }
  });

  test("reproduces pinned SDK cancellation gap on an already active replacement RPC", async () => {
    const replacement = deferred<void>();
    let calls = 0;
    const f = await serverFixture(
      (_call, reply) => {
        if (++calls === 1) reply({ code: grpc.status.UNAVAILABLE, details: "fixture transient" });
        else replacement.resolve();
      },
      {
        interceptors: [
          makeGrpcRetryInterceptor({
            retryableDecider: (attempt, status) =>
              attempt === 1 && status.code === grpc.status.UNAVAILABLE,
            delayFunction: () => 1,
          }),
        ],
      },
    );
    try {
      const controller = new AbortController();
      const outcome = f
        .retryingRead({ signal: controller.signal, deadline: Date.now() + 400 })
        .catch((error) => error);
      await replacement.promise;
      controller.abort();
      expect(isGrpcDeadlineError(await outcome)).toBe(true);
      expect(calls).toBe(2);
    } finally {
      await f.close();
    }
  });

  test("diagnostic failure/abort in the retry-backoff window cannot start a replacement RPC", async () => {
    const failed = deferred<void>();
    let calls = 0;
    let retryDecisions = 0;
    const f = await serverFixture(
      (_call, reply) => {
        calls++;
        reply({ code: grpc.status.UNAVAILABLE, details: "fixture transient" });
        failed.resolve();
      },
      {
        interceptors: [
          makeGrpcRetryInterceptor({
            retryableDecider: () => {
              retryDecisions++;
              return true;
            },
            delayFunction: () => 50,
          }),
        ],
      },
    );
    try {
      const controller = new AbortController();
      const outcome = f
        .read({ signal: controller.signal, deadline: Date.now() + 1_000 })
        .catch((error) => error);
      await failed.promise;
      controller.abort(); // The default SDK would now be entering retry backoff.
      const error = await outcome;
      expect(isGrpcServiceError(error)).toBe(true);
      expect([grpc.status.UNAVAILABLE, grpc.status.CANCELLED]).toContain(error.code);
      expect(retryDecisions).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls).toBe(1);
    } finally {
      await f.close();
    }
  });

  test("a later monitor attempt cancels natively and preserves the last successful tuple", async () => {
    const received = deferred<void>();
    const cancelled = deferred<void>();
    let calls = 0;
    const f = await serverFixture((call, reply) => {
      calls++;
      if (calls === 1)
        reply(null, {
          stats: { approximateBacklogCount: 9, approximateBacklogAge: { seconds: 1 } },
        });
      else if (calls === 2) reply({ code: grpc.status.UNAVAILABLE, details: "fixture transient" });
      else {
        call.on("cancelled", () => cancelled.resolve());
        received.resolve();
      }
    });
    const clock = telemetryClock();
    const outcomes = [deferred<void>(), deferred<void>(), deferred<void>()];
    let attempts = 0;
    const observability = createObservability(testSettings(), { component: "worker-turn" });
    const monitor = startTurnCapacityMonitor({
      observability,
      identity,
      scheduler: clock.scheduler,
      intervalMs: 1_000,
      read: (options) => {
        const attempt = attempts++;
        const reading = f.read(options);
        void reading.then(
          () => outcomes[attempt]?.resolve(),
          () => outcomes[attempt]?.resolve(),
        );
        return reading;
      },
    });
    const metric = (metrics: string, name: string) =>
      Number(
        metrics
          .split("\n")
          .find((line) => line.startsWith(`${name}{`))
          ?.split("} ")[1],
      );
    try {
      await outcomes[0]!.promise;
      await flushTelemetry();
      const original = await observability.prometheusMetrics();
      const timestamp = metric(
        original,
        "opengeni_turn_capacity_monitor_last_success_timestamp_seconds",
      );
      expect(metric(original, "opengeni_turn_eligible_backlog")).toBe(9);
      clock.advance(1_000);
      await outcomes[1]!.promise;
      await flushTelemetry();
      const failed = await observability.prometheusMetrics();
      expect(metric(failed, "opengeni_turn_capacity_monitor_last_read_success")).toBe(0);
      expect(metric(failed, "opengeni_turn_capacity_monitor_fresh")).toBe(0);
      expect(metric(failed, "opengeni_turn_eligible_backlog")).toBe(9);
      expect(metric(failed, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds")).toBe(
        timestamp,
      );
      clock.advance(1_000); // Only a new application observation retries the RPC.
      await received.promise;
      await monitor.close();
      await cancelled.promise;
      expect(calls).toBe(3);
      expect(attempts).toBe(3);
      expect(clock.timers()).toBe(0);
      const closed = await observability.prometheusMetrics();
      expect(metric(closed, "opengeni_turn_eligible_backlog")).toBe(9);
      expect(metric(closed, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds")).toBe(
        timestamp,
      );
      expect(metric(closed, "opengeni_turn_capacity_monitor_fresh")).toBe(0);
    } finally {
      await monitor.close();
      await f.close();
    }
  });

  test("workflow signaler keeps its shared retries but owns/cancels an isolated diagnostic connection", async () => {
    const received = deferred<void>();
    const cancelled = deferred<void>();
    let diagnosticCalls = 0;
    let systemCalls = 0;
    const f = await serverFixture(
      (call, reply) => {
        if (++diagnosticCalls === 1)
          reply({ code: grpc.status.UNAVAILABLE, details: "fixture transient" });
        else {
          call.on("cancelled", () => cancelled.resolve());
          received.resolve();
        }
      },
      {},
      (_call, reply) => {
        if (++systemCalls === 2)
          reply({ code: grpc.status.UNAVAILABLE, details: "fixture shared transient" });
        else reply(null, {});
      },
    );
    const lazy = spyOn(Connection, "lazy");
    const signaler = await createWorkerWorkflowSignaler(
      testSettings({ temporalHost: f.address }),
      {} as never,
    );
    try {
      const failure = await signaler
        .getTurnTaskQueueStats(undefined, identity)
        .catch((error) => error);
      expect(
        lazy.mock.calls.map(([options]) => options?.interceptors?.length ?? "default"),
      ).toEqual(["default", 0]);
      expect(diagnosticCalls).toBe(1); // No internal retry inherited from signaling.
      expect(failure).toMatchObject({ code: grpc.status.UNAVAILABLE });
      await signaler.check();
      expect(systemCalls).toBe(3); // Shared check still retries UNAVAILABLE.
      const outcome = signaler.getTurnTaskQueueStats(undefined, identity).catch((error) => error);
      await received.promise;
      await signaler.close();
      await cancelled.promise;
      expect(isGrpcCancelledError(await outcome)).toBe(true);
      await expect(signaler.getTurnTaskQueueStats(undefined, identity)).rejects.toThrow(
        "diagnostic client is closed",
      );
      expect(diagnosticCalls).toBe(2);
    } finally {
      await signaler.close();
      lazy.mockRestore();
      await f.close();
    }
  });

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
      // The failed read's call context cannot poison a later diagnostic read.
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
