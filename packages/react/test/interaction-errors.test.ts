import { expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import { isInteractionControlUnavailable } from "../src/lib/interaction-errors";

test.each(["browser", "computer"] as const)(
  "recognizes explicit %s service loss separately from target and OS errors",
  (surface) => {
    for (const code of [
      "agent_offline",
      "draining",
      "os",
      "not_found",
      "unsupported",
      "timeout",
      "fenced",
    ] as const) {
      const error = new OpenGeniApiError(
        503,
        JSON.stringify({
          error: {
            status: 503,
            code: "control_failure",
            message: "Control request failed",
            retryable: true,
            outcomeUnknown: false,
            details: {
              interactionLayer: "connected_machine",
              interactionSurface: surface,
              controlFailureCode: code,
            },
          },
        }),
      );
      const serviceLost = code === "agent_offline" || code === "draining";
      expect(isInteractionControlUnavailable(error)).toBe(serviceLost);
      expect(isInteractionControlUnavailable(error, "observation")).toBe(serviceLost);
    }
  },
);

test("an observation failure or an uncertain mutation does not establish service loss", () => {
  for (const status of [0, 500, 503]) {
    expect(
      isInteractionControlUnavailable(new OpenGeniApiError(status, "Control unavailable")),
    ).toBe(true);
    expect(
      isInteractionControlUnavailable(
        new OpenGeniApiError(status, "App inspection failed"),
        "observation",
      ),
    ).toBe(false);
    expect(
      isInteractionControlUnavailable(
        new OpenGeniApiError(status, "Outcome unknown", { outcomeUnknown: true }),
      ),
    ).toBe(false);
  }
  expect(
    isInteractionControlUnavailable(
      new OpenGeniApiError(504, "Gateway failed", { mutation: true }),
    ),
  ).toBe(false);
  expect(isInteractionControlUnavailable(new OpenGeniApiError(409, "Target changed"))).toBe(false);
  expect(isInteractionControlUnavailable(new Error("AXRaise unsupported"))).toBe(false);
});
