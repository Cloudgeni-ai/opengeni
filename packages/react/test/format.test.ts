import { describe, expect, test } from "bun:test";
import {
  COMPOSER_PAYMENT_REQUIRED_MESSAGE,
  ComposerReconciliationRequiredError,
  ComposerStateError,
  ComposerWorkspaceControlUnavailableError,
  CREDIT_EXHAUSTION_MESSAGE,
  composerSubmissionErrorMessage,
  composerSubmissionCanRetry,
  formatClockTime,
  formatRelativeTime,
  humanizeFailureReason,
  presentFailure,
  isCreditExhaustion,
  stringifyPayload,
  truncate,
  tryParseJson,
} from "../src/lib/format";
import { OpenGeniApiError } from "@opengeni/sdk";

describe("failure presentation", () => {
  test("database failures show a safe explanation without altering stored diagnostics", () => {
    for (const classification of [
      { code: "db_deadlock" },
      { code: "db_serialization_failure" },
      { code: "db_failure" },
      { sqlState: "40P01", database: { severity: "ERROR", routine: "DeadLockReport" } },
    ]) {
      const payload = Object.freeze({
        ...classification,
        error: "Failed query: INSERT INTO runtime_records VALUES ($1)",
        detail: "params: fixture-value",
        lastRetryableError: "fixture-value",
      });
      const before = JSON.stringify(payload);
      expect(presentFailure(payload)).toEqual({
        reason: "The service encountered a database error.",
        safetyRefusal: false,
      });
      expect(JSON.stringify(payload)).toBe(before);
    }
  });
  const refusal =
    "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
  test("exposes the actual reason in legacy exhausted-retry failures", () => {
    expect(
      presentFailure({
        error: "Upstream unavailable. Send a message to retry.",
        lastRetryableError: refusal,
      }),
    ).toEqual({
      reason: `The model provider blocked this request. ${refusal}`,
      safetyRefusal: true,
    });
  });
  test("retains the exact diagnostic on new safety failures", () => {
    expect(
      presentFailure({
        code: "provider_safety_refusal",
        error: "Automatic retries stopped.",
        detail: refusal,
      }),
    ).toEqual({
      reason: `The model provider blocked this request. ${refusal}`,
      safetyRefusal: true,
    });
  });
  test("keeps other underlying failures and ignores nontext details", () => {
    expect(
      presentFailure({ error: "Retries exhausted.", lastRetryableError: "Connection reset." })
        .reason,
    ).toBe("Retries exhausted. Connection reset.");
    expect(presentFailure({ error: "Failed.", detail: { nested: true } }).reason).toBe("Failed.");
    expect(presentFailure({})).toEqual({ reason: null, safetyRefusal: false });
  });
});

