import { describe, expect, spyOn, test } from "bun:test";
import {
  resolveTurnExecutionPolicyV1,
  withOrganizationAzureOpenAICredential,
} from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import {
  recordModelUsageAndDebitCredits,
  turnExecutionPolicyBillingIdentity,
} from "../src/activities/agent-turn";
import { useNoSessionUsageLimitForFakeDatabases } from "@opengeni/testing/session-usage-limits";
// Fake databases have no per-task usage limit state.
useNoSessionUsageLimitForFakeDatabases();

const db = {} as Database;
const MODEL_ID = "organization-azure-openai/gpt-6.1-sol";

function settings() {
  return withOrganizationAzureOpenAICredential(
    testSettings({ billingMode: "stripe", usageLimitsMode: "managed" }),
    "azure-org-key",
    {
      endpoint: "https://contoso.openai.azure.com/openai/v1",
      models: [{ upstreamModelId: "gpt-6.1-sol" }],
    },
  );
}

describe("organization Azure OpenAI usage", () => {
  test("an accepted turn is organization-paid and externally metered", () => {
    const policy = resolveTurnExecutionPolicyV1(settings(), {
      modelId: MODEL_ID,
      requestedModelId: MODEL_ID,
      modelSource: "explicit",
      reasoningEffort: "medium",
      reasoningSource: "deployment",
    });
    expect(policy).toMatchObject({
      providerId: "organization-azure-openai",
      upstreamModelId: "gpt-6.1-sol",
      credentialSource: { kind: "organization_connection", mechanism: "api_key" },
      billing: { upstreamPayer: "organization", metering: "external" },
    });
    expect(turnExecutionPolicyBillingIdentity(policy)).toEqual({
      externallyBilled: true,
      countsTowardTokenCap: false,
      codexSubscription: false,
      xaiSubscription: false,
    });
  });

  test("usage is recorded for the organization and never debits Opengeni credits", async () => {
    const recorded: Array<{ eventType: string; quantity: number }> = [];
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async (_db, input) => {
        recorded.push({ eventType: input.eventType, quantity: input.quantity });
      },
    );
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance");
    try {
      const billing = await recordModelUsageAndDebitCredits(settings(), db, {
        accountId: "acct",
        workspaceId: "ws",
        sessionId: "sess",
        turnId: "turn-organization-azure",
        turnAttemptId: "attempt",
        model: MODEL_ID,
        externallyBilled: true,
        usage: { inputTokens: 700, outputTokens: 80, totalTokens: 780 },
        sourceKey: "response-organization-azure",
      });
      expect(debitSpy).not.toHaveBeenCalled();
      expect(billing).toMatchObject({ billingPath: "external", pricedCostMicros: 0 });
      expect(recorded.some((event) => event.eventType === "model.cost" && event.quantity > 0)).toBe(
        false,
      );
    } finally {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });
});
