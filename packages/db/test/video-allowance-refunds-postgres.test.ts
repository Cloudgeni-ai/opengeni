import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  createSession,
  getWorkspaceUsage,
  grantWorkspaceCredits,
  migrate,
  provisionRoles,
  setWorkspaceAllowance,
  withRlsContext,
  type Database,
} from "../src";

let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("video-allowance-refunds");
  if (!acquired) throw new Error("PostgreSQL is required for video allowance refund tests");
  shared = acquired;
  app = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function fixture(db = app.db, admin = shared.admin) {
  const subjectId = `user:video-refund:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "video-refund",
    accountExternalId: crypto.randomUUID(),
    accountName: "Video refund",
    workspaceExternalSource: "video-refund",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Video refund",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    actorSubjectId: subjectId,
    subjectId,
  };
  await admin`insert into workspaces(id,account_id,name)
    values(${crypto.randomUUID()},${scope.accountId},'Personal')
    returning id`.then(async ([personal]) => {
    await admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
      values(${scope.accountId},${subjectId},'owner','active',${personal!.id})`;
  });
  const session = await createSession(db, {
    ...scope,
    initialMessage: "Video refund",
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
    createdByContext: {},
  });
  const [turn] = await admin`select id from session_turns where session_id=${session.id} limit 1`;
  if (!turn) throw new Error("Video refund fixture turn unavailable");
  await setWorkspaceAllowance(db, {
    ...scope,
    includedCredits: 100,
    period: "monthly",
    expectedVersion: 0,
  });
  await grantWorkspaceCredits(db, {
    ...scope,
    operationId: "early",
    credits: 30,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await grantWorkspaceCredits(db, { ...scope, operationId: "late", credits: 80 });
  return { ...scope, turnId: String(turn.id), operationId: crypto.randomUUID() };
}

type Scope = Awaited<ReturnType<typeof fixture>>;
function ledgerInput(scope: Scope, isRefund: boolean, amount = 180) {
  return {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    type: isRefund ? "video_generation_refund" : "video_generation_debit",
    amountMicros: isRefund ? amount : -amount,
    sourceType: "video_generation_operation",
    sourceId: scope.operationId,
    idempotencyKey: `credit:video_generation_${isRefund ? "refund" : "debit"}:${scope.operationId}`,
    metadata: { turnId: scope.turnId },
  };
}
async function debit(scope: Scope, db: Database = app.db) {
  await applyCreditLedgerEntry(db, ledgerInput(scope, false));
}
async function refund(scope: Scope, db: Database = app.db) {
  await applyCreditLedgerEntry(db, ledgerInput(scope, true));
}
async function grantBalances(scope: Scope, admin = shared.admin) {
  const rows = await admin`select operation_id,remaining from workspace_allowance_grants
    where workspace_id=${scope.workspaceId} order by operation_id`;
  return rows.map((row) => [row.operation_id, Number(row.remaining)]);
}

describe("existing prepaid video allowance refunds", () => {
  test("concurrent duplicate refund restores exact included/FEFO/member facts once and preserves another debit", async () => {
    const scope = await fixture();
    await Promise.all([debit(scope), debit(scope)]);
    const [allocation] = await shared.admin`select * from workspace_video_allowance_allocations
      where workspace_id=${scope.workspaceId}`;
    expect(Number(allocation!.included_used)).toBe(100);
    expect(Number(allocation!.grants_used)).toBe(80);
    expect(allocation!.human_subject_id).toBe(scope.subjectId);
    expect(allocation!.grant_allocations).toEqual([
      { operationId: "early", credits: 30 },
      { operationId: "late", credits: 50 },
    ]);
    await applyCreditLedgerEntry(app.db, {
      ...ledgerInput(scope, false, 20),
      type: "model",
      sourceType: "session_turn",
      sourceId: scope.turnId,
      idempotencyKey: crypto.randomUUID(),
    });
    await Promise.all([refund(scope), refund(scope), refund(scope)]);
    const usage = await getWorkspaceUsage(app.db, scope);
    expect(usage.workspace).toMatchObject({ used: 20, includedUsed: 0, grantsUsed: 20 });
    expect(usage.members.find((member) => member.subjectId === scope.subjectId)?.used).toBe(20);
    expect(await grantBalances(scope)).toEqual([
      ["early", 30],
      ["late", 60],
    ]);
    const [receipt] = await shared.admin`select a.reversed_by_ledger_id,r.id
      from workspace_video_allowance_allocations a join credit_ledger_entries r
        on r.id=a.reversed_by_ledger_id where a.workspace_id=${scope.workspaceId}`;
    expect(receipt!.reversed_by_ledger_id).toBe(receipt!.id);
    const [count] = await shared.admin`select count(*)::int as count from credit_ledger_entries
      where idempotency_key=${ledgerInput(scope, true).idempotencyKey}`;
    expect(count!.count).toBe(1);
  }, 60_000);

  test("wrong amount or original ledger association aborts the entire refund; rollback can retry", async () => {
    const scope = await fixture();
    await debit(scope);
    await expect(applyCreditLedgerEntry(app.db, ledgerInput(scope, true, 179))).rejects.toThrow(
      "does not match its original debit",
    );
    await shared.admin`update credit_ledger_entries set type='unrelated_debit'
      where idempotency_key=${ledgerInput(scope, false).idempotencyKey}`;
    await expect(refund(scope)).rejects.toThrow("does not match its original debit");
    await shared.admin`update credit_ledger_entries set type='video_generation_debit'
      where idempotency_key=${ledgerInput(scope, false).idempotencyKey}`;
    await expect(
      withRlsContext(app.db, scope, async (tx) => {
        await tx.execute(sql`insert into credit_ledger_entries
        (account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key)
        values(${scope.accountId},${scope.workspaceId},'video_generation_refund',180,
          'video_generation_operation',${scope.operationId},${ledgerInput(scope, true).idempotencyKey})`);
        throw new Error("rollback refund");
      }),
    ).rejects.toThrow("rollback refund");
    expect((await getWorkspaceUsage(app.db, scope)).workspace.used).toBe(180);
    expect(await grantBalances(scope)).toEqual([
      ["early", 0],
      ["late", 30],
    ]);
    await refund(scope);
    expect((await getWorkspaceUsage(app.db, scope)).workspace.used).toBe(0);
  }, 60_000);

  test("refund across rollover updates only original counters/snapshot; expired restored grants stay unavailable", async () => {
    const scope = await fixture();
    await debit(scope);
    // Move the observed settlement facts to an original period. No production
    // clock override or caller occurred_at affects settlement-time admission.
    await shared.admin`update workspace_allowance_counters set period_key='2000-01'
      where workspace_id=${scope.workspaceId}`;
    await shared.admin`update workspace_video_allowance_allocations set period_key='2000-01'
      where workspace_id=${scope.workspaceId}`;
    await shared.admin`update workspace_allowance_periods set period_key='2000-01',
      start_at='2000-01-01',end_at='2000-02-01'
      where workspace_id=${scope.workspaceId}`;
    await shared.admin`update workspace_allowance_grants set expires_at='2000-01-15'
      where workspace_id=${scope.workspaceId} and operation_id='early'`;
    await applyCreditLedgerEntry(app.db, {
      ...ledgerInput(scope, false, 20),
      sourceType: "service",
      type: "other_debit",
      idempotencyKey: crypto.randomUUID(),
    });
    await refund(scope);
    expect((await getWorkspaceUsage(app.db, scope)).workspace).toMatchObject({
      used: 20,
      includedUsed: 20,
      grantsUsed: 0,
      grantsRemaining: 80,
    });
    const historical = await getWorkspaceUsage(app.db, { ...scope, period: "2000-01" });
    expect(historical.workspace).toMatchObject({
      used: 0,
      includedUsed: 0,
      grantsUsed: 0,
      grantsRemaining: 80,
    });
    expect(await grantBalances(scope)).toEqual([
      ["early", 30],
      ["late", 80],
    ]);
  }, 60_000);

  test("purchases, unrelated positive credits, and pre-recording refunds never reduce usage", async () => {
    const scope = await fixture();
    await debit(scope);
    await applyCreditLedgerEntry(app.db, {
      ...ledgerInput(scope, true),
      type: "credit_purchase",
      idempotencyKey: crypto.randomUUID(),
    });
    await applyCreditLedgerEntry(app.db, {
      ...ledgerInput(scope, true),
      sourceId: crypto.randomUUID(),
      idempotencyKey: `credit:video_generation_refund:${crypto.randomUUID()}`,
    });
    const historicalOperation = crypto.randomUUID();
    await applyCreditLedgerEntry(app.db, {
      ...ledgerInput(scope, true),
      sourceId: historicalOperation,
      idempotencyKey: `credit:video_generation_refund:${historicalOperation}`,
    });
    expect((await getWorkspaceUsage(app.db, scope)).workspace.used).toBe(180);
    expect(await grantBalances(scope)).toEqual([
      ["early", 0],
      ["late", 30],
    ]);
  }, 60_000);
});

test("0544 non-superuser FORCE-RLS owner can read exact debit and restore all allocations; app cannot call/write internals", async () => {
  const owner = await acquireOwnerMigratedTestDatabase("video-refund-owner");
  if (!owner) throw new Error("Owner-migrated PostgreSQL database required");
  let ownerApp: ReturnType<typeof createDb> | undefined;
  const ownerSql = postgres(owner.ownerUrl, { max: 1 });
  try {
    await migrate(owner.ownerUrl);
    await provisionRoles(owner.adminUrl, {
      appRole: "opengeni_app",
      appPassword: owner.appPassword,
      rlsStrategy: "force",
    });
    const url = new URL(owner.adminUrl);
    url.username = "opengeni_app";
    url.password = owner.appPassword;
    ownerApp = createDb(url.toString());
    const scope = await fixture(ownerApp.db, owner.admin);
    await debit(scope, ownerApp.db);
    await refund(scope, ownerApp.db);
    expect((await getWorkspaceUsage(ownerApp.db, scope)).workspace).toMatchObject({
      used: 0,
      includedUsed: 0,
      grantsUsed: 0,
      grantsRemaining: 110,
    });
    expect(await grantBalances(scope, owner.admin)).toEqual([
      ["early", 30],
      ["late", 80],
    ]);
    const [hidden] =
      await ownerSql`select count(*)::int as count from workspace_video_allowance_allocations`;
    expect(hidden!.count).toBe(0);
    const [capabilities] =
      await owner.admin`select count(*)::int as count from opengeni_private.usage_allowance_capabilities`;
    expect(capabilities!.count).toBe(0);
    const [policy] = await owner.admin`select cmd from pg_policies
      where tablename='credit_ledger_entries' and policyname='video_allowance_owner_read'`;
    expect(policy!.cmd).toBe("SELECT");
    await expect(
      withRlsContext(ownerApp.db, scope, async (tx) => {
        await tx.execute(sql`update workspace_video_allowance_allocations
        set reversed_by_ledger_id=null where workspace_id=${scope.workspaceId}`);
      }),
    ).rejects.toThrow("permission denied");
    await expect(
      withRlsContext(ownerApp.db, scope, async (tx) => {
        await tx.execute(sql`select reverse_video_allowance_refund()`);
      }),
    ).rejects.toThrow("permission denied");
  } finally {
    await ownerApp?.close();
    await ownerSql.end();
    await owner.release();
  }
}, 240_000);
