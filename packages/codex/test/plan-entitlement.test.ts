import { describe, expect, test } from "bun:test";
import {
  CODEX_TRANSPORT_ERROR_HEADER,
  classifyCodexEncryptedArtifactRejection,
  classifyCodexEntitlementRejection,
  classifyCodexUsageLimitError,
  codexPlanDisplayName,
  codexPlanEntitlementLost,
  codexPlanKey,
} from "../src";

const transportHeaders = () => new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" });

/** The OpenAI SDK's APIError shape for a buffered Codex error response. */
function codexApiError(status: number, body?: Record<string, unknown>, message?: string) {
  return Object.assign(
    new Error(
      message ?? (body ? `${status} ${JSON.stringify(body)}` : `${status} status code (no body)`),
    ),
    { status, error: body, headers: transportHeaders() },
  );
}

describe("Codex plan entitlement rejection classification", () => {
  test("classifies the production empty-body 400 as ambiguous evidence", () => {
    expect(classifyCodexEntitlementRejection(codexApiError(400))).toEqual({
      status: 400,
      evidence: "empty_body",
    });
  });

  test("recognizes an empty-body 400 through an SDK wrapper cause chain", () => {
    const wrapped = Object.assign(new Error("model request failed"), {
      cause: codexApiError(400),
    });
    expect(classifyCodexEntitlementRejection(wrapped)).toEqual({
      status: 400,
      evidence: "empty_body",
    });
  });

  test("treats explicit plan codes and plan wording as authoritative evidence", () => {
    expect(
      classifyCodexEntitlementRejection(
        codexApiError(403, {
          code: "model_not_available_on_plan",
          message: "This model is not available on your current plan.",
        }),
      ),
    ).toEqual({ status: 403, evidence: "plan_entitlement" });
    expect(
      classifyCodexEntitlementRejection(
        codexApiError(400, {
          type: "invalid_request_error",
          message: "The requested model is not included in your ChatGPT plan.",
        }),
      ),
    ).toEqual({ status: 400, evidence: "plan_entitlement" });
    expect(
      classifyCodexEntitlementRejection(
        codexApiError(400, {
          type: "invalid_request_error",
          message: "Upgrade your plan to use this model.",
        }),
      ),
    ).toEqual({ status: 400, evidence: "plan_entitlement" });
  });

  test("classifies Codex usage_not_included (HTTP 429) as plan evidence, not quota", () => {
    const error = codexApiError(429, {
      type: "usage_not_included",
      message: "To use Codex with your ChatGPT plan, upgrade to Plus.",
    });
    expect(classifyCodexEntitlementRejection(error)).toEqual({
      status: 429,
      evidence: "plan_entitlement",
    });
  });

  test("leaves quota, auth, content, and malformed-request failures on their existing paths", () => {
    const quota = codexApiError(429, {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      resets_in_seconds: 60,
    });
    expect(classifyCodexUsageLimitError(quota)).not.toBeNull();
    expect(classifyCodexEntitlementRejection(quota)).toBeNull();

    expect(classifyCodexEntitlementRejection(codexApiError(401))).toBeNull();
    expect(
      classifyCodexEntitlementRejection(
        codexApiError(429, { code: "rate_limit_exceeded", message: "Slow down" }),
      ),
    ).toBeNull();

    const encrypted = codexApiError(400, {
      code: "invalid_encrypted_content",
      message: "The encrypted content could not be decrypted or parsed.",
    });
    expect(classifyCodexEncryptedArtifactRejection(encrypted)).not.toBeNull();
    expect(classifyCodexEntitlementRejection(encrypted)).toBeNull();

    expect(
      classifyCodexEntitlementRejection(
        codexApiError(400, {
          type: "invalid_request_error",
          message: "Invalid value for 'input[3].content'.",
        }),
      ),
    ).toBeNull();
    // A non-JSON body is text evidence of a different failure, not "no body".
    expect(
      classifyCodexEntitlementRejection(codexApiError(400, undefined, "400 Bad Request")),
    ).toBeNull();
    // A 403 without plan wording keeps the definitive forbidden path.
    expect(
      classifyCodexEntitlementRejection(
        codexApiError(403, { code: "forbidden", message: "Access denied" }),
      ),
    ).toBeNull();
  });

  test("requires Codex transport provenance", () => {
    const foreign = Object.assign(new Error("400 status code (no body)"), {
      status: 400,
      headers: new Headers(),
    });
    expect(classifyCodexEntitlementRejection(foreign)).toBeNull();
    expect(classifyCodexEntitlementRejection(new Error("400 status code (no body)"))).toBeNull();
  });
});

describe("Codex plan helpers", () => {
  test("normalizes plan keys and names", () => {
    expect(codexPlanKey(" Pro ")).toBe("pro");
    expect(codexPlanKey(null)).toBe("unknown");
    expect(codexPlanKey("")).toBe("unknown");
    expect(codexPlanDisplayName("free")).toBe("Free");
    expect(codexPlanDisplayName("pro")).toBe("Pro");
    expect(codexPlanDisplayName("self_serve_business")).toBe("Self Serve Business");
    expect(codexPlanDisplayName(null)).toBeNull();
  });

  test("an empty 400 is explained only by Free or a changed plan", () => {
    const decide = (previousPlanType: string | null, currentPlanType: string | null) =>
      codexPlanEntitlementLost({ evidence: "empty_body", previousPlanType, currentPlanType });
    expect(decide("pro", "free")).toBe(true);
    expect(decide("free", "free")).toBe(true);
    expect(decide("pro", "plus")).toBe(true);
    expect(decide("pro", "pro")).toBe(false);
    expect(decide(null, "pro")).toBe(false);
    expect(decide("pro", null)).toBe(false);
  });

  test("explicit plan evidence is authoritative even when the plan looks unchanged", () => {
    expect(
      codexPlanEntitlementLost({
        evidence: "plan_entitlement",
        previousPlanType: "plus",
        currentPlanType: "plus",
      }),
    ).toBe(true);
  });
});
