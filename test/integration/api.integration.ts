import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { allAccountPermissions, allWorkspacePermissions, applyCreditLedgerEntry, bootstrapWorkspace, createDb, dbSql, getBillingBalance, getScheduledTask, listSessionEvents, listScheduledTasks, listSessionTurns, listUsageEvents, recordStripeWebhookEvent, recordUsageEvent, requireSession, setSessionStatus, sumUsageQuantity } from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import { signDelegatedAccessToken, type AccessContext, type SessionEvent } from "@opengeni/contracts";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { buildOpenGeniMcpServer } from "../../apps/api/src/mcp/server";
import { MemoryEventBus, parseSseBlock, startTestServices, testSettings, type TestServices } from "@opengeni/testing";
import { prepareAgentTools } from "@opengeni/runtime";
import { createSignedState, readSignedState } from "@opengeni/github";

describe("API component integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;
  let workflow: FakeWorkflowClient;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false, objectStorage: true });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("creates sessions, persists initial events, and starts workflow", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);

    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "hello",
        clientEventId: "client-create",
        model: "scripted-model",
        reasoningEffort: "xhigh",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    const session = await response.json() as { id: string; temporalWorkflowId: string; model: string; metadata: Record<string, unknown> };
    expect(session.temporalWorkflowId).toBe(`session-${session.id}`);
    expect(session.model).toBe("scripted-model");
    expect(session.metadata.reasoningEffort).toBe("xhigh");
    expect(workflow.wakeups).toHaveLength(1);
    const events = await listSessionEvents(dbClient.db, workspaceId, session.id);
    expect(events.map((event) => event.type)).toEqual(["session.created", "user.message", "session.status.changed", "turn.queued"]);
  });

  test("managed email/password auth bootstraps account access and workspace API keys", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const email = `managed-${crypto.randomUUID()}@example.com`;
    const password = "password1234";
    const signup = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Managed User", email, password }),
    });
    expect(signup.status).toBeGreaterThanOrEqual(200);
    expect(signup.status).toBeLessThan(300);
    await dbClient.db.execute(dbSql`update auth_users set email_verified = true where email = ${email}`);

    const signin = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signin.status).toBeGreaterThanOrEqual(200);
    expect(signin.status).toBeLessThan(300);
    const cookie = signin.headers.get("set-cookie");
    expect(cookie).toBeTruthy();

    const access = await app.request("/v1/access/me", { headers: { cookie: cookie! } });
    expect(access.status).toBe(200);
    const context = await access.json() as AccessContext;
    expect(context.mode).toBe("managed");
    expect(context.accountGrants[0]?.permissions).toContain("billing:manage");
    const workspaceId = context.defaultWorkspaceId!;
    const createdKey = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ name: "Managed test key", permissions: ["workspace:read", "sessions:create"] }),
    });
    expect(createdKey.status).toBe(201);
    const keyBody = await createdKey.json() as { token: string; apiKey: { workspaceId: string } };
    expect(keyBody.token).toStartWith("ogk_");
    expect(keyBody.apiKey.workspaceId).toBe(workspaceId);
  });

  test("managed session cookie still authenticates when an invalid bearer header is present", async () => {
    const userId = `managed-user-${crypto.randomUUID()}`;
    const email = `managed-cookie-${crypto.randomUUID()}@example.com`;
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      managedAuth: {
        api: {
          getSession: async () => ({
            user: { id: userId, email, name: "Managed Cookie User" },
          }),
        },
      } as any,
    });

    const access = await app.request("/v1/access/me", {
      headers: {
        authorization: "Bearer not-a-valid-opengeni-token",
        cookie: "better-auth.session_token=test",
      },
    });
    expect(access.status).toBe(200);
    const context = await access.json() as AccessContext;
    expect(context.mode).toBe("managed");
    expect(context.subjectId).toBe(`user:${userId}`);
    expect(context.defaultWorkspaceId).toBeTruthy();
  });

  test("managed credit gate blocks costly writes and exposes recorded usage", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        usageLimitsMode: "managed",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const context = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:managed-credit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Managed credit test",
      workspaceExternalSource: "test:managed-credit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Managed credit workspace",
      subjectId: "test:managed-credit",
    });
    const grant = context.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId;
    const accountId = grant.accountId;
    const token = await signDelegatedAccessToken("test-delegation-secret", {
      accountId,
      workspaceId,
      subjectId: grant.subjectId,
      permissions: [...grant.permissions, "billing:read"],
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const authHeaders = { authorization: `Bearer ${token}` };

    const blocked = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "blocked until credits exist" }),
    });
    expect(blocked.status).toBe(402);

    await applyCreditLedgerEntry(dbClient.db, {
      accountId,
      type: "credit_topup",
      amountMicros: 1_000_000,
      sourceType: "test",
      sourceId: "managed-credit-gate",
      idempotencyKey: `test-credit:${accountId}`,
    });

    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "allowed with credits" }),
    });
    expect(created.status).toBe(202);
    const session = await created.json() as { id: string };

    const usage = await app.request(`/v1/billing/usage?accountId=${accountId}&workspaceId=${workspaceId}`, { headers: authHeaders });
    expect(usage.status).toBe(200);
    const usageBody = await usage.json() as { usage: Array<{ eventType: string; sourceResourceId: string }> };
    expect(usageBody.usage).toContainEqual(expect.objectContaining({
      eventType: "agent_run.created",
      sourceResourceId: session.id,
    }));
  });

  test("managed credit gate blocks document indexing before enqueueing work", async () => {
    const delegationSecret = "test-managed-document-credit-secret";
    const app = createApp({
      settings: {
        ...objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
        productAccessMode: "managed",
        billingMode: "stripe",
        delegationSecret,
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
        stripeSecretKey: "sk_test_fake",
      },
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      documentIndexer: {
        indexDocument: async () => {
          throw new Error("document indexer should not run without credits");
        },
      },
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:managed-document-credit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Managed document credit test",
      workspaceExternalSource: "test:managed-document-credit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Managed document credit workspace",
      subjectId: `test:managed-document-credit:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: access.defaultAccountId!,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const headers = { authorization: `Bearer ${token}` };
    const baseResponse = await app.request(workspacePath(workspaceId, "/document-bases"), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ name: "No credit docs" }),
    });
    expect(baseResponse.status).toBe(201);
    const base = await baseResponse.json() as { id: string };

    const blocked = await app.request(workspacePath(workspaceId, `/document-bases/${base.id}/documents`), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ fileId: crypto.randomUUID() }),
    });
    expect(blocked.status).toBe(402);
    expect(await blocked.text()).toContain("insufficient OpenGeni credits");
  });

  test("static usage limits enforce operator caps without Better Auth or Stripe", async () => {
    const delegationSecret = "test-static-usage-limits-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({
          maxWorkspacesPerAccount: 1,
          maxApiKeysPerWorkspace: 1,
          maxMonthlyAgentRunsPerWorkspace: 1,
        }),
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:static-usage-limits",
      accountExternalId: crypto.randomUUID(),
      accountName: "Static limits test",
      workspaceExternalSource: "test:static-usage-limits",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Static limits workspace",
      subjectId: `test:static-usage-limits:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const accountId = access.defaultAccountId!;
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const authHeaders = { authorization: `Bearer ${token}` };

    const extraWorkspace = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ accountId, name: "extra workspace" }),
    });
    expect(extraWorkspace.status).toBe(429);

    const keyOne = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ name: "first key", permissions: ["workspace:read"] }),
    });
    expect(keyOne.status).toBe(201);
    const keyTwo = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ name: "second key", permissions: ["workspace:read"] }),
    });
    expect(keyTwo.status).toBe(429);

    const runOne = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "allowed first run" }),
    });
    expect(runOne.status).toBe(202);
    const runTwo = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "blocked second run" }),
    });
    expect(runTwo.status).toBe(429);
  });

  test("static monthly cost cap blocks costly actions once reached", async () => {
    const delegationSecret = "test-static-cost-limit-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({ maxMonthlyCostMicrosPerAccount: 100 }),
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:static-cost-limit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Static cost limit test",
      workspaceExternalSource: "test:static-cost-limit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Static cost limit workspace",
      subjectId: `test:static-cost-limit:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const accountId = access.defaultAccountId!;
    await recordUsageEvent(dbClient.db, {
      accountId,
      workspaceId,
      eventType: "model.cost",
      quantity: 100,
      unit: "usd_micros",
      sourceResourceType: "test",
      sourceResourceId: "static-cost-limit",
      idempotencyKey: `test:model.cost:${accountId}:static-cost-limit`,
    });
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const blocked = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ initialMessage: "blocked by cost cap" }),
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("monthly model cost limit reached");
  });

  test("Stripe webhooks apply checkout, refund, and dispute ledger entries idempotently", async () => {
    const webhookSecret = "whsec_test_webhook_secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        billingMode: "stripe",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
        stripeSecretKey: "sk_test_fake",
        stripeWebhookSecret: webhookSecret,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const context = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:stripe-webhook",
      accountExternalId: crypto.randomUUID(),
      accountName: "Stripe webhook test",
      workspaceExternalSource: "test:stripe-webhook",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Stripe webhook workspace",
      subjectId: "test:stripe-webhook",
    });
    const accountId = context.defaultAccountId!;
    const metadata = {
      opengeni_account_id: accountId,
      opengeni_package_id: "topup_25",
      opengeni_credit_micros: "25000000",
      opengeni_credit_idempotency_key: `stripe:test:checkout:${accountId}`,
    };

    const checkout = await postStripeEvent(app, webhookSecret, {
      id: `evt_checkout_${crypto.randomUUID()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_test_${crypto.randomUUID()}`,
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_test_123",
          customer_email: "billing@example.com",
          customer_details: { email: "billing@example.com" },
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (checkout.status !== 200) {
      throw new Error(`checkout webhook failed: ${checkout.status} ${await checkout.text()}`);
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);

    await checkout.json();
    const duplicate = await postStripeEvent(app, webhookSecret, {
      id: `evt_checkout_duplicate_${crypto.randomUUID()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_test_duplicate_${crypto.randomUUID()}`,
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_test_123",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (duplicate.status !== 200) {
      throw new Error(`duplicate checkout webhook failed: ${duplicate.status} ${await duplicate.text()}`);
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);

    const refund = await postStripeEvent(app, webhookSecret, {
      id: `evt_refund_${crypto.randomUUID()}`,
      object: "event",
      type: "refund.created",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "re_test_123",
          object: "refund",
          amount: 500,
          currency: "usd",
          status: "succeeded",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (refund.status !== 200) {
      throw new Error(`refund webhook failed: ${refund.status} ${await refund.text()}`);
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(20_000_000);

    const releaseWithoutHold = await postStripeEvent(app, webhookSecret, {
      id: `evt_dispute_release_without_hold_${crypto.randomUUID()}`,
      object: "event",
      type: "charge.dispute.funds_reinstated",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "dp_without_hold",
          object: "dispute",
          amount: 1000,
          currency: "usd",
          status: "won",
          charge: "ch_test_without_hold",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (releaseWithoutHold.status !== 200) {
      throw new Error(`dispute release without hold webhook failed: ${releaseWithoutHold.status} ${await releaseWithoutHold.text()}`);
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(20_000_000);

    const disputeHold = await postStripeEvent(app, webhookSecret, {
      id: `evt_dispute_${crypto.randomUUID()}`,
      object: "event",
      type: "charge.dispute.created",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "dp_test_123",
          object: "dispute",
          amount: 1000,
          currency: "usd",
          status: "needs_response",
          charge: "ch_test_123",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (disputeHold.status !== 200) {
      throw new Error(`dispute hold webhook failed: ${disputeHold.status} ${await disputeHold.text()}`);
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(10_000_000);

    const disputeRelease = await postStripeEvent(app, webhookSecret, {
      id: `evt_dispute_release_${crypto.randomUUID()}`,
      object: "event",
      type: "charge.dispute.closed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "dp_test_123",
          object: "dispute",
          amount: 1000,
          currency: "usd",
          status: "won",
          charge: "ch_test_123",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (disputeRelease.status !== 200) {
      throw new Error(`dispute release webhook failed: ${disputeRelease.status} ${await disputeRelease.text()}`);
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(20_000_000);
  });

  test("Stripe webhook retry processes stored events that were not marked processed", async () => {
    const webhookSecret = "whsec_test_webhook_retry_secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        billingMode: "stripe",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
        stripeSecretKey: "sk_test_fake",
        stripeWebhookSecret: webhookSecret,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const context = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:stripe-webhook-retry",
      accountExternalId: crypto.randomUUID(),
      accountName: "Stripe webhook retry test",
      workspaceExternalSource: "test:stripe-webhook-retry",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Stripe webhook retry workspace",
      subjectId: "test:stripe-webhook-retry",
    });
    const accountId = context.defaultAccountId!;
    const event = {
      id: `evt_checkout_retry_${crypto.randomUUID()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_test_retry_${crypto.randomUUID()}`,
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_test_retry",
          customer_email: "retry@example.com",
          customer_details: { email: "retry@example.com" },
          payment_intent: "pi_test_retry",
          metadata: {
            opengeni_account_id: accountId,
            opengeni_package_id: "topup_25",
            opengeni_credit_micros: "25000000",
            opengeni_credit_idempotency_key: `stripe:test:checkout-retry:${accountId}`,
          },
        },
      },
    };
    await recordStripeWebhookEvent(dbClient.db, {
      id: event.id,
      type: event.type,
      livemode: event.livemode,
      payload: event,
    });

    const retry = await postStripeEvent(app, webhookSecret, event);
    if (retry.status !== 200) {
      throw new Error(`retry checkout webhook failed: ${retry.status} ${await retry.text()}`);
    }
    expect(await retry.json()).toEqual({ received: true });
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);

    const duplicate = await postStripeEvent(app, webhookSecret, event);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ received: true, duplicate: true });
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);
  });

  test("rejects unknown MCP tool refs during session create", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "search docs",
        tools: [{ kind: "mcp", id: "docs" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(422);
  });

  test("persists valid MCP tool refs on sessions", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers: [{
          id: "docs",
          name: "Document Search",
          url: "http://127.0.0.1:8787/mcp",
          allowedTools: ["search_documents", "fetch_document"],
          cacheToolsList: false,
        }],
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "search docs",
        tools: [{ kind: "mcp", id: "docs" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    const session = await response.json() as { tools: unknown[] };
    expect(session.tools).toEqual([{ kind: "mcp", id: "docs" }]);
  });

  test("adds MCP tool refs on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers: [{
          id: "docs",
          name: "Document Search",
          url: "http://127.0.0.1:8787/mcp",
          allowedTools: ["search_documents"],
          cacheToolsList: false,
        }],
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);

    const accepted = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: { text: "search docs", tools: [{ kind: "mcp", id: "docs" }] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(accepted.status).toBe(202);
    const event = await accepted.json() as SessionEvent;
    expect(event.payload).toEqual({ text: "search docs", tools: [{ kind: "mcp", id: "docs" }] });
    expect((await requireSession(dbClient.db, workspaceId, session.id)).tools).toEqual([{ kind: "mcp", id: "docs" }]);

    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const duplicate = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: { text: "again", tools: [{ kind: "mcp", id: "docs" }] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(duplicate.status).toBe(202);
    const currentSession = await requireSession(dbClient.db, workspaceId, session.id);
    expect(currentSession.tools).toEqual([{ kind: "mcp", id: "docs" }]);
    const turnIds = new Set((await listSessionTurns(dbClient.db, workspaceId, session.id)).map((turn) => turn.id));
    const usage = await listUsageEvents(dbClient.db, {
      accountId: currentSession.accountId,
      workspaceId,
      limit: 100,
    });
    expect(usage
      .filter((event) => event.eventType === "agent_run.created")
      .filter((event) => event.sourceResourceId === session.id || turnIds.has(event.sourceResourceId ?? ""))
    ).toHaveLength(3);
  });

  test("queues model settings on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "hello",
        model: "scripted-model",
        reasoningEffort: "low",
      }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);

    const accepted = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: {
          text: "use a stronger model",
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(accepted.status).toBe(202);
    const event = await accepted.json() as SessionEvent;
    expect(event.payload).toEqual({
      text: "use a stronger model",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    });
    const turns = await listSessionTurns(dbClient.db, workspaceId, session.id);
    const turn = turns.find((item) => item.triggerEventId === event.id);
    expect(turn?.model).toBe("gpt-5.5");
    expect(turn?.reasoningEffort).toBe("xhigh");
  });

  test("queues concurrent follow-up user messages while merging session tools", async () => {
    const mcpServers = Array.from({ length: 12 }, (_, index) => ({
      id: `docs-${index}`,
      name: `Docs ${index}`,
      url: `http://127.0.0.1:${8787 + index}/mcp`,
      allowedTools: ["search_documents"],
      cacheToolsList: false,
    }));
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);

    const responses = await Promise.all(mcpServers.map((server) => app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: { text: `search ${server.id}`, tools: [{ kind: "mcp", id: server.id }] },
      }),
      headers: { "content-type": "application/json" },
    })));

    expect(responses.filter((response) => response.status === 202)).toHaveLength(mcpServers.length);
    expect((await requireSession(dbClient.db, workspaceId, session.id)).tools).toHaveLength(mcpServers.length);
  });

  test("rejects unknown MCP tool refs on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const rejected = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: { text: "search docs", tools: [{ kind: "mcp", id: "docs" }] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(rejected.status).toBe(422);
  });

  test("returns client model and reasoning config", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("/v1/config/client");
    expect(response.status).toBe(200);
    const payload = await response.json() as { deploymentRevision: string; defaultModel: string; allowedReasoningEfforts: string[]; fileUploads: { enabled: boolean; maxSizeBytes: number } };
    expect(payload.deploymentRevision).toBe("dev");
    expect(payload.defaultModel).toBe("scripted-model");
    expect(payload.allowedReasoningEfforts).toContain("high");
    expect(payload.fileUploads).toEqual({ enabled: false, maxSizeBytes: 5_000_000_000 });
  });

  test("enforces shared-key auth on user-facing routes when enabled", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        authRequired: true,
        accessKey: "local-test-key",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });

    const config = await app.request("/v1/config/client");
    expect(config.status).toBe(200);
    expect((await config.json() as { auth: { mode: string } }).auth.mode).toBe("deploymentKey");

    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/metrics")).status).toBe(401);
    const authHeaders = { "x-opengeni-access-key": "local-test-key" };
    const workspaceId = await defaultWorkspaceId(app, authHeaders);
    expect((await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "blocked" }),
      headers: { "content-type": "application/json" },
    })).status).toBe(401);

    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "allowed" }),
      headers: {
        "content-type": "application/json",
        "x-opengeni-access-key": "local-test-key",
      },
    });
    expect(created.status).toBe(202);
  });

  test("can explicitly allow unauthenticated metrics for internal scrapers", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        authRequired: true,
        accessKey: "local-test-key",
        authAllowMetrics: true,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });

    const response = await app.request("/metrics");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("opengeni_http_requests_total");
  });

  test("creates and manages scheduled tasks", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "hourly",
        schedule: { type: "interval", everySeconds: 3600 },
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    const task = await created.json() as { id: string; temporalScheduleId: string };
    expect(task.temporalScheduleId).toBe(`scheduled-task-${task.id}`);
    expect(workflow.synced).toHaveLength(1);

    const paused = await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}/pause`), { method: "POST" });
    expect(paused.status).toBe(200);
    expect(workflow.synced).toHaveLength(2);

    const firedBefore = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "scheduled_task.fired",
      since: startOfUtcMonth(),
    });
    const triggered = await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`), { method: "POST" });
    expect(triggered.status).toBe(202);
    expect(workflow.triggers).toHaveLength(1);
    expect((workflow.triggers[0] as { task?: { id?: string; workspaceId?: string } }).task).toMatchObject({
      id: task.id,
      workspaceId,
    });
    const firedAfter = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "scheduled_task.fired",
      since: startOfUtcMonth(),
    });
    expect(firedAfter).toBe(firedBefore);

    const listed = await app.request(workspacePath(workspaceId, "/scheduled-tasks"));
    expect(listed.status).toBe(200);
    expect((await listed.json() as Array<{ id: string }>).some((item) => item.id === task.id)).toBe(true);
  });

  test("keeps scheduled task persistence consistent when schedule sync fails", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    workflow.syncError = new Error("temporal unavailable");
    const failedCreateName = `sync-fail-${crypto.randomUUID()}`;
    const workspaceId = await defaultWorkspaceId(app);
    const failedCreate = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: failedCreateName,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(failedCreate.status).toBe(500);
    expect((await listScheduledTasks(dbClient.db, workspaceId)).some((task) => task.name === failedCreateName)).toBe(false);

    workflow.syncError = null;
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: `rollback-${crypto.randomUUID()}`,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    const task = await created.json() as { id: string };

    workflow.syncError = new Error("temporal unavailable");
    const failedPause = await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}/pause`), { method: "POST" });
    expect(failedPause.status).toBe(500);
    expect((await getScheduledTask(dbClient.db, workspaceId, task.id))?.status).toBe("active");
  });

  test("keeps MCP scheduled task persistence consistent when schedule sync fails", async () => {
    workflow = new FakeWorkflowClient();
    const settings = testSettings({ databaseUrl: services.databaseUrl });
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcp = buildOpenGeniMcpServer({
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by scheduled task MCP tests");
      },
    }, grant);

    workflow.syncError = new Error("temporal unavailable");
    const failedCreateName = `mcp-sync-fail-${crypto.randomUUID()}`;
    await expect(callMcpTool(mcp, "scheduled_tasks_create", {
      name: failedCreateName,
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt: "inspect" },
    })).rejects.toThrow("temporal unavailable");
    expect((await listScheduledTasks(dbClient.db, grant.workspaceId)).some((task) => task.name === failedCreateName)).toBe(false);

    workflow.syncError = null;
    const task = await callMcpTool<{ id: string }>(mcp, "scheduled_tasks_create", {
      name: `mcp-rollback-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt: "inspect" },
    });

    workflow.syncError = new Error("temporal unavailable");
    await expect(callMcpTool(mcp, "scheduled_tasks_pause", { id: task.id })).rejects.toThrow("temporal unavailable");
    expect((await getScheduledTask(dbClient.db, grant.workspaceId, task.id))?.status).toBe("active");
    await expect(callMcpTool(mcp, "scheduled_tasks_resume", { id: crypto.randomUUID() })).rejects.toThrow("Scheduled task not found");
  });

  test("returns 404 for missing scheduled task actions", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, `/scheduled-tasks/${crypto.randomUUID()}/pause`), { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("validates scheduled task semantic edge cases", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const blankName = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "   ",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(blankName.status).toBe(422);

    const invalidWindow = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "bad-window",
        schedule: {
          type: "interval",
          everySeconds: 3600,
          startAt: "2026-05-08T12:00:00.000Z",
          endAt: "2026-05-08T11:00:00.000Z",
        },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidWindow.status).toBe(422);
  });

  test("reports file upload support when object storage is configured", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        objectStorageEndpoint: "http://127.0.0.1:9000",
        objectStorageAccessKeyId: "minioadmin",
        objectStorageSecretAccessKey: "minioadmin",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("/v1/config/client");
    expect(response.status).toBe(200);
    const payload = await response.json() as { fileUploads: { enabled: boolean; maxSizeBytes: number } };
    expect(payload.fileUploads).toEqual({ enabled: true, maxSizeBytes: 5_000_000_000 });
  });

  test("rejects mixed GitHub App repository installations during session create", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "bad repos",
        resources: [
          { kind: "repository", uri: "https://github.com/a/one.git", ref: "main", githubInstallationId: 1, githubRepositoryId: 11 },
          { kind: "repository", uri: "https://github.com/b/two.git", ref: "main", githubInstallationId: 2, githubRepositoryId: 22 },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(422);
  });

  test("supports direct-to-object-storage file uploads and file resources", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);

    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
      method: "POST",
      body: JSON.stringify({
        filename: "spec.txt",
        contentType: "text/plain",
        sizeBytes: 11,
        sha256: "test-sha",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(uploadResponse.status).toBe(201);
    const upload = await uploadResponse.json() as {
      fileId: string;
      uploadId: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
      maxSizeBytes: number;
    };
    expect(upload.maxSizeBytes).toBeGreaterThan(1_000_000_000);
    expect(upload.requiredHeaders).toMatchObject({
      "content-type": "text/plain",
    });

    const put = await fetch(upload.putUrl, {
      method: "PUT",
      body: "hello world",
      headers: upload.requiredHeaders,
    });
    expect(put.status).toBeGreaterThanOrEqual(200);
    expect(put.status).toBeLessThan(300);

    const completeResponse = await app.request(workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`), {
      method: "POST",
    });
    expect(completeResponse.status).toBe(200);
    const completed = await completeResponse.json() as { file: { id: string; status: string; objectKey: string } };
    expect(completed.file.id).toBe(upload.fileId);
    expect(completed.file.status).toBe("ready");
    expect(completed.file.objectKey).toContain(`/original/spec.txt`);

    const metadataResponse = await app.request(workspacePath(workspaceId, `/files/${upload.fileId}`));
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json() as Record<string, unknown>;
    expect(metadata.status).toBe("ready");
    expect(metadata).not.toHaveProperty("url");

    const downloadResponse = await app.request(workspacePath(workspaceId, `/files/${upload.fileId}/download-url`), { method: "POST" });
    expect(downloadResponse.status).toBe(200);
    const download = await downloadResponse.json() as { url: string };
    expect(download.url).toContain("X-Amz-Signature");

    const sessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use file",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(sessionResponse.status).toBe(202);
    const session = await sessionResponse.json() as { id: string; resources: unknown[] };
    expect(session.resources).toEqual([{ kind: "file", fileId: upload.fileId, mountPath: `files/${upload.fileId}` }]);
    const initialEvents = await listSessionEvents(dbClient.db, workspaceId, session.id, 0, 10);
    expect(initialEvents.find((event) => event.type === "user.message")?.payload).toEqual({
      text: "use file",
      resources: [{ kind: "file", fileId: upload.fileId, mountPath: `files/${upload.fileId}` }],
    });

    const followUpSessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "start empty" }),
      headers: { "content-type": "application/json" },
    });
    const followUpSession = await followUpSessionResponse.json() as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, followUpSession.id, "idle", null);
    const followUp = await app.request(workspacePath(workspaceId, `/sessions/${followUpSession.id}/events`), {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: {
          text: "use file now",
          resources: [{ kind: "file", fileId: upload.fileId }],
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(followUp.status).toBe(202);
    const followUpEvent = await followUp.json() as SessionEvent;
    expect(followUpEvent.payload).toEqual({
      text: "use file now",
      resources: [{ kind: "file", fileId: upload.fileId, mountPath: `files/${upload.fileId}` }],
    });
    expect((await requireSession(dbClient.db, workspaceId, followUpSession.id)).resources).toEqual([
      { kind: "file", fileId: upload.fileId, mountPath: `files/${upload.fileId}` },
    ]);
  });

  test("rejects pending file resources during session create", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
      method: "POST",
      body: JSON.stringify({ filename: "pending.txt", contentType: "text/plain", sizeBytes: 7 }),
      headers: { "content-type": "application/json" },
    });
    const upload = await uploadResponse.json() as { fileId: string };
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use pending file",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(422);
  });

  test("validates command state transitions and signals workflow", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "state" }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };

    const rejected = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({ type: "user.message", payload: { text: "too soon" } }),
      headers: { "content-type": "application/json" },
    });
    expect(rejected.status).toBe(202);

    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const accepted = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({ type: "user.message", payload: { text: "now" }, clientEventId: "follow-up" }),
      headers: { "content-type": "application/json" },
    });
    expect(accepted.status).toBe(202);
    expect(workflow.wakeups.length).toBeGreaterThanOrEqual(2);

    const approvalRejected = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({ type: "user.approvalDecision", payload: { approvalId: "x", decision: "approve" } }),
      headers: { "content-type": "application/json" },
    });
    expect(approvalRejected.status).toBe(409);

    await setSessionStatus(dbClient.db, workspaceId, session.id, "requires_action", null);
    const approvalAccepted = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({ type: "user.approvalDecision", payload: { approvalId: "x", decision: "approve" } }),
      headers: { "content-type": "application/json" },
    });
    expect(approvalAccepted.status).toBe(202);
    expect(workflow.approvals).toHaveLength(1);

    await setSessionStatus(dbClient.db, workspaceId, session.id, "running", null);
    const interruptAccepted = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({ type: "user.interrupt", payload: { reason: "stop" } }),
      headers: { "content-type": "application/json" },
    });
    expect(interruptAccepted.status).toBe(202);
    expect(workflow.interrupts).toHaveLength(1);

    const malformed = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
      method: "POST",
      body: JSON.stringify({ type: "user.message", payload: { text: "" } }),
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
  });

  test("lists events and streams SSE replay plus live fanout", async () => {
    const bus = new MemoryEventBus();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus,
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "stream" }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };

    const listed = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/events?limit=10`));
    expect(listed.status).toBe(200);
    const initialEvents = await listed.json() as SessionEvent[];
    expect(initialEvents.map((event) => event.type)).toEqual(["session.created", "user.message", "session.status.changed", "turn.queued"]);

    const replayAbort = new AbortController();
    const replay = await app.request(new Request(`http://test${workspacePath(workspaceId, `/sessions/${session.id}/events/stream?after=0`)}`, {
      signal: replayAbort.signal,
    }));
    expect(replay.status).toBe(200);
    expect((await readSseEvents(replay, 4, replayAbort)).map((event) => event.type)).toEqual(initialEvents.map((event) => event.type));

    const liveAbortA = new AbortController();
    const liveAbortB = new AbortController();
    const liveA = await app.request(new Request(`http://test${workspacePath(workspaceId, `/sessions/${session.id}/events/stream?after=${initialEvents.at(-1)!.sequence}`)}`, {
      signal: liveAbortA.signal,
    }));
    const liveB = await app.request(new Request(`http://test${workspacePath(workspaceId, `/sessions/${session.id}/events/stream?after=${initialEvents.at(-1)!.sequence}`)}`, {
      signal: liveAbortB.signal,
    }));
    const readA = readSseEvents(liveA, 1, liveAbortA);
    const readB = readSseEvents(liveB, 1, liveAbortB);
    const [appended] = await appendAndPublishEvents(dbClient.db, bus, workspaceId, session.id, [
      { type: "agent.message.delta", payload: { text: "live" } },
    ]);
    expect((await readA)[0]?.id).toBe(appended?.id);
    expect((await readB)[0]?.id).toBe(appended?.id);
  });

  test("reports missing GitHub App configuration", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/github/app"));
    expect(response.status).toBe(200);
    const body = await response.json() as { configured: boolean; missing: string[] };
    expect(body.configured).toBe(false);
    expect(body.missing.length).toBeGreaterThan(0);
    });

  test("redirects GitHub install callbacks through OAuth before binding a workspace installation", async () => {
    const stateSecret = "test-github-install-state-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        githubClientId: "test-github-client-id",
        githubAppManifestBaseUrl: "https://staging.app.opengeni.ai",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      githubStateSecret: stateSecret,
    });
    const context = await defaultAccessContext(app);
    const state = createSignedState(stateSecret, {
      accountId: context.defaultAccountId,
      workspaceId: context.defaultWorkspaceId,
    });

    const rejected = await app.request(`/v1/github/install/callback?installation_id=138826628&setup_action=install&state=${encodeURIComponent(state)}`);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("invalid or expired GitHub installation browser state");

    const response = await app.request(`/v1/github/install/callback?installation_id=138826628&setup_action=install&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `opengeni_github_state=${state}` },
    });
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const redirect = new URL(location!);
    expect(`${redirect.origin}${redirect.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(redirect.searchParams.get("client_id")).toBe("test-github-client-id");
    expect(redirect.searchParams.get("redirect_uri")).toBe("https://staging.app.opengeni.ai/v1/github/oauth/callback");
    const oauthState = redirect.searchParams.get("state");
    expect(oauthState).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain(`opengeni_github_state=${oauthState}`);
    const payload = readSignedState(oauthState!, stateSecret);
    expect(payload).toMatchObject({
      accountId: context.defaultAccountId,
      workspaceId: context.defaultWorkspaceId,
      installationId: 138826628,
    });
  });

  test("indexes uploaded files into document bases and searches them", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
      method: "POST",
      body: JSON.stringify({
        filename: "network-runbook.txt",
        contentType: "text/plain",
        sizeBytes: 67,
      }),
      headers: { "content-type": "application/json" },
    });
    const upload = await uploadResponse.json() as { fileId: string; uploadId: string; putUrl: string; requiredHeaders: Record<string, string> };
    const body = "Private endpoint failures are fixed by updating the network policy.";
    await fetch(upload.putUrl, { method: "PUT", body, headers: upload.requiredHeaders });
    expect((await app.request(workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`), { method: "POST" })).status).toBe(200);

    const baseResponse = await app.request(workspacePath(workspaceId, "/document-bases"), {
      method: "POST",
      body: JSON.stringify({ name: "Runbooks", description: "Operational docs" }),
      headers: { "content-type": "application/json" },
    });
    expect(baseResponse.status).toBe(201);
    const base = await baseResponse.json() as { id: string; name: string };
    expect(base.name).toBe("Runbooks");

    const addResponse = await app.request(workspacePath(workspaceId, `/document-bases/${base.id}/documents`), {
      method: "POST",
      body: JSON.stringify({ fileId: upload.fileId }),
      headers: { "content-type": "application/json" },
    });
    expect(addResponse.status).toBe(201);
    const document = await addResponse.json() as { id: string; status: string; chunkCount: number };
    expect(document.status).toBe("ready");
    expect(document.chunkCount).toBe(1);

    const readyRetryResponse = await app.request(workspacePath(workspaceId, `/document-bases/${base.id}/documents/${document.id}/reindex`), { method: "POST" });
    expect(readyRetryResponse.status).toBe(422);
    expect(await readyRetryResponse.text()).toContain("only failed documents can be retried");

    const listResponse = await app.request(workspacePath(workspaceId, `/document-bases/${base.id}/documents`));
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toHaveLength(1);

    const searchResponse = await app.request(workspacePath(workspaceId, `/document-bases/${base.id}/search`), {
      method: "POST",
      body: JSON.stringify({ query: "network policy", limit: 3 }),
      headers: { "content-type": "application/json" },
    });
    expect(searchResponse.status).toBe(200);
    const search = await searchResponse.json() as { results: Array<{ text: string; title: string }> };
    expect(search.results[0]?.text).toContain("network policy");
    expect(search.results[0]?.title).toBe("network-runbook.txt");
  });

  test("document indexing enforces exact chunk limits before embedding", async () => {
    const app = createApp({
      settings: {
        ...objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({ maxDocumentIndexedChunksPerWorkspace: 2 }),
      },
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      documentServices: {
        parser: {
          name: "test-text",
          parse: async (bytes, file) => ({
            text: new TextDecoder().decode(bytes),
            metadata: { filename: file.filename, contentType: file.contentType },
          }),
        },
        chunker: {
          chunk: (parsed, file) => parsed.text.match(/.{1,8}/g)!.map((text, index) => ({
            text,
            metadata: { filename: file.filename, chunkIndex: index },
          })),
        },
        embedder: {
          model: "test-embedder",
          dimensions: 3,
          embedMany: async () => {
            throw new Error("embedder should not run after document chunk cap fails");
          },
          embedQuery: async () => [0, 0, 0],
        },
      },
    });
    const context = await defaultAccessContext(app);
    const workspaceId = context.defaultWorkspaceId!;
    const accountId = context.defaultAccountId!;
    const oversizedBody = "This document is intentionally long enough to become many chunks.";
    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
      method: "POST",
      body: JSON.stringify({ filename: "oversized-doc.txt", contentType: "text/plain", sizeBytes: new TextEncoder().encode(oversizedBody).byteLength }),
      headers: { "content-type": "application/json" },
    });
    expect(uploadResponse.status).toBe(201);
    const upload = await uploadResponse.json() as { fileId: string; uploadId: string; putUrl: string; requiredHeaders: Record<string, string> };
    await fetch(upload.putUrl, { method: "PUT", body: oversizedBody, headers: upload.requiredHeaders });
    expect((await app.request(workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`), { method: "POST" })).status).toBe(200);

    const baseResponse = await app.request(workspacePath(workspaceId, "/document-bases"), {
      method: "POST",
      body: JSON.stringify({ name: "Limited docs" }),
      headers: { "content-type": "application/json" },
    });
    expect(baseResponse.status).toBe(201);
    const base = await baseResponse.json() as { id: string };
    const usageBefore = await sumUsageQuantity(dbClient.db, {
      accountId,
      workspaceId,
      eventType: "document.indexed",
      since: startOfUtcMonth(),
    });

    const addResponse = await app.request(workspacePath(workspaceId, `/document-bases/${base.id}/documents`), {
      method: "POST",
      body: JSON.stringify({ fileId: upload.fileId }),
      headers: { "content-type": "application/json" },
    });
    expect(addResponse.status).toBe(201);
    const document = await addResponse.json() as { status: string; chunkCount: number; error: string | null };
    expect(document.status).toBe("failed");
    expect(document.chunkCount).toBe(0);
    expect(document.error).toContain("monthly document indexing limit reached (2 chunks)");
    const usageAfter = await sumUsageQuantity(dbClient.db, {
      accountId,
      workspaceId,
      eventType: "document.indexed",
      since: startOfUtcMonth(),
    });
    expect(usageAfter).toBe(usageBefore);
  });

  test("serves indexed documents through the built-in MCP endpoint", async () => {
    const appSettings = {
      ...objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      delegationSecret: "test-delegation-secret",
    };
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const settings = {
      ...appSettings,
      mcpServers: [{
        id: "docs",
        name: "Document Search",
        url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp/docs`,
        allowedTools: ["search_documents", "fetch_document_chunk", "list_document_bases"],
        timeoutMs: undefined,
        cacheToolsList: false,
      }, {
        id: "files",
        name: "Files",
        url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
        allowedTools: ["files_get_download_url"],
        timeoutMs: undefined,
        cacheToolsList: false,
      }],
    };
    let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    try {
      const access = await defaultAccessContext(app);
      const workspaceId = access.defaultWorkspaceId!;
      const accountId = access.defaultAccountId!;
      const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
        method: "POST",
        body: JSON.stringify({ filename: "mcp-runbook.txt", contentType: "text/plain", sizeBytes: 60 }),
        headers: { "content-type": "application/json" },
      });
      const upload = await uploadResponse.json() as { fileId: string; uploadId: string; putUrl: string; requiredHeaders: Record<string, string> };
      await fetch(upload.putUrl, { method: "PUT", body: "MCP document search returns private endpoint runbook chunks.", headers: upload.requiredHeaders });
      expect((await app.request(workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`), { method: "POST" })).status).toBe(200);
      const baseResponse = await app.request(workspacePath(workspaceId, "/document-bases"), {
        method: "POST",
        body: JSON.stringify({ name: "MCP Runbooks" }),
        headers: { "content-type": "application/json" },
      });
      const base = await baseResponse.json() as { id: string };
      expect((await app.request(workspacePath(workspaceId, `/document-bases/${base.id}/documents`), {
        method: "POST",
        body: JSON.stringify({ fileId: upload.fileId }),
        headers: { "content-type": "application/json" },
      })).status).toBe(201);

      prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "docs" }, { kind: "mcp", id: "files" }], {
        accountId,
        workspaceId,
        subjectId: "test:mcp-client",
      });
      const docsServer = prepared.mcpServers[0]!;
      const filesServer = prepared.mcpServers[1]!;
      const docTools = await docsServer.listTools();
      expect(docTools.map((tool) => tool.name)).toContain("docs__search_documents");
      const fileTools = await filesServer.listTools();
      expect(fileTools.map((tool) => tool.name)).toEqual(["files__files_get_download_url"]);

      const result = await docsServer.callTool("docs__search_documents", { query: "private endpoint", baseIds: [base.id], limit: 3 });
      expect(JSON.stringify(result)).toContain("private endpoint runbook");

      const downloadResult = await filesServer.callTool("files__files_get_download_url", { fileId: upload.fileId });
      const downloadPayload = JSON.parse(mcpText(downloadResult)) as { file: { id: string; filename: string }; downloadUrl: { url: string } };
      expect(downloadPayload.file).toMatchObject({ id: upload.fileId, filename: "mcp-runbook.txt" });
      const downloaded = await fetch(downloadPayload.downloadUrl.url);
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toContain("private endpoint runbook");

      const pendingUploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
        method: "POST",
        body: JSON.stringify({ filename: "pending-mcp.txt", contentType: "text/plain", sizeBytes: 7 }),
        headers: { "content-type": "application/json" },
      });
      const pendingUpload = await pendingUploadResponse.json() as { fileId: string };
      expect(mcpText(await filesServer.callTool("files__files_get_download_url", { fileId: pendingUpload.fileId }))).toContain("file is pending_upload");
      expect(mcpText(await filesServer.callTool("files__files_get_download_url", { fileId: crypto.randomUUID() }))).toContain("File not found");
    } finally {
      await prepared?.close().catch(() => undefined);
      server.stop(true);
    }
  });

  test("file download MCP tool reports unconfigured object storage", async () => {
    const appSettings = testSettings({
      databaseUrl: services.databaseUrl,
      delegationSecret: "test-delegation-secret",
    });
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      delegationSecret: "test-delegation-secret",
      mcpServers: [{
        id: "files",
        name: "Files",
        url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
        allowedTools: ["files_get_download_url"],
        timeoutMs: undefined,
        cacheToolsList: false,
      }],
    });
    let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    try {
      const access = await defaultAccessContext(app);
      prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "files" }], {
        accountId: access.defaultAccountId!,
        workspaceId: access.defaultWorkspaceId!,
        subjectId: "test:mcp-client",
      });
      expect(mcpText(await prepared.mcpServers[0]!.callTool("files__files_get_download_url", { fileId: crypto.randomUUID() }))).toContain("object storage is not configured");
    } finally {
      await prepared?.close().catch(() => undefined);
      server.stop(true);
    }
  });
});

