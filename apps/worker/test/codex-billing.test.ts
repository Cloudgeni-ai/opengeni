import { describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import type { Database } from "@opengeni/db";
import { ensureRunAllowed, recordModelUsageAndDebitCredits } from "../src/activities/agent-turn";

const ACCOUNT = "acct-1";
const WORKSPACE = "ws-1";
const db = {} as Database;

// Live config that reproduces the bug: stripe + managed, 0 OpenGeni credits.
function billedSettings() {
  return testSettings({ billingMode: "stripe", usageLimitsMode: "managed" });
}

function mockZeroBalance(): () => void {
  const spy = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
    accountId: ACCOUNT,
    balanceMicros: 0,
    currency: "usd",
    updatedAt: new Date().toISOString(),
  });
  return () => spy.mockRestore();
}

describe("worker ensureRunAllowed — codex bypass", () => {
  test("(a) codex turn with 0 credits does NOT throw (credit gate skipped, balance never read)", async () => {
    let balanceRead = false;
    const spy = spyOn(opengeniDb, "getBillingBalance").mockImplementation(async () => {
      balanceRead = true;
      return {
        accountId: ACCOUNT,
        balanceMicros: 0,
        currency: "usd",
        updatedAt: new Date().toISOString(),
      };
    });
    try {
      await ensureRunAllowed(billedSettings(), db, ACCOUNT, WORKSPACE, /* isCodexTurn */ true);
      expect(balanceRead).toBe(false); // short-circuited before any balance read
    } finally {
      spy.mockRestore();
    }
  });

  test("(c) a normal turn with 0 credits still throws insufficient OpenGeni credits", async () => {
    const restore = mockZeroBalance();
    try {
      await expect(
        ensureRunAllowed(billedSettings(), db, ACCOUNT, WORKSPACE, /* isCodexTurn */ false),
      ).rejects.toThrow("insufficient OpenGeni credits");
    } finally {
      restore();
    }
  });
});

