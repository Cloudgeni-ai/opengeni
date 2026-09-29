import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import {
  apiErrorAdvice,
  apiErrorDetails,
  apiErrorFacts,
  isPermissionDenied,
  userErrorText,
} from "./api-error";

const REFERENCE = "bc734e3e-0cde-4331-9b15-03e64bf77695";

function apiError(status: number, message: string, code?: string) {
  return new OpenGeniApiError(
    status,
    JSON.stringify({ error: { message, requestId: REFERENCE, ...(code ? { code } : {}) } }),
    { mutation: false },
  );
}

describe("api errors in product words", () => {
  test("splits the raw message into status, server message and reference", () => {
    const error = apiError(403, "missing permission: workspace:admin");
    expect(error.message).toContain("OpenGeni API 403");
    expect(apiErrorFacts(error)).toEqual({
      status: 403,
      code: undefined,
      reference: REFERENCE,
      serverMessage: "missing permission: workspace:admin",
    });
    expect(apiErrorDetails(error)).toEqual({
      reference: REFERENCE,
      details: [
        { label: "Status", value: "HTTP 403" },
        { label: "Message", value: "missing permission: workspace:admin" },
      ],
    });
  });

  test("reads the reference from a plain message too", () => {
    const facts = apiErrorFacts(new Error(`OpenGeni API 404: not found Reference: ${REFERENCE}.`));
    expect(facts.reference).toBe(REFERENCE);
    expect(facts.serverMessage).toBe("not found");
  });

  test("a 403 or a missing permission is a permission refusal, not a failure", () => {
    expect(isPermissionDenied(apiError(403, "Forbidden"))).toBe(true);
    expect(
      isPermissionDenied(new Error("OpenGeni API 400: missing permission: secrets:read")),
    ).toBe(true);
    expect(isPermissionDenied(apiError(500, "boom"))).toBe(false);
    expect(isPermissionDenied(new Error("missing permission is a phrase in my own copy"))).toBe(
      false,
    );
  });

  test("advice never repeats the raw API string", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 503]) {
      const advice = apiErrorAdvice(apiError(status, "OPENGENI_SECRET_KEY is required"));
      expect(advice).not.toContain("OpenGeni API");
      expect(advice).not.toContain(REFERENCE);
      expect(advice).not.toContain("OPENGENI_SECRET_KEY");
    }
  });

  test("a short validation message is what happened", () => {
    expect(apiErrorAdvice(apiError(422, "URL must use https"))).toBe("URL must use https.");
    expect(apiErrorAdvice(apiError(422, '[{"code":"invalid_string"}]'))).toBe(
      "Check what you entered and try again.",
    );
    const bareCode = Object.assign(new Error("invalid_transaction"), { status: 400 });
    expect(apiErrorAdvice(bareCode)).toBe("Check what you entered and try again.");
    expect(apiErrorAdvice(apiError(422, "field redirect_uri is not allowed"))).toBe(
      "Check what you entered and try again.",
    );
  });

  test("keeps the app's own messages and maps network failures", () => {
    expect(userErrorText(new Error("Pick a workspace first."))).toBe("Pick a workspace first.");
    expect(userErrorText(new TypeError("Failed to fetch"))).toBe(
      "Check your connection and try again.",
    );
    expect(userErrorText(apiError(500, "boom"))).toBe(
      "Opengeni couldn't finish the request. Try again in a moment.",
    );
    expect(userErrorText(undefined, "Couldn't save.")).toBe("Couldn't save.");
  });
});