function mcpText(result: unknown): string {
  const content = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content
      : [];
  const first = content[0];
  if (first && typeof first === "object" && typeof (first as { text?: unknown }).text === "string") {
    return (first as { text: string }).text;
  }
  throw new Error(`MCP result did not contain text content: ${JSON.stringify(result)}`);
}

async function defaultAccessContext(app: ReturnType<typeof createApp>, headers?: HeadersInit): Promise<AccessContext> {
  const response = await app.request("/v1/access/me", { headers });
  expect(response.status).toBe(200);
  return await response.json() as AccessContext;
}

async function defaultWorkspaceId(app: ReturnType<typeof createApp>, headers?: HeadersInit): Promise<string> {
  const context = await defaultAccessContext(app, headers);
  expect(context.defaultWorkspaceId).toBeTruthy();
  return context.defaultWorkspaceId!;
}

async function postStripeEvent(app: ReturnType<typeof createApp>, webhookSecret: string, event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacSha256Hex(webhookSecret, `${timestamp}.${payload}`);
  return await app.request("/v1/webhooks/stripe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: payload,
  });
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function workspacePath(workspaceId: string, path: string): string {
  return `/v1/workspaces/${workspaceId}${path}`;
}

async function bootstrapMcpGrant(db: ReturnType<typeof createDb>["db"]) {
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:mcp",
    accountExternalId: crypto.randomUUID(),
    accountName: "MCP test account",
    workspaceExternalSource: "test:mcp",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "MCP test workspace",
    subjectId: `test:mcp:${crypto.randomUUID()}`,
    subjectLabel: "MCP test",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("MCP bootstrap did not create a workspace grant");
  }
  return grant;
}

