import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { OrganizationUsageSummary, WorkspaceInsightsSnapshot } from "@opengeni/contracts";
import { OrganizationModelUsage } from "@opengeni/contracts/organization-model-usage";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationModelUsage,
  getOrganizationPrivateSessionSettings,
  getOrganizationUsageSummary,
  transitionSessionVisibility,
  submitHumanPromptInTransaction,
  updateOrganizationPrivateSessionSettings,
  withSessionRlsActorContext,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";

import { getWorkspaceInsights } from "../src/domain/insights";

setDefaultTimeout(180_000);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const since = "2026-09-14T00:00:00.000Z";
const occurredAt = "2026-09-14T03:00:00.000Z";
const now = new Date("2026-09-14T12:00:00.000Z");

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("insights-charge-reconciliation");
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture() {
  if (!shared || !client) throw new Error("PostgreSQL test database unavailable");
  const userId = `insights-ledger-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Ledger owner",
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  await shared.admin`insert into session_tenancy_activations
    (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  const settings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: subjectId,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: subjectId,
    enabled: true,
    expectedVersion: settings.version,
    operationId: crypto.randomUUID(),
  });
  const create = async (owner = subjectId, parentSessionId: string | null = null) =>
    await withSessionRlsActorContext({ subjectId: owner }, () =>
      createSession(client!.db, {
        accountId,
        workspaceId,
        initialMessage: "SECRET RECONCILIATION CONTENT",
        resources: [],
        metadata: {},
        model: "fixture-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        parentSessionId,
        visibility: parentSessionId ? "user_private" : "workspace_shared",
        createdBy: { kind: "subject", subjectId: owner },
        createdByContext: {},
      }),
    );
  const makePrivate = async (sessionId: string, owner = subjectId) =>
    await transitionSessionVisibility(client!.db, {
      workspaceId,
      sessionId,
      actorSubjectId: owner,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: crypto.randomUUID(),
    });
  const readWorkspace = (
    viewer: string,
    filter: { provider?: string; model?: string; rootSessionId?: string; sessionId?: string } = {},
  ) =>
    withSessionRlsActorContext({ subjectId: viewer }, () =>
      getWorkspaceInsights(client!.db, testSettings({ sandboxSelfhostedEnabled: false }), {
        workspaceId,
        range: "today",
        now,
        ...filter,
      }),
    );
  const readOrganization = (viewer: string) =>
    withSessionRlsActorContext({ subjectId: viewer }, () =>
      getOrganizationUsageSummary(client!.db, { accountId, period: "today" }, now),
    );
  const readModels = (viewer: string) =>
    withSessionRlsActorContext({ subjectId: viewer }, () =>
      getOrganizationModelUsage(client!.db, { accountId, period: "today" }, now),
    );
  return {
    accountId,
    workspaceId,
    subjectId,
    create,
    makePrivate,
    readWorkspace,
    readOrganization,
    readModels,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Coherent facts, charged usage and independent negative credit debits. */
async function charge(
  seeded: Fixture,
  sessionId: string,
  input: {
    provider?: string;
    model?: string;
    credits: number;
    estimate: number | null;
    tokens?: number | null;
    at?: string;
  },
) {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const source = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const at = input.at ?? occurredAt;
  const tokens = input.tokens === undefined ? 20 : input.tokens;
  const provider = input.provider ?? "openai";
  const billingPath = input.credits > 0 ? "opengeni_credits" : "external";
  await shared.admin`insert into model_call_facts
    (account_id, workspace_id, session_id, turn_id, source_key, provider, provider_api, model,
     billing_path, input_tokens, output_tokens, cached_tokens, total_tokens, priced_cost_micros,
     estimated_provider_cost_micros, pricing_source, context_contributions, occurred_at)
    values (${seeded.accountId}, ${seeded.workspaceId}, ${sessionId}, ${turnId}, ${source},
      ${provider}, 'responses', ${input.model ?? "ledger-model"}, ${billingPath},
      ${tokens}, 0, null, ${tokens}, ${input.credits}, ${input.estimate},
      ${input.estimate === null ? null : "configured_list_price"},
      '[{"source":"company_profile","items":1,"utf8Bytes":40,"estimatedTokens":10}]'::jsonb,
      ${at})`;
  await shared.admin`insert into usage_events
    (account_id, workspace_id, session_id, event_type, quantity, unit,
     source_resource_type, source_resource_id, idempotency_key, occurred_at)
    values (${seeded.accountId}, ${seeded.workspaceId}, ${sessionId}, 'model.cost',
      ${input.credits}, 'usd_micros', 'model_response', ${source}, ${`usage:${source}`}, ${at})`;
  await shared.admin`insert into credit_ledger_entries
    (account_id, workspace_id, type, amount_micros, source_type, source_id, idempotency_key, occurred_at)
    values (${seeded.accountId}, ${seeded.workspaceId}, 'usage_debit', ${-input.credits},
      'model_response', ${source}, ${`debit:${source}`}, ${at})`;
  return { turnId, source };
}

/** No production projections, session joins or visibility functions in this oracle. */
async function oracle(seeded: Fixture) {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const [ledger] = await shared.admin<Array<{ amount: string; events: string }>>`
    select coalesce(sum(quantity), 0)::text as amount, count(*)::text as events
    from usage_events where account_id = ${seeded.accountId} and workspace_id = ${seeded.workspaceId}
      and event_type = 'model.cost' and unit = 'usd_micros'
      and occurred_at >= ${since} and occurred_at < ${now.toISOString()}`;
  const [debits] = await shared.admin<Array<{ amount: string }>>`
    select coalesce(-sum(amount_micros), 0)::text as amount from credit_ledger_entries
    where account_id = ${seeded.accountId} and workspace_id = ${seeded.workspaceId}
      and type = 'usage_debit' and occurred_at >= ${since} and occurred_at < ${now.toISOString()}`;
  const [facts] = await shared.admin<
    Array<{ calls: string; tokens: string; estimate: string; known: string }>
  >`
    select count(*)::text as calls, coalesce(sum(total_tokens), 0)::text as tokens,
      coalesce(sum(estimated_provider_cost_micros), 0)::text as estimate,
      count(estimated_provider_cost_micros)::text as known
    from model_call_facts where account_id = ${seeded.accountId} and workspace_id = ${seeded.workspaceId}
      and occurred_at >= ${since} and occurred_at < ${now.toISOString()}`;
  expect(ledger!.amount).toBe(debits!.amount);
  return { ledger: ledger!, facts: facts! };
}

/** Full row fingerprints, including zero-value and out-of-window charges. */
async function accountingState(seeded: Fixture) {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  return await shared.admin`
    select 'usage' as source, count(*)::text as rows,
      md5(coalesce(string_agg(to_jsonb(row)::text, '' order by row.id), '')) as fingerprint
    from usage_events row where account_id = ${seeded.accountId}
    union all
    select 'debits', count(*)::text,
      md5(coalesce(string_agg(to_jsonb(row)::text, '' order by row.id), ''))
    from credit_ledger_entries row where account_id = ${seeded.accountId}
    union all
    select 'facts', count(*)::text,
      md5(coalesce(string_agg(to_jsonb(row)::text, '' order by row.id), ''))
    from model_call_facts row where account_id = ${seeded.accountId}
    order by source`;
}

const cost = (totals: OrganizationUsageSummary["totals"]) =>
  totals.find((total) => total.eventType === "model.cost" && total.unit === "usd_micros");

test("complete org/workspace accounting reconciles to ledger/debits and separate provider facts without hidden JSON identity", async () => {
  if (!shared || !client) return;
  const seeded = await fixture();
  const publicRoot = await seeded.create();
  const privateRoot = await seeded.create();
  await seeded.makePrivate(privateRoot.id);
  const submitted = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    seeded.workspaceId,
    seeded.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: seeded.accountId,
          workspaceId: seeded.workspaceId,
          sessionId: privateRoot.id,
          subjectId: seeded.subjectId,
          actor: { type: "human", subjectId: seeded.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "SECRET CHILD PROMPT",
          resources: [],
          model: "fixture-model",
          reasoningEffort: "medium",
          reasoningEffortFallback: "medium",
          source: "user",
        }),
      ),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, seeded.workspaceId, {
    sessionId: privateRoot.id,
    workflowId: `session-${privateRoot.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed" || claim.turn.id !== submitted.turnId)
    throw new Error("Private parent was not claimed");
  const childInput: Parameters<typeof createSession>[1] = {
    accountId: seeded.accountId,
    workspaceId: seeded.workspaceId,
    visibility: "user_private",
    parentSessionId: privateRoot.id,
    sandboxGroupId: privateRoot.sandboxGroupId,
    initialMessage: "SECRET CHILD CONTENT",
    resources: [],
    metadata: {},
    model: "fixture-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdByActor: {
      type: "agent_attempt",
      sessionId: privateRoot.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  };
  const privateChild = await createSession(client.db, childInput);
  const sharedChild = await createSession(client.db, {
    ...childInput,
    initialMessage: "Visible independent child",
  });
  await transitionSessionVisibility(client.db, {
    workspaceId: seeded.workspaceId,
    sessionId: sharedChild.id,
    actorSubjectId: seeded.subjectId,
    targetVisibility: "workspace_shared",
    expectedAuthorityEpoch: 1,
    operationKey: crypto.randomUUID(),
  });
  const deleted = await seeded.create();
  const missingId = (await seeded.create()).id;
  await shared.admin`update sessions set title = 'HIDDEN RECONCILIATION TITLE'
    where id in (${privateRoot.id}, ${privateChild.id}, ${deleted.id})`;
  await charge(seeded, publicRoot.id, { credits: 101, estimate: 77 });
  await charge(seeded, sharedChild.id, { credits: 19, estimate: 11 });
  const hidden = await charge(seeded, privateRoot.id, { credits: 203, estimate: 133 });
  await charge(seeded, privateChild.id, { credits: 307, estimate: null, tokens: null });
  await charge(seeded, deleted.id, { credits: 401, estimate: 199 });
  await charge(seeded, missingId, { credits: 503, estimate: 251 });
  await charge(seeded, privateRoot.id, {
    provider: "codex-subscription",
    credits: 0,
    estimate: 59,
  });
  await charge(seeded, privateRoot.id, {
    provider: "supergrok-subscription",
    credits: 0,
    estimate: null,
  });
  await charge(seeded, privateRoot.id, { provider: "workspace-gateway", credits: 0, estimate: 61 });
  await charge(seeded, publicRoot.id, { credits: 997, estimate: 887, at: now.toISOString() });
  await charge(seeded, publicRoot.id, {
    credits: 991,
    estimate: 881,
    at: "2026-09-13T23:59:59.999Z",
  });
  const publicGroup = publicRoot.sandboxGroupId ?? publicRoot.id;
  const privateGroup = privateRoot.sandboxGroupId ?? privateRoot.id;
  // Warm usage can be workspace-level yet still carry a private root/group ID.
  // Its amount is billable; its group must not become a visible detail row.
  for (const [sessionId, groupId, seconds] of [
    [null, publicGroup, 11],
    [null, privateGroup, 23],
    [privateRoot.id, privateGroup, 29],
  ] as const) {
    await shared.admin`insert into usage_events
      (account_id, workspace_id, session_id, event_type, quantity, unit,
       source_resource_type, source_resource_id, idempotency_key, occurred_at)
      values (${seeded.accountId}, ${seeded.workspaceId}, ${sessionId}, 'sandbox.warm_seconds',
        ${seconds}, 'seconds', 'sandbox_group', ${`${groupId}:1`}, ${crypto.randomUUID()}, ${occurredAt})`;
  }
  for (const groupId of [publicGroup, privateGroup]) {
    await shared.admin`insert into sandbox_leases
      (account_id, workspace_id, sandbox_group_id, backend, liveness, expires_at)
      values (${seeded.accountId}, ${seeded.workspaceId}, ${groupId}, 'local', 'warm',
        ${new Date(now.getTime() + 60_000).toISOString()})`;
  }
  // Usage/facts deliberately survive their session. No test-only RLS bypass on reads.
  await shared.admin`delete from sessions where id in (${deleted.id}, ${missingId})`;
  const viewer = `user:ledger-viewer-${crypto.randomUUID()}`;
  const expected = await oracle(seeded);
  const unchanged = await accountingState(seeded);
  const organization = await seeded.readOrganization(viewer);
  const models = await seeded.readModels(viewer);
  const response = await seeded.readWorkspace(viewer);
  const { snapshot } = response;
  expect(cost(organization.totals)).toEqual({
    eventType: "model.cost",
    unit: "usd_micros",
    quantity: expected.ledger.amount,
    eventCount: expected.ledger.events,
  });
  expect(cost(organization.workspaces[0]!.totals)).toEqual(cost(organization.totals));
  expect(snapshot.workspaceCreditUsd).toBe(Number(expected.ledger.amount) / 1_000_000);
  expect(snapshot.creditUsd).toBe(Number(expected.ledger.amount) / 1_000_000);
  expect(snapshot.modelCalls).toBe(Number(expected.facts.calls));
  expect(snapshot.warmSeconds).toBe(63);
  expect(snapshot.series.reduce((sum, row) => sum + row.warmSeconds, 0)).toBe(63);
  expect(snapshot.warmGroups.map((row) => row.groupId)).toEqual([publicGroup]);
  expect(snapshot.liveWarm.map((row) => row.groupId)).toEqual([publicGroup]);
  expect(organization.totals.find((row) => row.eventType === "sandbox.warm_seconds")).toEqual({
    eventType: "sandbox.warm_seconds",
    unit: "seconds",
    quantity: "63",
    eventCount: "3",
  });
  expect(snapshot.estimatedProviderUsd).toBe(Number(expected.facts.estimate) / 1_000_000);
  expect(snapshot.estimatedProviderCostKnownCalls).toBe(Number(expected.facts.known));
  expect(snapshot.models.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(
    Number(expected.facts.tokens),
  );
  expect(snapshot.projects.reduce((sum, row) => sum + row.creditUsd, 0)).toBeCloseTo(
    snapshot.creditUsd,
    12,
  );
  expect(snapshot.privateChats).toHaveLength(1);
  expect(snapshot.privateChats[0]).toMatchObject({
    you: false,
    calls: 5,
    creditUsd: 510 / 1_000_000,
  });
  expect(snapshot.privateChats[0]!.ownerKey).toMatch(/^[a-f0-9]{64}$/);
  expect(snapshot.privateChatsTruncated).toBe(false);
  expect(organization.privateChats).toHaveLength(1);
  expect(cost(organization.privateChats[0]!.totals)?.quantity).toBe("510");
  expect(organization.privateChatsTruncated).toBe(false);
  expect(models.payers.find((row) => row.payer === "opengeni_credits")?.creditMicros).toBe(
    expected.ledger.amount,
  );
  expect(models.payers.find((row) => row.payer === "subscription")?.calls).toBe("2");
  expect(models.payers.find((row) => row.payer === "own_key")?.calls).toBe("1");
  expect(
    snapshot.recentCalls.every((row) => [publicRoot.id, sharedChild.id].includes(row.sessionId)),
  ).toBe(true);
  expect(snapshot.drivers).toHaveLength(1);
  expect(snapshot.drivers.every((row) => row.id === `root:${publicRoot.id}`)).toBe(true);
  // Actual response fields retain the released numeric v1 wire shape even
  // when every seeded fact has unknown cached tokens and prior calls are empty.
  expect(snapshot.priorCacheHitPct).toBe(0);
  expect(snapshot.series.length).toBeGreaterThan(0);
  expect(snapshot.series.every((row) => typeof row.cacheHitPct === "number")).toBe(true);
  expect(snapshot.drivers.every((row) => typeof row.cacheHitPct === "number")).toBe(true);
  expect(WorkspaceInsightsSnapshot.safeParse({ ...snapshot, priorCacheHitPct: null }).success).toBe(
    false,
  );
  const wire = JSON.stringify({ response, organization, models });
  for (const secret of [
    privateRoot.id,
    privateChild.id,
    privateGroup,
    deleted.id,
    missingId,
    hidden.turnId,
    hidden.source,
    "HIDDEN RECONCILIATION TITLE",
    "SECRET RECONCILIATION CONTENT",
  ]) {
    expect(wire).not.toContain(secret);
  }
  const filtered = (
    await seeded.readWorkspace(viewer, { provider: "codex-subscription", model: "ledger-model" })
  ).snapshot;
  expect(filtered.modelCalls).toBe(1);
  expect(filtered.privateChats[0]).toMatchObject({
    calls: 1,
    creditUsd: 0,
    estimatedProviderUsd: 59 / 1_000_000,
  });
  for (const filter of [
    { rootSessionId: publicRoot.id },
    { sessionId: publicRoot.id },
    { rootSessionId: privateRoot.id },
    { sessionId: privateRoot.id },
  ]) {
    const scoped = (await seeded.readWorkspace(viewer, filter)).snapshot;
    expect(scoped.privateChats).toEqual([]);
    expect(scoped.privateChatsTruncated).toBe(false);
    if (filter.rootSessionId === privateRoot.id || filter.sessionId === privateRoot.id) {
      expect(scoped.modelCalls).toBe(0);
      expect(scoped.scope).toEqual({ rootSessionId: null, sessionId: null });
      expect(JSON.stringify(scoped)).not.toContain(privateRoot.id);
    }
  }
  const childScope = (await seeded.readWorkspace(viewer, { sessionId: sharedChild.id })).snapshot;
  expect(childScope.modelCalls).toBe(1);
  expect(childScope.drivers).toEqual([]);
  expect(childScope.privateChats).toEqual([]);
  expect(JSON.stringify(childScope)).not.toContain(privateRoot.id);
  const {
    privateChats: _workspacePrivate,
    privateChatsTruncated: _workspaceFlag,
    ...oldSnapshot
  } = snapshot;
  expect(WorkspaceInsightsSnapshot.parse(oldSnapshot)).toMatchObject({
    privateChats: [],
    privateChatsTruncated: false,
  });
  const {
    privateChats: _orgPrivate,
    privateChatsTruncated: _orgFlag,
    ...oldOrganization
  } = organization;
  expect(OrganizationUsageSummary.parse(oldOrganization)).toMatchObject({
    privateChats: [],
    privateChatsTruncated: false,
  });
  const { payers: _payers, ...oldModels } = models;
  expect(OrganizationModelUsage.parse(oldModels).payers).toEqual([]);
  const owner = (await seeded.readWorkspace(seeded.subjectId)).snapshot;
  expect(owner.privateChats).toEqual([]);
  expect(owner.workspaceCreditUsd).toBe(snapshot.workspaceCreditUsd);
  expect(owner.modelCalls).toBe(snapshot.modelCalls);
  expect(cost((await seeded.readOrganization(seeded.subjectId)).totals)).toEqual(
    cost(organization.totals),
  );
  expect(await accountingState(seeded)).toEqual(unchanged);
});

test("201 owners truncate only private rows; >50 models never cap payer accounting", async () => {
  if (!shared || !client) return;
  const seeded = await fixture();
  const viewer = seeded.subjectId;
  const sessions: string[] = [];
  for (let index = 0; index < 201; index++) {
    const subjectId = `user:private-owner-${crypto.randomUUID()}`;
    const personalId = crypto.randomUUID();
    await shared.admin`insert into workspaces (id, account_id, name) values (${personalId}, ${seeded.accountId}, 'Personal')`;
    await shared.admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${seeded.accountId}, ${subjectId}, 'active', ${personalId})`;
    await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role, permissions)
      values (${seeded.accountId}, ${seeded.workspaceId}, ${subjectId}, ${`Member ${index}`}, 'member', '["sessions:read","sessions:control"]'::jsonb)`;
    const session = await seeded.create(subjectId);
    await seeded.makePrivate(session.id, subjectId);
    sessions.push(session.id);
    await charge(seeded, session.id, {
      model: `capped-model-${index}`,
      credits: index + 1,
      estimate: index % 2 === 0 ? index + 2 : null,
      tokens: index + 1,
    });
  }
  for (const provider of ["codex-subscription", "supergrok-subscription", "workspace-gateway"])
    await charge(seeded, sessions[0]!, {
      provider,
      model: `${provider}-model`,
      credits: 0,
      estimate: 13,
    });
  const expected = await oracle(seeded);
  const unchanged = await accountingState(seeded);
  const organization = await seeded.readOrganization(viewer);
  const models = await seeded.readModels(viewer);
  const { snapshot } = await seeded.readWorkspace(viewer);
  expect(organization.privateChats).toHaveLength(200);
  expect(organization.privateChatsTruncated).toBe(true);
  expect(snapshot.privateChats).toHaveLength(200);
  expect(snapshot.privateChatsTruncated).toBe(true);
  expect(snapshot.privateChats[0]!.tokens).toBe(201);
  expect(snapshot.privateChats[0]!.name).toBe("Member 200");
  expect(cost(organization.totals)?.quantity).toBe(expected.ledger.amount);
  expect(cost(organization.workspaces[0]!.totals)?.quantity).toBe(expected.ledger.amount);
  expect(snapshot.workspaceCreditUsd).toBe(Number(expected.ledger.amount) / 1_000_000);
  expect(snapshot.modelCalls).toBe(Number(expected.facts.calls));
  expect(snapshot.models).toHaveLength(204);
  expect(models.models).toHaveLength(50);
  expect(models.modelsTruncated).toBe(true);
  expect(models.payers.find((row) => row.payer === "opengeni_credits")).toMatchObject({
    calls: "201",
    creditMicros: expected.ledger.amount,
  });
  expect(models.payers.find((row) => row.payer === "subscription")?.calls).toBe("2");
  expect(models.payers.find((row) => row.payer === "own_key")?.calls).toBe("1");
  expect(models.payers.reduce((sum, row) => sum + BigInt(row.estimatedProviderMicros), 0n)).toBe(
    BigInt(expected.facts.estimate),
  );
  expect(snapshot.privateChats.reduce((sum, row) => sum + row.calls, 0)).toBeLessThan(
    snapshot.modelCalls,
  );
  expect(snapshot.drivers).toEqual([]);
  expect(snapshot.recentCalls).toEqual([]);
  const wire = JSON.stringify({ snapshot, organization, models });
  for (const sessionId of sessions) expect(wire).not.toContain(sessionId);
  const onlyOne = (await seeded.readWorkspace(viewer, { model: "capped-model-200" })).snapshot;
  expect(onlyOne.privateChats).toHaveLength(1);
  expect(onlyOne.privateChatsTruncated).toBe(false);
  expect(onlyOne.modelCalls).toBe(1);
  expect(await accountingState(seeded)).toEqual(unchanged);
});
