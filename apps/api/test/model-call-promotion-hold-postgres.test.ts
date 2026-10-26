import { expect, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  getBillingBalance,
  grantPlanCreditPeriod,
  upsertOrganizationPlan,
} from "@opengeni/db";
import * as provider from "@opengeni/runtime/model-call";
import { acquireRestrictedRuntimeTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createModelCallService } from "../src/model-calls/service";

test("direct model API refuses held Free credits before dispatch and preserves paid funding", async () => {
  const shared = await acquireRestrictedRuntimeTestDatabase("model-call-promotion-hold");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  const client = createDb(shared.appUrl, { max: 2, searchPath: shared.schema });
  const restores: Array<{ mockRestore(): void }> = [];
  try {
    const user = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test:model-call-hold",
      accountExternalId: user,
      accountName: "Model call hold",
      workspaceExternalSource: "test:model-call-hold",
      workspaceExternalId: user,
      workspaceName: "Model call hold",
      subjectId: `user:${user}`,
    });
    const grant = access.workspaceGrants[0]!;
    const model = "gpt-6-luna";
    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      type: "grant",
      amountMicros: 0,
      sourceType: "verified_signup_trial",
      sourceId: user,
      idempotencyKey: `verified-signup-trial:v1:${user}`,
      eligibleModelIds: [model],
    });
    const period = {
      accountId: grant.accountId,
      planKey: "free",
      periodStart: new Date(Date.now() - 1000),
      periodEnd: new Date(Date.now() + 3_600_000),
    };
    await upsertOrganizationPlan(client.db, {
      ...period,
      status: "active",
      currentPeriodStart: period.periodStart,
      currentPeriodEnd: period.periodEnd,
    });
    await grantPlanCreditPeriod(client.db, period);
    const settings = testSettings({ billingMode: "stripe", usageLimitsMode: "managed" });
    const selection = {
      model: {
        id: model,
        credentialSource: { kind: "deployment" },
        billing: { metering: "opengeni_credits", upstreamPayer: "deployment" },
        capabilities: { inputModalities: ["text"], structuredOutput: { runnable: true } },
      },
    } as never;
    // Keep catalog/provider availability offline. Admission, RLS, promotion
    // evaluation and the spendable balance all use their real implementations.
    restores.push(
      spyOn(core, "resolveWorkspaceCatalogSettings").mockResolvedValue({ settings } as never),
      spyOn(core, "resolveCallerWorkspaceModelSelections").mockResolvedValue([selection]),
      spyOn(core, "admissibleWorkspaceModel").mockReturnValue(selection),
      spyOn(core, "settingsWithModelProviderCredentials").mockResolvedValue(settings),
      spyOn(provider.MultiProviderModelProvider.prototype, "resolveBinding").mockReturnValue({
        client: {},
        provider: { id: "offline" },
        modelId: model,
      } as never),
    );
    const dispatch = spyOn(provider, "runSingleModelCall").mockResolvedValue({
      text: "offline fixture",
    } as never);
    restores.push(dispatch);
    const service = createModelCallService({ db: client.db, settings });
    const call = () =>
      service.call({
        grant: { ...grant, principalKind: "api_key" },
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        model,
        requestId: crypto.randomUUID(),
        request: { messages: [{ role: "user", content: "fixture" }] } as never,
      });

    await call();
    expect(dispatch).toHaveBeenCalledTimes(1);
    await shared.admin`select opengeni_private.set_promotion_enforcement(true,'test','direct model admission regression',true)`;
    await shared.admin`select opengeni_private.set_promotion_decision(${grant.accountId}::uuid,'held','test','direct API farming','{}'::jsonb,'operator:test',0)`;
    await expect(call()).rejects.toMatchObject({ status: 402, code: "insufficient_credits" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await getBillingBalance(client.db, grant.accountId)).toMatchObject({
      balanceMicros: 10_000_000,
      heldCreditMicros: 10_000_000,
    });

    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      type: "credit_topup",
      amountMicros: 3_000_000,
      idempotencyKey: crypto.randomUUID(),
    });
    await call();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(await getBillingBalance(client.db, grant.accountId)).toMatchObject({
      balanceMicros: 13_000_000,
      heldCreditMicros: 10_000_000,
    });
  } finally {
    for (const mocked of restores.reverse()) mocked.mockRestore();
    await client.close();
    await shared.release();
  }
}, 180_000);
