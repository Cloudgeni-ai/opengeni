import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getBillingBalance,
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
  CODE_SEARCH_DEBIT_TYPE,
  CodeSearchBillingRefusedError,
  codeSearchCreditBillingActive,
  codeSearchCreditMicros,
  createCodeSearchBilling,
  type CodeSearchCallScope,
} from "../src/domain/code-search-billing";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("code-search-billing");
  if (!acquired) throw new Error("Code search billing verification requires PostgreSQL");
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
  codeSearchBillingMode: "credits",
  codeSearchCreditMarginBps: 500,
});
const PAID_MODEL = "scripted-model";
const CREDITS_ROUTE = {
  funding: "credits",
  keySource: "deployment",
  provider: "openrouter",
} as const;

async function fixture(options: { credits?: number; promotionalFor?: string[] } = {}) {
  const human = `user:code-search:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "code-search-billing",
    accountExternalId: crypto.randomUUID(),
    accountName: "Code search",
    workspaceExternalSource: "code-search-billing",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Code search",
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
    initialMessage: "Find the code",
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
      text: "Search the code",
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
      idempotencyKey: `test:code-search-grant:${grant.workspaceId}`,
      ...(options.promotionalFor ? { eligibleModelIds: options.promotionalFor } : {}),
    });
  }
  const scope: CodeSearchCallScope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    productModelId: PAID_MODEL,
  };
  return { scope, human };
}

const cost = (providerMicros: number, route = CREDITS_ROUTE) => ({
  operationId: crypto.randomUUID(),
  route,
  model: "typesafe/jev-1.13",
  providerMicros,
  basis: "provider_reported" as const,
});

async function ledger(accountId: string) {
  return await shared.admin<
    { amount_micros: string; source_type: string; metadata: Record<string, unknown> }[]
  >`select amount_micros, source_type, metadata from credit_ledger_entries
      where account_id=${accountId} and type=${CODE_SEARCH_DEBIT_TYPE}`;
}

describe("code search credit pricing", () => {
  test("charges the provider cost plus the margin, rounded up", () => {
    expect(codeSearchCreditMicros(9_000, 500)).toBe(9_450);
    expect(codeSearchCreditMicros(1, 500)).toBe(2);
    expect(codeSearchCreditMicros(9_000, 0)).toBe(9_000);
    expect(codeSearchCreditMicros(0, 500)).toBe(0);
  });

  test("charges only in credits mode on a deployment that bills credits", () => {
    expect(codeSearchCreditBillingActive(billed)).toBe(true);
    expect(codeSearchCreditBillingActive({ ...billed, codeSearchBillingMode: "usage_only" })).toBe(
      false,
    );
    expect(
      codeSearchCreditBillingActive({
        ...billed,
        billingMode: "disabled",
        usageLimitsMode: "none",
      }),
    ).toBe(false);
    expect(
      codeSearchCreditBillingActive({
        ...billed,
        billingMode: "disabled",
        usageLimitsMode: "managed",
      }),
    ).toBe(true);
  });
});

describe("code search credit billing", () => {
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
    const billing = createCodeSearchBilling({ db: client.db, settings: billed });
    await billing.admit(scope, CREDITS_ROUTE);
    const call = cost(9_000);
    expect(await billing.settle(scope, call)).toBe(9_450);
    // A retried settlement of the same call never charges twice.
    await billing.settle(scope, call);
    const rows = await ledger(scope.accountId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amount_micros)).toBe(-9_450);
    expect(rows[0]!.source_type).toBe("code_search");
    expect(rows[0]!.metadata).toMatchObject({
      turnId: scope.turnId,
      initiatingHumanSubjectId: human,
      provider: "openrouter",
      model: "typesafe/jev-1.13",
      productModelId: PAID_MODEL,
      providerCostMicros: 9_000,
      marginBps: 500,
      basis: "provider_reported",
    });
    const usage = await shared.admin<
      { event_type: string; quantity: string; unit: string; turn_attempt_id: string }[]
    >`select event_type, quantity, unit, turn_attempt_id from usage_events
        where account_id=${scope.accountId} and source_resource_type='code_search'`;
    expect(usage.map((row) => [row.event_type, Number(row.quantity), row.unit])).toEqual([
      ["code_search.cost", 9_450, "usd_micros"],
    ]);
    expect(usage[0]!.turn_attempt_id).toBe(scope.attemptId);
    const counters = await shared.admin<{ subject_id: string; used: string }[]>`
        select subject_id, used from opengeni_private.workspace_allowance_counters
        where workspace_id=${scope.workspaceId} order by subject_id`;
    expect(counters.map((row) => [row.subject_id, Number(row.used)])).toEqual([
      ["", 9_450],
      [human, 9_450],
    ]);
  }, 180_000);

  test("promotional credits for the turn's model pay first and admit the call", async () => {
    const { scope } = await fixture({ credits: 100_000, promotionalFor: [PAID_MODEL] });
    const billing = createCodeSearchBilling({ db: client.db, settings: billed });
    await billing.admit(scope, CREDITS_ROUTE);
    await billing.settle(scope, cost(10_000));
    const rows = await ledger(scope.accountId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amount_micros)).toBe(-10_500);
    // The model's promotional grant paid; general credit was never touched.
    const balance = await getBillingBalance(client.db, scope.accountId);
    expect(balance.generalBalanceMicros).toBe(0);
    expect(balance.promotionalCredits?.[0]?.remainingMicros).toBe(89_500);
    // A grant for another model does not admit the call.
    const other = await fixture({ credits: 100_000, promotionalFor: ["another-model"] });
    const refusal = await billing
      .admit(other.scope, CREDITS_ROUTE)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CodeSearchBillingRefusedError);
    expect((refusal as CodeSearchBillingRefusedError).code).toBe("insufficient_credits");
  }, 180_000);

  test("charged calls are refused without credits or with an exhausted member allowance", async () => {
    const broke = await fixture();
    const billing = createCodeSearchBilling({ db: client.db, settings: billed });
    const refusal = await billing
      .admit(broke.scope, CREDITS_ROUTE)
      .catch((error: unknown) => error);
    expect((refusal as CodeSearchBillingRefusedError).code).toBe("insufficient_credits");

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
    await billing.settle(limited.scope, cost(1_000));
    const exhausted = await billing
      .admit(limited.scope, CREDITS_ROUTE)
      .catch((error: unknown) => error);
    expect((exhausted as CodeSearchBillingRefusedError).code).toBe("allowance_exhausted");
  }, 180_000);

  test("routes paid by the deployment or the customer, and usage_only, are never charged", async () => {
    const { scope } = await fixture();
    const billing = createCodeSearchBilling({ db: client.db, settings: billed });
    for (const route of [
      { funding: "external", keySource: "workspace_connection", provider: "openrouter" },
      { funding: "deployment", keySource: "deployment", provider: "typesafe" },
    ] as const) {
      // No credits at all, yet nothing is refused or charged.
      await billing.admit(scope, route);
      expect(await billing.settle(scope, cost(9_000, route as never))).toBe(0);
    }
    const usageOnly = createCodeSearchBilling({
      db: client.db,
      settings: testSettings({ ...billed, codeSearchBillingMode: "usage_only" }),
    });
    await usageOnly.admit(scope, CREDITS_ROUTE);
    expect(await usageOnly.settle(scope, cost(9_000))).toBe(0);
    expect(await ledger(scope.accountId)).toHaveLength(0);
    const usage = await shared.admin`select 1 from usage_events
        where account_id=${scope.accountId} and event_type='code_search.cost'`;
    expect(usage).toHaveLength(0);
  }, 180_000);
});
