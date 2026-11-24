import { afterAll, beforeAll, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { InsightsUsageResponse } from "@opengeni/contracts/insights-usage";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  applyCreditLedgerEntry,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  recordModelCallFact,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { withAccessGrantSessionRlsContext } from "../src/access-grant-rls";
import { registerInsightsUsageRoutes } from "../src/routes/insights-usage";

// Usage by agent (migration 1563): per-agent totals come from the same model
// call facts and credit debits as every other grouping, attributed by the
// ROOT chat's agent, and an agent's name shows only to people who may see it.
const secret = "insights-usage-agents-postgres";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("insights-usage-agents");
  if (!acquired) throw new Error("Insights usage by agent requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture() {
  const userId = `insights-agents-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Insights agents viewer",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const workspaceId = crypto.randomUUID();
  const otherSubjectId = `user:insights-agents-other-${crypto.randomUUID()}`;
  await shared.admin`insert into workspaces(id,account_id,name)
    values (${workspaceId},${accountId},'Insights agents fixture')`;
  await shared.admin`insert into workspace_inference_controls(workspace_id,account_id)
    values (${workspaceId},${accountId})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
    values (${accountId},${workspaceId},${subjectId},'owner','[]'::jsonb),
      (${accountId},${workspaceId},${otherSubjectId},'owner','[]'::jsonb)`;
  return { accountId, workspaceId, subjectId, otherSubjectId };
}
type Scope = Awaited<ReturnType<typeof fixture>>;

async function bearer(scope: Scope, permissions: Permission[]) {
  return `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: scope.subjectId,
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
  app.use("/v1/workspaces/:workspaceId/*", async (c, next) => {
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId")!);
    await withAccessGrantSessionRlsContext(deps, grant, next);
  });
  registerInsightsUsageRoutes(app, deps);
  return app;
}

async function agent(scope: Scope, input: { name: string; ownerSubjectId?: string }) {
  const id = crypto.randomUUID();
  await shared.admin`insert into agents(id,account_id,workspace_id,visibility,owner_subject_id,name,name_key,origin)
    values (${id},${scope.accountId},${scope.workspaceId},${input.ownerSubjectId ? "private" : "workspace"},
      ${input.ownerSubjectId ?? null},${input.name},${input.name.toLowerCase()},'app')`;
  return id;
}

async function chat(scope: Scope, options: { agentId?: string; parentSessionId?: string } = {}) {
  const session = await withSessionRlsActorContext({ subjectId: scope.subjectId }, () =>
    createSession(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      initialMessage: "Agent usage fixture",
      resources: [],
      metadata: {},
      model: "fixture-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: scope.subjectId },
      createdByContext: {},
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    }),
  );
  // Set as chat creation does for an agent's chat; child workers never set it.
  if (options.agentId)
    await shared.admin`update sessions set agent_id=${options.agentId} where id=${session.id}`;
  return session.id;
}

async function call(scope: Scope, sessionId: string, listMicros: number, debitMicros: number) {
  const turnId = crypto.randomUUID();
  const sourceKey = `response:${crypto.randomUUID()}`;
  await withSessionRlsActorContext({ subjectId: scope.subjectId }, () =>
    recordModelCallFact(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId,
      turnId,
      sourceKey,
      provider: "openai",
      providerApi: "responses",
      model: "fixture-model",
      billingPath: "opengeni_credits",
      pricedCostMicros: debitMicros,
      estimatedProviderCostMicros: listMicros,
      pricingSource: "configured_list_price",
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
    }),
  );
  await applyCreditLedgerEntry(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    type: "model_usage_debit",
    amountMicros: -debitMicros,
    sourceType: "model_response",
    sourceId: `${turnId}:${sourceKey}`,
    idempotencyKey: `credit:agents:${sourceKey}`,
    metadata: { sessionId, turnId, sourceKey, model: "fixture-model" },
  });
}

