import { describe, expect, test } from "bun:test";
import { formatErrorMessage as coreFormatErrorMessage } from "../src/core";
import { formatErrorMessage as browserFormatErrorMessage } from "../src/browser";

import {
  formatErrorMessage,
  OpenGeniAllowanceExhaustedError,
  OpenGeniApiContractMismatchError,
  OpenGeniApiError,
  OpenGeniSecureContextRequiredError,
  OpenGeniSetupError,
  OpenGeniStreamError,
} from "../src/errors";

test("neutral formatter is available through the core and browser entry points", () => {
  expect(coreFormatErrorMessage).toBe(browserFormatErrorMessage);
  expect(coreFormatErrorMessage(new TypeError("OpenGeni diagnostic"))).toBe(
    "The request could not be completed.",
  );
});

describe("brand-neutral error presentation", () => {
  test("keeps API diagnostics and references without displaying API prose", () => {
    const body = JSON.stringify({
      error: {
        code: "permission_denied",
        message: "OpenGeni rejected this operation.",
        requestId: "acme-denied-403",
        details: { missingPermission: "sessions:control" },
      },
    });
    const error = new OpenGeniApiError(403, body, { mutation: true });
    expect(formatErrorMessage(error)).toBe(
      "You don’t have permission to do that. Reference: acme-denied-403.",
    );
    expect(error.message).toContain("OpenGeni rejected this operation.");
    expect(error.body).toBe(body);
    expect(error.details).toEqual({ missingPermission: "sessions:control" });
    expect(error.code).toBe("permission_denied");
    expect(error.retryable).toBe(false);
    expect(error.outcomeUnknown).toBe(false);
  });

  test("setup and allowance guidance remain actionable without developer-only names", () => {
    const setup = new OpenGeniSetupError(
      new OpenGeniApiError(409, "", { correlationId: "setup-1" }),
    );
    expect(formatErrorMessage(setup)).toBe(
      "Private conversations are unavailable. Ask an administrator to enable them. Reference: setup-1.",
    );
    expect(setup.message).toContain("@opengeni/sdk");
    expect(setup.code).toBe("OPENGENI_SETUP_REQUIRED");
    expect(setup.retryable).toBe(false);
    const allowance = new OpenGeniAllowanceExhaustedError(
      429,
      JSON.stringify({
        error: {
          code: "allowance_exhausted",
          message: "OpenGeni allowance reached",
          details: { scope: "member", resetsAt: "2026-10-03T00:00:00Z", subjectId: "host-user-1" },
        },
      }),
    );
    expect(formatErrorMessage(allowance)).toContain("Usage limit reached");
    expect(formatErrorMessage(allowance)).not.toMatch(/opengeni/i);
    expect(allowance).toMatchObject({
      scope: "member",
      resetsAt: "2026-10-03T00:00:00Z",
      subjectId: "host-user-1",
      retryable: false,
      outcomeUnknown: false,
    });
  });

  test("unknown outcomes require reconciliation rather than a blind retry", () => {
    const error = new OpenGeniApiError(0, "", {
      code: "network_error",
      retryable: true,
      outcomeUnknown: true,
      correlationId: "transport-1",
      displayMessage: "OpenGeni could not confirm delivery",
    });
    expect(formatErrorMessage(error)).toBe(
      "The request could not be confirmed. Check its status before retrying. Reference: transport-1.",
    );
    expect(error).toMatchObject({ code: "network_error", retryable: true, outcomeUnknown: true });
    expect(error.message).toContain("OpenGeni could not confirm delivery");
  });

  test("retryable and operator-action failures stay distinct", () => {
    const transient = new OpenGeniApiError(
      503,
      JSON.stringify({ error: { message: "OpenGeni is down", retryable: true } }),
      { mutation: false },
    );
    const setup = new OpenGeniApiError(
      503,
      JSON.stringify({
        error: {
          message: "An operator must configure OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON",
          retryable: false,
          details: { oauthReason: "operator_oauth_app_missing" },
        },
      }),
      { mutation: false },
    );
    expect(formatErrorMessage(transient)).toBe(
      "The service is temporarily unavailable. Try again later.",
    );
    expect(formatErrorMessage(setup)).toBe(
      "The service is unavailable. Ask an administrator for help.",
    );
    expect(setup.message).toContain("OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON");
    expect(setup.details?.oauthReason).toBe("operator_oauth_app_missing");
  });

  test("browser, contract, stream and untyped transport errors have neutral defaults", () => {
    for (const error of [
      new OpenGeniSecureContextRequiredError("insecure_context"),
      new OpenGeniSecureContextRequiredError("web_crypto_unavailable"),
      new OpenGeniApiContractMismatchError("old", "new"),
      new OpenGeniStreamError("OpenGeni stream failed"),
      new TypeError("OpenGeni transport failed"),
      "OpenGeni proxy failed",
    ]) {
      expect(formatErrorMessage(error)).not.toMatch(/opengeni/i);
      expect(formatErrorMessage(error)).not.toBe("");
    }
    expect(
      formatErrorMessage(new Error("private diagnostic"), "ACME could not load this conversation."),
    ).toBe("ACME could not load this conversation.");
  });
});