describe("formatClockTime", () => {
  test("formats date + time and rejects invalid input", () => {
    expect(formatClockTime("not-a-date")).toBe("");
    const formatted = formatClockTime("2026-07-15T08:04:00");
    expect(formatted.toLowerCase()).toMatch(/jul/);
    expect(formatted).toMatch(/15/);
    expect(formatted).toMatch(/\d/);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-06-12T12:00:00Z");

  test("scales from now to days", () => {
    expect(formatRelativeTime("2026-06-12T11:59:55Z", now)).toBe("now");
    expect(formatRelativeTime("2026-06-12T11:59:20Z", now)).toBe("40s");
    expect(formatRelativeTime("2026-06-12T11:53:00Z", now)).toBe("7m");
    expect(formatRelativeTime("2026-06-12T09:00:00Z", now)).toBe("3h");
    expect(formatRelativeTime("2026-06-10T12:00:00Z", now)).toBe("2d");
  });

  test("handles invalid and future timestamps gracefully", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("");
    expect(formatRelativeTime("2026-06-12T12:30:00Z", now)).toBe("now");
  });
});

describe("truncate", () => {
  test("collapses whitespace and appends an ellipsis", () => {
    expect(truncate("deploy   the\nstaging cluster", 100)).toBe("deploy the staging cluster");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("stringifyPayload", () => {
  test("pretty-prints objects and embedded json strings, passes plain text through", () => {
    expect(stringifyPayload({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(stringifyPayload('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(stringifyPayload("plain output")).toBe("plain output");
    expect(stringifyPayload(null)).toBe("");
  });
});

describe("tryParseJson", () => {
  test("parses json and returns undefined otherwise", () => {
    expect(tryParseJson('{"x":1}')).toEqual({ x: 1 });
    expect(tryParseJson("[1,2]")).toEqual([1, 2]);
    expect(tryParseJson("nope")).toBeUndefined();
    expect(tryParseJson("{broken")).toBeUndefined();
  });
});

describe("isCreditExhaustion", () => {
  test("matches the engine error text, bare and wrapped, case-insensitively", () => {
    expect(isCreditExhaustion("insufficient OpenGeni credits")).toBe(true);
    expect(isCreditExhaustion("Activity task failed: insufficient OpenGeni credits")).toBe(true);
    expect(isCreditExhaustion("INSUFFICIENT OPENGENI CREDITS")).toBe(true);
    expect(
      isCreditExhaustion({ error: "Activity task failed: insufficient OpenGeni credits" }),
    ).toBe(true);
    expect(isCreditExhaustion({ detail: "insufficient OpenGeni credits" })).toBe(true);
  });

  test("matches the budget_exhausted segment limit on its own", () => {
    expect(isCreditExhaustion({ segmentLimit: "budget_exhausted" })).toBe(true);
    expect(
      isCreditExhaustion({
        detail: "insufficient OpenGeni credits",
        segmentLimit: "budget_exhausted",
      }),
    ).toBe(true);
  });

  test("rejects unrelated failures and limits", () => {
    expect(isCreditExhaustion("insufficient_quota")).toBe(false);
    expect(isCreditExhaustion({ error: "connection reset by peer" })).toBe(false);
    expect(isCreditExhaustion({ segmentLimit: "max_turns" })).toBe(false);
    expect(isCreditExhaustion({ error: null, detail: null, segmentLimit: null })).toBe(false);
  });
});

describe("composerSubmissionErrorMessage", () => {
  test("explains managed-credit admission and preserves typed API identity", () => {
    const error = new OpenGeniApiError(
      402,
      JSON.stringify({
        error: {
          status: 402,
          code: "payment_required",
          message: "insufficient OpenGeni credits",
          retryable: false,
        },
      }),
    );

    expect(error.code).toBe("payment_required");
    expect(composerSubmissionErrorMessage(error)).toBe(COMPOSER_PAYMENT_REQUIRED_MESSAGE);
    expect(composerSubmissionCanRetry(error)).toBe(false);
    expect(COMPOSER_PAYMENT_REQUIRED_MESSAGE).not.toContain("free");
    expect(COMPOSER_PAYMENT_REQUIRED_MESSAGE).not.toContain("Codex");
  });

  test("keeps unrelated submission diagnostics out of default UI copy", () => {
    expect(composerSubmissionErrorMessage(new Error("network unavailable"))).toBe(
      "The request could not be completed.",
    );
    expect(composerSubmissionCanRetry(new Error("network unavailable"))).toBe(true);
  });

  test("preserves composer-owned validation and safe reconciliation guidance", () => {
    expect(
      composerSubmissionErrorMessage(
        new ComposerStateError("A message can include at most 12 timeline annotations."),
      ),
    ).toContain("at most 12");
    expect(composerSubmissionErrorMessage(new ComposerReconciliationRequiredError())).toContain(
      "cannot safely retry",
    );
    expect(composerSubmissionErrorMessage(new ComposerReconciliationRequiredError())).toContain(
      "reconcile the session",
    );
    expect(new ComposerReconciliationRequiredError().message).toContain("Opengeni");
    expect(
      composerSubmissionErrorMessage(new ComposerWorkspaceControlUnavailableError()),
    ).toContain("Ask your administrator");
    expect(new ComposerWorkspaceControlUnavailableError().message).toContain(
      "setWorkspaceInferenceState",
    );
  });

  test("recognizes retained legacy credit errors without their API object", () => {
    const legacy = new Error("OpenGeni API 402: insufficient OpenGeni credits");
    expect(composerSubmissionErrorMessage(legacy)).toBe(COMPOSER_PAYMENT_REQUIRED_MESSAGE);
    expect(composerSubmissionCanRetry(legacy)).toBe(false);
  });

  test("allowance refusals require an admin change, but transient throttles remain retryable", () => {
    const allowance = new OpenGeniApiError(402, "", {
      code: "allowance_exhausted",
      retryable: false,
      outcomeUnknown: false,
      displayMessage: "Member allowance exhausted",
    });
    expect(composerSubmissionCanRetry(allowance)).toBe(false);
    expect(composerSubmissionErrorMessage(allowance)).toContain("workspace admin");
    expect(composerSubmissionCanRetry(new OpenGeniApiError(429, "rate limited"))).toBe(true);
    expect(composerSubmissionCanRetry(new OpenGeniApiError(503, "unavailable"))).toBe(true);
  });
});

describe("humanizeFailureReason", () => {
  test("maps credit exhaustion to the canonical sentence", () => {
    expect(humanizeFailureReason("insufficient OpenGeni credits")).toBe(CREDIT_EXHAUSTION_MESSAGE);
    expect(humanizeFailureReason("Activity task failed: insufficient OpenGeni credits")).toBe(
      CREDIT_EXHAUSTION_MESSAGE,
    );
  });

  test("keeps auth/quota mappings and passes other reasons through", () => {
    expect(humanizeFailureReason("Incorrect API key provided")).toContain("engine credentials");
    expect(humanizeFailureReason("insufficient_quota")).toContain("provider quota");
    expect(humanizeFailureReason("something else broke")).toBe("something else broke");
    expect(humanizeFailureReason(null)).toBeNull();
  });
});
