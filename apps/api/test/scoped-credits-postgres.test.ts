import Stripe from "stripe";
import assert from "node:assert/strict";
import { acquireSharedTestDatabase, MemoryEventBus, testSettings } from "@opengeni/testing";
import {
  createDb,
  bootstrapWorkspace,
  getBillingBalance,
  listSessionTurns,
  claimSessionWorkForAttempt,
  createApiKey,
} from "@opengeni/db";
import { DEFAULT_OPENROUTER_MODEL_ID } from "@opengeni/config";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { createApp } from "../src/app";
import { applyConnectedModelToNewSessionDraft } from "../../web/src/lib/model-access-onboarding";
import { ensureRunAllowedBetweenModelCalls } from "../../worker/src/activities/agent-turn/admission";
import {
  processModelResponseTerminalEvent,
  processCompactionModelUsageEvent,
  processSessionTitleModelUsageEvent,
  createModelResponseEventState,
  createCompactionModelUsageEventState,
} from "../../worker/src/activities/agent-turn/model-usage";
import { test, spyOn } from "bun:test";

// Real authorization, FORCE RLS, ledger and worker settlement; only Stripe transport is synthetic.
test("scoped checkout through first use, policy changes and paid top-ups stays correctly funded", async () => {
  const shared = await acquireSharedTestDatabase("scoped-credit-integration-review");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL required");
    return;
  }
  const client = createDb(shared.appUrl);
  const fakeStripe = new Stripe("sk_test_example");
  const restores: { mockRestore(): void }[] = [];
  try {
    const sessions = new Map<string, any>();
    const createdParams: any[] = [];
    restores.push(
      spyOn(Object.getPrototypeOf(fakeStripe.promotionCodes), "list").mockImplementation(
        async () => ({
          data: [
            {
              id: "promo_example",
              promotion: {
                coupon: { id: "coupon_example", valid: true, currency: "usd", amount_off: 10000 },
              },
            },
          ],
        }),
      ),
    );
    restores.push(
      spyOn(Object.getPrototypeOf(fakeStripe.customers), "create").mockImplementation(async () => ({
        id: "cus_review",
        email: null,
      })),
    );
    restores.push(
      spyOn(Object.getPrototypeOf(fakeStripe.checkout.sessions), "create").mockImplementation(
        async (params: any) => {
          createdParams.push(params);
          const amount = params.line_items[0].price_data.unit_amount;
          const free = Boolean(params.discounts);
          const session = {
            id: crypto.randomUUID().replaceAll("-", ""),
            mode: "payment",
            status: "open",
            payment_status: "unpaid",
            livemode: false,
            customer: "cus_review",
            url: "https://checkout.example.test/review",
            metadata: params.metadata,
            amount_subtotal: amount,
            amount_total: free ? 0 : amount,
            currency: "usd",
            total_details: {
              amount_discount: free ? amount : 0,
              amount_shipping: 0,
              amount_tax: 0,
            },
          };
          session.id = "cs_test_" + session.id;
          sessions.set(session.id, session);
          return session;
        },
      ),
    );
    restores.push(
      spyOn(Object.getPrototypeOf(fakeStripe.checkout.sessions), "retrieve").mockImplementation(
        async (id: string) => sessions.get(id),
      ),
    );
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test:credit-review",
      accountExternalId: crypto.randomUUID(),
      accountName: "Credit review",
      workspaceExternalSource: "test:credit-review",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Credit review",
      subjectId: `user:credit-review-${crypto.randomUUID()}`,
    });
    const grant = access.workspaceGrants[0]!;
    const [personal] =
      await shared.admin`insert into workspaces (account_id,name) values (${grant.accountId},'Personal') returning id`;
    await shared.admin`insert into organization_memberships (account_id,subject_id,role,status,personal_workspace_id) values (${grant.accountId},${grant.subjectId},'owner','active',${personal!.id})`;
    const settings = testSettings({
      productAccessMode: "managed",
      delegationSecret: "synthetic-review-secret",
      billingMode: "stripe",
      stripeSecretKey: "sk_test_example",
      stripeWebhookSecret: "whsec_example",
      creditPromotionPolicy: {
        defaultModelIds: ["gpt-6-sol"],
        offers: { coupon_example: { label: "Launch credits" } },
      },
      sandboxBackend: "none",
      openaiModel: DEFAULT_OPENROUTER_MODEL_ID,
      openrouterApiKey: "test-key",
      openaiAllowedModels: "gpt-6-astra,gpt-6-sol,gpt-6-luna",
    });
    const app = createApp({
      settings,
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {
        wakeSessionWorkflow: async () => undefined,
        requestSessionWorkflowWakeDispatch: async () => undefined,
      } as never,
      managedAuth: null,
    });
    const billingKey = "ogk_review_" + crypto.randomUUID();
    await createApiKey(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "Credit review",
      prefix: "ogk_review",
      keyHash: new Bun.CryptoHasher("sha256").update(billingKey).digest("hex"),
      permissions: ["billing:read", "billing:manage"],
    });
    const token = await signDelegatedAccessToken(settings.delegationSecret!, {
      ...grant,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    async function request(path: string, body?: unknown, method?: string) {
      return await app.request(path, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          authorization: `Bearer ${path.startsWith("/v1/billing") ? billingKey : token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function json(path: string, body?: unknown, method?: string) {
      const r = await request(path, body, method);
      const parsed = await r.json();
      if (!r.ok) throw new Error(JSON.stringify({ status: r.status, parsed }));
      return parsed;
    }
    const base = `/v1/workspaces/${grant.workspaceId}`;
    const zero = await json(`${base}/model-catalog`);
    assert.equal(zero.defaultSelection.model, DEFAULT_OPENROUTER_MODEL_ID);
    assert.deepEqual(zero.creditsSelection, {
      model: "gpt-6-luna",
      reasoningEffort: "xhigh",
      source: "credits",
    });
    assert(
      zero.models
        .filter((m: any) => m.cost === "credits")
        .every((m: any) => m.creditFunding === "unavailable"),
    );

    const checkout = await json("/v1/billing/checkout", {
      accountId: grant.accountId,
      promotionCode: "LAUNCH100",
    });
    assert.deepEqual(checkout.promotionalScope.eligibleModelIds, ["gpt-6-sol"]);
    const stripeSession = sessions.get(checkout.checkoutSessionId);
    stripeSession.status = "complete";
    stripeSession.payment_status = "no_payment_required";
    const fulfilled = await json(
      `/v1/billing/checkout/${checkout.checkoutSessionId}?accountId=${grant.accountId}`,
    );
    assert.equal(fulfilled.credit.state, "granted");
    assert.equal(fulfilled.balance.generalBalanceMicros, 0);
    assert.equal(fulfilled.balance.promotionalCredits[0].remainingMicros, 100_000_000);
    for (let i = 0; i < 2; i++) {
      const payload = JSON.stringify({
        id: "evt_review_same",
        type: "checkout.session.completed",
        livemode: false,
        data: { object: stripeSession },
      });
      const signature = await fakeStripe.webhooks.generateTestHeaderStringAsync({
        payload,
        secret: "whsec_example",
      });
      const hook = await app.request("/v1/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: payload,
      });
      assert.equal(hook.status, 200, await hook.text());
    }
    assert.equal((await getBillingBalance(client.db, grant.accountId)).balanceMicros, 100_000_000);

    const scope = await json(`${base}/model-catalog`);
    assert.equal(scope.defaultSelection.model, "gpt-6-sol");
    assert.equal(scope.models.find((m: any) => m.id === "gpt-6-sol").creditFunding, "promotional");
    assert.equal(
      scope.models.find((m: any) => m.id === "gpt-6-astra").creditFunding,
      "unavailable",
    );
    const adapter = {
      getWorkspaceModelCatalog: async () => await json(`${base}/model-catalog`),
      getNewSessionDraft: async () => await json(`${base}/new-session-draft`),
      saveNewSessionDraft: async (_id: string, body: unknown) =>
        await json(`${base}/new-session-draft`, body, "PUT"),
    };
    const selected = await applyConnectedModelToNewSessionDraft(
      adapter as never,
      grant.workspaceId,
      "credits",
    );
    assert.equal(selected!.id, "gpt-6-sol");
    const draft = await json(`${base}/new-session-draft`);
    assert.equal(draft.model, "gpt-6-sol");
    assert.equal(draft.reasoningEffort, scope.defaultSelection.reasoningEffort);
    const created = await request(`${base}/sessions`, {
      model: draft.model,
      reasoningEffort: draft.reasoningEffort,
      initialMessage: "Synthetic credit review",
      visibility: "workspace",
      tools: [],
    });
    const session = await created.json();
    assert.equal(created.status, 202, JSON.stringify(session));
    const refused = await request(`${base}/sessions`, {
      model: "gpt-6-astra",
      initialMessage: "Synthetic refusal",
      visibility: "workspace",
      tools: [],
    });
    assert.equal(refused.status, 402, await refused.text());

    const turn = (await listSessionTurns(client.db, grant.workspaceId, session.id))[0]!;
    assert(turn, "created session has accepted turn");
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    assert.equal(claim.action, "claimed");
    const admitted = await ensureRunAllowedBetweenModelCalls({
      settings,
      db: client.db,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      modelId: "gpt-6-sol",
      isExternallyBilledTurn: false,
      chargesOpenGeniCredits: true,
      countsTowardTokenCap: true,
      initiatingHumanSubjectId: null,
    });
    assert.equal(admitted, 0);
    const pendingCheckout = await json("/v1/billing/checkout", {
      accountId: grant.accountId,
      promotionCode: "LAUNCH100",
    });
    assert.deepEqual(pendingCheckout.promotionalScope.eligibleModelIds, ["gpt-6-sol"]);
    await shared.admin`select set_credit_promotion_policy(${shared.admin.json({ defaultModelIds: ["gpt-6-luna"], offers: {} })}::jsonb,'review operator','Switch model coverage')`;
    await assert.rejects(
      ensureRunAllowedBetweenModelCalls({
        settings,
        db: client.db,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        modelId: "gpt-6-sol",
        isExternallyBilledTurn: false,
        chargesOpenGeniCredits: true,
        countsTowardTokenCap: true,
        initiatingHumanSubjectId: null,
      }),
      /insufficient Opengeni credits/,
    );
    const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
    const common = {
      settings,
      db: client.db,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: turn.id,
      turnAttemptId: attemptId,
      model: "gpt-6-sol",
      externallyBilled: false,
      creditPolicyRevision: admitted,
      dispatchId: "review-dispatch",
      provider: "openai",
      providerApi: "responses",
      servingCredentialId: null,
      priorSessionCredentialId: null,
      emittedSourceKeys: new Set<string>(),
      renewLease: async () => undefined,
      leaseLost: () => false,
      leaseLostMessage: "fixture",
      observability: undefined,
      publish: null,
    };
    const main = await processModelResponseTerminalEvent({
      ...common,
      state: createModelResponseEventState(),
      event: {
        type: "raw_model_stream_event",
        data: { type: "response_done", response: { id: "main-review", output: [], usage } },
      },
      metricProvider: "openai",
      setLastInputTokens: async () => undefined,
    } as never);
    assert.equal(main.status, "processed");
    const compaction = await processCompactionModelUsageEvent({
      ...common,
      state: createCompactionModelUsageEventState(),
      usage: { responseId: "compaction-review", usage },
    } as never);
    assert.equal(compaction.status, "processed");
    const title = await processSessionTitleModelUsageEvent({
      ...common,
      state: createCompactionModelUsageEventState(),
      usage: { responseId: "title-review", usage },
    } as never);
    assert.equal(title.status, "processed");
    const final = await getBillingBalance(client.db, grant.accountId);
    assert.equal(final.generalBalanceMicros, 0);
    assert(final.promotionalCredits![0]!.remainingMicros < 100_000_000);
    assert.deepEqual(final.promotionalCredits![0]!.eligibleModelIds, ["gpt-6-luna"]);

    const pendingStripe = sessions.get(pendingCheckout.checkoutSessionId);
    pendingStripe.status = "complete";
    pendingStripe.payment_status = "no_payment_required";
    const late = await json(
      `/v1/billing/checkout/${pendingCheckout.checkoutSessionId}?accountId=${grant.accountId}`,
    );
    assert.equal(late.credit.state, "granted");
    assert.equal(late.balance.generalBalanceMicros, 0);
    assert.equal(late.balance.promotionalCredits.length, 2);
    assert(
      late.balance.promotionalCredits.every(
        (g: any) => g.eligibleModelIds.length === 1 && g.eligibleModelIds[0] === "gpt-6-luna",
      ),
    );
    assert.equal(late.balance.balanceMicros, final.balanceMicros + 100_000_000);
    const replay = await json(
      `/v1/billing/checkout/${pendingCheckout.checkoutSessionId}?accountId=${grant.accountId}`,
    );
    assert.equal(replay.balance.balanceMicros, late.balance.balanceMicros);

    const paid = await json("/v1/billing/checkout", { accountId: grant.accountId, amountUsd: 25 });
    assert.equal(paid.promotionalScope, undefined);
    const paidParams = createdParams.at(-1);
    assert.equal(paidParams.allow_promotion_codes, false);
    assert.equal(paidParams.line_items[0].price_data.unit_amount, 2500);
    assert(
      !Object.keys(paidParams.metadata).some((key) => key.startsWith("opengeni_credit_scope_")),
    );
    const paidStripe = sessions.get(paid.checkoutSessionId);
    paidStripe.status = "complete";
    paidStripe.payment_status = "paid";
    const paidResult = await json(
      `/v1/billing/checkout/${paid.checkoutSessionId}?accountId=${grant.accountId}`,
    );
    assert.equal(paidResult.credit.free, false);
    assert.equal(paidResult.balance.generalBalanceMicros, 25_000_000);
    assert.equal(paidResult.balance.balanceMicros, late.balance.balanceMicros + 25_000_000);
    const paidCatalog = await json(`${base}/model-catalog`);
    assert.equal(
      paidCatalog.models.find((m: any) => m.id === "gpt-6-sol").creditFunding,
      "general",
    );
    assert.equal(
      paidCatalog.models.find((m: any) => m.id === "gpt-6-luna").creditFunding,
      "promotional",
    );
  } finally {
    for (const spy of restores.reverse()) spy.mockRestore();
    await client.close();
    await shared.release();
  }
}, 180_000);
