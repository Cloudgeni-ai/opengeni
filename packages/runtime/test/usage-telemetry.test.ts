import { describe, expect, test } from "bun:test";
import { normalizeModelCallUsage } from "../src/usage-telemetry";

describe("cache-write TTL snapshot evidence", () => {
  test("preserves known zero and mixed TTLs without adding writes to total input twice", () => {
    const result = normalizeModelCallUsage({
      inputTokens: 1000,
      outputTokens: 20,
      totalTokens: 1020,
      inputTokensDetails: {
        cached_tokens: 100,
        cache_write_tokens: 300,
        cache_write_tokens_5m: 200,
        cache_write_tokens_1h: 100,
      },
    });
    expect(result.cacheWriteTokensByTtl).toEqual({ fiveMinute: 200, oneHour: 100 });
    expect(result.telemetry).toMatchObject({
      inputTokens: 1000,
      cachedTokens: 100,
      cacheWriteTokens: 300,
    });
    expect(result.totalTokens).toBe(1020);
    const zero = normalizeModelCallUsage({
      inputTokensDetails: { cache_write_tokens_5m: 0, cache_write_tokens_1h: 0 },
    });
    expect(zero.cacheWriteTokensByTtl).toEqual({ fiveMinute: 0, oneHour: 0 });
  });

  test("preserves per-request TTL evidence for tiered pricing", () => {
    const result = normalizeModelCallUsage({
      requestUsageEntries: [
        {
          inputTokens: 1000,
          outputTokens: 10,
          inputTokensDetails: {
            cached_tokens: 0,
            cache_write_tokens: 200,
            cache_write_tokens_5m: 200,
            cache_write_tokens_1h: 0,
          },
        },
        {
          input_tokens: 2000,
          output_tokens: 20,
          input_tokens_details: {
            cached_tokens: 100,
            cache_write_tokens: 300,
            cache_write_tokens_5m: 0,
            cache_write_tokens_1h: 300,
          },
        },
      ],
    });
    expect(result.cacheWriteTokensByTtl).toEqual({ fiveMinute: 200, oneHour: 300 });
    expect(result.requestUsageEntries?.map((entry) => entry.inputTokensDetails)).toEqual([
      {
        cached_tokens: 0,
        cache_write_tokens: 200,
        cache_write_tokens_5m: 200,
        cache_write_tokens_1h: 0,
      },
      {
        cached_tokens: 100,
        cache_write_tokens: 300,
        cache_write_tokens_5m: 0,
        cache_write_tokens_1h: 300,
      },
    ]);
    expect(result.telemetry.inputTokens).toBe(3000);
    expect(result.totalTokens).toBe(3030);
  });

  test("unknown TTL is not zero; incomplete request TTLs remain incomplete", () => {
    const unknown = normalizeModelCallUsage({
      inputTokens: 10,
      outputTokens: 1,
      inputTokensDetails: { cache_write_tokens: 5 },
    });
    expect(unknown.cacheWriteTokensByTtl).toBeUndefined();
    const partial = normalizeModelCallUsage({
      requestUsageEntries: [
        {
          inputTokens: 10,
          outputTokens: 1,
          inputTokensDetails: { cache_write_tokens: 5, cache_write_tokens_5m: 5 },
        },
        { inputTokens: 20, outputTokens: 2, inputTokensDetails: { cache_write_tokens: 5 } },
      ],
    });
    expect(partial.cacheWriteTokensByTtl).toBeUndefined();
    expect(partial.requestUsageEntries?.[0]?.inputTokensDetails?.cache_write_tokens_5m).toBe(5);
    expect(
      partial.requestUsageEntries?.[1]?.inputTokensDetails?.cache_write_tokens_5m,
    ).toBeUndefined();
  });

  test("invalid TTL values are rejected without altering valid billing totals", () => {
    const result = normalizeModelCallUsage({
      inputTokens: 100,
      outputTokens: 2,
      inputTokensDetails: {
        cache_write_tokens: 10,
        cache_write_tokens_5m: -1,
        cache_write_tokens_1h: Number.MAX_SAFE_INTEGER + 1,
      },
    });
    expect(result.cacheWriteTokensByTtl).toBeUndefined();
    expect(result.rejectedFields).toEqual(
      expect.arrayContaining([
        "inputTokensDetails.cache_write_tokens_5m",
        "inputTokensDetails.cache_write_tokens_1h",
      ]),
    );
    expect(result.telemetry.cacheWriteTokens).toBe(10);
    expect(result.totalTokens).toBe(102);
  });
});
