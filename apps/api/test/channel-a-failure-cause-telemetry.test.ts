// An "unexpected" Channel-A failure must say which component refused it. A
// browser resume on a Connected Machine once failed with only reason
// "unexpected" and a generic 500, with no persisted cause anywhere.
import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { createObservability } from "@opengeni/observability";
import { BrowserControlRequestError } from "@opengeni/runtime/sandbox";
import { observeChannelAOperationFailure, type ChannelAServices } from "../src/sandbox/channel-a";

function observedLines(
  error: unknown,
  operation = "browser.resume",
): { warnings: Record<string, unknown>[]; metrics: () => Promise<string> } {
  const observed: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => observed.push(String(message));
  let metrics: () => Promise<string> = async () => "";
  try {
    const obs = createObservability(
      {
        serviceName: "opengeni",
        environment: "test",
        deploymentRevision: "revision-test",
        observabilityStructuredLogs: true,
        observabilityMetricsEnabled: true,
        observabilityOtlpHeaders: "",
      },
      { component: "api", now: () => 1 },
    );
    observeChannelAOperationFailure({ observability: obs } as unknown as ChannelAServices, {
      workspaceId: "1f9c9a34-0c7f-4f8f-9d64-0f2f7f4f2f11",
      sandboxGroupId: "2f9c9a34-0c7f-4f8f-9d64-0f2f7f4f2f22",
      backend: "selfhosted",
      operation,
      durationMs: 498,
      error,
    });
    metrics = () => obs.prometheusMetrics();
  } finally {
    console.warn = warn;
  }
  return {
    warnings: observed.map((line) => JSON.parse(line) as Record<string, unknown>),
    metrics,
  };
}

function observedWarnings(error: unknown, operation = "browser.resume"): Record<string, unknown>[] {
  return observedLines(error, operation).warnings;
}

describe("Channel-A failure cause telemetry", () => {
  test("a controller's own 4xx refusal is counted as rejected, not as an unexpected 500", async () => {
    const stale = new BrowserControlRequestError(409, {
      code: "target_stale",
      message: "computer target changed",
      retryable: false,
    });
    const { warnings, metrics: render } = observedLines(stale, "computer.read");
    expect(warnings).toEqual([]);
    const failures = (await render())
      .split("\n")
      .filter((line) => line.startsWith("opengeni_channel_a_operation_failures_total{"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(
      'backend="selfhosted",op="computer.read",reason="request_rejected",status="409"',
    );
    expect(failures[0]).toEndWith(" 1");
  });

  test("an unexpected browser resume failure names the controller refusal", () => {
    const refusal = new BrowserControlRequestError(500, {
      code: "driver_failed",
      message: "profile /home/user/.config/browser failed",
      retryable: false,
    });
    const [line] = observedWarnings(refusal);
    expect(line).toMatchObject({
      message: "Channel-A operation failed",
      op: "browser.resume",
      reason: "unexpected",
      causeName: "BrowserControlRequestError",
      causeCode: "driver_failed",
      causeStatus: 500,
    });
    expect(JSON.stringify(line)).not.toContain("/home/user");
  });

  test("a plain programming error is still identified by its class only", () => {
    const [line] = observedWarnings(new TypeError("cannot read secret of undefined"));
    expect(line).toMatchObject({ reason: "unexpected", causeName: "TypeError" });
    expect(JSON.stringify(line)).not.toContain("secret");
  });

  test("a wrapping 500 is looked through to its cause", () => {
    const wrapped = new HTTPException(500, {
      message: "BrowserSession request failed",
      cause: Object.assign(new Error("permission denied for table"), {
        name: "PostgresError",
        code: "42501",
      }),
    });
    const [line] = observedWarnings(wrapped, "computer.action");
    expect(line).toMatchObject({
      op: "computer.action",
      reason: "unexpected",
      causeName: "PostgresError",
      causeSqlState: "42501",
    });
  });
});
