import { describe, expect, spyOn, test } from "bun:test";
import { withWorkspaceOpperCredential } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import { recordModelUsageAndDebitCredits } from "../src/activities/agent-turn";

const db = {} as Database;
const SONNET = "aws/claude-sonnet-4-6-eu";

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

const usage = { inputTokens: 669, outputTokens: 33, totalTokens: 702 };

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
          model: `opper/${SONNET}`,
          externallyBilled: false,
          // Live Opper response: usage.opper.cost.total = 0.0027522 USD.
          gatewayBilling: { finalProvider: "opper", inferenceCostUsd: "0.0027522" },
          usage,
          sourceKey: "response-opper",
        },
      );
      // 2,752.2 micros -> 2,753 provider micros; x1.05 -> 2,889.81 -> 2,890.
      expect(s.recorded).toContainEqual({ eventType: "model.cost", quantity: 2_890 });
      expect(s.debits[0]).toMatchObject({ requestedAmountMicros: 2_890 });
      expect(billing).toMatchObject({
        billingPath: "opengeni_credits",
        pricedCostMicros: 2_890,
        estimatedProviderCostMicros: 2_753,
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
          model: `opper/${SONNET}`,
          externallyBilled: false,
          usage,
          sourceKey: "response-opper-static",
        },
      );
      // (669 * $3.30 + 33 * $16.50) / 1M = $0.0027522, x1.05; the static path
      // rounds each token class up, so it lands one micro above the exact cost.
      expect(billing).toMatchObject({
        pricedCostMicros: 2_891,
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
        model: `workspace-opper/${SONNET}`,
        externallyBilled: true,
        gatewayBilling: { finalProvider: "opper", inferenceCostUsd: "0.0027522" },
        usage,
        sourceKey: "response-workspace-opper",
      });
      expect(s.debits).toHaveLength(0);
      expect(billing).toMatchObject({
        billingPath: "external",
        pricedCostMicros: 0,
        estimatedProviderCostMicros: 2_753,
      });
    } finally {
      s.restore();
    }
  });
});
