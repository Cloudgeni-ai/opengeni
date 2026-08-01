import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import {
  recordAuthoritativeModelCallFact,
  recordModelUsageAndDebitCredits,
} from "../src/activities/agent-turn";

const ACCOUNT = "acct-1";
const WORKSPACE = "ws-1";
const db = {} as Database;

function billedSettings() {
  return testSettings({ billingMode: "stripe", usageLimitsMode: "managed" });
}

describe("recordAuthoritativeModelCallFact", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

  test("soft-fails fact persist without throwing", async () => {
    const factSpy = spyOn(opengeniDb, "recordModelCallFact").mockImplementation(async () => {
      throw new Error("db unavailable");
    });
    restores.push(() => factSpy.mockRestore());
    const warns: string[] = [];
    await recordAuthoritativeModelCallFact({
      db,
      observability: {
        warn: (message: string) => {
          warns.push(message);
        },
      } as never,
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-1",
      turnId: "turn-1",
      turnAttemptId: "attempt-1",
      sourceKey: "response-1",
      provider: "openai",
      providerApi: "responses",
      model: "scripted-model",
      billing: {
        billingPath: "opengeni_credits",
        pricedCostMicros: 1000,
        normalizedUsage: {
          telemetry: {
            inputTokens: 10,
            outputTokens: 2,
            cachedTokens: 1,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
          totalTokens: 12,
          rejectedFields: [],
        },
      },
    });
    expect(warns).toEqual(["model call fact persist failed"]);
    expect(factSpy).toHaveBeenCalledTimes(1);
  });

  test("external billing returns pricedCostMicros 0 for facts", async () => {
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
    restores.push(() => recordSpy.mockRestore());
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
      async () => {
        throw new Error("credits must NOT be debited for an externally billed turn");
      },
    );
    restores.push(() => debitSpy.mockRestore());
    const billing = await recordModelUsageAndDebitCredits(billedSettings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-1",
      turnId: "turn-1",
      turnAttemptId: "attempt-1",
      model: "codex/gpt-5.6-sol",
      externallyBilled: true,
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      sourceKey: "response-1",
    });
    expect(billing.billingPath).toBe("external");
    expect(billing.pricedCostMicros).toBe(0);
    expect(debitSpy).not.toHaveBeenCalled();
  });
});
