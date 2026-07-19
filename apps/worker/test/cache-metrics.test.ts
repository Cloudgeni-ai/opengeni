import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  modelCallAccountContext,
  recordModelCacheTokens,
  stableAccountHash,
} from "../src/observability-metrics";

// Prompt-cache efficiency: pin that each per-call cache signal fires with the
// right series and bounded labels, degrades safely on providers that do not
// report cached tokens, and that the account-switch log dimension is computed
// correctly — so the "is the codex prompt cache working" question is a number,
// and the account-rotation hypothesis is testable from the logs.

function worker() {
  return createObservability(testSettings(), { component: "worker" });
}

describe("recordModelCacheTokens — prompt-cache efficiency", () => {
  test("counts cached tokens and observes the cached/prompt ratio by provider", async () => {
    const observability = worker();
    recordModelCacheTokens(observability, "codex-subscription", {
      cachedTokens: 512,
      promptTokens: 1024,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_cached_tokens_total\{[^}]*provider="codex-subscription"[^}]*\} 512\b/,
    );
    // ratio 0.5 → histogram sum 0.5, one observation
    expect(metrics).toMatch(
      /opengeni_model_cache_hit_ratio_sum\{[^}]*provider="codex-subscription"[^}]*\} 0\.5\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_cache_hit_ratio_count\{[^}]*provider="codex-subscription"[^}]*\} 1\b/,
    );
  });

  test("a call with prompt tokens but NO cached tokens records a real 0 ratio (cache did nothing)", async () => {
    const observability = worker();
    recordModelCacheTokens(observability, "codex-subscription", {
      cachedTokens: 0,
      promptTokens: 2000,
    });

    const metrics = await observability.prometheusMetrics();
    // The 0 must land in the histogram (it is the low-cache signal the alert watches).
    expect(metrics).toMatch(
      /opengeni_model_cache_hit_ratio_sum\{[^}]*provider="codex-subscription"[^}]*\} 0\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_cache_hit_ratio_count\{[^}]*provider="codex-subscription"[^}]*\} 1\b/,
    );
    // No cached tokens → the counter is never created (no phantom zero-increment).
    expect(metrics).not.toMatch(/opengeni_model_cached_tokens_total/);
  });

  test("absent/null cached tokens remains unknown and does not fabricate a zero ratio", async () => {
    const observability = worker();
    expect(() =>
      recordModelCacheTokens(observability, "openai", {
        cachedTokens: null,
        promptTokens: 1000,
      }),
    ).not.toThrow();
    expect(() =>
      recordModelCacheTokens(observability, "openai", {
        cachedTokens: undefined,
        promptTokens: undefined,
      }),
    ).not.toThrow();

    const metrics = await observability.prometheusMetrics();
    expect(metrics).not.toMatch(/opengeni_model_cached_tokens_total/);
    expect(metrics).not.toMatch(/opengeni_model_cache_hit_ratio/);
  });

  test("counts provider-reported cache writes without inventing absent writes", async () => {
    const observability = worker();
    recordModelCacheTokens(observability, "openai", {
      cachedTokens: 0,
      cacheWriteTokens: 256,
      promptTokens: 1024,
    });
    recordModelCacheTokens(observability, "codex-subscription", {
      cachedTokens: 0,
      cacheWriteTokens: null,
      promptTokens: 1024,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_cache_write_tokens_total\{[^}]*provider="openai"[^}]*\} 256\b/,
    );
    expect(metrics).not.toMatch(
      /opengeni_model_cache_write_tokens_total\{[^}]*provider="codex-subscription"/,
    );
  });

  test("no prompt tokens → no ratio observation (a call with no prompt has no ratio)", async () => {
    const observability = worker();
    recordModelCacheTokens(observability, "openai", { cachedTokens: 10, promptTokens: 0 });

    const metrics = await observability.prometheusMetrics();
    // cached still counts; ratio series is never created (no prompt to divide by).
    expect(metrics).toMatch(
      /opengeni_model_cached_tokens_total\{[^}]*provider="openai"[^}]*\} 10\b/,
    );
    expect(metrics).not.toMatch(/opengeni_model_cache_hit_ratio/);
  });

  test("ratio is clamped to 1 when cached exceeds prompt", async () => {
    const observability = worker();
    recordModelCacheTokens(observability, "openai", { cachedTokens: 1500, promptTokens: 1000 });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_cache_hit_ratio_sum\{[^}]*provider="openai"[^}]*\} 1\b/,
    );
  });

  test("non-finite / negative inputs are ignored, not thrown or counted", async () => {
    const observability = worker();
    expect(() =>
      recordModelCacheTokens(observability, "openai", {
        cachedTokens: Number.NaN,
        cacheWriteTokens: Number.NEGATIVE_INFINITY,
        promptTokens: -5,
      }),
    ).not.toThrow();

    const metrics = await observability.prometheusMetrics();
    expect(metrics).not.toMatch(/opengeni_model_cached_tokens_total/);
    expect(metrics).not.toMatch(/opengeni_model_cache_write_tokens_total/);
    expect(metrics).not.toMatch(/opengeni_model_cache_hit_ratio/);
  });
});

