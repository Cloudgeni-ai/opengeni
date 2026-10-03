import { afterAll, beforeAll, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { InsightsCallsResponse, InsightsUsageResponse } from "@opengeni/contracts/insights-usage";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  applyCreditLedgerEntry,
  createApiKey,
  createDb,
  createOrganizationApiKey,
  createSession,
  ensureManagedAccessForUser,
  recordModelCallFact,
  updateSessionTitle,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { withAccessGrantSessionRlsContext } from "../src/access-grant-rls";
import { registerInsightsUsageRoutes } from "../src/routes/insights-usage";

const secret = "insights-unified-http-postgres-fixture";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("insights-unified-http");
  if (!acquired) throw new Error("Unified Insights HTTP verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture() {
  const userId = `insights-http-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Insights HTTP owner",
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = crypto.randomUUID();
  await shared.admin`insert into workspaces(id,account_id,name)
    values (${workspaceId},${grant.accountId},'Shared Insights HTTP fixture')`;
  await shared.admin`insert into workspace_inference_controls(workspace_id,account_id)
    values (${workspaceId},${grant.accountId})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
    values (${grant.accountId},${workspaceId},${subjectId},'owner','[]'::jsonb)`;
  return { accountId: grant.accountId, workspaceId, subjectId };
}
type Scope = Awaited<ReturnType<typeof fixture>>;

async function bearer(scope: Scope, permissions: Permission[]) {
  return `Bearer ${await signDelegatedAccessToken(secret, {
    ...scope,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

function api() {
  const app = new Hono();
  const deps = {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
  } as ApiRouteDeps;
  // Reuse the production workspace actor wrapper, including its provenance rules.
  app.use("/v1/workspaces/:workspaceId/*", async (c, next) => {
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId")!);
    await withAccessGrantSessionRlsContext(deps, grant, next);
  });
  registerInsightsUsageRoutes(app, deps);
  return app;
}

function path(scope: Scope, organization: boolean, leaf: "usage" | "calls", query = "range=ytd") {
  const parent = organization
    ? `organizations/${scope.accountId}`
    : `workspaces/${scope.workspaceId}`;
  return `http://insights.test/v1/${parent}/insights/${leaf}?${query}`;
}

test("all four endpoints return validated HTTP 200 for genuinely empty data in all six ranges", async () => {
  const scope = await fixture();
  const authorization = await bearer(scope, ["workspace:admin", "billing:read"]);
  const app = api();
  for (const range of ["today", "week", "month", "30d", "90d", "ytd"]) {
    for (const organization of [false, true]) {
      const usage = await app.request(path(scope, organization, "usage", `range=${range}`), {
        headers: { authorization },
      });
      expect(usage.status, await usage.clone().text()).toBe(200);
      const body = InsightsUsageResponse.parse(await usage.json());
      expect(body.totals).toMatchObject({ calls: 0, chargedMicros: 0, listMicros: 0 });
      expect(body.prior).toBeNull();
      expect(body.groups).toEqual([]);
      const calls = await app.request(path(scope, organization, "calls", `range=${range}`), {
        headers: { authorization },
      });
      expect(calls.status, await calls.clone().text()).toBe(200);
      expect(InsightsCallsResponse.parse(await calls.json())).toEqual({
        calls: [],
        nextCursor: null,
      });
    }
  }
}, 120_000);

test("canonical selected-workspace organization keys never inherit Shared-all detail authority", async () => {
  const scope = await fixture();
  const other = { ...scope, workspaceId: crypto.randomUUID() };
  await shared.admin`insert into workspaces(id,account_id,name)
    values (${other.workspaceId},${scope.accountId},'Outside selected key scope')`;
  await shared.admin`insert into workspace_inference_controls(workspace_id,account_id)
    values (${other.workspaceId},${scope.accountId})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
    values (${scope.accountId},${other.workspaceId},${scope.subjectId},'owner','[]'::jsonb)`;
  const sessions = [];
  for (const selected of [scope, other]) {
    const session = await withSessionRlsActorContext({ subjectId: scope.subjectId }, () =>
      createSession(client.db, {
        accountId: scope.accountId,
        workspaceId: selected.workspaceId,
        initialMessage: "Selected key fixture",
        resources: [],
        metadata: {},
        model: "fixture-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: scope.subjectId },
        createdByContext: {},
      }),
    );
    sessions.push(session);
    await withSessionRlsActorContext({ subjectId: scope.subjectId }, () =>
      recordModelCallFact(client.db, {
        accountId: scope.accountId,
        workspaceId: selected.workspaceId,
        sessionId: session.id,
        turnId: crypto.randomUUID(),
        sourceKey: crypto.randomUUID(),
        provider: selected === scope ? "selected-provider" : "outside-provider",
        providerApi: "responses",
        model: "fixture-model",
        billingPath: "external",
        pricedCostMicros: 0,
        estimatedProviderCostMicros: 13,
        pricingSource: "configured_list_price",
      }),
    );
  }
  async function key(
    workspaceIds: string[] | null,
    permissions: Permission[] = ["billing:read", "workspace:read", "sessions:read"],
  ) {
    const raw = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    const input = {
      accountId: scope.accountId,
      name: "Selected Insights test key",
      prefix: raw.slice(0, 14),
      keyHash: createHash("sha256").update(raw).digest("hex"),
      permissions,
    };
    // The separate policy writer currently inserts an empty values() batch for
    // all/empty scopes. Do not change authorization code in this Insights task:
    // install those valid fixture rows, then use real canonical authentication.
    if (workspaceIds === null || workspaceIds.length === 0) {
      const created = await createApiKey(client.db, { ...input, credentialKind: "organization" });
      await shared.admin`update api_keys set permission_mode='explicit',workspace_scope=${workspaceIds === null ? "all" : "selected"}
        where id=${created.id} and account_id=${scope.accountId}`;
    } else
      await createOrganizationApiKey(client.db, {
        ...input,
        policy: {
          preset: "custom",
          permissions,
          workspaceScope:
            workspaceIds === null ? { kind: "all" } : { kind: "selected", workspaceIds },
        },
      });
    return `Bearer ${raw}`;
  }
  const app = api();
  const selectedKey = await key([scope.workspaceId]);
  const allKey = await key(null);
  const adminOnlyKey = await key(
    [scope.workspaceId],
    ["billing:read", "workspace:read", "workspace:admin"],
  );
  for (const [authorization, expectedIds] of [
    [selectedKey, [scope.workspaceId]],
    [allKey, [scope.workspaceId, other.workspaceId]],
    [await key([]), []],
    [await key([scope.workspaceId], ["billing:read"]), []],
    [adminOnlyKey, []],
  ] as const) {
    const response = await app.request(
      path(scope, true, "usage", "range=ytd&groupBy=rootSession"),
      {
        headers: { authorization },
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = InsightsUsageResponse.parse(await response.json());
    // Account billing authority still includes unattributed amounts; detail ceiling is independent.
    expect(body.totals).toMatchObject({ calls: 2, listMicros: 26 });
    expect(body.facets.workspaces.map((item) => item.id).sort()).toEqual([...expectedIds].sort());
    const calls = await app.request(path(scope, true, "calls"), { headers: { authorization } });
    expect(calls.status, await calls.clone().text()).toBe(200);
    expect(
      InsightsCallsResponse.parse(await calls.json())
        .calls.map((call) => call.workspaceId)
        .sort(),
    ).toEqual([...expectedIds].sort());
  }
  for (const leaf of ["usage", "calls"] as const) {
    const response = await app.request(path(scope, false, leaf), {
      headers: { authorization: adminOnlyKey },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    if (leaf === "calls")
      expect(InsightsCallsResponse.parse(body)).toEqual({ calls: [], nextCursor: null });
    else expect(InsightsUsageResponse.parse(body).facets.workspaces).toEqual([]);
    const denied = await app.request(path(other, false, leaf), {
      headers: { authorization: adminOnlyKey },
    });
    expect(denied.status).toBe(403);
  }
  for (const query of [
    "provider=outside-provider",
    `rootSessionId=${sessions[1]!.id}`,
    `workspaceId=${other.workspaceId}&provider=outside-provider`,
  ]) {
    const response = await app.request(path(scope, true, "usage", `range=ytd&${query}`), {
      headers: { authorization: selectedKey },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(InsightsUsageResponse.parse(await response.json()).totals.calls).toBe(0);
    const calls = await app.request(path(scope, true, "calls", `range=ytd&${query}`), {
      headers: { authorization: selectedKey },
    });
    expect(calls.status, await calls.clone().text()).toBe(200);
    expect(InsightsCallsResponse.parse(await calls.json())).toEqual({
      calls: [],
      nextCursor: null,
    });
  }
}, 120_000);

test("HTTP readers preserve actual debit totals while enforcing the delegated detail ceiling", async () => {
  const scope = await fixture();
  const session = await withSessionRlsActorContext({ subjectId: scope.subjectId }, () =>
    createSession(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      initialMessage: "Insights HTTP detail",
      resources: [],
      metadata: {},
      model: "fixture-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: scope.subjectId },
      createdByContext: {},
    }),
  );
  const title = `HTTP DETAIL SENTINEL ${crypto.randomUUID()}`;
  expect(
    await withSessionRlsActorContext({ subjectId: scope.subjectId }, () =>
      updateSessionTitle(client.db, {
        workspaceId: scope.workspaceId,
        sessionId: session.id,
        title,
        source: "user",
      }),
    ),
  ).toMatchObject({ updated: true, title });
  const turnId = crypto.randomUUID();
  const sourceKey = `response:${crypto.randomUUID()}`;
  await withSessionRlsActorContext({ subjectId: scope.subjectId }, () =>
    recordModelCallFact(client.db, {
      ...scope,
      sessionId: session.id,
      turnId,
      sourceKey,
      provider: "openai",
      providerApi: "responses",
      model: "fixture-model",
      billingPath: "opengeni_credits",
      pricedCostMicros: 999,
      estimatedProviderCostMicros: 500,
      pricingSource: "configured_list_price",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
      totalTokens: 150,
    }),
  );
  await applyCreditLedgerEntry(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    type: "model_usage_debit",
    amountMicros: -7,
    sourceType: "model_response",
    sourceId: `${turnId}:${sourceKey}`,
    idempotencyKey: `credit:fixture:${sourceKey}`,
    metadata: { sessionId: session.id, turnId, sourceKey, model: "fixture-model" },
  });
  const app = api();
  const full = await bearer(scope, ["billing:read", "workspace:admin"]);
  const billing = await bearer(scope, ["billing:read"]);
  for (const organization of [false, true]) {
    const response = await app.request(path(scope, organization, "usage"), {
      headers: { authorization: full },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = InsightsUsageResponse.parse(await response.json());
    expect(body.totals).toMatchObject({
      calls: 1,
      chargedMicros: 7,
      listMicros: 500,
      cacheWriteKnownCalls: 1,
      tokens: { uncachedInput: 70, cacheRead: 20, cacheWrite: 10, output: 50, reasoning: 5 },
      byPayer: { opengeni_credits: { calls: 1, chargedMicros: 7, listMicros: 500 } },
    });
    const calls = await app.request(path(scope, organization, "calls"), {
      headers: { authorization: full },
    });
    expect(calls.status, await calls.clone().text()).toBe(200);
    expect(InsightsCallsResponse.parse(await calls.json()).calls).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        sessionTitle: title,
        chargedMicros: 7,
        tokens: { uncachedInput: 70, cacheRead: 20, cacheWrite: 10, output: 50, reasoning: 5 },
      }),
    ]);
  }
  const amounts = await app.request(path(scope, true, "usage", "range=ytd&groupBy=rootSession"), {
    headers: { authorization: billing },
  });
  expect(amounts.status, await amounts.clone().text()).toBe(200);
  const amountsBody = InsightsUsageResponse.parse(await amounts.json());
  expect(amountsBody.totals).toMatchObject({ calls: 1, chargedMicros: 7, listMicros: 500 });
  expect(JSON.stringify(amountsBody)).not.toContain(session.id);
  expect(JSON.stringify(amountsBody)).not.toContain(title);
  const deniedDetails = await app.request(path(scope, true, "calls"), {
    headers: { authorization: billing },
  });
  expect(deniedDetails.status, await deniedDetails.clone().text()).toBe(200);
  expect(InsightsCallsResponse.parse(await deniedDetails.json())).toEqual({
    calls: [],
    nextCursor: null,
  });
}, 120_000);
