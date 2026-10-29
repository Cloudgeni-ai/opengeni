import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  applyCreditDebitAfterUse,
  applyCreditDebitUpToBalance,
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createSession,
  expirePlanCreditPeriod,
  ensureManagedAccessForUser,
  getBillingBalance,
  getSpendableCreditBalance,
  grantPlanCreditPeriod,
  initializeSessionStartAtomically,
  manualScheduledTaskRunBillingOrigin,
  markScheduledTaskApiBilled,
  nestedPostgresSqlState,
  readScheduledTaskBillingOrigin,
  upsertOrganizationPlan,
  withBillingOriginOverride,
  withRlsContext,
  type DbClient,
  type PlanCreditPeriodInput,
} from "../src";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
const M = 1_000_000;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("billing-usage-origin");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function proAccount() {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Plan owner",
  });
  const accountId = access.defaultAccountId!;
  const input: PlanCreditPeriodInput = {
    accountId,
    planKey: "pro",
    periodStart: new Date(Date.now() - 1000),
    periodEnd: new Date(Date.now() + 3_600_000),
    stripeSubscriptionId: `sub_${crypto.randomUUID()}`,
  };
  await upsertOrganizationPlan(client!.db, {
    ...input,
    status: "active",
    currentPeriodStart: input.periodStart,
    currentPeriodEnd: input.periodEnd,
  });
  await grantPlanCreditPeriod(client!.db, input);
  return accountId;
}
const topup = (accountId: string, amountMicros: number) =>
  applyCreditLedgerEntry(client!.db, {
    accountId,
    type: "credit_topup",
    amountMicros,
    idempotencyKey: crypto.randomUUID(),
  });

test("API usage spends credits only and never the plan allowance; runtime posture stays least-privilege", async () => {
  if (!client || !shared) return;
  const accountId = await proAccount();
  await topup(accountId, 30 * M);
  const start = await getBillingBalance(client.db, accountId);
  expect(start.plan?.creditRemainingMicros).toBe(200 * M);
  expect(start.creditsMicros).toBe(30 * M);

  // Admission: an API caller sees credits only, an app caller sees both.
  expect(
    (await getSpendableCreditBalance(client.db, accountId, undefined, undefined, undefined, "api"))
      .balanceMicros,
  ).toBe(30 * M);
  expect(
    (await getSpendableCreditBalance(client.db, accountId, undefined, undefined, undefined, "app"))
      .balanceMicros,
  ).toBe(230 * M);
  // An ambient override (an API request scope) decides when the caller does not.
  expect(
    (await withBillingOriginOverride("api", () => getSpendableCreditBalance(client!.db, accountId)))
      .balanceMicros,
  ).toBe(30 * M);

  // Up-to-balance: capped at credits, plan untouched.
  const capped = await applyCreditDebitUpToBalance(client.db, {
    accountId,
    type: "model_usage_debit",
    requestedAmountMicros: 50 * M,
    idempotencyKey: crypto.randomUUID(),
    usageOrigin: "api",
  });
  expect(capped.debitedMicros).toBe(30 * M);
  expect(capped.balance.plan?.creditRemainingMicros).toBe(200 * M);
  expect(capped.balance.creditsMicros).toBe(0);

  // After use: credits may go negative; the plan allowance still does not pay.
  const after = await applyCreditDebitAfterUse(client.db, {
    accountId,
    type: "model_usage_debit",
    amountMicros: 5 * M,
    sourceType: "test",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    usage: "model-a",
    usageOrigin: "api",
  });
  expect(after.balance.plan?.creditRemainingMicros).toBe(200 * M);
  expect(after.balance.creditsMicros).toBe(-5 * M);
  expect(
    (await getSpendableCreditBalance(client.db, accountId, undefined, undefined, undefined, "api"))
      .balanceMicros,
  ).toBe(0);

  // App usage keeps today's order: plan allowance first.
  const app = await applyCreditDebitAfterUse(client.db, {
    accountId,
    type: "model_usage_debit",
    amountMicros: 10 * M,
    sourceType: "test",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  });
  expect(app.balance.plan?.creditRemainingMicros).toBe(190 * M);
  expect(app.balance.creditsMicros).toBe(-5 * M);

  const origins = await shared.admin`
    select usage_origin, -amount_micros as amount from credit_ledger_entries
    where account_id = ${accountId}::uuid and type = 'model_usage_debit'
    order by created_at, id`;
  expect(origins.map((row) => [row.usage_origin, Number(row.amount)])).toEqual([
    ["api", 30 * M],
    ["api", 5 * M],
    ["app", 10 * M],
  ]);

  const options = {
    expectedRole: "opengeni_app",
    rlsStrategy: "force" as const,
    targetSchema: shared.schema,
  };
  expect(
    evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(client.db, options),
      options,
    ),
  ).toEqual([]);
}, 180_000);