describe("stableAccountHash — opaque, stable account tag", () => {
  test("is stable, opaque (never the raw id), and short", () => {
    const id = "cred_01H8XABCDEF1234567890";
    const hash = stableAccountHash(id);
    expect(hash).toBe(stableAccountHash(id)); // stable
    expect(hash).not.toBe(id); // opaque — never the id verbatim
    expect(hash).not.toContain(id);
    expect(hash).toMatch(/^[0-9a-f]{12}$/); // short hex tag
  });

  test("distinct accounts get distinct tags", () => {
    expect(stableAccountHash("cred-a")).not.toBe(stableAccountHash("cred-b"));
  });

  test("a null/absent/empty account tags as 'none'", () => {
    expect(stableAccountHash(null)).toBe("none");
    expect(stableAccountHash(undefined)).toBe("none");
    expect(stableAccountHash("")).toBe("none");
  });
});

describe("modelCallAccountContext — account-switch dimension", () => {
  test("first call of a turn on a NEW account reports a switch", () => {
    const ctx = modelCallAccountContext({
      servingCredentialId: "cred-new",
      priorSessionCredentialId: "cred-old",
      isFirstCallOfTurn: true,
    });
    expect(ctx.accountChangedFromPrevCall).toBe(true);
    expect(ctx.servingAccountHash).toBe(stableAccountHash("cred-new"));
  });

  test("first call on the SAME account is not a switch", () => {
    const ctx = modelCallAccountContext({
      servingCredentialId: "cred-x",
      priorSessionCredentialId: "cred-x",
      isFirstCallOfTurn: true,
    });
    expect(ctx.accountChangedFromPrevCall).toBe(false);
  });

  test("a session's very first call (no prior account) is a cold start, not a switch", () => {
    const ctx = modelCallAccountContext({
      servingCredentialId: "cred-x",
      priorSessionCredentialId: null,
      isFirstCallOfTurn: true,
    });
    expect(ctx.accountChangedFromPrevCall).toBe(false);
    expect(ctx.servingAccountHash).toBe(stableAccountHash("cred-x"));
  });

  test("later calls within the same turn never report a switch (account is fixed per turn)", () => {
    const ctx = modelCallAccountContext({
      servingCredentialId: "cred-new",
      priorSessionCredentialId: "cred-old",
      isFirstCallOfTurn: false,
    });
    expect(ctx.accountChangedFromPrevCall).toBe(false);
  });

  test("a non-codex turn (no serving credential) tags 'none' and never a switch", () => {
    const ctx = modelCallAccountContext({
      servingCredentialId: null,
      priorSessionCredentialId: null,
      isFirstCallOfTurn: true,
    });
    expect(ctx.servingAccountHash).toBe("none");
    expect(ctx.accountChangedFromPrevCall).toBe(false);
  });
});
