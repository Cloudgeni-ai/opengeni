import { expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import { withOrganizationAzureOpenAICredential } from "@opengeni/config";
import { ADD_CREDITS_ACTION } from "@opengeni/contracts";
import { requireLimit, type ApiRouteDeps } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import { HTTPException } from "hono/http-exception";
import { insufficientCreditsHttpError } from "../src/http/api-error";
import { siteUnfundedReason } from "../src/site-publishing/agent-model";

test("an own-key run without paid credit is a 402 that offers Add credits", async () => {
  const settings = withOrganizationAzureOpenAICredential(
    testSettings({ billingMode: "stripe", usageLimitsMode: "managed", byokPlatformFeeBps: 500 }),
    "azure-org-key",
    {
      endpoint: "https://contoso.openai.azure.com/openai/v1",
      models: [{ upstreamModelId: "gpt-6.1-sol" }],
    },
  );
  const balance = spyOn(opengeniDb, "getByokFeeSpendableBalance").mockResolvedValue({
    accountId: "acct-1",
    balanceMicros: 0,
    currency: "usd",
    updatedAt: new Date().toISOString(),
  });
  const codex = spyOn(opengeniDb, "isCodexBilledTurn").mockResolvedValue(false);
  const allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(null);
  let failure: unknown;
  try {
    await requireLimit({ settings, db: {} as opengeniDb.Database } as ApiRouteDeps, {
      accountId: "acct-1",
      workspaceId: "ws-1",
      action: "agent_run:create",
      quantity: 1,
      model: "organization-azure-openai/gpt-6.1-sol",
    });
  } catch (error) {
    failure = error;
  } finally {
    balance.mockRestore();
    codex.mockRestore();
    allowance.mockRestore();
  }
  expect(failure).toBeInstanceOf(HTTPException);
  const mapped = insufficientCreditsHttpError(failure);
  expect(mapped?.status).toBe(402);
  expect(mapped?.message).toBe("Add credits to use your own key.");
  expect(mapped?.details).toEqual({
    code: "byok_paid_credit_required",
    action: ADD_CREDITS_ACTION,
  });
  expect(
    siteUnfundedReason({
      allowed: false,
      code: "byok_paid_credit_required",
      message: "Add credits to use your own key.",
    }),
  ).toBe("no_credits");
});
