import { describe, expect, test } from "bun:test";
import { CancelledFailure } from "@temporalio/activity";
import { CompactionProviderResponseError, EmptyCompactionSummaryError } from "@opengeni/runtime";
import { compactionTrimFallbackReason } from "../src/activities/agent-turn/compaction-trim-fallback";

describe("compactionTrimFallbackReason", () => {
  test("a terminal summary failure falls back to trimming, named by its kind", () => {
    expect(
      compactionTrimFallbackReason(
        new CompactionProviderResponseError({
          httpStatus: 400,
          type: "invalid_request_error",
          code: "invalid_request_error",
          requestId: "req_1",
        }),
      ),
    ).toBe("provider_rejected");
    expect(
      compactionTrimFallbackReason(new CompactionProviderResponseError({ httpStatus: 422 })),
    ).toBe("provider_rejected");
    expect(
      compactionTrimFallbackReason(
        new CompactionProviderResponseError({ responseStatus: "failed", code: "server_error" }),
      ),
    ).toBe("provider_failed");
    expect(compactionTrimFallbackReason(new EmptyCompactionSummaryError({ reason: "empty" }))).toBe(
      "summary_unusable",
    );
  });

  test("retryable, cancelled and unrelated failures keep their existing handling", () => {
    // The same-turn retry still owns a transient provider failure.
    expect(
      compactionTrimFallbackReason(
        new CompactionProviderResponseError({ httpStatus: 503, code: "server_error" }),
      ),
    ).toBeNull();
    expect(
      compactionTrimFallbackReason(new CompactionProviderResponseError({ httpStatus: 429 })),
    ).toBeNull();
    // The attempt's own cancellation keeps propagating.
    const aborted = new AbortController();
    aborted.abort();
    expect(
      compactionTrimFallbackReason(
        new CompactionProviderResponseError({ httpStatus: 400 }),
        aborted.signal,
      ),
    ).toBeNull();
    expect(compactionTrimFallbackReason(new CancelledFailure("cancelled"))).toBeNull();
    // Anything that is not a summary failure is not the summary's to replace.
    expect(compactionTrimFallbackReason(new Error("database unavailable"))).toBeNull();
  });
});