async function readSseEvents(response: Response, count: number, abort: AbortController): Promise<SessionEvent[]> {
  expect(response.body).toBeTruthy();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: SessionEvent[] = [];
  let buffer = "";
  try {
    while (events.length < count) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (!parsed?.data) {
          continue;
        }
        events.push(JSON.parse(parsed.data) as SessionEvent);
        if (events.length === count) {
          break;
        }
      }
    }
    return events;
  } finally {
    abort.abort();
    await reader.cancel().catch(() => undefined);
  }
}

async function callMcpTool<T = unknown>(server: unknown, name: string, args: Record<string, unknown>): Promise<T> {
  const tool = (server as { _registeredTools?: Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> })._registeredTools?.[name];
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) {
    throw new Error(`MCP tool returned no text: ${name}`);
  }
  return JSON.parse(text) as T;
}

class FakeWorkflowClient implements SessionWorkflowClient {
  userMessages: unknown[] = [];
  wakeups: unknown[] = [];
  approvals: unknown[] = [];
  interrupts: unknown[] = [];
  synced: unknown[] = [];
  deletedSchedules: unknown[] = [];
  triggers: unknown[] = [];
  syncError: Error | null = null;

  async signalUserMessage(input: unknown): Promise<void> {
    this.userMessages.push(input);
  }

  async wakeSessionWorkflow(input: unknown): Promise<void> {
    this.wakeups.push(input);
  }

  async signalApprovalDecision(input: unknown): Promise<void> {
    this.approvals.push(input);
  }

  async signalInterrupt(input: unknown): Promise<void> {
    this.interrupts.push(input);
  }

  async syncScheduledTask(input: unknown): Promise<void> {
    this.synced.push(input);
    if (this.syncError) {
      throw this.syncError;
    }
  }

  async deleteScheduledTaskSchedule(input: unknown): Promise<void> {
    this.deletedSchedules.push(input);
  }

  async triggerScheduledTask(input: unknown): Promise<void> {
    this.triggers.push(input);
  }
}

function objectStorageSettings(databaseUrl: string, endpoint: string) {
  return testSettings({
    databaseUrl,
    objectStorageEndpoint: endpoint,
    objectStorageSandboxEndpoint: endpoint,
    objectStorageAccessKeyId: "minioadmin",
    objectStorageSecretAccessKey: "minioadmin",
  });
}

function startOfUtcMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
