// An "unexpected" Channel-A failure must say which component refused it. A
// browser resume on a Connected Machine once failed with only reason
// "unexpected" and a generic 500, with no persisted cause anywhere.
import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { createObservability } from "@opengeni/observability";
import { BrowserControlRequestError } from "@opengeni/runtime/sandbox";
import { observeChannelAOperationFailure, type ChannelAServices } from "../src/sandbox/channel-a";

function observedWarnings(error: unknown, operation = "browser.resume"): Record<string, unknown>[] {
  const observed: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => observed.push(String(message));
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
  } finally {
    console.warn = warn;
  }
  return observed.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Channel-A failure cause telemetry", () => {
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