test("usage groups and filters by the root chat's agent and hides names the viewer can't see", async () => {
  const scope = await fixture();
  const reviewer = await agent(scope, { name: "Reviewer" });
  const secretName = `Secret helper ${crypto.randomUUID()}`;
  const othersOnlyMe = await agent(scope, {
    name: secretName,
    ownerSubjectId: scope.otherSubjectId,
  });

  const reviewerRootA = await chat(scope, { agentId: reviewer });
  const reviewerWorker = await chat(scope, { parentSessionId: reviewerRootA });
  const reviewerRootB = await chat(scope, { agentId: reviewer });
  const hiddenRoot = await chat(scope, { agentId: othersOnlyMe });
  const plain = await chat(scope);
  await call(scope, reviewerRootA, 1_000, 40);
  await call(scope, reviewerWorker, 2_000, 70);
  await call(scope, reviewerRootB, 3_000, 110);
  await call(scope, hiddenRoot, 5_000, 200);
  await call(scope, plain, 7_000, 300);

  // The records for the Reviewer's chats, read straight from the tables.
  const reviewerSessions = [reviewerRootA, reviewerWorker, reviewerRootB];
  const [facts] = await shared.admin<{ calls: string; list: string }[]>`
    select count(*)::text as calls,sum(estimated_provider_cost_micros)::text as list
    from model_call_facts where session_id in ${shared.admin(reviewerSessions)}`;
  const [credits] = await shared.admin<{ charged: string }[]>`
    select (-sum(amount_micros))::text as charged from credit_ledger_entries
    where type='model_usage_debit' and metadata->>'sessionId' in ${shared.admin(reviewerSessions)}`;
  expect(facts).toEqual({ calls: "3", list: "6000" });
  expect(credits).toEqual({ charged: "220" });

  const app = api();
  const authorization = await bearer(scope, ["workspace:admin", "billing:read"]);
  const read = async (query: string) => {
    const response = await app.request(
      `http://insights.test/v1/workspaces/${scope.workspaceId}/insights/usage?${query}`,
      { headers: { authorization } },
    );
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(text).not.toContain(secretName);
    return InsightsUsageResponse.parse(JSON.parse(text));
  };

  const byAgent = await read("range=30d&groupBy=agent");
  const group = (key: string) => byAgent.groups.find((candidate) => candidate.key === key);
  expect(group(`item:${reviewer}`)).toMatchObject({
    kind: "item",
    label: "Reviewer",
    measures: {
      calls: Number(facts!.calls),
      chargedMicros: Number(credits!.charged),
      listMicros: Number(facts!.list),
    },
  });
  expect(group(`item:${othersOnlyMe}`)).toMatchObject({
    kind: "item",
    label: "Unavailable agent",
    measures: { calls: 1, chargedMicros: 200, listMicros: 5_000 },
  });
  expect(group("unfiled:none")).toMatchObject({
    kind: "unfiled",
    label: "No agent",
    measures: { calls: 1, chargedMicros: 300, listMicros: 7_000 },
  });
  expect(byAgent.groups).toHaveLength(3);
  expect(byAgent.facets.agents).toEqual([{ id: reviewer, name: "Reviewer" }]);

  // The agent page's read: totals for one agent, one group per run (root chat).
  const runs = await read(`range=30d&groupBy=rootSession&agentId=${reviewer}`);
  expect(runs.totals).toMatchObject({
    calls: 3,
    chargedMicros: 220,
    listMicros: 6_000,
  });
  expect(runs.groupCount).toBe(2);
  expect(runs.groups.map((row) => row.key).sort()).toEqual(
    [`item:${reviewerRootA}`, `item:${reviewerRootB}`].sort(),
  );

  // Several agents are OR'ed; an agent without usage matches nothing.
  const both = await read(`range=30d&agentId=${reviewer},${othersOnlyMe}`);
  expect(both.totals).toMatchObject({ calls: 4, chargedMicros: 420 });
  const none = await read(`range=30d&agentId=${crypto.randomUUID()}`);
  expect(none.totals).toMatchObject({ calls: 0, chargedMicros: 0, listMicros: 0 });

  // The owner of the Only me agent sees its name.
  const owner = await app.request(
    `http://insights.test/v1/workspaces/${scope.workspaceId}/insights/usage?range=30d&groupBy=agent`,
    {
      headers: {
        authorization: `Bearer ${await signDelegatedAccessToken(secret, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          subjectId: scope.otherSubjectId,
          permissions: ["workspace:admin", "billing:read"],
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1000) + 3600,
        })}`,
      },
    },
  );
  const ownerText = await owner.text();
  expect(owner.status, ownerText).toBe(200);
  const ownerBody = InsightsUsageResponse.parse(JSON.parse(ownerText));
  expect(ownerBody.groups.find((row) => row.key === `item:${othersOnlyMe}`)?.label).toBe(
    secretName,
  );
}, 180_000);
