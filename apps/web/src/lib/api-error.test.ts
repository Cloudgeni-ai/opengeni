import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import {
  apiErrorAdvice,
  apiErrorDetails,
  apiErrorFacts,
  isPermissionDenied,
  userErrorText,
  userErrorTextWithoutReference,
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

  test("a model refusal names the model, never its routing id", () => {
    expect(apiErrorAdvice(apiError(422, "model is not selectable: codex/gpt-6.1-sol"))).toBe(
      "GPT-6.1 Sol isn't available here. Choose another model.",
    );
    expect(
      apiErrorAdvice(
        apiError(422, "model is not available: organization-claude-subscription/claude-opus-5-5"),
      ),
    ).toBe("Claude Opus 5.5 isn't available here. Choose another model.");
  });

  test("keeps the app's own messages and maps network failures", () => {
    expect(userErrorText(new Error("Pick a workspace first."))).toBe("Pick a workspace first.");
    expect(userErrorText(new TypeError("Failed to fetch"))).toBe(
      "Check your connection and try again.",
    );
    expect(userErrorText(apiError(500, "boom"))).toBe(
      `Opengeni couldn't finish the request. Try again in a moment. Reference: ${REFERENCE}.`,
    );
    expect(userErrorText(undefined, "Couldn't save.")).toBe("Couldn't save.");
  });

  test("a 409 with a readable server sentence says what conflicted", () => {
    expect(apiErrorAdvice(apiError(409, "variable set name is already in use: Prod"))).toBe(
      "Variable set name is already in use: Prod.",
    );
    expect(apiErrorAdvice(apiError(409, "personal GitHub connection must be reconnected"))).toBe(
      "Personal GitHub connection must be reconnected.",
    );
    // No readable sentence: the change-since-load advice.
    expect(apiErrorAdvice(apiError(409, "revision_mismatch"))).toBe(
      "It changed since this page loaded. Reload the page and try again.",
    );
    expect(apiErrorAdvice(apiError(412, '{"etag":"W/1"}'))).toBe(
      "It changed since this page loaded. Reload the page and try again.",
    );
  });

  test("only a fetch transport failure is a connection problem", () => {
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "Network request failed",
    ]) {
      expect(userErrorText(new TypeError(message))).toBe("Check your connection and try again.");
    }
    // The SDK's input checks and plain bugs are TypeErrors too.
    expect(userErrorText(new TypeError("customModelId must be a UUID"))).toBe(
      "customModelId must be a UUID",
    );
    expect(
      apiErrorAdvice(new TypeError("Cannot read properties of undefined (reading 'id')")),
    ).toBe("Try again. If it keeps happening, reload the page.");
  });

  test("the one-line text keeps the support reference unless Technical details show it", () => {
    const error = apiError(409, "variable set name is already in use: Prod");
    expect(userErrorText(error)).toBe(
      `Variable set name is already in use: Prod. Reference: ${REFERENCE}.`,
    );
    expect(userErrorTextWithoutReference(error)).toBe("Variable set name is already in use: Prod.");
    expect(userErrorText(new Error(`OpenGeni API 404: not found Reference: ${REFERENCE}.`))).toBe(
      `Try again. If it keeps happening, reload the page. Reference: ${REFERENCE}.`,
    );
    // No reference, nothing appended; an app error keeps its own message.
    expect(userErrorText(Object.assign(new Error("gone"), { status: 404 }))).toBe(
      "It may have been removed. Reload the page and try again.",
    );
    expect(userErrorText(new Error("Pick a workspace first."))).toBe("Pick a workspace first.");
  });
});
