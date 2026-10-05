import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { configuredModels } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";

import {
  modelMetricProductId,
  recordAuthoritativeModelUsageMetrics,
  recordModelUsageAndDebitCredits,
} from "../src/activities/agent-turn/model-usage";
import {
  boundedModelMetricLabel,
  recordModelCreditsCharged,
  recordModelResponseUsage,
} from "../src/observability-metrics";

// Per-model usage and money metrics: pin the series names, the bounded label
// set, and that no account/workspace/session identifier ever becomes a label.

function worker() {
  return createObservability(testSettings(), { component: "worker" });
}

function billedSettings() {
  return testSettings({
    billingMode: "stripe",
    usageLimitsMode: "managed",
    modelPricingJson: JSON.stringify({
      "gpt-5.6-sol": {
        inputMicrosPerMillionTokens: 4_000_000,
        cachedInputMicrosPerMillionTokens: 400_000,
        cacheWriteMicrosPerMillionTokens: 5_000_000,
        outputMicrosPerMillionTokens: 20_000_000,
        marginBps: 500,
      },
    }),
  });
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe("recordModelResponseUsage", () => {
  test("counts responses, every token type and the estimated provider cost", async () => {
    const observability = worker();
    recordModelResponseUsage(observability, {
      provider: "azure-sol",
      model: "gpt-5.6-sol",
      payer: "deployment",
      tokens: {
        inputTokens: 1_000,
        cachedTokens: 600,
        cacheWriteTokens: 100,
        outputTokens: 200,
        reasoningTokens: 50,
      },
      estimatedProviderCostMicros: 4_321,
      pricingSource: "configured_list_price",
    });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_responses_total\{(?=[^}]*provider="azure-sol")(?=[^}]*model="gpt-5\.6-sol")(?=[^}]*priced="true")[^}]*\} 1\n/,
    );
    for (const [type, value] of [
      ["input", 1_000],
      ["cached_input", 600],
      ["cache_write", 100],
      ["output", 200],
      ["reasoning", 50],
    ] as const) {
      expect(metrics).toMatch(
        new RegExp(
          `opengeni_model_tokens_total\\{(?=[^}]*model="gpt-5\\.6-sol")(?=[^}]*type="${type}")[^}]*\\} ${value}\\n`,
        ),
      );
    }
    expect(metrics).toMatch(
      /opengeni_model_provider_cost_micros_total\{(?=[^}]*payer="deployment")(?=[^}]*pricing_source="configured_list_price")[^}]*\} 4321\n/,
    );
    await observability.flush();
  });

  test("an unpriced response is counted without a cost series; absent tokens add nothing", async () => {
    const observability = worker();
    recordModelResponseUsage(observability, {
      provider: "workspace-openrouter",
      model: "custom",
      payer: "external",
      tokens: {
        inputTokens: 10,
        cachedTokens: null,
        cacheWriteTokens: null,
        outputTokens: 0,
        reasoningTokens: null,
      },
      estimatedProviderCostMicros: null,
      pricingSource: null,
    });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_model_responses_total\{(?=[^}]*priced="false")[^}]*\} 1\n/);
    expect(metrics).toMatch(/opengeni_model_tokens_total\{(?=[^}]*type="input")[^}]*\} 10\n/);
    expect(metrics).not.toMatch(/type="cached_input"/);
    expect(metrics).not.toMatch(/type="output"/);
    expect(metrics).not.toMatch(/opengeni_model_provider_cost_micros_total\{/);
    await observability.flush();
  });
});

describe("recordModelCreditsCharged", () => {
  test("splits debited micros into promotional and general funding", async () => {
    const observability = worker();
    recordModelCreditsCharged(observability, {
      provider: "azure-sol",
      model: "gpt-5.6-sol",
      debitedMicros: 1_000,
      grantDebitedMicros: 300,
    });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_credits_charged_micros_total\{(?=[^}]*funding="promotional")[^}]*\} 300\n/,
    );
    expect(metrics).toMatch(
      /opengeni_model_credits_charged_micros_total\{(?=[^}]*funding="general")[^}]*\} 700\n/,
    );
    await observability.flush();
  });

  test("records nothing for a zero debit and clamps an invalid grant share", async () => {
    const observability = worker();
    recordModelCreditsCharged(observability, {
      provider: "azure-sol",
      model: "gpt-5.6-sol",
      debitedMicros: 0,
      grantDebitedMicros: 0,
    });
    recordModelCreditsCharged(observability, {
      provider: "azure-sol",
      model: "gpt-5.6-sol",
      debitedMicros: 500,
      grantDebitedMicros: undefined as unknown as number,
    });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_credits_charged_micros_total\{(?=[^}]*funding="general")[^}]*\} 500\n/,
    );
    expect(metrics).not.toMatch(/funding="promotional"/);
    await observability.flush();
  });
});

