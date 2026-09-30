import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  applyCreditDebitAfterUse,
  applyCreditDebitUpToBalance,
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  checkWorkspaceAllowance,
  clearWorkspaceAllowance,
  createDb,
  createSession,
  getWorkspaceAllowance,
  getWorkspaceUsage,
  grantWorkspaceCredits,
  maintainWorkspaceAllowances,
  migrate,
  provisionRoles,
  recordUsageEvent,
  setMemberAllowance,
  setWorkspaceAllowance,
  UsageAllowanceVersionConflictError,
  withRlsContext,
} from "../src/index";

setDefaultTimeout(60_000);
let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("usage-allowances");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  app = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
});

async function fixture(db = app.db, admin = shared.admin) {
  const subjectId = `user:allowance:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "allowance-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Allowance",
    workspaceExternalSource: "allowance-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Allowance",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const personalId = crypto.randomUUID();
  await admin`insert into workspaces(id,account_id,name) values(${personalId},${grant.accountId},'Personal')`;
  await admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${grant.accountId},${subjectId},'owner','active',${personalId})`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    actorSubjectId: subjectId,
    subjectId,
  };
}

async function charge(
  scope: { accountId: string; workspaceId: string },
  micros: number,
  key = crypto.randomUUID(),
) {
  return await applyCreditDebitAfterUse(app.db, {
    ...scope,
    type: "test",
    amountMicros: micros,
    sourceType: "test",
    sourceId: key,
    idempotencyKey: key,
  });
}

