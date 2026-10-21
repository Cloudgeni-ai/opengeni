import { expect, test } from "bun:test";
import { acquireSharedTestDatabase, MemoryEventBus, testSettings } from "@opengeni/testing";
import {
  applyCreditDebitUpToBalance,
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  grantPlanCreditPeriod,
  upsertOrganizationPlan,
} from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { createApp } from "../src/app";
import {
  freeCreditGap,
  freeCreditGapReason,
} from "../../../packages/react/src/app/lib/free-credit-gap";
import type { PickerModelRow } from "../../../packages/react/src/app/lib/model-policy";

test("only Free monthly credit funds the catalog hint and uncovered-model gap", async () => {
  const shared = await acquireSharedTestDatabase("free-plan-credit-catalog");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  const client = createDb(shared.appUrl, { max: 4 });
  try {
    const user = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test:free-plan",
      accountExternalId: user,
      accountName: "Free plan",
      workspaceExternalSource: "test:free-plan",
      workspaceExternalId: user,
      workspaceName: "Free plan",
      subjectId: `user:${user}`,
    });
    const grant = access.workspaceGrants[0]!;
    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      type: "grant",
      amountMicros: 0,
      sourceType: "verified_signup_trial",
      sourceId: user,
      idempotencyKey: `verified-signup-trial:v1:${user}`,
      eligibleModelIds: ["gpt-6-luna"],
    });
    const beforeMonthly = await applyCreditDebitUpToBalance(client.db, {
      accountId: grant.accountId,
      type: "model_debit",
      requestedAmountMicros: 1,
      modelId: "gpt-6-luna",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(beforeMonthly.debitedMicros).toBe(0);
    const period = {
      accountId: grant.accountId,
      planKey: "free",
      periodStart: new Date(Date.now() - 1000),
      periodEnd: new Date(Date.now() + 3600000),
    };
    await upsertOrganizationPlan(client.db, {
      ...period,
      status: "active",
      currentPeriodStart: period.periodStart,
      currentPeriodEnd: period.periodEnd,
    });
    await grantPlanCreditPeriod(client.db, period);
    const settings = testSettings({
      productAccessMode: "managed",
      delegationSecret: "free-plan-test",
      billingMode: "stripe",
      stripeSecretKey: "sk_test_example",
      sandboxBackend: "none",
      openrouterApiKey: "test-key",
      openaiAllowedModels: "gpt-6-astra,gpt-6-sol,gpt-6-luna",
    });
    const app = createApp({
      settings,
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
      managedAuth: null,
    });
    const token = await signDelegatedAccessToken(settings.delegationSecret!, {
      ...grant,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const response = await app.request(`/v1/workspaces/${grant.workspaceId}/model-catalog`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const catalog = await response.json();
    expect(catalog.models.find((m: { id: string }) => m.id === "gpt-6-luna").creditFunding).toBe(
      "promotional",
    );
    expect(catalog.models.find((m: { id: string }) => m.id === "gpt-6-astra").creditFunding).toBe(
      "unavailable",
    );
    const rows = catalog.models.map((model: { id: string; label: string }) => ({
      id: model.id,
      label: model.label,
      selectable: true,
      catalog: model,
    })) as PickerModelRow[];
    const gap = freeCreditGap(rows, "gpt-6-astra");
    expect(gap).not.toBeNull();
    expect(freeCreditGapReason(gap!)).toContain("Your free credits don't cover");
    expect(gap!.covered.map((m) => m.id)).toContain("gpt-6-luna");
  } finally {
    await client.close();
    await shared.release();
  }
}, 180_000);
