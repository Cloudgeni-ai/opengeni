import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  for (const structured of [true, false]) {
    test(`logs a real rejection with no diagnostic exporter (structured=${structured})`, async () => {
      const temp = mkdtempSync(join(tmpdir(), "SECRET_BUNDLE_ROOT_CANARY-"));
      try {
        const bundle = join(temp, "apps/api/dist/process");
        mkdirSync(bundle, { recursive: true });
        writeFileSync(join(bundle, "chunk-abcd1234.js"), "export const valid = true;\n");
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "-e",
            `
        import { createObservability } from "@opengeni/observability";
        import { installApiFatalProcessBoundary } from "./src/fatal-process-boundary";
        const bundle = ${JSON.stringify(bundle)};
        process.argv[1] = bundle + "/index.js";
        const observability = createObservability({
          serviceName: "test", environment: "test", observabilityStructuredLogs: ${structured},
          observabilityMetricsEnabled: true, observabilityOtlpHeaders: "",
        }, { component: "api" });
        const boundary = installApiFatalProcessBoundary({ observability });
        boundary.markRunning();
        const reason = new TypeError("Bearer SECRET_MESSAGE_CANARY");
        reason.code = "ERR_INVALID_ARG_TYPE";
        reason.stack = [
          reason.toString(),
          "    at " + bundle + "/chunk-missing0.js:1:1",
          "    at EXTRA_PRIVATE_CONTEXT (/private/SECRET_PATH_CANARY.ts:1:1)",
          "    at SECRET_FUNCTION_CANARY (/private/SECRET_PREFIX_CANARY/apps/api/dist/process/index.js:400:2)",
          "    at " + bundle + "/chunk-abcd1234.js:401:3",
          "    at /private/apps/api/dist/process/index.js:402:4",
          "    at /private/apps/api/dist/process/index.js:403:5",
        ].join("\\n");
        Promise.reject(reason);
      `,
          ],
          { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode).toBe(1);
        expect(stdout + stderr).not.toContain("CANARY");
        expect(stderr.trim().split("\n")).toHaveLength(1);
        const record = structured ? JSON.parse(stderr) : { message: stderr };
        expect(record.message).toMatch(
          /api_unhandled_rejection; phase=running; reason_kind=error; correlation_id=[0-9a-f-]{36}\)/,
        );
        expect(record.message).toContain("cause_class=TypeError; cause_code=ERR_INVALID_ARG_TYPE;");
        expect(record.message).toContain(
          "cause_frames=apps/api/dist/process/index.js:400:2,apps/api/dist/process/chunk-abcd1234.js:401:3,apps/api/dist/process/index.js:402:4",
        );
        expect(record.message).not.toContain(":403:5");
        if (structured) expect(record.message).toContain(`correlation_id=${record.correlationId}`);
      } finally {
        rmSync(temp, { recursive: true });
      }
    });
  }

  test("passes the original cause to the protected diagnostic boundary before flushing and exiting", async () => {
    const runtime = fakeProcess();
    const source = new TypeError("SECRET_CANARY", { cause: new Error("nested SECRET_CANARY") });
    const steps: string[] = [];
    const boundary = installApiFatalProcessBoundary({
      process: runtime.process,
      observability: {
        recordFailureDiagnostic: (input) => {
          expect(input.error).toBe(source);
          expect(input.stage).toBe("startup");
          steps.push("capture");
          return "protected-diagnostic-id";
        },
        error: (message, attributes) => {
          expect(message).not.toContain("SECRET_CANARY");
          expect(attributes?.correlationId).toBe("protected-diagnostic-id");
          steps.push("public");
        },
        startSpan: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), end: () => {} }),
        flush: async () => {
          steps.push("flush");
        },
      },
    });
    await boundary.reportStartupFailure(source);
    expect(steps).toEqual(["capture", "public", "flush"]);
    expect(runtime.exits).toEqual([1]);
  });
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

  test("preserves reviewed fallback frames but never copies unknown class names or codes", async () => {
    const runtime = fakeProcess();
    const fallbackLogs: string[] = [];
    const boundary = installApiFatalProcessBoundary({
      process: runtime.process,
      fallbackLog: (message) => fallbackLogs.push(message),
    });
    const reason = Object.assign(new Error("SECRET_MESSAGE_CANARY"), {
      name: "SecretNameCanary",
      code: "SECRET_CODE_CANARY",
      stack: "Error: SECRET_STACK_CANARY\n    at /app/apps/api/src/index.ts:55:2",
    });

    await boundary.reportStartupFailure(reason);

    expect(runtime.exits).toEqual([1]);
    expect(fallbackLogs).toHaveLength(1);
    expect(fallbackLogs[0]).toContain("cause_class=Error; cause_code=unknown;");
    expect(fallbackLogs[0]).toContain("cause_frames=apps/api/src/index.ts:55:2");
    expect(fallbackLogs[0]).not.toMatch(/canary/i);
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

  test("survives an unhandled rejection that only reports a lost database connection while running", async () => {
    const runtime = fakeProcess();
    const warnings: Array<{ message: string; attributes: Attributes }> = [];
    const errors: string[] = [];
    const counters: string[] = [];
    const boundary = installApiFatalProcessBoundary({
      process: runtime.process,
      observability: {
        error: (message) => {
          errors.push(message);
        },
        warn: (message, attributes = {}) => {
          warnings.push({ message, attributes });
        },
        incrementCounter: (input) => {
          counters.push(input.name);
        },
        startSpan: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), end: () => {} }),
        flush: async () => undefined,
      },
    });
    boundary.markRunning();
    const terminated = Object.assign(new Error("Failed query: claim private sentinel"), {
      name: "DrizzleQueryError",
      cause: Object.assign(new Error("terminating connection due to administrator command"), {
        name: "PostgresError",
        code: "57P01",
      }),
    });

    runtime.emit("unhandledRejection", terminated);
    runtime.emit(
      "unhandledRejection",
      Object.assign(new Error("write CONNECTION_CLOSED 10.0.0.4:5432"), {
        code: "CONNECTION_CLOSED",
        errno: "CONNECTION_CLOSED",
        address: ["10.0.0.4"],
      }),
    );
    await Bun.sleep(20);

    expect(runtime.exits).toEqual([]);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.attributes).toMatchObject({
      errorCode: "api_unhandled_database_connection_loss",
      reasonKind: "error",
    });
    expect(JSON.stringify(warnings)).not.toContain("private sentinel");
    expect(counters).toEqual([
      "opengeni_api_recovered_rejections_total",
      "opengeni_api_recovered_rejections_total",
    ]);

    // Any other unhandled rejection still terminates the process.
    runtime.emit("unhandledRejection", new TypeError("unexpected"));
    expect(await runtime.exit).toBe(1);
    boundary.dispose();
  });

  test("still exits for a lost database connection during startup and for uncaught exceptions", async () => {
    const startup = fakeProcess();
    const startupBoundary = installApiFatalProcessBoundary({
      process: startup.process,
      fallbackLog: () => undefined,
    });
    startup.emit("unhandledRejection", Object.assign(new Error("x"), { code: "57P01" }));
    expect(await startup.exit).toBe(1);
    startupBoundary.dispose();

    const running = fakeProcess();
    const runningBoundary = installApiFatalProcessBoundary({
      process: running.process,
      fallbackLog: () => undefined,
    });
    runningBoundary.markRunning();
    running.emit("uncaughtException", Object.assign(new Error("x"), { code: "57P01" }));
    expect(await running.exit).toBe(1);
    runningBoundary.dispose();

    // The same transport code from another service (here NATS) is not survivable.
    const nats = fakeProcess();
    const natsBoundary = installApiFatalProcessBoundary({
      process: nats.process,
      fallbackLog: () => undefined,
    });
    natsBoundary.markRunning();
    nats.emit(
      "unhandledRejection",
      Object.assign(new Error("closed"), { name: "NatsError", code: "CONNECTION_CLOSED" }),
    );
    expect(await nats.exit).toBe(1);
    natsBoundary.dispose();
  });
});
