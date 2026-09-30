import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  applyCreditDebitAfterUse,
  applyCreditDebitUpToBalance,
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  checkWorkspaceAllowance,
  clearWorkspaceAllowance,
  createDb,
  createSession,
  ensureExternalIdentity,
  getWorkspaceAllowance,
  getWorkspaceAllowanceState,
  inspectRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
  RUNTIME_ALLOWANCE_PRIVATE_TABLES,
  saveKnowledgeEntry,
  transitionSessionVisibility,
  getWorkspaceUsage,
  initializeSessionStartAtomically,
  grantWorkspaceCredits,
  maintainWorkspaceAllowances,
  migrate,
  provisionRoles,
  recordUsageEvent,
  nestedPostgresSqlState,
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
  test("clear tombstone version is discoverable and exact lost-response replay cannot clear a successor", async () => {
    const scope = await fixture();
    expect(await getWorkspaceAllowanceState(app.db, scope)).toEqual({ version: 0, config: null });
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "monthly",
      expectedVersion: 0,
    });
    const request = { ...scope, expectedVersion: 1, operationId: crypto.randomUUID() };
    expect(await clearWorkspaceAllowance(app.db, request)).toEqual({ version: 2 });
    expect(await getWorkspaceAllowance(app.db, scope)).toBeNull();
    expect(await getWorkspaceAllowanceState(app.db, scope)).toEqual({ version: 2, config: null });
    expect(await clearWorkspaceAllowance(app.db, request)).toEqual({ version: 2 });
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 200,
      period: "none",
      expectedVersion: 2,
    });
    await expect(clearWorkspaceAllowance(app.db, request)).rejects.toBeInstanceOf(
      UsageAllowanceVersionConflictError,
    );
    expect((await getWorkspaceAllowanceState(app.db, scope)).version).toBe(3);
    await expect(
      clearWorkspaceAllowance(app.db, { ...request, expectedVersion: 3 }).catch(
        nestedPostgresSqlState,
      ),
    ).resolves.toBe("23505");
  });

  test("idle expired monthly window advances during debit and BEFORE monthly-to-none edit", async () => {
    for (const debitFirst of [true, false]) {
      const scope = await fixture();
      await setWorkspaceAllowance(app.db, {
        ...scope,
        includedCredits: 100,
        period: "monthly",
        anchorDay: 31,
        expectedVersion: 0,
      });
      await charge(scope, 20);
      const [saved] =
        await shared.admin`select active_period_key from opengeni_private.workspace_usage_allowances
        where workspace_id=${scope.workspaceId}`;
      await shared.admin.begin(async (tx) => {
        await tx`update opengeni_private.workspace_usage_allowances set active_period_key='2000-01',
          active_start_at='2000-01-31',active_end_at='2000-02-29' where workspace_id=${scope.workspaceId}`;
        await tx`update opengeni_private.workspace_allowance_periods set period_key='2000-01',
          start_at='2000-01-31',end_at='2000-02-29' where workspace_id=${scope.workspaceId}`;
        await tx`update opengeni_private.workspace_allowance_counters set period_key='2000-01'
          where workspace_id=${scope.workspaceId} and period_key=${saved!.active_period_key}`;
      });
      // No read or maintenance between expiration and settlement/config edit.
      if (debitFirst) await charge(scope, 80);
      await setWorkspaceAllowance(app.db, {
        ...scope,
        includedCredits: 100,
        period: "none",
        expectedVersion: 1,
      });
      if (!debitFirst) await charge(scope, 80);
      expect((await getWorkspaceUsage(app.db, scope)).workspace.used).toBe(80);
      const [state] =
        await shared.admin`select active_period_key,active_end_at from opengeni_private.workspace_usage_allowances
        where workspace_id=${scope.workspaceId}`;
      expect(state!.active_period_key).not.toBe("2000-01");
      expect(state!.active_end_at).toBeNull();
      expect(
        (await getWorkspaceUsage(app.db, { ...scope, period: "2000-01" })).workspace.used,
      ).toBe(20);
    }
  });

  test("old complete readiness and old role provisioning stay compatible with private allowance storage", async () => {
    const repoRoot = new URL("../../..", import.meta.url).pathname;
    // Exact pre-allowance origin/main ancestor of PR3038. A moving merge-base
    // would stop exercising the old binary as soon as the PR itself merges.
    const oldRevision = "3a354ce4637d71e632f92be6f9aa6ff97f470fba";
    const directory = `${repoRoot}/.allowance-old-runtime-${crypto.randomUUID()}`;
    // Build immutable old source with the current dependency resolver, without
    // copying/modifying source or substituting today's evaluator constants.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const root = await mkdtemp(directory);
    try {
      for (const name of ["runtime-posture.ts", "role-relationships.ts", "provision-roles.ts"]) {
        await writeFile(
          `${root}/${name}`,
          execFileSync("git", ["show", `${oldRevision}:packages/db/src/${name}`], {
            cwd: repoRoot,
          }),
        );
      }
      const old = await import(pathToFileURL(`${root}/runtime-posture.ts`).href);
      const oldProvision = await import(pathToFileURL(`${root}/provision-roles.ts`).href);
      const options = {
        expectedRole: "opengeni_app",
        rlsStrategy: "force" as const,
        targetSchema: "public",
      };
      await oldProvision.provisionRoles(shared.adminUrl, {
        appRole: "opengeni_app",
        appPassword: new URL(shared.appUrl).password,
        rlsStrategy: "force",
      });
      const previous = await old.inspectRuntimeDatabasePosture(app.db, options);
      expect(old.evaluateRuntimeDatabasePosture(previous, options)).toEqual([]);
      // Re-provisioning current roles must both restore new EXECUTE seams and
      // preserve all previously required exact privileges.
      await provisionRoles(shared.adminUrl, {
        appRole: "opengeni_app",
        appPassword: new URL(shared.appUrl).password,
        rlsStrategy: "force",
      });
      const current = await inspectRuntimeDatabasePosture(app.db, options);
      expect(evaluateRuntimeDatabasePosture(current, options)).toEqual([]);
      expect(
        current.tables.some((table) =>
          (RUNTIME_ALLOWANCE_PRIVATE_TABLES as readonly string[]).includes(table.name),
        ),
      ).toBe(false);
      const unsafe = structuredClone(current);
      unsafe.privateTables.find((table) => table.name === "workspace_usage_allowances")!.insert =
        true;
      expect(evaluateRuntimeDatabasePosture(unsafe, options)).toContain(
        "usage allowance private table workspace_usage_allowances is missing or unsafe",
      );
      // Real catalog probe: table-level checks alone miss column-only DML.
      await shared.admin`grant insert(config) on opengeni_private.workspace_usage_allowances to opengeni_app`;
      const columnGrant = await inspectRuntimeDatabasePosture(app.db, options);
      expect(evaluateRuntimeDatabasePosture(columnGrant, options)).toContain(
        "usage allowance private table workspace_usage_allowances is missing or unsafe",
      );
      await provisionRoles(shared.adminUrl, {
        appRole: "opengeni_app",
        appPassword: new URL(shared.appUrl).password,
        rlsStrategy: "force",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("allowance mutation waits for organization BEFORE tenancy while a real visibility transition completes", async () => {
    const scope = await fixture();
    const [membership] =
      await shared.admin`select personal_workspace_id from organization_memberships
      where account_id=${scope.accountId} and subject_id=${scope.subjectId}`;
    const personal = { ...scope, workspaceId: String(membership!.personal_workspace_id) };
    await shared.admin`insert into workspace_inference_controls(account_id,workspace_id)
      values(${scope.accountId},${personal.workspaceId})`;
    await shared.admin`insert into session_tenancy_activations
      (account_id,activation_version,activated_by,inventory_digest,parity_digest)
      values(${scope.accountId},1,${scope.subjectId},${"a".repeat(64)},${"b".repeat(64)})`;
    const session = await createSession(app.db, {
      ...personal,
      initialMessage: "Allowance lock",
      model: "test",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: scope.subjectId },
    });
    const holder = await shared.admin.reserve();
    const [baseline] =
      await shared.admin`select deadlocks from pg_stat_database where datname=current_database()`;
    let pending: Promise<unknown> | undefined;
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtextextended(
        ${`organization-membership:${scope.accountId}`},0))`;
      const [backend] = await holder`select pg_backend_pid() as pid`;
      const pid = Number(backend!.pid);
      pending = setWorkspaceAllowance(app.db, {
        ...personal,
        includedCredits: 100,
        period: "none",
        expectedVersion: 0,
      });
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const [observed] = await shared.admin`select exists(select 1 from pg_stat_activity
          where ${pid}::integer=any(pg_blocking_pids(pid))) as blocked`;
        if (observed!.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      await holder`set local lock_timeout='2s'`;
      // This fails in the old helper: its blocked mutation already held shared
      // tenancy and the organization's exclusive-tenancy waiter forms a cycle.
      await holder`select pg_advisory_xact_lock(hashtextextended(
        ${`session-tenancy:${personal.workspaceId}`},0))`;
      await holder`commit`;
      const [, transition] = await Promise.all([
        pending,
        transitionSessionVisibility(app.db, {
          workspaceId: personal.workspaceId,
          sessionId: session.id,
          actorSubjectId: scope.subjectId,
          targetVisibility: "user_private",
          expectedAuthorityEpoch: 1,
          operationKey: crypto.randomUUID(),
        }),
      ]);
      expect(transition).toMatchObject({
        changed: true,
        visibility: "user_private",
        authorityEpoch: 2,
      });
      const [after] =
        await shared.admin`select deadlocks from pg_stat_database where datname=current_database()`;
      expect(after!.deadlocks).toBe(baseline!.deadlocks);
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
      await pending?.catch(() => undefined);
    }
  });
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
      setMemberAllowance(app.db, { ...personal, rule: { credits: 50 }, expectedVersion: 1 }).catch(
        nestedPostgresSqlState,
      ),
    ).resolves.toBe("42501");
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
      from opengeni_private.workspace_allowance_periods p where p.workspace_id=a.workspace_id) periods
      from opengeni_private.workspace_usage_allowances a where workspace_id=${scope.workspaceId}`;
    await getWorkspaceAllowance(app.db, scope);
    await getWorkspaceUsage(app.db, scope);
    await checkWorkspaceAllowance(app.db, scope);
    const after = await shared.admin`select to_jsonb(a) allowance,(select jsonb_agg(to_jsonb(p))
      from opengeni_private.workspace_allowance_periods p where p.workspace_id=a.workspace_id) periods
      from opengeni_private.workspace_usage_allowances a where workspace_id=${scope.workspaceId}`;
    expect([...after]).toEqual([...before]);
    const [notifications] =
      await shared.admin`select count(*)::integer count from opengeni_private.workspace_allowance_notifications
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
      await shared.admin`select active_period_key from opengeni_private.workspace_usage_allowances where workspace_id=${scope.workspaceId}`;
    await shared.admin`update opengeni_private.workspace_usage_allowances set active_period_key='2000-01',
      active_start_at='2000-01-01',active_end_at='2000-02-01',maintenance_next_at=now()-interval '1 minute'
      where workspace_id=${scope.workspaceId}`;
    await shared.admin`update opengeni_private.workspace_allowance_periods set period_key='2000-01',start_at='2000-01-01',end_at='2000-02-01'
      where workspace_id=${scope.workspaceId} and period_key=${old!.active_period_key}`;
    await maintainWorkspaceAllowances(app.db, { limit: 100 });
    const [closed] =
      await shared.admin`select closed_at from opengeni_private.workspace_allowance_periods
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
      await shared.admin`select maintenance_error from opengeni_private.workspace_usage_allowances where workspace_id=${scope.workspaceId}`;
    expect(failed!.maintenance_error).toBe("23514");
    const [before] =
      await shared.admin`select count(*)::integer count from opengeni_private.workspace_allowance_notifications where workspace_id=${scope.workspaceId}`;
    expect(before!.count).toBe(0);
    await shared.admin`update opengeni_private.workspace_usage_allowances set maintenance_next_at=now()-interval '1 second'
      where workspace_id=${scope.workspaceId}`;
    await maintainWorkspaceAllowances(app.db, { limit: 100 });
    const [after] =
      await shared.admin`select count(*)::integer count from workspace_webhook_deliveries
      where workspace_id=${scope.workspaceId} and event_type='usage.exhausted'`;
    expect(after!.count).toBe(1);
  });
  test("external member mutation resolves only an active same-workspace identity", async () => {
    const scope = await fixture();
    const identity = await ensureExternalIdentity(app.db, {
      accountId: scope.accountId,
      source: "product",
      externalId: "customer-member",
    });
    await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id)
      values(${scope.accountId},${scope.workspaceId},${identity.subjectId})`;
    const result = await setMemberAllowance(app.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      actorSubjectId: scope.actorSubjectId,
      externalIdentity: { source: "product", externalId: "customer-member" },
      rule: { share: 1.5 },
      expectedVersion: 0,
    });
    expect(result).toEqual({ subjectId: identity.subjectId, rule: { share: 1.5 }, version: 1 });
    await expect(
      setMemberAllowance(app.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        actorSubjectId: scope.actorSubjectId,
        externalIdentity: { source: "product", externalId: "missing" },
        rule: null,
        expectedVersion: 0,
      }).catch(nestedPostgresSqlState),
    ).resolves.toBe("23503");
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
      }).catch(nestedPostgresSqlState),
    ).resolves.toBe("42501");
    await shared.admin`update organization_memberships set role='member'
      where account_id=${scope.accountId} and subject_id=${scope.subjectId}`;
    await expect(
      setWorkspaceAllowance(app.db, {
        ...scope,
        includedCredits: 100,
        period: "monthly",
        expectedVersion: 0,
      }).catch(nestedPostgresSqlState),
    ).resolves.toBe("42501");
    // bootstrap grants workspace administration, which may change member
    // limits without gaining organization budget authority.
    await setMemberAllowance(app.db, { ...scope, rule: { credits: 50 }, expectedVersion: 0 });
    await shared.admin`update organization_memberships set status='suspended'
      where account_id=${scope.accountId} and subject_id=${scope.subjectId}`;
    await expect(
      setMemberAllowance(app.db, { ...scope, rule: { credits: 60 }, expectedVersion: 1 }).catch(
        nestedPostgresSqlState,
      ),
    ).resolves.toBe("42501");
  });

  test("historical period reads use retained config, grants and member rules after current edits", async () => {
    const scope = await fixture();
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 1000,
      period: "monthly",
      expectedVersion: 0,
    });
    await shared.admin`insert into opengeni_private.workspace_allowance_periods
      (account_id,workspace_id,period_key,config,start_at,end_at,grants_remaining,member_count,grants_snapshot,member_rules)
      values(${scope.accountId},${scope.workspaceId},'2000-01',
        '{"includedCredits":100,"period":"monthly","memberDefault":"equal_share"}',
        '2000-01-01T00:00:00Z','2000-02-01T00:00:00Z',20,2,
        '[{"remaining":20,"expiresAt":null},{"remaining":80,"expiresAt":"2000-01-15T00:00:00Z"}]',
        '{"placeholder":{"rule":{"credits":40},"version":3}}'::jsonb)`;
    await shared.admin`update opengeni_private.workspace_allowance_periods
      set member_rules=jsonb_build_object(${scope.subjectId}::text,
        jsonb_build_object('rule',jsonb_build_object('credits',40),'version',3))
      where workspace_id=${scope.workspaceId} and period_key='2000-01'`;
    await shared.admin`insert into opengeni_private.workspace_allowance_counters(account_id,workspace_id,period_key,subject_id,used,grants_used)
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
      grantWorkspaceCredits(app.db, { ...scope, operationId: "late", credits: 81 }).catch(
        nestedPostgresSqlState,
      ),
    ).resolves.toBe("23505");
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
      await shared.admin`select operation_id,remaining::integer from opengeni_private.workspace_allowance_grants
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
    await initializeSessionStartAtomically(app.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
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
    const workspaceScope = { accountId: scope.accountId, workspaceId: scope.workspaceId };
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
      (await getWorkspaceUsage(app.db, workspaceScope)).members.find((m) => m.subjectId === other)!
        .limit,
    ).toBe(50);
    await setMemberAllowance(app.db, { ...scope, rule: { share: 2 }, expectedVersion: 0 });
    expect(
      (await getWorkspaceUsage(app.db, workspaceScope)).members.find(
        (m) => m.subjectId === scope.subjectId,
      )!.limit,
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

test("0547 portable owner capabilities cover every SELECT/INSERT/UPDATE and reject direct runtime writes", async () => {
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
    const knowledge = await saveKnowledgeEntry(
      ownerApp.db,
      {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        actor: {
          kind: "human",
          principalKind: "human_session",
          subjectId: scope.subjectId,
          writeScopes: ["workspace"],
          settingsScopes: ["workspace"],
          review: true,
        },
      },
      {
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        expectedVersion: 0,
        scope: "workspace",
        entry: {
          kind: "fact",
          title: "Definer shadow",
          content: "Real index job",
          groupIds: [],
          evidence: [],
          relationships: [],
        },
      },
    );
    const malicious = postgres(url.toString(), { max: 1 });
    try {
      const columns = await owner.admin`select quote_ident(attname) as name,
        format_type(atttypid,atttypmod) as type from pg_attribute
        where attrelid='knowledge_index_jobs'::regclass and attnum>0 and not attisdropped order by attnum`;
      await malicious.begin(async (tx) => {
        await tx.unsafe(
          `create temp table knowledge_index_jobs (${columns
            .map((column) => `${column.name} ${column.type}`)
            .join(",")})`,
        );
        await tx.unsafe(
          `grant select,update on pg_temp.knowledge_index_jobs to "${owner.ownerRole.replaceAll('"', '""')}"`,
        );
        await tx`create function pg_temp.shadow_owner_probe() returns trigger language plpgsql as $$
          begin raise exception 'SHADOW_OWNER_TRIGGER_EXECUTED'; end $$`;
        await tx`create trigger shadow_owner_probe before update on pg_temp.knowledge_index_jobs
          for each statement execute function pg_temp.shadow_owner_probe()`;
        const [claimed] = await tx`select public.knowledge_index_claim('shadow-test',3,20) as jobs`;
        expect(
          claimed!.jobs.some(
            (job: { revisionId: string }) => job.revisionId === knowledge.revisionId,
          ),
        ).toBe(true);
      });
      const [path] = await owner.admin`select proconfig from pg_proc
        where oid='knowledge_index_claim(text,integer,integer)'::regprocedure`;
      expect(path!.proconfig).toContain("search_path=pg_catalog, public, pg_temp");
    } finally {
      await malicious.end();
    }
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
      await ownerSql`select count(*)::integer as count from opengeni_private.workspace_allowance_counters`;
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
            sql`update opengeni_private.workspace_usage_allowances set version=99 where workspace_id=${scope.workspaceId}`,
          ),
      ).catch(nestedPostgresSqlState),
    ).resolves.toBe("42501");
    const policies = await owner.admin`select tablename,cmd from pg_policies
      where policyname='usage_allowance_owner' order by tablename`;
    expect(policies).toHaveLength(8);
    expect(policies.every((p) => p.cmd === "ALL")).toBe(true);
    const attributionPolicies = await owner.admin`select tablename,cmd from pg_policies
      where policyname='usage_allowance_owner_read' order by tablename`;
    expect([...attributionPolicies]).toEqual([
      { tablename: "external_identities", cmd: "SELECT" },
      { tablename: "knowledge_entries", cmd: "SELECT" },
      { tablename: "knowledge_index_jobs", cmd: "SELECT" },
      { tablename: "organization_memberships", cmd: "SELECT" },
      { tablename: "sandbox_leases", cmd: "SELECT" },
    ]);
  } finally {
    await ownerApp?.close();
    await ownerSql.end();
    await owner.release();
  }
}, 240_000);

