import { describe, expect, test } from "bun:test";
import { CancelledFailure } from "@temporalio/activity";
import {
  AnthropicProviderRejection,
  CompactionProviderResponseError,
  EmptyCompactionSummaryError,
  compactionProviderFailureDiagnostics,
} from "@opengeni/runtime";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { compactionTrimFallbackReason } from "../src/activities/agent-turn/compaction-trim-fallback";

/** How the runtime wraps a thrown provider or transport error. */
const wrapped = (error: unknown) =>
  new CompactionProviderResponseError(compactionProviderFailureDiagnostics(error), error);
const apiError = (status: number, body: Record<string, unknown> = {}) =>
  wrapped(APIError.generate(status, { error: body }, undefined, new Headers()));
/** How the runtime wraps a failed or incomplete response it received. */
const failedResponse = (response: Record<string, unknown>) =>
  new CompactionProviderResponseError(
    compactionProviderFailureDiagnostics(response),
    undefined,
    response,
  );

describe("compactionTrimFallbackReason", () => {
  test("a failure repeating the request cannot fix falls back to trimming, named by its kind", () => {
    for (const status of [400, 413, 422]) {
      expect(
        compactionTrimFallbackReason(
          apiError(status, { type: "invalid_request_error", message: "max_tokens too large" }),
        ),
      ).toBe("provider_rejected");
    }
    expect(
      compactionTrimFallbackReason(
        failedResponse({ status: "failed", error: { code: "invalid_prompt", message: "no" } }),
      ),
    ).toBe("provider_failed");
    expect(
      compactionTrimFallbackReason(
        failedResponse({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ),
    ).toBe("provider_failed");
    expect(compactionTrimFallbackReason(new EmptyCompactionSummaryError({ reason: "empty" }))).toBe(
      "summary_unusable",
    );
  });

  test("a safety refusal of the summary request falls back whatever status carried it", () => {
    // Claude refuses with HTTP 200 and stop_reason "refusal".
    expect(
      compactionTrimFallbackReason(
        wrapped(new AnthropicProviderRejection("content_policy_violation", 200, "req_1")),
      ),
    ).toBe("provider_rejected");
    expect(
      compactionTrimFallbackReason(
        failedResponse({ status: "failed", error: { code: "content_filter", message: "no" } }),
      ),
    ).toBe("provider_rejected");
    // An account refusal is not about this request: the next one fails too.
    expect(
      compactionTrimFallbackReason(
        wrapped(new AnthropicProviderRejection("anthropic_permission_denied", 403)),
      ),
    ).toBeNull();
  });

  test("temporary, account and transport failures keep history and their existing handling", () => {
    // The same-turn retry owns a transient provider failure.
    for (const status of [429, 500, 502, 503]) {
      expect(compactionTrimFallbackReason(apiError(status))).toBeNull();
    }
    // The next ordinary request would be refused the same way, so trimming
    // would lose history and gain nothing.
    for (const status of [401, 402, 403, 404, 408, 409]) {
      expect(compactionTrimFallbackReason(apiError(status))).toBeNull();
    }
    // No response at all: the next request may pass.
    expect(
      compactionTrimFallbackReason(wrapped(new APIConnectionError({ message: "down" }))),
    ).toBeNull();
    expect(compactionTrimFallbackReason(wrapped(new APIConnectionTimeoutError()))).toBeNull();
    expect(
      compactionTrimFallbackReason(
        wrapped(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })),
      ),
    ).toBeNull();
    expect(compactionTrimFallbackReason(wrapped(new TypeError("fetch failed")))).toBeNull();
    // A failed response with a temporary code, or with no code, is not definitive.
    for (const code of ["server_error", "rate_limit_exceeded", "overloaded_error", "timeout"]) {
      expect(
        compactionTrimFallbackReason(
          failedResponse({ status: "failed", error: { code, message: "Upstream overloaded" } }),
        ),
      ).toBeNull();
    }
    expect(compactionTrimFallbackReason(failedResponse({ status: "failed" }))).toBeNull();
  });

  test("cancellation and errors outside the summary keep propagating", () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(compactionTrimFallbackReason(apiError(400), aborted.signal)).toBeNull();
    expect(compactionTrimFallbackReason(new CancelledFailure("cancelled"))).toBeNull();
    expect(compactionTrimFallbackReason(new Error("database unavailable"))).toBeNull();
  });
});
