import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { normalizeModelCallUsage } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing/settings";
import {
  planModelUsageSettlement,
  settleModelUsage,
  type ModelUsageSettlementInput,
} from "../src/billing/model-usage-settlement";

// A response's settlement is planned when its usage is recorded: the charges
// and the idempotency key of its last ledger write. Recovery uses the key to
// tell an owed settlement from a finished one, and settles the recorded
// charges, so both must match what settlement actually writes.

const ACCOUNT = "acct-settlement-plan";
const WORKSPACE = "ws-settlement-plan";
const TURN = "55555555-5555-4555-8555-555555555555";
const db = {} as Database;

type Write = { key: string; amountMicros?: number; type?: string };

function spyWrites() {
  const writes: Write[] = [];
  const spies = [
    spyOn(opengeniDb, "recordUsageEvent").mockImplementation(async (_db, input) => {
      writes.push({ key: input.idempotencyKey, amountMicros: input.quantity });
      return undefined as never;
    }),
    spyOn(opengeniDb, "applyCreditDebitAfterUse").mockImplementation(async (_db, input) => {
      writes.push({
        key: input.idempotencyKey,
        amountMicros: input.amountMicros,
        type: input.type,
      });
      return { balance: {}, debitedMicros: input.amountMicros, grantDebitedMicros: 0 } as never;
    }),
    spyOn(opengeniDb, "applyByokPlatformFeeDebit").mockImplementation(async (_db, input) => {
      writes.push({ key: input.idempotencyKey, amountMicros: input.amountMicros, type: "byok" });
      return { balance: {}, debitedMicros: input.amountMicros, grantDebitedMicros: 0 } as never;
    }),
    spyOn(opengeniDb, "creditDebitAttributionForTurn").mockImplementation(
      async (_db, input) =>
        ({ kind: "turn", turnId: input.turnId, initiatingHumanSubjectId: "user:1" }) as never,
    ),
    spyOn(opengeniDb, "withRlsContext").mockImplementation(
      (async (database: unknown, _context: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        await fn(database)) as never,
    ),
    spyOn(opengeniDb, "settleSessionUsageReceipt").mockImplementation(async () => {
      return { outcome: "recorded" as const, state: null };
    }),
  ];
  return {
    writes,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

let active: ReturnType<typeof spyWrites> | null = null;
afterEach(() => {
  active?.restore();
  active = null;
});

const pricing = (input: number, output: number) =>
  JSON.stringify({
    "priced-model": { inputMicrosPerMillionTokens: input, outputMicrosPerMillionTokens: output },
  });
const billed = (overrides: Parameters<typeof testSettings>[0] = {}) =>
  testSettings({
    billingMode: "stripe",
    usageLimitsMode: "none",
    modelPricingJson: pricing(2_000_000, 8_000_000),
    ...overrides,
  });

function response(overrides: Partial<ModelUsageSettlementInput> = {}): ModelUsageSettlementInput {
  return {
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    model: "priced-model",
    chargesOpenGeniCredits: true,
    countsTowardTokenCap: true,
    normalizedUsage: normalizeModelCallUsage({
      inputTokens: 100_000,
      outputTokens: 50_000,
      totalTokens: 150_000,
    }),
    sourceId: `${TURN}:resp_${crypto.randomUUID()}`,
    sessionId: "session-1",
    turnId: TURN,
    turnAttemptId: "attempt-1",
    ...overrides,
  };
}

const SCENARIOS: Array<{
  name: string;
  settings: ReturnType<typeof testSettings>;
  input: Partial<ModelUsageSettlementInput>;
  last: (sourceId: string) => string | null;
}> = [
  {
    name: "credit debit",
    settings: billed(),
    input: {},
    last: (sourceId) => `credit:model_usage_debit:${sourceId}`,
  },
  {
    name: "credit debit with hosted searches",
    settings: billed(),
    input: { hostedWebSearchRequests: 2 },
    last: (sourceId) => `credit:web_search_debit:hosted:${sourceId}`,
  },
  {
    name: "hosted searches the operator does not charge",
    settings: billed({ paidHostedToolsCreditBilling: false }),
    input: { hostedWebSearchRequests: 2 },
    last: (sourceId) => `credit:model_usage_debit:${sourceId}`,
  },
  {
    name: "credit model on a deployment without billing",
    settings: testSettings({ billingMode: "none", usageLimitsMode: "none" }),
    input: {},
    last: (sourceId) => `usage:model.tokens:${sourceId}`,
  },
  {
    name: "credit model with zero tokens",
    settings: billed(),
    input: { normalizedUsage: normalizeModelCallUsage({ inputTokens: 0, outputTokens: 0 }) },
    last: () => null,
  },
  {
    name: "externally billed",
    settings: billed({ byokPlatformFeeBps: 0 }),
    input: { chargesOpenGeniCredits: false, countsTowardTokenCap: false },
    last: (sourceId) => `usage:model.cost:${sourceId}`,
  },
  {
    name: "bring-your-own-key fee",
    settings: billed({ byokPlatformFeeBps: 500 }),
    input: { chargesOpenGeniCredits: false, countsTowardTokenCap: false, byok: true },
    last: (sourceId) => `credit:byok_platform_fee:${sourceId}`,
  },
];

describe("model usage settlement plan", () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.name}: the completion key is the last ledger write`, async () => {
      const input = response(scenario.input);
      const { charges } = planModelUsageSettlement(scenario.settings, input);
      active = spyWrites();
      await settleModelUsage(scenario.settings, db, input);
      expect(charges.completionKey).toBe(scenario.last(input.sourceId));
      expect(active.writes.at(-1)?.key ?? null).toBe(charges.completionKey);
      // The recorded charges settle exactly the same writes.
      const settled = active.writes;
      active.restore();
      active = spyWrites();
      await settleModelUsage(scenario.settings, db, { ...input, recordedCharges: charges });
      expect(active.writes).toEqual(settled);
    });
  }

  test("recovery charges the recorded amounts, whatever the prices and rates are now", async () => {
    const input = response({ hostedWebSearchRequests: 3 });
    const { record, charges } = planModelUsageSettlement(billed(), input);
    expect(charges.creditCostMicros).toBe(record.pricedCostMicros);
    expect(charges.creditCostMicros).toBeGreaterThan(0);
    expect(charges.hostedWebSearch?.creditMicros).toBeGreaterThan(0);
    // Prices doubled, the model lost its price, hosted search charges were
    // switched off: the recorded charges still settle unchanged.
    for (const later of [
      billed({ modelPricingJson: pricing(4_000_000, 16_000_000) }),
      billed({ modelPricingJson: JSON.stringify({}), paidHostedToolsCreditBilling: false }),
    ]) {
      active = spyWrites();
      const billing = await settleModelUsage(later, db, { ...input, recordedCharges: charges });
      expect(billing.pricedCostMicros).toBe(charges.creditCostMicros);
      expect(
        active.writes
          .filter((write) => write.type)
          .map((write) => [write.type, write.amountMicros]),
      ).toEqual([
        ["model_usage_debit", charges.creditCostMicros],
        ["web_search_debit", charges.hostedWebSearch!.creditMicros],
      ]);
      expect(active.writes.at(-1)?.key).toBe(charges.completionKey);
      active.restore();
      active = null;
    }
    // Without recorded charges an unpriced model still fails before any write.
    active = spyWrites();
    await expect(
      settleModelUsage(billed({ modelPricingJson: JSON.stringify({}) }), db, input),
    ).rejects.toThrow("Missing model pricing for priced-model");
    expect(active.writes).toEqual([]);
  });

  test("a recorded bring-your-own-key fee is charged as recorded", async () => {
    const input = response({
      chargesOpenGeniCredits: false,
      countsTowardTokenCap: false,
      byok: true,
    });
    const { charges } = planModelUsageSettlement(billed({ byokPlatformFeeBps: 500 }), input);
    expect(charges.byokPlatformFeeMicros).toBeGreaterThan(0);
    active = spyWrites();
    await settleModelUsage(billed({ byokPlatformFeeBps: 2_000 }), db, {
      ...input,
      recordedCharges: charges,
    });
    expect(active.writes.filter((write) => write.type === "byok")).toEqual([
      { key: charges.completionKey!, amountMicros: charges.byokPlatformFeeMicros, type: "byok" },
    ]);
  });
});