test("private allowance storage binds a dedicated data schema under a non-bypass owner", async () => {
  const owner = await acquireOwnerMigratedTestDatabase("allowance-dedicated");
  if (!owner) throw new Error("Owner-migrated PostgreSQL database unavailable");
  const schema = "allowance_data";
  let client: ReturnType<typeof createDb> | undefined;
  const admin = postgres(owner.adminUrl, { max: 1, connection: { search_path: schema } });
  try {
    // The production fixture preinstalls vector in public. A dedicated schema
    // must own its extension namespace too: migrations pin schema-only paths.
    await owner.admin.unsafe(
      `create schema allowance_data authorization "${owner.ownerRole.replaceAll('"', '""')}"`,
    );
    await owner.admin`alter extension vector set schema allowance_data`;
    await migrate(owner.ownerUrl, schema, { applicationDatabaseRoles: ["opengeni_app"] });
    await provisionRoles(owner.adminUrl, {
      targetSchema: schema,
      appRole: "opengeni_app",
      appPassword: owner.appPassword,
      rlsStrategy: "force",
    });
    const appUrl = new URL(owner.adminUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = owner.appPassword;
    client = createDb(appUrl.toString(), { searchPath: schema });
    const scope = await fixture(client.db, admin);
    await setWorkspaceAllowance(client.db, {
      ...scope,
      includedCredits: 100,
      period: "monthly",
      anchorDay: 31,
      expectedVersion: 0,
    });
    const [prior] =
      await admin`select active_period_key from opengeni_private.workspace_usage_allowances
      where workspace_id=${scope.workspaceId}`;
    await admin`update opengeni_private.workspace_usage_allowances set active_period_key='2000-01',
      active_start_at='2000-01-31',active_end_at='2000-02-29' where workspace_id=${scope.workspaceId}`;
    await admin`update opengeni_private.workspace_allowance_periods set period_key='2000-01',
      start_at='2000-01-31',end_at='2000-02-29'
      where workspace_id=${scope.workspaceId} and period_key=${prior!.active_period_key}`;
    await applyCreditDebitAfterUse(client.db, {
      ...scope,
      amountMicros: 80,
      type: "test",
      sourceType: "service",
      sourceId: "dedicated",
      idempotencyKey: crypto.randomUUID(),
    });
    await setWorkspaceAllowance(client.db, {
      ...scope,
      includedCredits: 100,
      period: "none",
      expectedVersion: 1,
    });
    expect((await getWorkspaceUsage(client.db, scope)).workspace.used).toBe(80);
    const clear = { ...scope, expectedVersion: 2, operationId: crypto.randomUUID() };
    expect(await clearWorkspaceAllowance(client.db, clear)).toEqual({ version: 3 });
    expect(await getWorkspaceAllowanceState(client.db, scope)).toEqual({
      version: 3,
      config: null,
    });
    expect(await clearWorkspaceAllowance(client.db, clear)).toEqual({ version: 3 });
    const options = {
      expectedRole: "opengeni_app",
      rlsStrategy: "force" as const,
      targetSchema: schema,
    };
    expect(
      evaluateRuntimeDatabasePosture(
        await inspectRuntimeDatabasePosture(client.db, options),
        options,
      ),
    ).toEqual([]);
    const [path] = await admin`select proconfig from pg_proc
      where oid='knowledge_index_claim(text,integer,integer)'::regprocedure`;
    expect(path!.proconfig).toContain("search_path=pg_catalog, allowance_data, pg_temp");
    const [stamp] =
      await admin`select count(*)::integer as count from opengeni_private.usage_allowance_capabilities`;
    expect(stamp!.count).toBe(0);
  } finally {
    await client?.close();
    await admin.end();
    await owner.release();
  }
}, 240_000);
