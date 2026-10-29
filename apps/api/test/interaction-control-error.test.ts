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
import { ApiHttpError } from "../src/http/api-error";
import { browserRouteError } from "../src/routes/browser-sessions";
import {
  INTERACTION_ACTION_DEADLINE_ERROR_DETAIL_CODE,
  interactionActionDeadlineApiError,
  interactionControlApiError,
  interactionControlRequestFor,
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
      "live_view",
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
      "live_view",
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
        "live_view",
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

  test("names the action or request that failed instead of the live view", () => {
    const timeout = (overrides: Partial<ConstructorParameters<typeof SelfhostedControlError>[0]>) =>
      controlError(AgentErrorCode.ERROR_CODE_TIMEOUT, { retryable: true, ...overrides });
    expect(interactionControlRequestFor("browser.action")).toBe("action");
    expect(interactionControlRequestFor("computer.action")).toBe("action");
    expect(interactionControlRequestFor("browser.attach")).toBe("live_view");
    expect(interactionControlRequestFor("computer.attach")).toBe("live_view");
    expect(interactionControlRequestFor("browser.read")).toBe("read");
    expect(interactionControlRequestFor("computer.read")).toBe("read");
    expect(interactionControlRequestFor("browser.control")).toBe("request");
    expect(interactionControlRequestFor("computer.end")).toBe("request");
    expect(interactionControlRequestFor("browser.create")).toBe("open");
    expect(interactionControlRequestFor("computer.create")).toBe("open");

    // A click that reached the machine and got no answer may have happened.
    const click = browserRouteError(timeout({ neverSent: false }), "action") as ApiHttpError;
    expect(click.status).toBe(504);
    expect(click.message).toBe(
      "The connected machine did not answer this browser action in time, so whether it ran is unknown. Check the page before doing anything again; do not repeat the action automatically.",
    );
    expect(click.outcomeUnknown).toBe(true);
    expect(click.details?.controlFailureCode).toBe("timeout");
    // One that never left the API did not.
    const unsent = browserRouteError(timeout({ neverSent: true }), "action") as ApiHttpError;
    expect(unsent.message).toBe(
      "The connected machine did not answer in time, so this browser action was not sent. It is safe to retry.",
    );
    expect(unsent.outcomeUnknown).toBe(false);
    const computerClick = interactionControlApiError(
      timeout({ neverSent: false }),
      "computer",
      "action",
    );
    expect(computerClick?.message).toBe(
      "The connected machine did not answer this computer action in time, so whether it ran is unknown. Check the window before doing anything again; do not repeat the action automatically.",
    );
    // Other requests name themselves too, and nothing mentions a live view
    // that was never involved.
    const opened = browserRouteError(timeout({ neverSent: false })) as ApiHttpError;
    expect(opened.message).toBe(
      "The connected machine did not answer this browser request in time, so whether it ran is unknown. Check the browser before repeating it.",
    );
    expect(opened.outcomeUnknown).toBe(true);
    for (const code of [
      AgentErrorCode.ERROR_CODE_UNSUPPORTED,
      AgentErrorCode.ERROR_CODE_OS,
      AgentErrorCode.ERROR_CODE_NOT_FOUND,
      AgentErrorCode.ERROR_CODE_CONSENT_REQUIRED,
      AgentErrorCode.ERROR_CODE_TIMEOUT,
      AgentErrorCode.ERROR_CODE_DRAINING,
      AgentErrorCode.ERROR_CODE_PROTOCOL,
      AgentErrorCode.ERROR_CODE_STREAM,
      AgentErrorCode.ERROR_CODE_AGENT_OFFLINE,
      AgentErrorCode.ERROR_CODE_FENCED,
      AgentErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
      AgentErrorCode.ERROR_CODE_UNSPECIFIED,
    ]) {
      for (const request of ["action", "read", "open", "request"] as const) {
        const projected = interactionControlApiError(controlError(code), "browser", request)!;
        expect(projected.message).not.toContain("live view");
        expect(projected.message).not.toContain("PRIVATE");
        // The live view keeps its own wording.
        expect(
          interactionControlApiError(controlError(code), "browser", "live_view")!.message,
        ).toContain("live view");
      }
    }
  });

  test("says whether a timed-out request may have run and when repeating it is safe", () => {
    const timeout = (neverSent: boolean) =>
      controlError(AgentErrorCode.ERROR_CODE_TIMEOUT, { retryable: true, neverSent });
    // A request that reached the machine (opening a tab, ending a session)
    // may have run.
    const sent = interactionControlApiError(timeout(false), "computer", "request")!;
    expect(sent.message).toBe(
      "The connected machine did not answer this computer request in time, so whether it ran is unknown. Check the screen before repeating it.",
    );
    expect(sent.outcomeUnknown).toBe(true);
    // One that never left the API did not.
    const unsent = interactionControlApiError(timeout(true), "browser", "request")!;
    expect(unsent.message).toBe(
      "The connected machine did not answer in time, so this browser request was not sent. It is safe to retry.",
    );
    expect(unsent.outcomeUnknown).toBe(false);
    // A read changes nothing, sent or not.
    for (const neverSent of [false, true]) {
      const read = interactionControlApiError(timeout(neverSent), "browser", "read")!;
      expect(read.message).toBe(
        "The connected machine did not answer this browser request in time. It only reads, so it is safe to retry.",
      );
      expect(read.outcomeUnknown).toBe(false);
      expect(read.retryable).toBe(true);
    }
  });

  test("a missing controller or missing screen access names the next step", () => {
    const notFound = controlError(AgentErrorCode.ERROR_CODE_NOT_FOUND);
    expect(interactionControlApiError(notFound, "browser", "action")!.message).toBe(
      "The connected machine's browser controller is not running, so this browser action could not run. Open the browser again with browser_open, then look at the page before repeating it.",
    );
    expect(interactionControlApiError(notFound, "computer", "read")!.message).toBe(
      "The connected machine's screen controller is not running, so this computer request could not run. Open the computer again with computer_open, then look at the screen before repeating it.",
    );
    // Opening is the request that failed, so its next step is not "open it
    // again with browser_open": one more try, then the agent.
    const failedOpen = browserRouteError(notFound, "open") as ApiHttpError;
    expect(failedOpen.status).toBe(404);
    expect(failedOpen.message).toBe(
      "The connected machine's browser controller stopped while the browser was opening. Open it once more; if that fails too, restart the Opengeni agent on that machine.",
    );
    expect(interactionControlApiError(notFound, "computer", "open")!.message).toBe(
      "The connected machine's screen controller stopped while the computer was opening. Open it once more; if that fails too, restart the Opengeni agent on that machine.",
    );
    expect(failedOpen.message).not.toContain("browser_open");
    // An agent without a browser controller (none was installed beside it, or
    // one too old) reports the request unsupported: the next step is the
    // agent, never opening the browser again.
    const unsupported = controlError(AgentErrorCode.ERROR_CODE_UNSUPPORTED);
    for (const request of ["open", "action", "read", "request"] as const) {
      const projected = interactionControlApiError(unsupported, "browser", request)!;
      expect(projected.status).toBe(409);
      expect(projected.message).not.toContain("browser_open");
    }
    expect(interactionControlApiError(unsupported, "browser", "open")!.message).toBe(
      "This connected machine's Opengeni agent cannot run this browser request: its browser controller is missing or too old. Update or reinstall the agent on that machine; retrying will not help until then.",
    );
    expect(interactionControlApiError(unsupported, "computer", "action")!.message).toBe(
      "This connected machine does not support this computer action.",
    );
    const consent = interactionControlApiError(
      controlError(AgentErrorCode.ERROR_CODE_CONSENT_REQUIRED),
      "computer",
      "action",
    )!;
    expect(consent.status).toBe(403);
    expect(consent.message).toBe(
      "Screen access is not enabled on this connected machine, so this computer action could not run. Turn screen control on with connected_machine_enable_screen_control; on a Mac, the person must also allow Opengeni under Privacy & Security in System Settings.",
    );
  });

  test("omits malformed inner correlation instead of reflecting it", () => {
    const projected = interactionControlApiError(
      controlError(AgentErrorCode.ERROR_CODE_STREAM, {
        controlRequestId: "<script>private</script>",
      }),
      "browser",
      "live_view",
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
