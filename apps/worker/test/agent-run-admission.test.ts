import { describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { agentRunAdmissionDenial } from "../src/activities/agent-run-admission";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";

function mockZeroBalance(): () => void {
  const spy = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
    accountId: ACCOUNT,
    balanceMicros: 0,
    currency: "usd",
    updatedAt: new Date().toISOString(),
  });
  return () => spy.mockRestore();
}

function mockCodexBilled(active: boolean): () => void {
  const spy = spyOn(opengeniDb, "isCodexBilledTurn").mockResolvedValue(active);
  return () => spy.mockRestore();
}

describe("worker agent-run admission funding", () => {
  test("admits SuperGrok subscription runs with zero OpenGeni credits", async () => {
    const restoreBalance = mockZeroBalance();
    const restoreCodex = mockCodexBilled(false);
    try {
      expect(
        await agentRunAdmissionDenial(
          {
            db: {} as opengeniDb.Database,
            entitlements: null,
            settings: testSettings({
              billingMode: "stripe",
              usageLimitsMode: "managed",
              supergrokSubscriptionEnabled: true,
            }),
          },
          {
            accountId: ACCOUNT,
            workspaceId: WORKSPACE,
            model: "supergrok/grok-4.6",
            requestedAgentRuns: 1,
          },
        ),
      ).toBeNull();
    } finally {
      restoreCodex();
      restoreBalance();
    }
  });

  test("keeps an unconnected Codex model behind the credit gate", async () => {
    const restoreBalance = mockZeroBalance();
    const restoreCodex = mockCodexBilled(false);
    try {
      expect(
        await agentRunAdmissionDenial(
          {
            db: {} as opengeniDb.Database,
            entitlements: null,
            settings: testSettings({
              billingMode: "stripe",
              usageLimitsMode: "managed",
              codexSubscriptionEnabled: true,
            }),
          },
          {
            accountId: ACCOUNT,
            workspaceId: WORKSPACE,
            model: "codex/gpt-5.6-sol",
            requestedAgentRuns: 1,
          },
        ),
      ).toBe("insufficient_credits");
    } finally {
      restoreCodex();
      restoreBalance();
    }
  });
});
