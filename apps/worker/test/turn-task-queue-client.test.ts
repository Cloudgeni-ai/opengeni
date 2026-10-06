import { describe, expect, spyOn, test } from "bun:test";
import { Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createObservability } from "@opengeni/observability";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import * as core from "@opengeni/core";
import * as workerHttp from "../src/http";
import { createOpenGeniWorkerService } from "../src";
import { createTurnTaskQueueStatsClient } from "../src/turn-task-queue-reader";
import { deferred, flushTelemetry, telemetryClock } from "./fixtures/telemetry-clock";

const identity = { temporalNamespace: "diagnostic-test", taskQueue: "actual-turn-queue" };

describe("owned task-queue diagnostic client", () => {
  test("unused/pre-aborted client never constructs a connection and cannot reopen after close", async () => {
    const lazy = spyOn(Connection, "lazy");
    const client = createTurnTaskQueueStatsClient({ address: "unused.invalid:7233" });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        client.read({ signal: controller.signal, deadline: 101_000 }, identity),
      ).rejects.toThrow();
      expect(lazy).not.toHaveBeenCalled();
      const closing = client.close();
      expect(client.close()).toBe(closing);
      await closing;
      await expect(
        client.read({ signal: new AbortController().signal, deadline: 101_000 }, identity),
      ).rejects.toThrow("diagnostic client is closed");
      expect(lazy).not.toHaveBeenCalled();
    } finally {
      lazy.mockRestore();
    }
  });

  test("close cancels all native reads, removes caller subscriptions and fences late settlement even when close hangs", async () => {
    const clock = telemetryClock();
    const reply = deferred<any>();
    const nativeClose = deferred<void>();
    const nativeSignals: AbortSignal[] = [];
    const deadlines: number[] = [];
    let closes = 0;
    const lazy = spyOn(Connection, "lazy").mockReturnValue({
      withAbortSignal: (signal: AbortSignal, operation: () => Promise<unknown>) => {
        nativeSignals.push(signal);
        return operation();
      },
      withDeadline: (deadline: number, operation: () => Promise<unknown>) => {
        deadlines.push(deadline);
        return operation();
      },
      workflowService: { describeTaskQueue: () => reply.promise },
      close: () => {
        closes++;
        return nativeClose.promise;
      },
    } as unknown as Connection);
    const client = createTurnTaskQueueStatsClient(
      { address: "fixture.invalid:7233" },
      { scheduler: clock.scheduler, closeTimeoutMs: 50 },
    );
    const first = new AbortController();
    const second = new AbortController();
    const removeFirst = spyOn(first.signal, "removeEventListener");
    const removeSecond = spyOn(second.signal, "removeEventListener");
    try {
      const firstOutcome = client
        .read({ signal: first.signal, deadline: 101_000 }, identity)
        .catch((error) => error);
      const secondOutcome = client
        .read({ signal: second.signal, deadline: 102_000 }, identity)
        .catch((error) => error);
      expect(lazy).toHaveBeenCalledTimes(1);
      expect(lazy.mock.calls[0]?.[0]?.interceptors).toEqual([]);
      expect(deadlines).toEqual([101_000, 102_000]);
      let closed = false;
      const closing = client.close();
      void closing.then(() => {
        closed = true;
      });
      expect(client.close()).toBe(closing);
      expect(closes).toBe(1);
      expect(nativeSignals.map((signal) => signal.aborted)).toEqual([true, true]);
      expect(first.signal.aborted).toBe(false); // Never mutate the host's signal.
      clock.advance(49);
      await flushTelemetry();
      expect(closed).toBe(false);
      clock.advance(1);
      await closing;
      expect(closed).toBe(true);
      expect(clock.timers()).toBe(0);
      await expect(
        client.read({ signal: new AbortController().signal, deadline: 103_000 }, identity),
      ).rejects.toThrow("diagnostic client is closed");
      reply.resolve({
        stats: { approximateBacklogCount: 888, approximateBacklogAge: { seconds: 1 } },
      });
      expect(await firstOutcome).toBeInstanceOf(Error);
      expect(await secondOutcome).toBeInstanceOf(Error);
      expect(removeFirst).toHaveBeenCalledTimes(1);
      expect(removeSecond).toHaveBeenCalledTimes(1);
      nativeClose.resolve();
      await flushTelemetry();
      expect(closes).toBe(1);
      expect(clock.timers()).toBe(0);
    } finally {
      nativeClose.resolve();
      await client.close();
      removeFirst.mockRestore();
      removeSecond.mockRestore();
      lazy.mockRestore();
    }
  });

  test("normal read settles its caller subscription and close errors cannot fail cleanup", async () => {
    for (const close of [
      () => {
        throw Error("fixture close failed");
      },
      () => Promise.reject(Error("fixture close failed")),
    ]) {
      const clock = telemetryClock();
      const lazy = spyOn(Connection, "lazy").mockReturnValue({
        withAbortSignal: (_signal: AbortSignal, operation: () => Promise<unknown>) => operation(),
        withDeadline: (_deadline: number, operation: () => Promise<unknown>) => operation(),
        workflowService: {
          describeTaskQueue: async () => ({ stats: { approximateBacklogCount: 0 } }),
        },
        close,
      } as unknown as Connection);
      const controller = new AbortController();
      const remove = spyOn(controller.signal, "removeEventListener");
      const client = createTurnTaskQueueStatsClient(
        { address: "fixture.invalid:7233" },
        { scheduler: clock.scheduler },
      );
      try {
        expect(
          (await client.read({ signal: controller.signal, deadline: 101_000 }, identity))
            .eligibleBacklog,
        ).toBe(0);
        expect(remove).toHaveBeenCalledTimes(1);
        await client.close();
        expect(clock.timers()).toBe(0);
      } finally {
        await client.close();
        remove.mockRestore();
        lazy.mockRestore();
      }
    }
  });

  test("actual service close and late startup failure each close both diagnostic and signaling owners", async () => {
    for (const startupFailure of [false, true]) {
      const settings = testSettings();
      const observability = createObservability(settings, { component: "worker-turn" });
      const signals: AbortSignal[] = [];
      const requests: any[] = [];
      const reply = deferred<any>();
      let clientCloses = 0;
      let nativeCloses = 0;
      let unsubscriptions = 0;
      let shutdowns = 0;
      const lazy = spyOn(Connection, "lazy").mockImplementation(
        () =>
          ({
            ensureConnected: async () => {},
            withAbortSignal: (signal: AbortSignal, operation: () => Promise<unknown>) => {
              signals.push(signal);
              return operation();
            },
            withDeadline: (_deadline: number, operation: () => Promise<unknown>) => operation(),
            workflowService: {
              describeTaskQueue: (request: unknown) => {
                requests.push(request);
                return reply.promise;
              },
            },
            close: async () => {
              clientCloses++;
              reply.reject(Error("fixture connection closed"));
            },
          }) as unknown as Connection,
      );
      const connect = spyOn(NativeConnection, "connect").mockResolvedValue({
        close: async () => {
          nativeCloses++;
        },
      } as NativeConnection);
      const create = spyOn(Worker, "create").mockResolvedValue({
        options: { namespace: identity.temporalNamespace, taskQueue: identity.taskQueue },
        getStatus: () => ({
          numInFlightNonLocalActivities: 0,
          numInFlightLocalActivities: 0,
          numInFlightActivities: 0,
        }),
        numInFlightActivities$: {
          subscribe: () => ({
            unsubscribe: () => {
              unsubscriptions++;
            },
          }),
        },
        run: async () => {},
        shutdown: () => {
          shutdowns++;
        },
      } as unknown as Worker);
      const catalog = spyOn(core, "resolveCatalogSettings").mockResolvedValue({
        settings,
        source: "code",
        version: null,
        modelNotes: [],
      });
      const http = startupFailure
        ? spyOn(workerHttp, "startWorkerHttpServer").mockImplementation(() => {
            throw Error("fixture late startup failure");
          })
        : undefined;
      try {
        const creating = createOpenGeniWorkerService({
          role: "turn",
          settings,
          http: startupFailure ? {} : false,
          activities: { noop: async () => {} },
          activityDependencies: { db: {} as never, bus: new MemoryEventBus(), observability },
        });
        if (startupFailure) await expect(creating).rejects.toThrow("fixture late startup failure");
        else {
          const service = await creating;
          expect(signals).toHaveLength(1);
          expect(
            lazy.mock.calls.map(([options]) => options?.interceptors?.length ?? "default"),
          ).toEqual(["default", 0]);
          await service.close();
          await service.close();
          expect(service.state()).toBe("stopped");
          expect(shutdowns).toBe(1);
        }
        expect(signals.map((signal) => signal.aborted)).toEqual([true]);
        expect(requests).toEqual([
          {
            namespace: identity.temporalNamespace,
            taskQueue: { name: identity.taskQueue },
            taskQueueType: 2,
            reportStats: true,
          },
        ]);
        expect(clientCloses).toBe(2);
        expect(nativeCloses).toBe(1);
        expect(unsubscriptions).toBe(1);
      } finally {
        http?.mockRestore();
        catalog.mockRestore();
        create.mockRestore();
        connect.mockRestore();
        lazy.mockRestore();
      }
    }
  });
});
