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
    accountId: ACCOUNT, balanceMicros: 0, currency: "usd", updatedAt: new Date().toISOString(),
  });
  return () => spy.mockRestore();
}

describe("worker ensureRunAllowed — codex bypass", () => {
  test("(a) codex turn with 0 credits does NOT throw (credit gate skipped, balance never read)", async () => {
    let balanceRead = false;
    const spy = spyOn(opengeniDb, "getBillingBalance").mockImplementation(async () => {
      balanceRead = true;
      return { accountId: ACCOUNT, balanceMicros: 0, currency: "usd", updatedAt: new Date().toISOString() };
    });
    try {
      await ensureRunAllowed(billedSettings(), db, ACCOUNT, WORKSPACE, /* isCodexTurn */ true);
      expect(balanceRead).toBe(false); // short-circuited before any balance read
    } finally { spy.mockRestore(); }
  });

  test("(c) a normal turn with 0 credits still throws insufficient OpenGeni credits", async () => {
    const restore = mockZeroBalance();
    try {
      await expect(ensureRunAllowed(billedSettings(), db, ACCOUNT, WORKSPACE, /* isCodexTurn */ false))
        .rejects.toThrow("insufficient OpenGeni credits");
    } finally { restore(); }
  });
});

describe("worker recordModelUsageAndDebitCredits — codex usage recording", () => {
  test("(d) codex turn records model.cost=0, does NOT throw 'Missing model pricing', and never debits", async () => {
    const recorded: Array<{ eventType: string; quantity: number; unit: string }> = [];
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(async (_db, input) => {
      recorded.push({ eventType: input.eventType, quantity: input.quantity, unit: input.unit });
    });
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(async () => {
      throw new Error("credits must NOT be debited for a codex turn");
    });
    try {
      await recordModelUsageAndDebitCredits(billedSettings(), db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-1",
        model: "codex/gpt-5.5", // has NO OpenGeni pricing
        isCodexTurn: true,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        sourceKey: "response-1",
      });
      // Exactly one event: a zero-cost audit marker. NO model.tokens row (it would
      // feed the OpenGeni token cap a codex turn is exempt from).
      expect(recorded).toEqual([{ eventType: "model.cost", quantity: 0, unit: "usd_micros" }]);
      expect(debitSpy).not.toHaveBeenCalled();
    } finally { recordSpy.mockRestore(); debitSpy.mockRestore(); }
  });

  test("(control) a normal turn still records model.tokens and a non-zero model.cost", async () => {
    const recorded: Array<{ eventType: string; quantity: number }> = [];
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(async (_db, input) => {
      recorded.push({ eventType: input.eventType, quantity: input.quantity });
    });
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockResolvedValue(undefined as never);
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
      expect(recorded.some((r) => r.eventType === "model.tokens" && r.quantity === 1500)).toBe(true);
      expect(recorded.some((r) => r.eventType === "model.cost")).toBe(true);
    } finally { recordSpy.mockRestore(); debitSpy.mockRestore(); }
  });
});
