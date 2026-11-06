import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  configuredModelListPricingSchedules,
  configuredModels,
  defaultModelPricing,
  parseModelProvidersJson,
  reviewedModelListPricing,
  withClaudeConnectionCatalog,
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  type Settings,
} from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { useNoSessionUsageLimitForFakeDatabases } from "@opengeni/testing/session-usage-limits";

import { recordModelUsageAndDebitCredits } from "../src/activities/agent-turn/model-usage";

useNoSessionUsageLimitForFakeDatabases();

const db = {} as Database;

/**
 * The Codex catalog is dynamic: it can serve any reviewed GPT slug, not only
 * the fallback list. Configure every GPT id that has a debit or reviewed list
 * price, plus the other subscription catalogs priced by reviewed list rates.
 */
function catalogSettings(): Settings {
  let settings = withCodexCatalogProvider(
    testSettings({
      billingMode: "stripe",
      usageLimitsMode: "managed",
      claudeSubscriptionEnabled: true,
    }),
  );
  const providers = parseModelProvidersJson(settings.modelProvidersJson);
  const codex = providers.find((provider) => provider.kind === "codex-subscription")!;
  const template = codex.models[0]!;
  const slugs = [...Object.keys(defaultModelPricing), ...Object.keys(reviewedModelListPricing)];
  for (const slug of new Set(slugs.filter((id) => id.startsWith("gpt-")))) {
    if (codex.models.some((model) => model.upstreamModelId === slug)) continue;
    codex.models.push({ ...template, id: `codex/${slug}`, upstreamModelId: slug });
  }
  settings = withXaiSubscriptionCatalogProvider({
    ...settings,
    modelProvidersJson: JSON.stringify(providers),
  });
  const claudeModels = Object.keys(reviewedModelListPricing)
    .filter((id) => id.startsWith("claude-"))
    .map((upstreamModelId) => ({ upstreamModelId }));
  return withClaudeConnectionCatalog(
    settings,
    { claude_subscription: { models: claudeModels } },
    "workspace",
  );
}

describe("catalog list prices produce an equivalent credit cost", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

  test("every list-priced subscription model records a non-zero equivalent credit cost", async () => {
    const usageSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockResolvedValue({
      debitedMicros: 0,
    } as never);
    restores.push(
      () => usageSpy.mockRestore(),
      () => debitSpy.mockRestore(),
    );
    const settings = catalogSettings();
    const listPrices = configuredModelListPricingSchedules(settings);
    const models = configuredModels(settings).filter(
      (model) => model.billing.metering === "external",
    );
    const listPriced = models.filter((model) => listPrices[model.id] !== undefined);
    // The guard must actually cover the newest catalog models.
    expect(listPriced.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "codex/gpt-6-astra",
        "codex/gpt-6-luna",
        "codex/gpt-6.1-sol",
        "codex/gpt-6.1-terra",
      ]),
    );
    const missing: string[] = [];
    for (const model of models) {
      const billing = await recordModelUsageAndDebitCredits(settings, db, {
        accountId: "acct-1",
        workspaceId: "ws-1",
        sessionId: "sess-1",
        turnId: "turn-1",
        turnAttemptId: "attempt-1",
        model: model.id,
        externallyBilled: true,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        sourceKey: `response-${model.id}`,
      });
      if (
        listPrices[model.id] !== undefined &&
        billing?.pricingSource !== "configured_list_price"
      ) {
        missing.push(`${model.id}: list price configured but pricingSource is not a list price`);
      }
      if (
        billing?.pricingSource === "configured_list_price" &&
        !((billing.equivalentCreditCostMicros ?? 0) > 0)
      ) {
        missing.push(`${model.id}: configured_list_price without an equivalent credit cost`);
      }
    }
    expect(missing).toEqual([]);
    expect(debitSpy).not.toHaveBeenCalled();
  });
});
