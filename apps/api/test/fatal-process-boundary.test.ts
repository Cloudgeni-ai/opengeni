import { describe, expect, test } from "bun:test";
import type { Attributes } from "@opengeni/observability";
import { installApiFatalProcessBoundary } from "../src/fatal-process-boundary";

type FatalEvent = "unhandledRejection" | "uncaughtException";

function fakeProcess() {
  const listeners = new Map<FatalEvent, (reason: unknown) => void>();
  const exits: number[] = [];
  let resolveExit: ((code: number) => void) | undefined;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return {
    process: {
      on: (event: FatalEvent, listener: (reason: unknown) => void) => {
        listeners.set(event, listener);
      },
      off: (event: FatalEvent, listener: (reason: unknown) => void) => {
        if (listeners.get(event) === listener) listeners.delete(event);
      },
      exit: (code: number) => {
        exits.push(code);
        resolveExit?.(code);
      },
    },
    emit: (event: FatalEvent, reason: unknown) => {
      listeners.get(event)?.(reason);
    },
    listeners,
    exits,
    exit,
  };
}

describe("API fatal process boundary", () => {
  test("reports an unhandled rejection with closed structural facts and no rejection content", async () => {
    const sentinel = "API_FATAL_PRIVATE_SENTINEL_76d324";
    const runtime = fakeProcess();
    const logs: Array<{ message: string; attributes: Attributes }> = [];
    const spans: Array<{
      name: string;
      attributes: Attributes;
      endInput?: { attributes?: Attributes; error?: unknown };
    }> = [];
    let flushes = 0;
    const boundary = installApiFatalProcessBoundary({
      process: runtime.process,
      correlationId: () => "api-fatal.test-unhandled",
      observability: {
        error: (message, attributes = {}) => {
          logs.push({ message, attributes });
        },
        startSpan: (name, attributes = {}) => {
          const recorded: (typeof spans)[number] = {
            name,
            attributes,
          };
          spans.push(recorded);
          return {
            traceId: "0".repeat(32),
            spanId: "0".repeat(16),
            end: (input = {}) => {
              recorded.endInput = input;
            },
          };
        },
        flush: async () => {
          flushes += 1;
        },
      },
    });
    boundary.markRunning();
    const hostileReason = new Proxy(
      { privateValue: sentinel },
      {
        get: () => {
          throw new Error(sentinel);
        },
        getPrototypeOf: () => {
          throw new Error(sentinel);
        },
      },
    );

    runtime.emit("unhandledRejection", hostileReason);
    expect(await runtime.exit).toBe(1);

    expect(logs).toHaveLength(1);
    expect(logs[0]!.attributes).toMatchObject({
      errorClass: "ApiFatalOperationError",
      errorCode: "api_unhandled_rejection",
      origin: "api",
      phase: "running",
      reasonKind: "object",
      correlationId: "api-fatal.test-unhandled",
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "api.process.fatal",
      attributes: logs[0]!.attributes,
      endInput: { error: true },
    });
    expect(flushes).toBe(1);
    expect(runtime.exits).toEqual([1]);
    expect(JSON.stringify({ logs, spans })).not.toContain(sentinel);

    boundary.dispose();
    expect(runtime.listeners.size).toBe(0);
  });

  test("uses a safe startup fallback when observability is not available", async () => {
    const sentinel = "API_STARTUP_PRIVATE_SENTINEL_2aa957";
    const runtime = fakeProcess();
    const fallbackLogs: string[] = [];
    const boundary = installApiFatalProcessBoundary({
      process: runtime.process,
      correlationId: () => `private correlation ${sentinel}`,
      fallbackLog: (message) => fallbackLogs.push(message),
    });

    await boundary.reportStartupFailure(`private startup failure ${sentinel}`);

    expect(runtime.exits).toEqual([1]);
    expect(fallbackLogs).toHaveLength(1);
    expect(fallbackLogs[0]).toContain("api_startup_failed");
    expect(fallbackLogs[0]).toContain("phase=startup");
    expect(fallbackLogs[0]).toContain("reason_kind=string");
    expect(fallbackLogs[0]).toContain("correlation_id=api-fatal.fallback");
    expect(fallbackLogs[0]).not.toContain(sentinel);
  });

  test("bounds a hung telemetry flush and reports only the first fatal event", async () => {
    const runtime = fakeProcess();
    const logs: Array<{ message: string; attributes: Attributes }> = [];
    const boundary = installApiFatalProcessBoundary({
      process: runtime.process,
      flushTimeoutMs: 5,
      correlationId: () => "api-fatal.test-timeout",
      observability: {
        error: (message, attributes = {}) => logs.push({ message, attributes }),
        startSpan: () => ({
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
          end: () => undefined,
        }),
        flush: async () => await new Promise<void>(() => undefined),
      },
    });

    runtime.emit("uncaughtException", new Error("first private failure"));
    runtime.emit("unhandledRejection", new Error("second private failure"));
    const exitCode = await Promise.race([
      runtime.exit,
      Bun.sleep(200).then(() => {
        throw new Error("fatal boundary did not exit after the flush deadline");
      }),
    ]);

    expect(exitCode).toBe(1);
    expect(runtime.exits).toEqual([1]);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.attributes).toMatchObject({
      errorCode: "api_uncaught_exception",
      phase: "startup",
      reasonKind: "error",
    });
    expect(JSON.stringify(logs)).not.toContain("private failure");
    boundary.dispose();
  });
});
