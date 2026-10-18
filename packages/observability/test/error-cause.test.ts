import { describe, expect, test } from "bun:test";
import { InteractionError } from "@opengeni/contracts";
import { createObservability, errorCauseAttributes, PUBLIC_INTERACTION_ERROR_CODES } from "../src";

const settings = {
  serviceName: "opengeni",
  environment: "test",
  deploymentRevision: "revision-test",
  observabilityStructuredLogs: true,
  observabilityMetricsEnabled: true,
  observabilityOtlpHeaders: "",
};

class BrowserControlRequestError extends Error {
  readonly name = "BrowserControlRequestError";
  constructor(
    readonly status: number,
    readonly error: { code: string; message: string; retryable: boolean },
  ) {
    super(error.message);
  }
}

class SelfhostedControlError extends Error {
  readonly name = "SelfhostedControlError";
  constructor(readonly code: number) {
    super("agent refused /private/path/secret");
  }
}

class HTTPException extends Error {
  constructor(
    readonly status: number,
    options: { message: string; cause: unknown },
  ) {
    super(options.message, { cause: options.cause });
  }
}

function capture(run: (obs: ReturnType<typeof createObservability>) => void): string[] {
  const observed: string[] = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (message?: unknown) => observed.push(String(message));
  console.error = (message?: unknown) => observed.push(String(message));
  try {
    run(createObservability(settings, { component: "api", now: () => 1 }));
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return observed;
}

describe("error cause classification", () => {
  test("names the controller refusal underneath a route's 500 wrapper", () => {
    const refusal = new BrowserControlRequestError(503, {
      code: "resource_unavailable",
      message: "working copy /home/user/profile is unavailable",
      retryable: false,
    });
    const wrapped = new HTTPException(500, {
      message: "BrowserSession request failed",
      cause: refusal,
    });
    expect(errorCauseAttributes(wrapped)).toEqual({
      causeName: "BrowserControlRequestError",
      causeCode: "resource_unavailable",
      causeStatus: 503,
    });
  });

  test("keeps only the agent's enum number for a connected-machine failure", () => {
    expect(errorCauseAttributes(new SelfhostedControlError(2))).toEqual({
      causeName: "SelfhostedControlError",
      causeAgentCode: 2,
    });
  });

  test("keeps a SQLSTATE but never the database message", () => {
    const error = Object.assign(new Error("relation secret_table denied"), {
      name: "PostgresError",
      code: "42501",
    });
    expect(errorCauseAttributes(error)).toEqual({
      causeName: "PostgresError",
      causeSqlState: "42501",
    });
  });

  test("an unreviewed class or code contributes nothing", () => {
    const sentinel = "SECRET_SENTINEL_9d1";
    const Secret = class SECRET_SENTINEL_9d1 extends Error {};
    expect(errorCauseAttributes(Object.assign(new Secret(sentinel), { code: sentinel }))).toEqual(
      {},
    );
    const odd = new BrowserControlRequestError(700, {
      code: sentinel,
      message: sentinel,
      retryable: false,
    });
    expect(errorCauseAttributes(odd)).toEqual({ causeName: "BrowserControlRequestError" });
    expect(errorCauseAttributes("plain string")).toEqual({});
  });

  test("the reviewed controller codes are exactly the contract's closed codes", () => {
    expect([...PUBLIC_INTERACTION_ERROR_CODES].sort()).toEqual(
      [...InteractionError.shape.code.options].sort(),
    );
  });

  test("Channel-A and HTTP failure logs carry the reviewed cause and the browser operation", () => {
    const sentinel = "DIAGNOSTIC_VALUE_SENTINEL_77aa";
    const lines = capture((obs) => {
      obs.warn("Channel-A operation failed", {
        errorClass: "SandboxChannelAOperationError",
        errorCode: "sandbox_channel_a_operation_failed",
        origin: "api",
        op: "browser.resume",
        reason: "unexpected",
        outcome: "failed",
        causeName: "BrowserControlRequestError",
        causeCode: "resource_unavailable",
        causeStatus: 503,
      });
      obs.error("HTTP request failed", {
        errorClass: "HttpOperationError",
        errorCode: "internal_error",
        origin: "api",
        method: "POST",
        route: "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/resume",
        causeName: "SelfhostedControlError",
        causeAgentCode: 2,
      });
      obs.warn("Channel-A operation failed", {
        errorClass: "SandboxChannelAOperationError",
        causeName: sentinel,
        causeCode: sentinel,
        causeAgentCode: 4096,
        causeStatus: Number.NaN,
        causeSqlState: sentinel,
      });
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      op: "browser.resume",
      reason: "unexpected",
      causeName: "BrowserControlRequestError",
      causeCode: "resource_unavailable",
      causeStatus: 503,
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      causeName: "SelfhostedControlError",
      causeAgentCode: 2,
    });
    expect(lines[2]).not.toContain(sentinel);
    for (const key of ["causeName", "causeCode", "causeAgentCode", "causeStatus", "causeSqlState"])
      expect(JSON.parse(lines[2]!)).not.toHaveProperty(key);
  });
});
