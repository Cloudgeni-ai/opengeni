import { describe, expect, spyOn, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import {
  AnthropicRequestSizeError,
  CompactionNeededError,
  CompactionProviderResponseError,
  EmptyCompactionSummaryError,
  findCompactionNeededError,
} from "@opengeni/runtime";
import {
  logContextCompactionFailure,
  logContextCompactionRequest,
} from "../src/activities/agent-turn/compaction-diagnostics";

const identity = { sessionId: "private-session", turnId: "private-turn" };
const settings = {
  serviceName: "opengeni",
  environment: "test",
  observabilityStructuredLogs: true,
  observabilityMetricsEnabled: false,
};

function captureLogs(run: (observability: ReturnType<typeof createObservability>) => void) {
  const lines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((method) =>
    spyOn(console, method).mockImplementation((line) => {
      lines.push(String(line));
    }),
  );
  try {
    run(createObservability(settings, { component: "worker-turn" }));
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines.map((line) => JSON.parse(line));
}

describe("compaction diagnostics through the real log projection", () => {
  for (const trigger of ["threshold", "operator"] as const) {
    test(`${trigger} compaction is an informational transition with its actual signal`, () => {
      const needed = new CompactionNeededError({
        signalTokens: 251_000,
        thresholdTokens: 250_000,
        signalSource: "provider",
        trigger,
      });
      const [record] = captureLogs((obs) =>
        logContextCompactionRequest(obs, {
          ...identity,
          reason: trigger === "operator" ? "operator" : "proactive",
          compactionNeeded: findCompactionNeededError(new Error("SDK wrapper", { cause: needed })),
          requestSizeError: null,
        }),
      );
      expect(record).toMatchObject({
        level: "info",
        message: "context compaction requested",
        signalSource: "provider",
        signalTokens: 251_000,
        thresholdTokens: 250_000,
        reason: trigger === "operator" ? "operator" : "proactive",
      });
      expect(record).not.toHaveProperty("errorCode");
      expect(record).not.toHaveProperty("errorClass");
      expect(JSON.stringify(record)).not.toContain("private-");
    });
  }

  test("history footprint requests retain the dimension and measured counts", () => {
    const [record] = captureLogs((obs) =>
      logContextCompactionRequest(obs, {
        ...identity,
        reason: "proactive",
        requestSizeError: null,
        compactionNeeded: new CompactionNeededError({
          signalTokens: 0,
          thresholdTokens: 250_000,
          signalSource: "history_footprint",
          historyFootprint: { dimension: "json_nodes", actual: 600, threshold: 500 },
        }),
      }),
    );
    expect(record).toMatchObject({
      level: "info",
      signalSource: "history_footprint",
      historyFootprintDimension: "json_nodes",
      historyFootprintActual: 600,
      historyFootprintThreshold: 500,
    });
  });

  test("context overflow and request-byte refusal remain distinct warnings", () => {
    const size = {
      requestBytes: 120,
      limitBytes: 100,
      imageCount: 2,
      imageBase64Bytes: 80,
      systemBytes: 10,
      toolsBytes: 20,
    };
    const records = captureLogs((obs) => {
      for (const requestSizeError of [null, new AnthropicRequestSizeError(size, "preflight")]) {
        logContextCompactionRequest(obs, {
          ...identity,
          reason: "overflow",
          compactionNeeded: null,
          requestSizeError,
        });
      }
    });
    expect(records[0]).toMatchObject({
      level: "warn",
      reason: "overflow",
      errorCode: "model_context_window_exceeded",
    });
    expect(records[1]).toMatchObject({
      level: "warn",
      reason: "overflow",
      errorCode: "model_request_size_exceeded",
      ...size,
    });
    expect(JSON.stringify(records)).not.toContain("worker_operation_failed");
  });

  test("checkpoint failures retain their cause and diagnostic correlation without provider text", () => {
    const records = captureLogs((obs) => {
      for (const error of [
        new CompactionProviderResponseError(
          { httpStatus: 400 },
          new Error("private-provider-body"),
        ),
        new EmptyCompactionSummaryError({ stage: "checkpoint_response" }),
      ])
        logContextCompactionFailure(obs, { ...identity, error });
    });
    expect(records[0]).toMatchObject({
      level: "error",
      errorCode: "compaction_provider_request_failed",
      status: 400,
      failureKind: "CompactionProviderResponseError",
    });
    expect(records[1]).toMatchObject({
      level: "error",
      errorCode: "compaction_summary_empty",
      failureKind: "EmptyCompactionSummaryError",
    });
    for (const record of records) expect(record.failureDiagnosticId).toBeString();
    expect(JSON.stringify(records)).not.toContain("private-");
  });

  test("the stream uses the diagnostic boundary without passing the control signal as an error", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    ).text();
    expect(source).toContain("logContextCompactionRequest(observability, {");
    expect(source).toContain("logContextCompactionFailure(observability, {");
    expect(source).not.toContain("...safeErrorDiagnostic(attemptError)");
  });
});