describe("model label bounds", () => {
  test("caps distinct model labels per process and rejects unusual shapes", () => {
    const observability = worker();
    expect(boundedModelMetricLabel(observability, "has spaces")).toBe("custom");
    expect(boundedModelMetricLabel(observability, "x".repeat(200))).toBe("custom");
    for (let index = 0; index < 64; index += 1) {
      expect(boundedModelMetricLabel(observability, `model-${index}`)).toBe(`model-${index}`);
    }
    expect(boundedModelMetricLabel(observability, "model-64")).toBe("other");
    // Already-seen values keep their label after the cap.
    expect(boundedModelMetricLabel(observability, "model-3")).toBe("model-3");
  });

  test("labels catalog models by product id and workspace models as custom", () => {
    const settings = billedSettings();
    const catalogModel = configuredModels(settings)[0]!.id;
    expect(modelMetricProductId(settings, "azure", catalogModel)).toBe(catalogModel);
    expect(modelMetricProductId(settings, "azure", "not-in-the-catalog-model")).toBe("custom");
    expect(modelMetricProductId(settings, "workspace-gateway", "workspace-gateway/abc")).toBe(
      "custom",
    );
    expect(modelMetricProductId(settings, "workspace-openrouter", catalogModel)).toBe("custom");
  });
});

describe("model usage wiring", () => {
  test("a credit debit records charged credits with the grant-funded share", async () => {
    const observability = worker();
    const settings = billedSettings();
    const usageSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
    restores.push(() => usageSpy.mockRestore());
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
      async (_db, input) => ({
        balance: {} as never,
        debitedMicros: input.requestedAmountMicros,
        grantDebitedMicros: 1,
      }),
    );
    restores.push(() => debitSpy.mockRestore());
    const model = configuredModels(settings).some((candidate) => candidate.id === "gpt-5.6-sol")
      ? "gpt-5.6-sol"
      : "custom";
    const billing = await recordModelUsageAndDebitCredits(settings, {} as Database, {
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      turnAttemptId: "attempt-1",
      model: "gpt-5.6-sol",
      externallyBilled: false,
      usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
      sourceKey: "response-1",
      observability,
      metricProvider: "azure-sol",
    });
    expect(billing?.pricedCostMicros).toBeGreaterThan(0);
    recordAuthoritativeModelUsageMetrics({
      observability,
      settings,
      provider: "azure-sol",
      model: "gpt-5.6-sol",
      externallyBilled: false,
      billing: billing!,
    });
    const metrics = await observability.prometheusMetrics();
    const general = billing!.pricedCostMicros - 1;
    expect(metrics).toMatch(
      new RegExp(
        `opengeni_model_credits_charged_micros_total\\{(?=[^}]*provider="azure-sol")(?=[^}]*model="${model.replaceAll(".", "\\.")}")(?=[^}]*funding="general")[^}]*\\} ${general}\\n`,
      ),
    );
    expect(metrics).toMatch(
      /opengeni_model_credits_charged_micros_total\{(?=[^}]*funding="promotional")[^}]*\} 1\n/,
    );
    expect(metrics).toMatch(
      /opengeni_model_tokens_total\{(?=[^}]*provider="azure-sol")(?=[^}]*type="output")[^}]*\} 500\n/,
    );
    expect(metrics).toMatch(
      new RegExp(
        `opengeni_model_provider_cost_micros_total\\{(?=[^}]*payer="deployment")[^}]*\\} ${billing!.estimatedProviderCostMicros}\\n`,
      ),
    );
    // Identifiers never become labels.
    expect(metrics).not.toMatch(/acct-1|ws-1|sess-1|turn-1|attempt-1/);
    await observability.flush();
  });
});
