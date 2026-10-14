import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { OPENGENI_GATEWAY_MODELS } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { toPostgresLosslessJson } from "@opengeni/db";

/** The lossless codec's JSON string tag (packages/db/src/lossless-json.ts). */
const LOSSLESS_JSON_STRING_PREFIX = "opengeni_lossless_json_string_v2_81f06e15:";
import { normalizeModelCallUsage } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import {
  SESSION_USAGE_RECEIPT_SOURCE_ID_MAX_BYTES,
  settleModelUsage,
  sessionUsageReceiptSourceId,
  type ModelUsageSettlementInput,
} from "../src/billing/model-usage-settlement";
import { SESSION_USAGE_LIMIT_EVENTS_METRIC } from "../src/session-usage-limit-metrics";

// every funding path records the canonical pre-margin
// `estimatedProviderCostMicros` once against the task, before and without
// changing any credit, usage or entitlement write.

const ACCOUNT = "acct-usage-limit";
const WORKSPACE = "ws-usage-limit";
const db = {} as Database;

type Call = { fn: string; input: Record<string, unknown> };

function spyWrites(options: { settleFails?: boolean } = {}) {
  const calls: Call[] = [];
  const spies = [
    spyOn(opengeniDb, "recordUsageEvent").mockImplementation(async (_db, input) => {
      calls.push({ fn: "usage", input: input as unknown as Record<string, unknown> });
      return undefined as never;
    }),
    spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(async (_db, input) => {
      calls.push({ fn: "debit", input: input as unknown as Record<string, unknown> });
      return {
        balance: {
          accountId: ACCOUNT,
          balanceMicros: 10_000_000,
          currency: "usd",
          updatedAt: new Date().toISOString(),
        },
        debitedMicros: input.requestedAmountMicros,
      } as never;
    }),
    spyOn(opengeniDb, "settleSessionUsageReceipt").mockImplementation(async (_db, input) => {
      calls.push({ fn: "receipt", input: input as unknown as Record<string, unknown> });
      if (options.settleFails) throw new Error("database unavailable");
      return { outcome: "recorded" as const, state: null };
    }),
  ];
  return {
    calls,
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

const PRICED = JSON.stringify({
  "priced-model": {
    inputMicrosPerMillionTokens: 2_000_000,
    outputMicrosPerMillionTokens: 8_000_000,
    marginBps: 5_000,
  },
  "free-model": { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
});

const usage = normalizeModelCallUsage({
  inputTokens: 1_000,
  outputTokens: 500,
  totalTokens: 1_500,
});

function settlementInput(
  overrides: Partial<ModelUsageSettlementInput> & { model: string },
  sessionId: string | null,
): ModelUsageSettlementInput {
  return {
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    chargesOpenGeniCredits: true,
    countsTowardTokenCap: true,
    normalizedUsage: usage,
    sourceId: `turn-1:${overrides.model}`,
    ...(sessionId ? { sessionId, turnId: "turn-1", turnAttemptId: "attempt-1" } : {}),
    ...overrides,
  };
}

/** Writes other than the receipt, without session attribution, for comparison. */
function nonReceiptWrites(calls: Call[]) {
  return calls
    .filter((call) => call.fn !== "receipt")
    .map((call) => {
      // The control has no task, so its usage rows carry no session context.
      const {
        sessionId: _session,
        turnId: _turn,
        turnAttemptId: _attempt,
        ...rest
      } = call.input as Record<string, unknown>;
      return { fn: call.fn, rest: JSON.stringify(rest, Object.keys(rest).sort()) };
    });
}

const paths: Array<{
  name: string;
  settings: () => ReturnType<typeof testSettings>;
  overrides: Partial<ModelUsageSettlementInput> & { model: string };
  expectedReceipt: { amountMicros: number | null; pricingSource: string | null };
}> = [
  {
    name: "metered Opengeni credits",
    settings: () =>
      testSettings({ billingMode: "stripe", usageLimitsMode: "managed", modelPricingJson: PRICED }),
    overrides: { model: "priced-model" },
    // 1000 * $2/M + 500 * $8/M = $0.006 pre-margin (the 50% margin is never counted).
    expectedReceipt: { amountMicros: 6_000, pricingSource: "configured_list_price" },
  },
  {
    name: "subscription / workspace key (externally billed)",
    settings: () =>
      testSettings({ billingMode: "stripe", usageLimitsMode: "managed", modelPricingJson: PRICED }),
    overrides: {
      model: "priced-model",
      chargesOpenGeniCredits: false,
      countsTowardTokenCap: false,
    },
    expectedReceipt: { amountMicros: 6_000, pricingSource: "configured_list_price" },
  },
  {
    name: "billing disabled (self-hosted)",
    settings: () => testSettings({ billingMode: "disabled", modelPricingJson: PRICED }),
    overrides: { model: "priced-model" },
    expectedReceipt: { amountMicros: 6_000, pricingSource: "configured_list_price" },
  },
  {
    name: "verified free model",
    settings: () => testSettings({ billingMode: "stripe", modelPricingJson: PRICED }),
    overrides: { model: "free-model" },
    expectedReceipt: { amountMicros: 0, pricingSource: "configured_list_price" },
  },
  {
    name: "unpriced model",
    settings: () => testSettings({ billingMode: "disabled", modelPricingJson: JSON.stringify({}) }),
    overrides: { model: "unknown-model", chargesOpenGeniCredits: false },
    expectedReceipt: { amountMicros: null, pricingSource: null },
  },
  {
    name: "managed AI Gateway reported cost",
    settings: () =>
      testSettings({
        billingMode: "stripe",
        usageLimitsMode: "managed",
        vercelAiGatewayApiKey: "vck_test",
      }),
    overrides: {
      model: OPENGENI_GATEWAY_MODELS.deepseek.productId,
      gatewayBilling: { finalProvider: "baseten", inferenceCostUsd: "0.00000325" },
    },
    // The gateway-reported provider cost (rounded up to whole micros), pre-margin.
    expectedReceipt: { amountMicros: 4, pricingSource: "gateway_reported" },
  },
];

describe("per-task usage limit settlement across funding paths", () => {
  for (const path of paths) {
    test(`${path.name}: one receipt at the canonical pre-margin cost; credits unchanged`, async () => {
      // Control: the same response with no task (no receipt).
      active = spyWrites();
      const control = await settleModelUsage(
        path.settings(),
        db,
        settlementInput(path.overrides, null),
      );
      const controlWrites = nonReceiptWrites(active.calls);
      expect(active.calls.some((call) => call.fn === "receipt")).toBe(false);
      active.restore();

      active = spyWrites();
      const record = await settleModelUsage(
        path.settings(),
        db,
        settlementInput(path.overrides, "session-1"),
      );
      const receipts = active.calls.filter((call) => call.fn === "receipt");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.input).toMatchObject({
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "session-1",
        sourceId: `turn-1:${path.overrides.model}`,
        turnId: "turn-1",
        amountMicros: path.expectedReceipt.amountMicros,
        pricingSource: path.expectedReceipt.pricingSource,
      });
      // The receipt is the record's canonical estimate, never the credit price.
      expect(receipts[0]!.input.amountMicros).toBe(record.estimatedProviderCostMicros);
      // Synchronous and first: no credit/usage write precedes the receipt.
      expect(active.calls[0]!.fn).toBe("receipt");
      // Credit debits and usage events are byte-identical to the no-task control.
      expect(nonReceiptWrites(active.calls)).toEqual(controlWrites);
      expect(record.pricedCostMicros).toBe(control.pricedCostMicros);
      expect(record.billingPath).toBe(control.billingPath);
    });
  }

  test("a settlement database failure throws before any credit or usage write", async () => {
    active = spyWrites({ settleFails: true });
    const counters: Array<{ name: string; labels: Record<string, string> }> = [];
    await expect(
      settleModelUsage(testSettings({ billingMode: "stripe", modelPricingJson: PRICED }), db, {
        ...settlementInput({ model: "priced-model" }, "session-1"),
        usageLimitMetrics: {
          incrementCounter: (metric) => {
            counters.push({ name: metric.name, labels: metric.labels ?? {} });
          },
        },
      }),
    ).rejects.toThrow("database unavailable");
    expect(active.calls.map((call) => call.fn)).toEqual(["receipt"]);
    expect(counters).toEqual([
      {
        name: SESSION_USAGE_LIMIT_EVENTS_METRIC.name,
        labels: { boundary: "settlement", outcome: "accounting_failure" },
      },
    ]);
  });

  test("an attempt-authenticated single call meters its task, not its usage attribution", async () => {
    active = spyWrites();
    await settleModelUsage(
      testSettings({ billingMode: "disabled", modelPricingJson: PRICED }),
      db,
      {
        ...settlementInput({ model: "priced-model" }, null),
        sourceId: "model_call:req-1",
        usageLimitSessionId: "session-attempt",
      },
    );
    const receipts = active.calls.filter((call) => call.fn === "receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.input).toMatchObject({
      sessionId: "session-attempt",
      sourceId: "model_call:req-1",
      amountMicros: 6_000,
    });
    // Usage attribution (no sessionId on the usage event) is unchanged.
    const usageEvents = active.calls.filter((call) => call.fn === "usage");
    for (const event of usageEvents) expect(event.input.sessionId).toBeUndefined();
  });

  test("a source identity past the receipt bound is recorded under a stable digest", async () => {
    const turnId = "00000000-0000-4000-8000-000000000001";
    // The longest identity the event trigger and legacy import accept is kept as is.
    const longestShared = `${turnId}:${"r".repeat(1024)}`;
    expect(sessionUsageReceiptSourceId(longestShared)).toBe(longestShared);
    const atBound = "é".repeat(SESSION_USAGE_RECEIPT_SOURCE_ID_MAX_BYTES / 2);
    expect(sessionUsageReceiptSourceId(atBound)).toBe(atBound);
    // Past the bound (counted in UTF-8 bytes), a digest the column accepts.
    const tooLong = `${turnId}:${"é".repeat(600)}`;
    const digest = sessionUsageReceiptSourceId(tooLong);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sessionUsageReceiptSourceId(tooLong)).toBe(digest);
    expect(sessionUsageReceiptSourceId(`${tooLong}x`)).not.toBe(digest);

    active = spyWrites();
    await settleModelUsage(
      testSettings({ billingMode: "disabled", modelPricingJson: PRICED }),
      db,
      { ...settlementInput({ model: "priced-model" }, "session-1"), sourceId: tooLong },
    );
    const receipts = active.calls.filter((call) => call.fn === "receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.input).toMatchObject({ sourceId: digest, amountMicros: 6_000 });
  });

  test("a source key PostgreSQL cannot store as given uses the event's stored encoding", () => {
    const turnId = "00000000-0000-4000-8000-000000000002";
    for (const key of [
      `n3s-\ud800${"z".repeat(95)}`,
      `n3n-\u0000${"w".repeat(20)}`,
      `${LOSSLESS_JSON_STRING_PREFIX}${"p".repeat(40)}`,
    ]) {
      const stored = toPostgresLosslessJson(key) as string;
      expect(stored).not.toBe(key);
      // Exactly the identity the event trigger meters: `<turnId>:<stored sourceKey>`.
      expect(sessionUsageReceiptSourceId(`${turnId}:${key}`, turnId)).toBe(`${turnId}:${stored}`);
    }
    // Encoded past the bound: a digest of the stored identity, still stable.
    const long = `${turnId}:n3-\ud800${"y".repeat(400)}`;
    const digest = sessionUsageReceiptSourceId(long, turnId);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sessionUsageReceiptSourceId(long, turnId)).toBe(digest);
    // Safe keys are untouched, with or without the turn.
    expect(sessionUsageReceiptSourceId(`${turnId}:resp_1`, turnId)).toBe(`${turnId}:resp_1`);
    expect(sessionUsageReceiptSourceId("model_call:req-1")).toBe("model_call:req-1");
  });

  test("a response that reported no usage is an unknown amount, never known free", async () => {
    for (const reported of [
      normalizeModelCallUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      normalizeModelCallUsage({}),
    ]) {
      active = spyWrites();
      const record = await settleModelUsage(
        testSettings({ billingMode: "disabled", modelPricingJson: PRICED }),
        db,
        {
          ...settlementInput({ model: "priced-model", chargesOpenGeniCredits: false }, "session-1"),
          normalizedUsage: reported,
        },
      );
      const receipt = active.calls.find((call) => call.fn === "receipt")!;
      expect(receipt.input).toMatchObject({ amountMicros: null, pricingSource: null });
      // Billing and Insights keep their own estimate unchanged.
      expect(
        record.estimatedProviderCostMicros === null || record.estimatedProviderCostMicros === 0,
      ).toBe(true);
      active.restore();
      active = null;
    }
  });

  test("a known free model with reported tokens stays known free", async () => {
    active = spyWrites();
    await settleModelUsage(
      testSettings({ billingMode: "disabled", modelPricingJson: PRICED }),
      db,
      {
        ...settlementInput({ model: "free-model", chargesOpenGeniCredits: false }, "session-1"),
      },
    );
    expect(active.calls.find((call) => call.fn === "receipt")!.input).toMatchObject({
      amountMicros: 0,
      pricingSource: "configured_list_price",
    });
  });

  test("with custody, a failed receipt write is handed over and credit settlement continues", async () => {
    active = spyWrites({ settleFails: true });
    const held: unknown[] = [];
    const counters: string[] = [];
    await settleModelUsage(testSettings({ billingMode: "stripe", modelPricingJson: PRICED }), db, {
      ...settlementInput({ model: "priced-model" }, "session-1"),
      receiptCustody: (receipt) => void held.push(receipt),
      usageLimitMetrics: {
        incrementCounter: (metric) => void counters.push(metric.labels?.outcome ?? ""),
      },
    });
    expect(held).toEqual([
      {
        sessionId: "session-1",
        sourceId: "turn-1:priced-model",
        turnId: "turn-1",
        amountMicros: 6_000,
        pricingSource: "configured_list_price",
        model: "priced-model",
      },
    ]);
    expect(counters).toEqual(["held"]);
    // The receipt came first; the credit debit and usage writes still ran.
    expect(active.calls[0]!.fn).toBe("receipt");
    expect(active.calls.some((call) => call.fn === "debit")).toBe(true);
  });
});
