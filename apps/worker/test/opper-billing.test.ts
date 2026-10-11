import { describe, expect, spyOn, test } from "bun:test";
import { withWorkspaceOpperCredential } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import { recordModelUsageAndDebitCredits } from "../src/activities/agent-turn";

const db = {} as Database;
const OPUS = "aws/claude-opus-5-5";

function spies() {
  const recorded: Array<{ eventType: string; quantity: number }> = [];
  const debits: Array<Record<string, any>> = [];
  const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(async (_db, input) => {
    recorded.push({ eventType: input.eventType, quantity: input.quantity });
  });
  const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
    async (_db, input) => {
      debits.push(input);
      return {
        balance: {
          accountId: "acct",
          balanceMicros: 1_000_000,
          currency: "usd",
          updatedAt: new Date().toISOString(),
        },
        debitedMicros: input.requestedAmountMicros,
      };
    },
  );
  return {
    recorded,
    debits,
    restore: () => {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    },
  };
}

const usage = { inputTokens: 706, outputTokens: 75, totalTokens: 781 };

describe("Opper reported-cost billing", () => {
  test("deployment Opper debits the exact Opper-reported cost plus 5%", async () => {
    const s = spies();
    try {
      const billing = await recordModelUsageAndDebitCredits(
        testSettings({ billingMode: "stripe", usageLimitsMode: "managed", opperApiKey: "op-x" }),
        db,
        {
          accountId: "acct",
          workspaceId: "ws",
          sessionId: "sess",
          turnId: "turn-opper",
          turnAttemptId: "attempt",
          model: `opper/${OPUS}`,
          externallyBilled: false,
          // Live Opper response: usage.opper.cost.total = 0.0047564 USD.
          gatewayBilling: { finalProvider: "opper", inferenceCostUsd: "0.0047564" },
          usage,
          sourceKey: "response-opper",
        },
      );
      // 4,756.4 micros -> 4,757 provider micros; x1.05 -> 4,994.85 -> 4,995.
      expect(s.recorded).toContainEqual({ eventType: "model.cost", quantity: 4_995 });
      expect(s.debits[0]).toMatchObject({ requestedAmountMicros: 4_995 });
      expect(billing).toMatchObject({
        billingPath: "opengeni_credits",
        pricedCostMicros: 4_995,
        estimatedProviderCostMicros: 4_757,
        pricingSource: "gateway_reported",
        upstreamProvider: "opper",
      });
    } finally {
      s.restore();
    }
  });

  test("without reported cost, deployment Opper falls back to the reviewed static rate", async () => {
    const s = spies();
    try {
      const billing = await recordModelUsageAndDebitCredits(
        testSettings({ billingMode: "stripe", usageLimitsMode: "managed", opperApiKey: "op-x" }),
        db,
        {
          accountId: "acct",
          workspaceId: "ws",
          sessionId: "sess",
          turnId: "turn-opper-static",
          turnAttemptId: "attempt",
          model: `opper/${OPUS}`,
          externallyBilled: false,
          usage,
          sourceKey: "response-opper-static",
        },
      );
      // (706 * $4.40 + 75 * $22.00) / 1M = $0.0047564 (the live reported
      // cost exactly), x1.05 = the same 4,995 micros.
      expect(billing).toMatchObject({
        pricedCostMicros: 4_995,
        pricingSource: "configured_list_price",
      });
    } finally {
      s.restore();
    }
  });

  test("workspace Opper records the exact provider cost and never debits credits", async () => {
    const s = spies();
    try {
      const settings = withWorkspaceOpperCredential(
        testSettings({ billingMode: "stripe", usageLimitsMode: "managed" }),
        "op-workspace",
      );
      const billing = await recordModelUsageAndDebitCredits(settings, db, {
        accountId: "acct",
        workspaceId: "ws",
        sessionId: "sess",
        turnId: "turn-workspace-opper",
        turnAttemptId: "attempt",
        model: `workspace-opper/${OPUS}`,
        externallyBilled: true,
        gatewayBilling: { finalProvider: "opper", inferenceCostUsd: "0.0047564" },
        usage,
        sourceKey: "response-workspace-opper",
      });
      expect(s.debits).toHaveLength(0);
      expect(billing).toMatchObject({
        billingPath: "external",
        pricedCostMicros: 0,
        estimatedProviderCostMicros: 4_757,
      });
    } finally {
      s.restore();
    }
  });
});