test("API usage never spends scoped promotional credit", async () => {
  if (!client || !shared) return;
  const accountId = await proAccount();
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "grant",
    amountMicros: 40 * M,
    eligibleModelIds: ["model-a"],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(
    (await getSpendableCreditBalance(client.db, accountId, "model-a", undefined, undefined, "api"))
      .balanceMicros,
  ).toBe(0);
  const refused = await applyCreditDebitUpToBalance(client.db, {
    accountId,
    type: "model_usage_debit",
    requestedAmountMicros: 5 * M,
    modelId: "model-a",
    idempotencyKey: crypto.randomUUID(),
    usageOrigin: "api",
  });
  expect(refused.debitedMicros).toBe(0);
  expect(refused.balance.promotionalCredits?.find((g) => !g.planCredit)?.remainingMicros).toBe(
    40 * M,
  );
}, 180_000);

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId: `billing-origin-account-${suffix}`,
    accountName: "Billing origin account",
    workspaceExternalSource: "test",
    workspaceExternalId: `billing-origin-workspace-${suffix}`,
    workspaceName: "Billing origin workspace",
    subjectId: `billing-origin-subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}
async function startedSession(
  grant: { accountId: string; workspaceId: string },
  billingOrigin: "app" | "api" | null,
  parentSessionId: string | null = null,
) {
  const session = await createSession(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Run",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    parentSessionId,
  });
  const started = await initializeSessionStartAtomically(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: { source: "billing-origin-test" },
    billingOrigin,
  });
  return { session, turn: started.turn! };
}
async function turnOrigin(workspaceId: string, turnId: string) {
  const [row] = await shared!
    .admin`select billing_origin from session_turns where workspace_id = ${workspaceId}::uuid and id = ${turnId}::uuid`;
  return row?.billing_origin ?? null;
}

test("turns freeze their origin; undecided turns inherit the chat's, then the parent chat's", async () => {
  if (!client || !shared) return;
  const grant = await workspace();
  const api = await startedSession(grant, "api");
  expect(await turnOrigin(grant.workspaceId, api.turn.id)).toBe("api");

  // A sub-agent chat whose first turn decides nothing is billed like its parent.
  const child = await startedSession(grant, null, api.session.id);
  expect(await turnOrigin(grant.workspaceId, child.turn.id)).toBe("api");

  // No origin anywhere stays null (billed as app).
  const legacy = await startedSession(grant, null);
  expect(await turnOrigin(grant.workspaceId, legacy.turn.id)).toBeNull();

  // The origin cannot be rewritten once accepted.
  let failure: unknown;
  try {
    await withRlsContext(
      client.db,
      { accountId: grant.accountId, workspaceId: grant.workspaceId },
      (tx) =>
        tx.execute(
          sql`update session_turns set billing_origin = 'app' where workspace_id = ${grant.workspaceId}::uuid and id = ${api.turn.id}::uuid`,
        ),
    );
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe("55000");

  // A legacy null origin is not backfilled by a later write either.
  failure = undefined;
  try {
    await shared.admin`update session_turns set billing_origin = 'api' where id = ${legacy.turn.id}::uuid`;
  } catch (error) {
    failure = error;
  }
  expect((failure as { code?: string } | undefined)?.code).toBe("55000");

  // Only app and api are valid origins.
  const checks = await shared.admin`
    select conname, pg_get_constraintdef(oid) as def from pg_constraint
    where conname in ('session_turns_billing_origin_valid', 'scheduled_tasks_billing_origin_valid',
      'credit_ledger_entries_usage_origin_valid')
      and connamespace = ${shared.schema}::regnamespace
    order by conname`;
  expect(checks.map((row) => row.conname)).toEqual([
    "credit_ledger_entries_usage_origin_valid",
    "scheduled_tasks_billing_origin_valid",
    "session_turns_billing_origin_valid",
  ]);
  for (const row of checks) expect(row.def).toContain("'app'::text, 'api'::text");
}, 180_000);

async function proPeriod() {
  const accountId = await proAccount();
  const [row] = await shared!.admin`
    select id from plan_credit_periods where account_id = ${accountId}::uuid and expired_at is null`;
  return { accountId, periodId: row!.id as string };
}
async function nextProPeriod(accountId: string) {
  const input: PlanCreditPeriodInput = {
    accountId,
    planKey: "pro",
    periodStart: new Date(Date.now() - 500),
    periodEnd: new Date(Date.now() + 3_600_000),
    stripeSubscriptionId: `sub_${crypto.randomUUID()}`,
  };
  await upsertOrganizationPlan(client!.db, {
    ...input,
    status: "active",
    currentPeriodStart: input.periodStart,
    currentPeriodEnd: input.periodEnd,
  });
  return await grantPlanCreditPeriod(client!.db, input);
}
const apiOverrun = (accountId: string, amountMicros: number) =>
  applyCreditDebitAfterUse(client!.db, {
    accountId,
    type: "model_usage_debit",
    amountMicros,
    sourceType: "test",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    usageOrigin: "api",
  });

test("plan credit never repays API debt: not mid-period, not at expiry, not in the next period", async () => {
  if (!client || !shared) return;
  const { accountId, periodId } = await proPeriod();
  await topup(accountId, 1 * M);
  await apiOverrun(accountId, 6 * M);
  const owing = await getBillingBalance(client.db, accountId);
  expect(owing.creditsMicros).toBe(-5 * M);
  expect(owing.apiDebtMicros).toBe(5 * M);
  expect(owing.plan?.creditRemainingMicros).toBe(200 * M);
  // App work still has the whole plan allowance while credits owe API debt.
  expect(
    (await getSpendableCreditBalance(client.db, accountId, undefined, undefined, undefined, "app"))
      .balanceMicros,
  ).toBe(200 * M);
  expect(
    (await getSpendableCreditBalance(client.db, accountId, undefined, undefined, undefined, "api"))
      .balanceMicros,
  ).toBe(0);

  // Expiry removes the unused allowance; the API debt stays credit debt.
  await expirePlanCreditPeriod(client.db, { accountId, periodId, force: true });
  const expired = await getBillingBalance(client.db, accountId);
  expect(expired.balanceMicros).toBe(-5 * M);
  expect(expired.creditsMicros).toBe(-5 * M);

  // The next period opens in full: API debt is not netted from plan credit.
  const next = await nextProPeriod(accountId);
  expect(next.opening_debt_micros).toBe(0);
  const renewed = await getBillingBalance(client.db, accountId);
  expect(renewed.plan?.creditRemainingMicros).toBe(200 * M);
  expect(renewed.creditsMicros).toBe(-5 * M);

  // The next top-up repays the API debt first.
  await topup(accountId, 8 * M);
  expect((await getBillingBalance(client.db, accountId)).creditsMicros).toBe(3 * M);
}, 180_000);

test("an ended period awaiting expiry never reads API debt as spent plan credit", async () => {
  if (!client || !shared) return;
  const { accountId, periodId } = await proPeriod();
  await topup(accountId, 1 * M);
  await apiOverrun(accountId, 6 * M);
  // The period ended; no writer has expired it yet (the read settles it).
  await shared.admin`
    update plan_credit_periods set period_end = now() - interval '1 second'
    where id = ${periodId}::uuid`;
  const pending = await getBillingBalance(client.db, accountId);
  expect(pending.plan?.creditRemainingMicros).toBe(0);
  expect(pending.plan?.creditPendingExpiryMicros).toBe(200 * M);
  expect(pending.balanceMicros).toBe(-5 * M);
  expect(pending.creditsMicros).toBe(-5 * M);
  expect(pending.apiDebtMicros).toBe(5 * M);
}, 180_000);

test("app overruns still carry into the next period's opening debt", async () => {
  if (!client || !shared) return;
  const { accountId, periodId } = await proPeriod();
  await applyCreditDebitAfterUse(client.db, {
    accountId,
    type: "model_usage_debit",
    amountMicros: 205 * M,
    sourceType: "test",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  });
  await expirePlanCreditPeriod(client.db, { accountId, periodId, force: true });
  const next = await nextProPeriod(accountId);
  expect(next.opening_debt_micros).toBe(5 * M);
  const renewed = await getBillingBalance(client.db, accountId);
  expect(renewed.plan?.creditRemainingMicros).toBe(195 * M);
  expect(renewed.creditsMicros).toBe(0);
}, 180_000);

test("documents uploaded with an API key record their origin", async () => {
  if (!client || !shared) return;
  const grant = await workspace();
  const [base] = await shared.admin`
    insert into document_bases (account_id, workspace_id, name)
    values (${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${`base-${crypto.randomUUID()}`})
    returning id`;
  // The application role writes the row, as an upload does.
  const insert = async (attribution: Record<string, unknown>) => {
    const [file] = await shared!.admin`
      insert into files (account_id, workspace_id, status, filename, safe_filename, content_type,
        size_bytes, bucket, object_key)
      values (${grant.accountId}::uuid, ${grant.workspaceId}::uuid, 'ready', 'api.txt', 'api.txt',
        'text/plain', 1, 'test', ${`documents/${crypto.randomUUID()}`})
      returning id`;
    return await withRlsContext(
      client!.db,
      { accountId: grant.accountId, workspaceId: grant.workspaceId },
      (tx) =>
        tx.execute(sql`
          insert into documents (account_id, workspace_id, base_id, file_id, status, title, created_by,
            authority_kind, authority_workspace_id, visibility, billing_attribution)
          values (${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${base!.id}::uuid,
            ${file!.id}::uuid, 'queued', 'api', 'api-key:test', 'workspace', ${grant.workspaceId}::uuid,
            'workspace', ${JSON.stringify(attribution)}::jsonb)`),
    );
  };
  const codeOf = async (attribution: Record<string, unknown>) => {
    try {
      await insert(attribution);
      return null;
    } catch (error) {
      return nestedPostgresSqlState(error) ?? "unknown";
    }
  };
  expect(await codeOf({ kind: "service", billingOrigin: "api" })).toBeNull();
  expect(await codeOf({ kind: "service", billingOrigin: "app" })).toBeNull();
  expect(await codeOf({ kind: "service" })).toBeNull();
  expect(await codeOf({ kind: "service", billingOrigin: "free" })).toBe("23514");
  expect(await codeOf({ kind: "service", billingOrigin: "api", extra: 1 })).toBe("23514");
  const [jobs] = await shared.admin`
    select pg_get_constraintdef(oid) as def from pg_constraint
    where conname = 'knowledge_index_billing_attribution_check'
      and connamespace = ${shared.schema}::regnamespace`;
  expect(jobs?.def).toContain("billingOrigin");
}, 180_000);

test("an API caller's edit or manual run makes a schedule set up in the app API use", async () => {
  if (!client || !shared) return;
  const grant = await workspace();
  const task = await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    billingOrigin: "app",
    name: "App schedule",
    status: "active",
    visibility: "workspace_shared",
    schedule: { type: "manual" },
    temporalScheduleId: `billing-origin-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "Run", resources: [], tools: [], metadata: {}, sandboxBackend: "none" },
    metadata: {},
    createdBy: { kind: "subject", subjectId: grant.subjectId },
  } as never);
  const ref = { accountId: grant.accountId, workspaceId: grant.workspaceId, taskId: task.id };
  expect(await readScheduledTaskBillingOrigin(client.db, ref)).toBe("app");
  // A person's manual run in the app stays app; an API caller's is API.
  expect(
    await manualScheduledTaskRunBillingOrigin(client.db, { ...ref, callerOrigin: "app" }),
  ).toBe("app");
  expect(
    await manualScheduledTaskRunBillingOrigin(client.db, { ...ref, callerOrigin: "api" }),
  ).toBe("api");

  await markScheduledTaskApiBilled(client.db, ref);
  expect(await readScheduledTaskBillingOrigin(client.db, ref)).toBe("api");
  // Every later run, including a person's, is API use.
  expect(
    await manualScheduledTaskRunBillingOrigin(client.db, { ...ref, callerOrigin: "app" }),
  ).toBe("api");
}, 180_000);