describe("usage allowance DB lifecycle", () => {
  test("Personal owner participates in the same eligible roster, denominator and member mutation", async () => {
    const scope = await fixture();
    const [membership] =
      await shared.admin`select personal_workspace_id from organization_memberships
      where account_id=${scope.accountId} and subject_id=${scope.subjectId}`;
    const personal = { ...scope, workspaceId: String(membership!.personal_workspace_id) };
    await setWorkspaceAllowance(app.db, {
      ...personal,
      includedCredits: 100,
      period: "monthly",
      memberDefault: "equal_share",
      expectedVersion: 0,
    });
    await setMemberAllowance(app.db, { ...personal, rule: null, expectedVersion: 0 });
    const usage = await getWorkspaceUsage(app.db, personal);
    expect(usage.members).toHaveLength(1);
    expect(usage.members[0]).toMatchObject({ subjectId: scope.subjectId, limit: 100 });
    await shared.admin`update organization_memberships set status='suspended'
      where account_id=${scope.accountId} and subject_id=${scope.subjectId}`;
    expect((await getWorkspaceUsage(app.db, personal)).members).toEqual([]);
    await expect(
      setMemberAllowance(app.db, { ...personal, rule: { credits: 50 }, expectedVersion: 1 }),
    ).rejects.toThrow("workspace administrator");
  });
  test("usage/get/check have no persisted read-side effects", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "monthly",
      expectedVersion: 0,
    });
    const before = await shared.admin`select to_jsonb(a) allowance,(select jsonb_agg(to_jsonb(p))
      from workspace_allowance_periods p where p.workspace_id=a.workspace_id) periods
      from workspace_usage_allowances a where workspace_id=${scope.workspaceId}`;
    await getWorkspaceAllowance(app.db, scope);
    await getWorkspaceUsage(app.db, scope);
    await checkWorkspaceAllowance(app.db, scope);
    const after = await shared.admin`select to_jsonb(a) allowance,(select jsonb_agg(to_jsonb(p))
      from workspace_allowance_periods p where p.workspace_id=a.workspace_id) periods
      from workspace_usage_allowances a where workspace_id=${scope.workspaceId}`;
    expect([...after]).toEqual([...before]);
    const [notifications] =
      await shared.admin`select count(*)::integer count from workspace_allowance_notifications
      where workspace_id=${scope.workspaceId}`;
    expect(notifications!.count).toBe(0);
  });
  test("anchor and period edits preserve the existing accounting key and used credits", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "monthly",
      anchorDay: 1,
      expectedVersion: 0,
    });
    await charge(scope, 30);
    const before = await getWorkspaceUsage(app.db, scope);
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "monthly",
      anchorDay: 31,
      expectedVersion: 1,
    });
    const edited = await getWorkspaceUsage(app.db, scope);
    expect(edited.period).toEqual(before.period);
    expect(edited.workspace.used).toBe(30);
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "none",
      expectedVersion: 2,
    });
    expect((await getWorkspaceUsage(app.db, scope)).workspace.used).toBe(30);
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "monthly",
      expectedVersion: 3,
    });
    expect((await getWorkspaceUsage(app.db, scope)).workspace.used).toBe(30);
  });
  test("bounded periodic maintenance observes idle rollover/expiry and seals old snapshots", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "monthly",
      expectedVersion: 0,
    });
    await charge(scope, 10);
    await shared.admin`insert into workspace_webhooks(account_id,workspace_id,url,secret_encrypted,event_types)
      values(${scope.accountId},${scope.workspaceId},'https://example.test','sealed',
        array['usage.period_reset','usage.exhausted'])`;
    const [old] =
      await shared.admin`select active_period_key from workspace_usage_allowances where workspace_id=${scope.workspaceId}`;
    await shared.admin`update workspace_usage_allowances set active_period_key='2000-01',
      active_start_at='2000-01-01',active_end_at='2000-02-01',maintenance_next_at=now()-interval '1 minute'
      where workspace_id=${scope.workspaceId}`;
    await shared.admin`update workspace_allowance_periods set period_key='2000-01',start_at='2000-01-01',end_at='2000-02-01'
      where workspace_id=${scope.workspaceId} and period_key=${old!.active_period_key}`;
    await maintainWorkspaceAllowances(app.db, { limit: 100 });
    const [closed] = await shared.admin`select closed_at from workspace_allowance_periods
      where workspace_id=${scope.workspaceId} and period_key='2000-01'`;
    expect(closed!.closed_at).not.toBeNull();
    const events = await shared.admin`select event_type from workspace_webhook_deliveries
      where workspace_id=${scope.workspaceId}`;
    expect(events.some((e) => e.event_type === "usage.period_reset")).toBe(true);
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 0,
      period: "monthly",
      expectedVersion: 1,
    });
    await grantWorkspaceCredits(app.db, {
      ...scope,
      operationId: "expiry",
      credits: 20,
      expiresAt: "2000-01-01T00:00:00Z",
    });
    await maintainWorkspaceAllowances(app.db, { limit: 100 });
    const expired = await shared.admin`select event_type from workspace_webhook_deliveries
      where workspace_id=${scope.workspaceId}`;
    expect(expired.some((e) => e.event_type === "usage.exhausted")).toBe(true);
  });
  test("maintenance enqueue failures retain a retryable page", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 0,
      period: "monthly",
      expectedVersion: 0,
    });
    await shared.admin`insert into workspace_webhooks(account_id,workspace_id,url,secret_encrypted,event_types)
      values(${scope.accountId},${scope.workspaceId},'https://example.test/retry','sealed',array['usage.exhausted'])`;
    await shared.admin.begin(async (adminTx) => {
      // DDL is test-admin-only, scoped to this one workspace, and rolls back
      // on test failure. Normal maintenance never changes table posture.
      await adminTx.unsafe(`alter table workspace_webhook_deliveries add constraint allowance_test_enqueue_failure
        check(workspace_id<>'${scope.workspaceId}'::uuid) not valid`);
      await adminTx`select maintain_usage_allowances(100,100)`;
      await adminTx`alter table workspace_webhook_deliveries drop constraint allowance_test_enqueue_failure`;
    });
    const [failed] =
      await shared.admin`select maintenance_error from workspace_usage_allowances where workspace_id=${scope.workspaceId}`;
    expect(failed!.maintenance_error).toBe("23514");
    const [before] =
      await shared.admin`select count(*)::integer count from workspace_allowance_notifications where workspace_id=${scope.workspaceId}`;
    expect(before!.count).toBe(0);
    await shared.admin`update workspace_usage_allowances set maintenance_next_at=now()-interval '1 second'
      where workspace_id=${scope.workspaceId}`;
    await maintainWorkspaceAllowances(app.db, { limit: 100 });
    const [after] =
      await shared.admin`select count(*)::integer count from workspace_webhook_deliveries
      where workspace_id=${scope.workspaceId} and event_type='usage.exhausted'`;
    expect(after!.count).toBe(1);
  });
  test("external member mutation resolves only an active same-workspace identity", async () => {
    const scope = await fixture();
    await shared.admin`insert into external_identities
      (id,account_id,source,external_id,subject_id,organization_membership_id,personal_workspace_id)
      select ${crypto.randomUUID()},account_id,'product','customer-member',subject_id,id,personal_workspace_id
      from organization_memberships where account_id=${scope.accountId} and subject_id=${scope.subjectId}`;
    const result = await setMemberAllowance(app.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      actorSubjectId: scope.actorSubjectId,
      externalIdentity: { source: "product", externalId: "customer-member" },
      rule: { share: 1.5 },
      expectedVersion: 0,
    });
    expect(result).toEqual({ subjectId: scope.subjectId, rule: { share: 1.5 }, version: 1 });
    await expect(
      setMemberAllowance(app.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        actorSubjectId: scope.actorSubjectId,
        externalIdentity: { source: "product", externalId: "missing" },
        rule: null,
        expectedVersion: 0,
      }),
    ).rejects.toThrow("member not found");
  });
  test("live authority denies agents and workspace-only budget increases", async () => {
    const scope = await fixture();
    await expect(
      setWorkspaceAllowance(app.db, {
        ...scope,
        actorType: "agent_attempt",
        includedCredits: 100,
        period: "monthly",
        expectedVersion: 0,
      }),
    ).rejects.toThrow("actor scope");
    await shared.admin`update organization_memberships set role='member'
      where account_id=${scope.accountId} and subject_id=${scope.subjectId}`;
    await expect(
      setWorkspaceAllowance(app.db, {
        ...scope,
        includedCredits: 100,
        period: "monthly",
        expectedVersion: 0,
      }),
    ).rejects.toThrow("organization administrator");
    // bootstrap grants workspace administration, which may change member
    // limits without gaining organization budget authority.
    await setMemberAllowance(app.db, { ...scope, rule: { credits: 50 }, expectedVersion: 0 });
    await shared.admin`update organization_memberships set status='suspended'
      where account_id=${scope.accountId} and subject_id=${scope.subjectId}`;
    await expect(
      setMemberAllowance(app.db, { ...scope, rule: { credits: 60 }, expectedVersion: 1 }),
    ).rejects.toThrow("workspace administrator");
  });

  test("historical period reads use retained config, grants and member rules after current edits", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 1000,
      period: "monthly",
      expectedVersion: 0,
    });
    await shared.admin`insert into workspace_allowance_periods
      (account_id,workspace_id,period_key,config,start_at,end_at,grants_remaining,member_count,grants_snapshot,member_rules)
      values(${scope.accountId},${scope.workspaceId},'2000-01',
        '{"includedCredits":100,"period":"monthly","memberDefault":"equal_share"}',
        '2000-01-01T00:00:00Z','2000-02-01T00:00:00Z',20,2,
        '[{"remaining":20,"expiresAt":null},{"remaining":80,"expiresAt":"2000-01-15T00:00:00Z"}]',
        ${JSON.stringify({ [scope.subjectId]: { rule: { credits: 40 }, version: 3 } })}::jsonb)`;
    await shared.admin`insert into workspace_allowance_counters(account_id,workspace_id,period_key,subject_id,used,grants_used)
      values(${scope.accountId},${scope.workspaceId},'2000-01','',70,0),
        (${scope.accountId},${scope.workspaceId},'2000-01',${scope.subjectId},30,0)`;
    await setMemberAllowance(app.db, { ...scope, rule: { credits: 900 }, expectedVersion: 0 });
    await grantWorkspaceCredits(app.db, { ...scope, operationId: "current", credits: 500 });
    const old = await getWorkspaceUsage(app.db, { ...scope, period: "2000-01" });
    expect(old.workspace).toMatchObject({
      includedCredits: 100,
      limit: 120,
      used: 70,
      remaining: 50,
      grantsRemaining: 20,
    });
    expect(old.members.find((m) => m.subjectId === scope.subjectId)).toMatchObject({
      rule: { credits: 40 },
      version: 3,
      limit: 40,
      used: 30,
      remaining: 10,
    });
    expect(new Date(old.period.start!).toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(new Date(old.period.end!).toISOString()).toBe("2000-02-01T00:00:00.000Z");
  });
  test("CAS serializes concurrent creates/updates and retains member tombstones", async () => {
    const scope = await fixture();
    const attempts = await Promise.allSettled(
      [1, 2].map(() =>
        setWorkspaceAllowance(app.db, {
          ...scope,
          includedCredits: 100,
          period: "none",
          expectedVersion: 0,
        }),
      ),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (attempts.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
    ).toBeInstanceOf(UsageAllowanceVersionConflictError);
    await setMemberAllowance(app.db, { ...scope, rule: { share: 2 }, expectedVersion: 0 });
    await setMemberAllowance(app.db, { ...scope, rule: null, expectedVersion: 1 });
    await expect(
      setMemberAllowance(app.db, { ...scope, rule: { credits: 1 }, expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(UsageAllowanceVersionConflictError);
    await clearWorkspaceAllowance(app.db, { ...scope, expectedVersion: 1 });
    expect(await getWorkspaceAllowance(app.db, scope)).toBeNull();
    await expect(
      clearWorkspaceAllowance(app.db, { ...scope, expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(UsageAllowanceVersionConflictError);
    await expect(
      setWorkspaceAllowance(app.db, {
        ...scope,
        includedCredits: 10,
        period: "none",
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(UsageAllowanceVersionConflictError);
    expect(
      (
        await setWorkspaceAllowance(app.db, {
          ...scope,
          includedCredits: 10,
          period: "none",
          expectedVersion: 2,
        })
      ).version,
    ).toBe(3);
  });

  test("all inserted debits count exactly once; rollback and external credits do not", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 1000,
      period: "none",
      expectedVersion: 0,
    });
    const key = crypto.randomUUID();
    await Promise.all(Array.from({ length: 8 }, () => charge(scope, 10, key)));
    expect((await getWorkspaceUsage(app.db, scope)).workspace.used).toBe(10);
    await applyCreditLedgerEntry(app.db, {
      ...scope,
      type: "purchase",
      amountMicros: 100,
      idempotencyKey: crypto.randomUUID(),
    });
    await applyCreditDebitUpToBalance(app.db, {
      ...scope,
      type: "model",
      requestedAmountMicros: 20,
      idempotencyKey: crypto.randomUUID(),
    });
    await applyCreditLedgerEntry(app.db, {
      ...scope,
      type: "legacy-media-debit",
      amountMicros: -5,
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      withRlsContext(app.db, scope, async (tx) => {
        await applyCreditLedgerEntry(tx, {
          ...scope,
          type: "rollback",
          amountMicros: -50,
          idempotencyKey: crypto.randomUUID(),
        });
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect((await getWorkspaceUsage(app.db, scope)).workspace.used).toBe(35);
  });

  test("included first, FEFO persistent grants, expiry, idempotent topups and live share scaling", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "none",
      memberDefault: { share: 0.5 },
      expectedVersion: 0,
    });
    await grantWorkspaceCredits(app.db, {
      ...scope,
      operationId: "expired",
      credits: 500,
      expiresAt: "2000-01-01T00:00:00Z",
    });
    await grantWorkspaceCredits(app.db, {
      ...scope,
      operationId: "early",
      credits: 20,
      expiresAt: "2090-01-01T00:00:00Z",
    });
    await grantWorkspaceCredits(app.db, { ...scope, operationId: "late", credits: 80 });
    await grantWorkspaceCredits(app.db, { ...scope, operationId: "late", credits: 80 });
    await expect(
      grantWorkspaceCredits(app.db, { ...scope, operationId: "late", credits: 81 }),
    ).rejects.toThrow("operation conflict");
    expect((await getWorkspaceUsage(app.db, scope)).members[0]!.limit).toBe(100);
    await charge(scope, 110);
    const usage = await getWorkspaceUsage(app.db, scope);
    expect(usage.workspace).toMatchObject({
      used: 110,
      remaining: 90,
      grantsRemaining: 90,
      limit: 200,
    });
    expect(usage.members[0]!.limit).toBe(95);
    const grants =
      await shared.admin`select operation_id,remaining::integer from workspace_allowance_grants
      where workspace_id=${scope.workspaceId} order by operation_id`;
    expect([...grants]).toEqual([
      { operation_id: "early", remaining: 10 },
      { operation_id: "expired", remaining: 500 },
      { operation_id: "late", remaining: 80 },
    ]);
    await charge(scope, 100);
    expect(await checkWorkspaceAllowance(app.db, scope)).toMatchObject({
      code: "allowance_exhausted",
      scope: "workspace",
    });
  });

  test("frozen initiating human, not service or session creator, receives the debit", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 1000,
      period: "monthly",
      expectedVersion: 0,
    });
    const session = await createSession(app.db, {
      ...scope,
      initialMessage: "test",
      resources: [],
      metadata: {},
      model: "scripted",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: scope.subjectId },
      createdByContext: {},
    });
    const [turn] =
      await shared.admin`select id from session_turns where session_id=${session.id} order by created_at limit 1`;
    expect(turn).toBeDefined();
    await setMemberAllowance(app.db, { ...scope, rule: { credits: 5 }, expectedVersion: 0 });
    await applyCreditDebitAfterUse(app.db, {
      ...scope,
      type: "model",
      amountMicros: 10,
      sourceType: "model_response",
      sourceId: `${turn!.id}:response`,
      idempotencyKey: crypto.randomUUID(),
      metadata: { initiatingHumanSubjectId: "service:spoof" },
    });
    expect(await checkWorkspaceAllowance(app.db, scope)).toMatchObject({
      scope: "member",
      subjectId: scope.subjectId,
    });
    await charge(scope, 3);
    const usage = await getWorkspaceUsage(app.db, scope);
    expect(usage.workspace.used).toBe(13);
    expect(usage.members.find((m) => m.subjectId === scope.subjectId)!.used).toBe(10);
  });
  test("Knowledge query counters use the immutable cost receipt, not metadata", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "monthly",
      expectedVersion: 0,
    });
    const sourceId = crypto.randomUUID();
    await withRlsContext(app.db, scope, async (tx) => {
      await recordUsageEvent(tx, {
        ...scope,
        eventType: "document.query_embedding_cost",
        quantity: 10,
        unit: "micro_usd",
        sourceResourceType: "knowledge_query",
        sourceResourceId: sourceId,
        idempotencyKey: `knowledge.query_cost:${sourceId}`,
        initiator: { kind: "service", subjectId: "worker:knowledge-query" },
        initiatorContext: {
          creditDebitAttribution: { kind: "human", initiatingHumanSubjectId: scope.subjectId },
        },
      });
      await applyCreditDebitAfterUse(tx, {
        ...scope,
        type: "document_embedding_debit",
        amountMicros: 10,
        sourceType: "knowledge_query",
        sourceId,
        idempotencyKey: `knowledge.query_embedding:${sourceId}`,
        metadata: { initiatingHumanSubjectId: "user:spoof" },
      });
    });
    const usage = await getWorkspaceUsage(app.db, scope);
    expect(usage.workspace.used).toBe(10);
    expect(usage.members.find((m) => m.subjectId === scope.subjectId)!.used).toBe(10);
    expect(usage.members.some((m) => m.subjectId === "user:spoof")).toBe(false);
  });

  test("admission matrix covers equal share, fixed credits, fallback none and oversubscription", async () => {
    const scope = await fixture();
    const other = `user:other:${crypto.randomUUID()}`;
    await shared.admin`insert into workspace_memberships (account_id,workspace_id,subject_id)
      values (${scope.accountId},${scope.workspaceId},${other})`;
    const otherPersonal = crypto.randomUUID();
    await shared.admin`insert into workspaces(id,account_id,name) values(${otherPersonal},${scope.accountId},'Other Personal')`;
    await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
      values(${scope.accountId},${other},'member','active',${otherPersonal})`;
    await shared.admin`insert into workspace_memberships (account_id,workspace_id,subject_id)
      values (${scope.accountId},${scope.workspaceId},'service:excluded')`;
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "none",
      memberDefault: "equal_share",
      expectedVersion: 0,
    });
    expect(
      (await getWorkspaceUsage(app.db, scope)).members.find((m) => m.subjectId === other)!.limit,
    ).toBe(50);
    await setMemberAllowance(app.db, { ...scope, rule: { share: 2 }, expectedVersion: 0 });
    expect(
      (await getWorkspaceUsage(app.db, scope)).members.find((m) => m.subjectId === scope.subjectId)!
        .limit,
    ).toBe(200);
    await setMemberAllowance(app.db, {
      ...scope,
      subjectId: other,
      rule: { credits: 0 },
      expectedVersion: 0,
    });
    expect(await checkWorkspaceAllowance(app.db, { ...scope, subjectId: other })).toMatchObject({
      scope: "member",
      subjectId: other,
    });
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "none",
      memberDefault: "none",
      expectedVersion: 1,
    });
    await setMemberAllowance(app.db, {
      ...scope,
      subjectId: other,
      rule: null,
      expectedVersion: 1,
    });
    expect(await checkWorkspaceAllowance(app.db, { ...scope, subjectId: other })).toBeNull();
    await charge(scope, 100);
    expect(await checkWorkspaceAllowance(app.db, scope)).toMatchObject({ scope: "workspace" });
  });

  test("threshold/exhaustion delivery is durable and deduped; notifications cannot block debits", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "none",
      expectedVersion: 0,
    });
    await shared.admin`insert into workspace_webhooks (account_id,workspace_id,url,secret_encrypted,event_types)
      values (${scope.accountId},${scope.workspaceId},'https://example.test/webhook','sealed',
        array['usage.threshold_reached','usage.exhausted','usage.period_reset'])`;
    await charge(scope, 80);
    await charge(scope, 25);
    await getWorkspaceUsage(app.db, scope);
    await maintainWorkspaceAllowances(app.db, { limit: 100 });
    const deliveries = await shared.admin`select event_type from workspace_webhook_deliveries
      where workspace_id=${scope.workspaceId} order by event_type`;
    expect([...deliveries]).toEqual([
      { event_type: "usage.exhausted" },
      { event_type: "usage.threshold_reached" },
      { event_type: "usage.threshold_reached" },
    ]);
    expect((await getWorkspaceUsage(app.db, scope)).workspace.used).toBe(105);
    await charge(scope, 1);
    await maintainWorkspaceAllowances(app.db, { limit: 100 });
    const [count] =
      await shared.admin`select count(*)::integer as count from workspace_webhook_deliveries where workspace_id=${scope.workspaceId}`;
    expect(count!.count).toBe(3);
  });

  test("UTC month-end anchors clamp and new periods reset counters without expiring grants", async () => {
    const rows = await shared.admin`select * from usage_allowance_period(
      '{"includedCredits":100,"period":"monthly","anchorDay":31}'::jsonb,'2024-02-29T00:00:00Z'::timestamptz)`;
    expect(rows[0]!.period_key).toBe("2024-02");
    expect(new Date(rows[0]!.start_at).toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(new Date(rows[0]!.end_at).toISOString()).toBe("2024-03-31T00:00:00.000Z");
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "monthly",
      expectedVersion: 0,
    });
    await grantWorkspaceCredits(app.db, { ...scope, operationId: "persistent", credits: 50 });
    await charge(scope, 20);
    const historical = await getWorkspaceUsage(app.db, { ...scope, period: "2000-01" });
    expect(historical.workspace.used).toBe(0);
    expect(historical.workspace.grantsRemaining).toBe(0);
  });
});

test("0542 portable owner capabilities cover every SELECT/INSERT/UPDATE and reject direct runtime writes", async () => {
  const owner = await acquireOwnerMigratedTestDatabase("allowance-owner");
  if (!owner) throw new Error("Owner-migrated PostgreSQL database unavailable");
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
    await setWorkspaceAllowance(ownerApp.db, {
      ...scope,
      includedCredits: 10,
      period: "none",
      expectedVersion: 0,
    });
    await setMemberAllowance(ownerApp.db, { ...scope, rule: { share: 2 }, expectedVersion: 0 });
    await grantWorkspaceCredits(ownerApp.db, { ...scope, operationId: "owner", credits: 5 });
    await applyCreditDebitAfterUse(ownerApp.db, {
      ...scope,
      type: "test",
      amountMicros: 12,
      sourceType: "service",
      sourceId: "service",
      idempotencyKey: crypto.randomUUID(),
    });
    await maintainWorkspaceAllowances(ownerApp.db, { limit: 100, memberLimit: 1 });
    const [personalMembership] =
      await owner.admin`select personal_workspace_id from organization_memberships
      where account_id=${scope.accountId} and subject_id=${scope.subjectId}`;
    const personalScope = {
      ...scope,
      workspaceId: String(personalMembership!.personal_workspace_id),
    };
    await setWorkspaceAllowance(ownerApp.db, {
      ...personalScope,
      includedCredits: 100,
      period: "monthly",
      memberDefault: "equal_share",
      expectedVersion: 0,
    });
    await setMemberAllowance(ownerApp.db, { ...personalScope, rule: null, expectedVersion: 0 });
    expect((await getWorkspaceUsage(ownerApp.db, personalScope)).members[0]).toMatchObject({
      subjectId: scope.subjectId,
      limit: 100,
    });
    expect((await getWorkspaceUsage(ownerApp.db, scope)).workspace).toMatchObject({
      used: 12,
      grantsRemaining: 3,
    });
    const [direct] =
      await ownerSql`select count(*)::integer as count from workspace_allowance_counters`;
    expect(direct!.count).toBe(0);
    const [capabilities] =
      await owner.admin`select count(*)::integer as count from opengeni_private.usage_allowance_capabilities`;
    expect(capabilities!.count).toBe(0);
    await expect(
      withRlsContext(
        ownerApp.db,
        scope,
        async (tx) =>
          await tx.execute(
            sql`update workspace_usage_allowances set version=99 where workspace_id=${scope.workspaceId}`,
          ),
      ),
    ).rejects.toThrow("permission denied");
    const policies = await owner.admin`select tablename,cmd from pg_policies
      where policyname='usage_allowance_owner' order by tablename`;
    expect(policies).toHaveLength(7);
    expect(policies.every((p) => p.cmd === "ALL")).toBe(true);
    const attributionPolicies = await owner.admin`select tablename,cmd from pg_policies
      where policyname='usage_allowance_owner_read' order by tablename`;
    expect([...attributionPolicies]).toEqual([
      { tablename: "external_identities", cmd: "SELECT" },
      { tablename: "knowledge_entries", cmd: "SELECT" },
      { tablename: "knowledge_index_jobs", cmd: "SELECT" },
      { tablename: "organization_memberships", cmd: "SELECT" },
      { tablename: "sandbox_leases", cmd: "SELECT" },
      { tablename: "scheduled_task_runs", cmd: "SELECT" },
      { tablename: "session_turns", cmd: "SELECT" },
      { tablename: "usage_events", cmd: "SELECT" },
    ]);
  } finally {
    await ownerApp?.close();
    await ownerSql.end();
    await owner.release();
  }
}, 240_000);
