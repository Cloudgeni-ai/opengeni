import { describe, expect, test } from "bun:test";
import {
  COMPOSER_PAYMENT_REQUIRED_MESSAGE,
  CREDIT_EXHAUSTION_MESSAGE,
  composerSubmissionErrorMessage,
  formatRelativeTime,
  humanizeFailureReason,
  isCreditExhaustion,
  stringifyPayload,
  truncate,
  tryParseJson,
} from "../src/lib/format";
import { OpenGeniApiError } from "@opengeni/sdk";

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
    expect(COMPOSER_PAYMENT_REQUIRED_MESSAGE).toContain("connected Codex subscription model");
    expect(COMPOSER_PAYMENT_REQUIRED_MESSAGE).toContain("draft and attachments are preserved");
  });

  test("passes unrelated submission errors through", () => {
    expect(composerSubmissionErrorMessage(new Error("network unavailable"))).toBe(
      "network unavailable",
    );
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
