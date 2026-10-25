import { describe, expect, test } from "bun:test";
import { ErrorCode as AgentErrorCode } from "@opengeni/agent-proto";
import {
  BrowserControlActionDeadlineError,
  BrowserControlRequestError,
  BrowserControlTransportError,
  SelfhostedControlError,
} from "@opengeni/runtime/sandbox";
import { testSettings } from "@opengeni/testing/settings";
import { HTTPException } from "hono/http-exception";
import { createApp } from "../src/app";
import {
  INTERACTION_ACTION_DEADLINE_ERROR_DETAIL_CODE,
  interactionActionDeadlineApiError,
  interactionControlApiError,
  legacyInteractionCapacityError,
  legacyInteractionCapacityFailure,
  publicControlFailureCode,
} from "../src/http/interaction-control-error";

function controlError(
  code: AgentErrorCode,
  overrides: Partial<ConstructorParameters<typeof SelfhostedControlError>[0]> = {},
): SelfhostedControlError {
  return new SelfhostedControlError({
    message: "PRIVATE /home/user/token=secret",
    code,
    reason: null,
    retryable: false,
    controlRequestId: "inner-request-42",
    detail: { path: "/home/user/private", token: "secret" },
    ...overrides,
  });
}

describe("connected-machine interaction control errors", () => {
  test("keeps every wire class machine-readable", () => {
    expect(publicControlFailureCode(AgentErrorCode.ERROR_CODE_STREAM)).toBe("stream");
    expect(publicControlFailureCode(AgentErrorCode.ERROR_CODE_OS)).toBe("os");
    expect(publicControlFailureCode(AgentErrorCode.ERROR_CODE_UNSPECIFIED)).toBe("unknown");
  });

  test("projects stream failures without exposing local detail", () => {
    const projected = interactionControlApiError(
      controlError(AgentErrorCode.ERROR_CODE_STREAM),
      "browser",
    );
    expect(projected).not.toBeNull();
    expect(projected!.status).toBe(502);
    expect(projected!.code).toBe("upstream_unavailable");
    expect(projected!.retryable).toBe(false);
    expect(projected!.outcomeUnknown).toBe(false);
    expect(projected!.details).toEqual({
      interactionLayer: "connected_machine",
      interactionSurface: "browser",
      controlFailureCode: "stream",
      controlRequestId: "inner-request-42",
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE");
    expect(JSON.stringify(projected)).not.toContain("/home/user");
    expect(JSON.stringify(projected)).not.toContain("secret");
  });

  test("projects an offline Channel-A preflight preserved as an HTTP cause", () => {
    const inner = controlError(AgentErrorCode.ERROR_CODE_AGENT_OFFLINE, {
      reason: "agent_offline",
      agentOffline: true,
      neverSent: true,
      controlRequestId: null,
    });
    const projected = interactionControlApiError(
      new HTTPException(409, {
        message: "Connected Machine has no live runner connection",
        cause: inner,
      }),
      "browser",
    );
    expect(projected).not.toBeNull();
    expect(projected!.status).toBe(503);
    expect(projected!.retryable).toBe(false);
    expect(projected!.outcomeUnknown).toBe(false);
    expect(projected!.details).toEqual({
      interactionLayer: "connected_machine",
      interactionSurface: "browser",
      controlFailureCode: "agent_offline",
    });
  });

  test("preserves timeout uncertainty and both correlation layers in the API envelope", async () => {
    const app = createApp({
      settings: testSettings(),
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    app.post("/v1/test/control-timeout", () => {
      throw interactionControlApiError(
        controlError(AgentErrorCode.ERROR_CODE_TIMEOUT, {
          reason: "agent_reconnecting",
          retryable: true,
          neverSent: false,
        }),
        "computer",
      )!;
    });

    const response = await app.request("http://localhost/v1/test/control-timeout", {
      method: "POST",
      headers: { "x-opengeni-correlation-id": "outer-api-request" },
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: {
        status: 504,
        code: "upstream_unavailable",
        message: "The connected machine did not finish opening the computer live view in time.",
        retryable: true,
        outcomeUnknown: true,
        requestId: "outer-api-request",
        details: {
          interactionLayer: "connected_machine",
          interactionSurface: "computer",
          controlFailureCode: "timeout",
          controlRequestId: "inner-request-42",
        },
      },
    });
  });

  test("omits malformed inner correlation instead of reflecting it", () => {
    const projected = interactionControlApiError(
      controlError(AgentErrorCode.ERROR_CODE_STREAM, {
        controlRequestId: "<script>private</script>",
      }),
      "browser",
    );
    expect(projected?.details).not.toHaveProperty("controlRequestId");
  });
});

describe("action deadline errors", () => {
  const deadline = (surface: "browser" | "computer") =>
    new BrowserControlActionDeadlineError(surface, 182_000, {
      cause: new BrowserControlTransportError("browser controller request transport failed"),
    });

  test("says the action may still be running instead of reporting an outage", async () => {
    const app = createApp({
      settings: testSettings(),
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    app.post("/v1/test/action-deadline", () => {
      // Route helpers may wrap the controller failure as an HTTPException cause.
      throw interactionActionDeadlineApiError(
        new HTTPException(503, {
          message: "browser controller is unavailable",
          cause: deadline("browser"),
        }),
      )!;
    });
    const response = await app.request("http://localhost/v1/test/action-deadline", {
      method: "POST",
      headers: { "x-opengeni-correlation-id": "outer-api-request" },
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: {
        status: 504,
        code: "action_timeout",
        message:
          "The browser action did not finish within its 182-second limit and may still be running in the browser. Check the page before doing anything again; do not repeat the action automatically.",
        retryable: false,
        outcomeUnknown: true,
        requestId: "outer-api-request",
        details: { code: INTERACTION_ACTION_DEADLINE_ERROR_DETAIL_CODE, deadlineMs: 182_000 },
      },
    });
  });

  test("names the window for a computer action", () => {
    const projected = interactionActionDeadlineApiError(deadline("computer"));
    expect(projected?.status).toBe(504);
    expect(projected?.message).toBe(
      "The computer action did not finish within its 182-second limit and may still be running on the computer. Check the window before doing anything again; do not repeat the action automatically.",
    );
  });

  test("leaves ordinary transport failures to the existing mapping", () => {
    const transport = new BrowserControlTransportError("browser controller is not running");
    expect(interactionActionDeadlineApiError(transport)).toBeNull();
    expect(
      interactionActionDeadlineApiError(new HTTPException(503, { cause: transport })),
    ).toBeNull();
  });
});

describe("legacy supervisor capacity errors", () => {
  test("a full supervisor from an older agent becomes an actionable 409, not a retryable outage", () => {
    const legacy = new BrowserControlRequestError(503, {
      code: "resource_unavailable",
      message: "browser supervisor session capacity is exhausted",
      retryable: true,
    });
    const mapped = legacyInteractionCapacityError(legacy, "browser");
    expect(mapped?.status).toBe(409);
    expect(mapped?.message).toContain("End browser sessions that are no longer needed");
    // A failed create records the same definite, non-retryable failure.
    expect(legacyInteractionCapacityFailure(legacy, "browser")).toMatchObject({
      code: "capacity_exhausted",
      retryable: false,
    });
    expect(
      legacyInteractionCapacityError(
        new BrowserControlRequestError(503, {
          code: "resource_unavailable",
          message: "computer supervisor session capacity is exhausted",
          retryable: true,
        }),
        "computer",
      )?.message,
    ).toContain("End computer sessions");
    // Other unavailable resources keep their own mapping.
    expect(
      legacyInteractionCapacityError(
        new BrowserControlRequestError(503, {
          code: "resource_unavailable",
          message: "browser controller is stopping",
          retryable: true,
        }),
        "browser",
      ),
    ).toBeNull();
  });
});
