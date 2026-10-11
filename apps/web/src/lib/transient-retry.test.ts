import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import { isTransientServiceFailure, retryTransient } from "./transient-retry";

function apiError(status: number, body: Record<string, unknown> = {}, mutation = false) {
  return new OpenGeniApiError(status, JSON.stringify({ error: { status, ...body } }), {
    mutation,
  });
}

const noSleep = async () => undefined;

describe("transient service failures", () => {
  test("covers deploy-time gateway, availability and network failures only", () => {
    expect(
      isTransientServiceFailure(apiError(503, { code: "upstream_unavailable", retryable: true })),
    ).toBe(true);
    expect(isTransientServiceFailure(apiError(502))).toBe(true);
    expect(isTransientServiceFailure(apiError(504))).toBe(true);
    expect(
      isTransientServiceFailure(apiError(500, { code: "internal_error", retryable: true })),
    ).toBe(true);
    expect(isTransientServiceFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      isTransientServiceFailure(
        new OpenGeniApiError(0, "", { code: "network_error", retryable: true, mutation: true }),
      ),
    ).toBe(true);

    expect(
      isTransientServiceFailure(apiError(500, { code: "internal_error", retryable: false })),
    ).toBe(false);
    expect(isTransientServiceFailure(apiError(403, { code: "forbidden" }))).toBe(false);
    expect(isTransientServiceFailure(apiError(409, { code: "conflict" }))).toBe(false);
    expect(isTransientServiceFailure(apiError(422, { code: "validation_failed" }))).toBe(false);
    expect(isTransientServiceFailure(new TypeError("x is not a function"))).toBe(false);
    expect(isTransientServiceFailure(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isTransientServiceFailure(new Error("Opengeni API 500: boom"))).toBe(false);
  });

  test("retries a read through a brief outage with the configured backoff", async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await retryTransient(
      async () => {
        calls += 1;
        if (calls < 3) throw apiError(503, { code: "upstream_unavailable", retryable: true });
        return "draft";
      },
      { delaysMs: [1_000, 2_000, 4_000, 8_000], sleep: async (ms) => void waits.push(ms) },
    );
    expect(value).toBe("draft");
    expect(calls).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  test("never retries a definitive failure and gives up after the last delay", async () => {
    let calls = 0;
    const forbidden = apiError(403, { code: "forbidden" });
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          throw forbidden;
        },
        { sleep: noSleep },
      ),
    ).rejects.toBe(forbidden);
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          throw apiError(503);
        },
        { delaysMs: [1, 1], sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(OpenGeniApiError);
    expect(calls).toBe(3);
  });

  test("stops when the caller no longer wants the result", async () => {
    let calls = 0;
    let current = true;
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          current = false;
          throw apiError(503);
        },
        { shouldContinue: () => current, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(OpenGeniApiError);
    expect(calls).toBe(1);
  });
});
