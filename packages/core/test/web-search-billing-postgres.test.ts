import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  setMemberAllowance,
  setWorkspaceAllowance,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  WEB_SEARCH_DEBIT_TYPE,
  WebSearchBillingRefusedError,
  createWebSearchBilling,
  type WebSearchCallScope,
} from "../src/domain/web-search-billing";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("web-search-billing");
  if (!acquired) throw new Error("Web search billing verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const billed = testSettings({
  billingMode: "stripe",
  usageLimitsMode: "none",
  sandboxBackend: "none",
});

async function fixture(options: { credits?: number } = {}) {
  const human = `user:web-search:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "web-search-billing",
    accountExternalId: crypto.randomUUID(),
    accountName: "Web search",
    workspaceExternalSource: "web-search-billing",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Web search",
    subjectId: human,
  });
  const grant = access.workspaceGrants[0]!;
  const personalId = crypto.randomUUID();
  await shared.admin`insert into workspaces(id,account_id,name)
    values(${personalId},${grant.accountId},'Personal')`;
  await shared.admin`insert into organization_memberships
    (account_id,subject_id,role,status,personal_workspace_id)
    values(${grant.accountId},${human},'owner','active',${personalId})`;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Find the news",
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: human },
  });
  await withWorkspaceSubjectSessionActivityRls(client.db, grant.workspaceId, human, (tx) =>
    submitHumanPromptInTransaction(tx, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: human,
      actor: { type: "human", subjectId: human },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Search the web",
      resources: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      reasoningEffortFallback: "medium",
      source: "user",
    }),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`Fixture claim failed: ${claimed.reason}`);
  if (options.credits) {
    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      type: "grant",
      amountMicros: options.credits,
      sourceType: "test_grant",
      sourceId: crypto.randomUUID(),
      idempotencyKey: `test:web-search-grant:${grant.workspaceId}`,
    });
  }
  const scope: WebSearchCallScope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
  };
  return { scope, human };
}

describe("web search credit billing", () => {
  test("settlement records the receipt and one idempotent debit attributed to the turn's human", async () => {
    const { scope, human } = await fixture({ credits: 1_000_000 });
    await setWorkspaceAllowance(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      actorSubjectId: human,
      includedCredits: 1_000_000,
      period: "monthly",
      expectedVersion: 0,
    });
    const billing = createWebSearchBilling({ db: client.db, settings: billed });
    await billing.admit(scope, 5_000);
    const cost = {
      operationId: crypto.randomUUID(),
      operation: "search" as const,
      provider: "brave",
      providerMicros: 5_000,
      creditMicros: 5_250,
      marginBps: 500,
      basis: "list_price" as const,
    };
    await billing.settle(scope, cost);
    // A retried settlement of the same call never charges twice.
    await billing.settle(scope, cost);
    const ledger = await shared.admin<
      {
        type: string;
        amount_micros: string;
        source_type: string;
        metadata: Record<string, unknown>;
      }[]
    >`select type, amount_micros, source_type, metadata from credit_ledger_entries
        where account_id=${scope.accountId} and type=${WEB_SEARCH_DEBIT_TYPE}`;
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]!.amount_micros)).toBe(-5_250);
    expect(ledger[0]!.source_type).toBe("web_search");
    expect(ledger[0]!.metadata).toMatchObject({
      turnId: scope.turnId,
      initiatingHumanSubjectId: human,
      provider: "brave",
      providerCostMicros: 5_000,
      marginBps: 500,
    });
    const usage = await shared.admin<
      { event_type: string; quantity: string; turn_attempt_id: string }[]
    >`select event_type, quantity, turn_attempt_id from usage_events
        where account_id=${scope.accountId} and source_resource_type='web_search'
        order by event_type`;
    expect(usage.map((row) => [row.event_type, Number(row.quantity)])).toEqual([
      ["web_search.cost", 5_250],
      ["web_search.search_requests", 1],
    ]);
    expect(usage.every((row) => row.turn_attempt_id === scope.attemptId)).toBe(true);
    const counters = await shared.admin<{ subject_id: string; used: string }[]>`
        select subject_id, used from opengeni_private.workspace_allowance_counters
        where workspace_id=${scope.workspaceId} order by subject_id`;
    expect(counters.map((row) => [row.subject_id, Number(row.used)])).toEqual([
      ["", 5_250],
      [human, 5_250],
    ]);
  }, 180_000);

  test("paid calls are refused without credits or with an exhausted member allowance", async () => {
    const broke = await fixture();
    const billing = createWebSearchBilling({ db: client.db, settings: billed });
    const refusal = await billing.admit(broke.scope, 5_000).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(WebSearchBillingRefusedError);
    expect((refusal as WebSearchBillingRefusedError).code).toBe("insufficient_credits");
    // Free calls are never refused.
    await billing.admit(broke.scope, 0);

    const limited = await fixture({ credits: 1_000_000 });
    const policy = {
      accountId: limited.scope.accountId,
      workspaceId: limited.scope.workspaceId,
      actorSubjectId: limited.human,
    };
    await setWorkspaceAllowance(client.db, {
      ...policy,
      includedCredits: 1_000_000,
      period: "monthly",
      expectedVersion: 0,
    });
    await setMemberAllowance(client.db, {
      ...policy,
      subjectId: limited.human,
      rule: { credits: 1_000 },
      expectedVersion: 0,
    });
    await billing.settle(limited.scope, {
      operationId: crypto.randomUUID(),
      operation: "fetch",
      provider: "exa",
      providerMicros: 1_000,
      creditMicros: 1_050,
      marginBps: 500,
      basis: "provider_reported",
    });
    const exhausted = await billing.admit(limited.scope, 1_000).catch((error: unknown) => error);
    expect((exhausted as WebSearchBillingRefusedError).code).toBe("allowance_exhausted");
  }, 180_000);

  test("deployments without credit billing record request counts only", async () => {
    const { scope } = await fixture();
    const billing = createWebSearchBilling({
      db: client.db,
      settings: testSettings({ billingMode: "disabled", usageLimitsMode: "none" }),
    });
    await billing.admit(scope, 5_000);
    await billing.settle(scope, {
      operationId: crypto.randomUUID(),
      operation: "search",
      provider: "tavily",
      providerMicros: 8_000,
      creditMicros: 8_400,
      marginBps: 500,
      basis: "provider_reported",
    });
    const rows = await shared.admin<{ event_type: string }[]>`
        select event_type from usage_events where account_id=${scope.accountId}
          and source_resource_type='web_search'`;
    expect(rows.map((row) => row.event_type)).toEqual(["web_search.search_requests"]);
    const debits = await shared.admin`select 1 from credit_ledger_entries
        where account_id=${scope.accountId} and type=${WEB_SEARCH_DEBIT_TYPE}`;
    expect(debits).toHaveLength(0);
  }, 180_000);
});
