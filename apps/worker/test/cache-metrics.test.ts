import { describe, expect, spyOn, test } from "bun:test";
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
    expect(metrics).toMatch(
      /opengeni_model_cache_read_telemetry_total\{[^}]*provider="codex-subscription"[^}]*status="reported"[^}]*\} 1\b/,
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
    expect(metrics).toMatch(
      /opengeni_model_cache_read_telemetry_total\{[^}]*provider="openai"[^}]*status="missing"[^}]*\} 2\b/,
    );
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

  test("malformed, fractional, unsafe, and over-contract inputs cannot poison metrics", async () => {
    const observability = worker();
    const invalid = [
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      -5,
      1.5,
      Number.MAX_SAFE_INTEGER,
      1_000_000_001,
    ];
    for (const value of invalid) {
      expect(() =>
        recordModelCacheTokens(observability, "openai", {
          cachedTokens: value,
          cacheWriteTokens: value,
          promptTokens: value,
        }),
      ).not.toThrow();
    }
    // Repeated oversized input must remain rejected rather than accumulating
    // into an unsafe or infinite counter.
    for (let index = 0; index < 10; index += 1) {
      recordModelCacheTokens(observability, "openai", {
        cachedTokens: 1_000_000_001,
        cacheWriteTokens: 1_000_000_001,
        promptTokens: 1_000_000_001,
      });
    }

    const metrics = await observability.prometheusMetrics();
    expect(metrics).not.toMatch(/opengeni_model_cached_tokens_total/);
    expect(metrics).not.toMatch(/opengeni_model_cache_write_tokens_total/);
    expect(metrics).not.toMatch(/opengeni_model_cache_hit_ratio/);
    expect(metrics).not.toMatch(/\} \+Inf(?:\n|$)/);
    expect(metrics).toMatch(
      /opengeni_model_cache_read_telemetry_total\{[^}]*provider="openai"[^}]*status="missing"[^}]*\} 17\b/,
    );
  });

  test("refuses cache-counter increments beyond the process-safe cumulative bound", async () => {
    const observability = worker();
    const warn = spyOn(observability, "warn").mockImplementation(() => undefined);
    try {
      for (let index = 0; index < 1001; index += 1) {
        recordModelCacheTokens(observability, "openai", {
          cachedTokens: 1_000_000_000,
          cacheWriteTokens: 1_000_000_000,
          promptTokens: null,
        });
      }

      const metrics = await observability.prometheusMetrics();
      expect(metrics).toMatch(
        /opengeni_model_cached_tokens_total\{[^}]*provider="openai"[^}]*\} 1000000000000\b/,
      );
      expect(metrics).toMatch(
        /opengeni_model_cache_write_tokens_total\{[^}]*provider="openai"[^}]*\} 1000000000000\b/,
      );
      expect(metrics).not.toMatch(/\} \+Inf(?:\n|$)/);
      expect(warn).toHaveBeenCalledWith("model cache metric cumulative limit reached", {
        provider: "openai",
        metric: "opengeni_model_cached_tokens_total",
      });
      expect(warn).toHaveBeenCalledWith("model cache metric cumulative limit reached", {
        provider: "openai",
        metric: "opengeni_model_cache_write_tokens_total",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("availability labels stay bounded and the chart alerts on missing Codex telemetry", async () => {
    const observability = worker();
    recordModelCacheTokens(observability, "codex-subscription", {
      cachedTokens: null,
      promptTokens: 100,
    });
    const metrics = await observability.prometheusMetrics();
    const availabilityLine = metrics
      .split("\n")
      .find((line) => line.startsWith("opengeni_model_cache_read_telemetry_total{"));
    expect(availabilityLine).toContain('provider="codex-subscription"');
    expect(availabilityLine).toContain('status="missing"');
    const availabilityLabels = availabilityLine?.slice(
      availabilityLine.indexOf("{") + 1,
      availabilityLine.indexOf("}"),
    );
    expect(availabilityLabels).not.toMatch(/account|session|workspace|model|source/);

    const rule = await Bun.file("deploy/helm/opengeni/templates/prometheusrule.yaml").text();
    expect(rule).toContain("OpenGeniCodexPromptCacheTelemetryMissing");
    expect(rule).toContain("opengeni_model_cache_read_telemetry_total");
    expect(rule).toContain('provider="codex-subscription",status="missing"');
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