describe("worker recordModelUsageAndDebitCredits — codex usage recording", () => {
  test("(d) codex turn records model.cost=0, does NOT throw 'Missing model pricing', and never debits", async () => {
    const recorded: Array<{ eventType: string; quantity: number; unit: string }> = [];
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async (_db, input) => {
        recorded.push({ eventType: input.eventType, quantity: input.quantity, unit: input.unit });
      },
    );
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
      async () => {
        throw new Error("credits must NOT be debited for a codex turn");
      },
    );
    try {
      await recordModelUsageAndDebitCredits(billedSettings(), db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-1",
        model: "codex/gpt-5.6-sol", // has NO OpenGeni pricing
        isCodexTurn: true,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        sourceKey: "response-1",
      });
      // Exactly one event: a zero-cost audit marker. NO model.tokens row (it would
      // feed the OpenGeni token cap a codex turn is exempt from).
      expect(recorded).toEqual([{ eventType: "model.cost", quantity: 0, unit: "usd_micros" }]);
      expect(debitSpy).not.toHaveBeenCalled();
    } finally {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });

  test("(control) a normal turn still records model.tokens and a non-zero model.cost", async () => {
    const recorded: Array<{ eventType: string; quantity: number }> = [];
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async (_db, input) => {
        recorded.push({ eventType: input.eventType, quantity: input.quantity });
      },
    );
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockResolvedValue(
      undefined as never,
    );
    try {
      // A model the test settings price (the default openaiModel). testSettings
      // ships pricing for "scripted-model"; if cost is 0 the debit is skipped, but
      // the model.tokens row and a model.cost row must still be written.
      await recordModelUsageAndDebitCredits(billedSettings(), db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-2",
        model: "scripted-model",
        isCodexTurn: false,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        sourceKey: "response-1",
      });
      expect(recorded.some((r) => r.eventType === "model.tokens" && r.quantity === 1500)).toBe(
        true,
      );
      expect(recorded.some((r) => r.eventType === "model.cost")).toBe(true);
    } finally {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });

  test("malformed token counts cannot create token, cost, or debit quantities", async () => {
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined);
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
      async () => {
        throw new Error("malformed usage must not debit credits");
      },
    );
    try {
      const malformedUsages = [
        {
          inputTokens: 1.5,
          outputTokens: Number.POSITIVE_INFINITY,
          totalTokens: Number.NaN,
        },
        {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: Number.MAX_SAFE_INTEGER,
          totalTokens: Number.MAX_SAFE_INTEGER,
        },
        {
          inputTokens: 1_000_000_001,
          outputTokens: 1_000_000_001,
          totalTokens: 1_000_000_001,
          inputTokensDetails: { cached_tokens: 1_000_000_001 },
        },
        { inputTokens: -1, outputTokens: -2, totalTokens: -3 },
      ];
      for (const [index, usage] of malformedUsages.entries()) {
        await recordModelUsageAndDebitCredits(billedSettings(), db, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          sessionId: "sess-1",
          turnId: "turn-malformed",
          model: "gpt-5.6-sol",
          isCodexTurn: false,
          usage,
          sourceKey: `response-${index}`,
        });
      }

      expect(recordSpy).not.toHaveBeenCalled();
      expect(debitSpy).not.toHaveBeenCalled();
    } finally {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });

  test("valid SDK aggregates are billed once with one canonical cached-token total", async () => {
    const recorded: Array<{ eventType: string; quantity: number }> = [];
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async (_db, input) => {
        recorded.push({ eventType: input.eventType, quantity: input.quantity });
      },
    );
    const debitInputs: Array<Record<string, any>> = [];
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
      async (_db, input) => {
        debitInputs.push(input);
        return {
          balance: {
            accountId: ACCOUNT,
            balanceMicros: 1_000_000,
            currency: "usd",
            updatedAt: new Date().toISOString(),
          },
          debitedMicros: input.requestedAmountMicros,
        };
      },
    );
    try {
      await recordModelUsageAndDebitCredits(billedSettings(), db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-aggregate",
        model: "gpt-5.6-sol",
        isCodexTurn: false,
        usage: {
          inputTokens: 3000,
          outputTokens: 30,
          totalTokens: 3030,
          requestUsageEntries: [
            {
              inputTokens: 1000,
              outputTokens: 10,
              totalTokens: 1010,
              inputTokensDetails: {
                cached_tokens: 100,
                cachedInputTokens: 999,
              },
            },
            {
              inputTokens: 2000,
              outputTokens: 20,
              totalTokens: 2020,
              inputTokensDetails: { cached_tokens: 300 },
            },
          ],
        },
        sourceKey: "aggregate",
      });

      expect(recorded).toContainEqual({ eventType: "model.tokens", quantity: 3030 });
      expect(recorded.some((record) => record.eventType === "model.cost")).toBe(true);
      expect(debitInputs).toHaveLength(1);
      expect(debitInputs[0]?.metadata).toMatchObject({
        inputTokens: 3000,
        outputTokens: 30,
        totalTokens: 3030,
        cachedTokens: 400,
      });
    } finally {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });

  test("inconsistent reported totals cannot suppress token rows, cost, or debit metadata", async () => {
    const settings = testSettings({
      billingMode: "stripe",
      usageLimitsMode: "managed",
      modelPricingJson: JSON.stringify({
        "scripted-model": {
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 1_000_000,
        },
      }),
    });
    const recorded: Array<{ eventType: string; quantity: number; sourceResourceId: string }> = [];
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async (_db, input) => {
        recorded.push({
          eventType: input.eventType,
          quantity: input.quantity,
          sourceResourceId: input.sourceResourceId,
        });
      },
    );
    const debitInputs: Array<Record<string, any>> = [];
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
      async (_db, input) => {
        debitInputs.push(input);
        return {
          balance: {
            accountId: ACCOUNT,
            balanceMicros: 1_000_000,
            currency: "usd",
            updatedAt: new Date().toISOString(),
          },
          debitedMicros: input.requestedAmountMicros,
        };
      },
    );
    try {
      const cases = [
        {
          sourceKey: "zero-total",
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 0 },
          expectedTotal: 120,
        },
        {
          sourceKey: "low-total",
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 3 },
          expectedTotal: 120,
        },
        {
          sourceKey: "request-authority",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            requestUsageEntries: [
              { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
              { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
            ],
          },
          expectedTotal: 350,
        },
      ];
      for (const value of cases) {
        await recordModelUsageAndDebitCredits(settings, db, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          sessionId: "sess-1",
          turnId: "turn-inconsistent",
          model: "scripted-model",
          isCodexTurn: false,
          usage: value.usage,
          sourceKey: value.sourceKey,
        });
      }

      for (const value of cases) {
        expect(recorded).toContainEqual({
          eventType: "model.tokens",
          quantity: value.expectedTotal,
          sourceResourceId: `turn-inconsistent:${value.sourceKey}`,
        });
      }
      expect(debitInputs).toHaveLength(cases.length);
      expect(debitInputs.map((input) => input.metadata.totalTokens)).toEqual(
        cases.map((value) => value.expectedTotal),
      );
      expect(debitInputs[2]?.metadata).toMatchObject({
        inputTokens: 300,
        outputTokens: 50,
        totalTokens: 350,
      });
    } finally {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });
});
