#!/usr/bin/env bun
/**
 * Compare hand-maintained OpenGeni credit list prices against llm-prices.com.
 *
 * OpenGeni debit authority stays in `defaultModelPricing`
 * (`packages/config/src/index.ts`). llm-prices is an external ground-truth
 * canary for Standard short/long-context rates — never a generator or runtime
 * source. Fast multipliers, Fireworks, and marginBps are OpenGeni-owned and
 * are not asserted here.
 *
 * Usage:
 *   bun run check:model-pricing              # fetch live JSON
 *   bun run check:model-pricing -- --fixture path/to/current-v1.json
 *   bun run check:model-pricing -- --help
 */

import { defaultModelPricing, type ModelPricing } from "@opengeni/config";

const LLM_PRICES_URL = "https://www.llm-prices.com/current-v1.json";

type LlmPriceRow = {
  id: string;
  vendor: string;
  name: string;
  input: number;
  output: number;
  input_cached: number | null;
};

type LlmPricesDocument = {
  updated_at?: string;
  prices: LlmPriceRow[];
};

/** Product models we expect llm-prices to cover, with optional long-context twin. */
const AUDIT_MODELS: Array<{
  productId: keyof typeof defaultModelPricing;
  shortId: string;
  longId?: string;
  longMinimumInputTokens?: number;
}> = [
  {
    productId: "gpt-5.6-sol",
    shortId: "gpt-5.6-sol",
    longId: "gpt-5.6-sol-272k",
    longMinimumInputTokens: 272_001,
  },
  {
    productId: "gpt-5.6-terra",
    shortId: "gpt-5.6-terra",
    longId: "gpt-5.6-terra-272k",
    longMinimumInputTokens: 272_001,
  },
  {
    productId: "gpt-5.6-luna",
    shortId: "gpt-5.6-luna",
    longId: "gpt-5.6-luna-272k",
    longMinimumInputTokens: 272_001,
  },
];

const OPENGENI_ONLY = ["accounts/fireworks/models/glm-5p2"] as const;

function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function pricingLabel(pricing: ModelPricing): string {
  const cached = pricing.cachedInputMicrosPerMillionTokens;
  return [
    `in=${pricing.inputMicrosPerMillionTokens}`,
    cached === undefined ? "cache=—" : `cache=${cached}`,
    `out=${pricing.outputMicrosPerMillionTokens}`,
  ].join(" ");
}

function rowToPricing(row: LlmPriceRow): ModelPricing {
  return {
    inputMicrosPerMillionTokens: usdToMicros(row.input),
    ...(row.input_cached === null
      ? {}
      : { cachedInputMicrosPerMillionTokens: usdToMicros(row.input_cached) }),
    outputMicrosPerMillionTokens: usdToMicros(row.output),
  };
}

function comparePricing(
  label: string,
  ours: ModelPricing,
  theirs: ModelPricing,
): string[] {
  const errors: string[] = [];
  if (ours.inputMicrosPerMillionTokens !== theirs.inputMicrosPerMillionTokens) {
    errors.push(
      `${label} input: OpenGeni ${ours.inputMicrosPerMillionTokens} vs llm-prices ${theirs.inputMicrosPerMillionTokens}`,
    );
  }
  if (ours.outputMicrosPerMillionTokens !== theirs.outputMicrosPerMillionTokens) {
    errors.push(
      `${label} output: OpenGeni ${ours.outputMicrosPerMillionTokens} vs llm-prices ${theirs.outputMicrosPerMillionTokens}`,
    );
  }
  const ourCache = ours.cachedInputMicrosPerMillionTokens;
  const theirCache = theirs.cachedInputMicrosPerMillionTokens;
  if (theirCache !== undefined && ourCache !== theirCache) {
    errors.push(
      `${label} cached: OpenGeni ${ourCache ?? "—"} vs llm-prices ${theirCache}`,
    );
  }
  return errors;
}

export function auditModelPricingAgainstLlmPrices(doc: LlmPricesDocument): {
  ok: boolean;
  lines: string[];
  errors: string[];
} {
  const byId = new Map(doc.prices.map((row) => [row.id, row]));
  const lines: string[] = [];
  const errors: string[] = [];

  if (doc.updated_at) {
    lines.push(`llm-prices updated_at: ${doc.updated_at}`);
  }

  for (const entry of AUDIT_MODELS) {
    const schedule = defaultModelPricing[entry.productId];
    if (!schedule) {
      errors.push(`missing OpenGeni schedule for ${entry.productId}`);
      continue;
    }

    const shortRow = byId.get(entry.shortId);
    if (!shortRow) {
      errors.push(`llm-prices missing short-context row ${entry.shortId}`);
    } else {
      const mismatches = comparePricing(
        entry.productId,
        schedule.default,
        rowToPricing(shortRow),
      );
      if (mismatches.length === 0) {
        lines.push(`ok  ${entry.productId}  ${pricingLabel(schedule.default)}`);
      } else {
        errors.push(...mismatches);
      }
    }

    if (entry.longId && entry.longMinimumInputTokens !== undefined) {
      const longRow = byId.get(entry.longId);
      const tier = (schedule.inputTokenTiers ?? []).find(
        (candidate) => candidate.minimumInputTokens === entry.longMinimumInputTokens,
      );
      if (!longRow) {
        errors.push(`llm-prices missing long-context row ${entry.longId}`);
      } else if (!tier) {
        errors.push(
          `OpenGeni missing long-context tier ${entry.longMinimumInputTokens} for ${entry.productId}`,
        );
      } else {
        const mismatches = comparePricing(
          `${entry.productId}>${entry.longMinimumInputTokens}`,
          tier.pricing,
          rowToPricing(longRow),
        );
        if (mismatches.length === 0) {
          lines.push(
            `ok  ${entry.productId} long@${entry.longMinimumInputTokens}  ${pricingLabel(tier.pricing)}`,
          );
        } else {
          errors.push(...mismatches);
        }
      }
    }
  }

  for (const id of OPENGENI_ONLY) {
    lines.push(`skip ${id} (OpenGeni-only; not in llm-prices)`);
  }

  lines.push(
    "note Fast/priority multipliers and marginBps are OpenGeni-owned — not audited here",
  );

  return { ok: errors.length === 0, lines, errors };
}

async function loadDocument(argv: string[]): Promise<LlmPricesDocument> {
  const fixtureIdx = argv.indexOf("--fixture");
  if (fixtureIdx >= 0) {
    const path = argv[fixtureIdx + 1];
    if (!path) {
      throw new Error("--fixture requires a path");
    }
    return (await Bun.file(path).json()) as LlmPricesDocument;
  }
  const response = await fetch(LLM_PRICES_URL);
  if (!response.ok) {
    throw new Error(`failed to fetch ${LLM_PRICES_URL}: HTTP ${response.status}`);
  }
  return (await response.json()) as LlmPricesDocument;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Compare OpenGeni defaultModelPricing to llm-prices.com

Usage:
  bun run check:model-pricing
  bun run check:model-pricing -- --fixture <path>

Authority: packages/config/src/index.ts defaultModelPricing
Ground truth canary: ${LLM_PRICES_URL}
Docs: docs/model-providers.md § Price audit`);
    return;
  }

  const doc = await loadDocument(argv);
  const result = auditModelPricingAgainstLlmPrices(doc);
  for (const line of result.lines) {
    console.log(line);
  }
  if (!result.ok) {
    console.error("\nDrift vs llm-prices (update defaultModelPricing after verifying OpenAI):");
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log("\nAll audited OpenGeni list prices match llm-prices.");
}

if (import.meta.main) {
  await main();
}
