import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  checkSessionUsageLimitAdmission,
  createDb,
  createSession,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  maintainSessionUsageLimits,
  migrate,
  provisionRoles,
  readSessionUsageLimit,
  RUNTIME_SESSION_USAGE_LIMIT_PRIVATE_TABLES,
  SessionUsageLimitForbiddenError,
  setSessionUsageLimitInTransaction,
  settleSessionUsageReceipt,
  withCreditDebitAttribution,
  withRlsContext,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";

// OPE-798: per-task (root session) API-equivalent usage limits on real
// PostgreSQL with the non-bypass application role and FORCE RLS.
setDefaultTimeout(120_000);
let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-usage-limits");
  if (!acquired) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL is required");
    return;
  }
  shared = acquired;
  app = createDb(shared.appUrl, { max: 24 });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await shared?.release();
});

async function fixture() {
  const subjectId = `user:usage-limit:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "usage-limit-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Usage limit",
    workspaceExternalSource: "usage-limit-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Usage limit",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
}

type Scope = Awaited<ReturnType<typeof fixture>>;

async function newSession(scope: Scope, parentSessionId?: string) {
  const session = await createSession(app.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    initialMessage: "usage limit fixture",
    model: "test",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: scope.subjectId },
    ...(parentSessionId ? { parentSessionId } : {}),
  });
  return session.id;
}

async function setLimit(
  scope: Scope,
  sessionId: string,
  limitMicros: number | null,
  expectedVersion: number,
  operationId = crypto.randomUUID(),
  producerEnabled = true,
) {
  return await withWorkspaceSubjectSessionActivityRls(
    app.db,
    scope.workspaceId,
    scope.subjectId,
    async (tx) =>
      await setSessionUsageLimitInTransaction(tx, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId,
        limitMicros,
        expectedVersion,
        operationId,
        actor: { subjectId: scope.subjectId, type: "human" },
        producerEnabled,
      }),
  );
}

async function settle(
  scope: Scope,
  sessionId: string,
  sourceId: string,
  amountMicros: number | null,
  pricingSource: "configured_list_price" | "gateway_reported" | null = "configured_list_price",
) {
  return await settleSessionUsageReceipt(app.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId,
    sourceId,
    turnId: null,
    amountMicros,
    pricingSource,
    model: "test",
  });
}

async function read(scope: Scope, sessionId: string, prepare = false) {
  const result = await readSessionUsageLimit(app.db, { ...scope, sessionId, prepare });
  if (result.outcome !== "ok") throw new Error(`unexpected ${result.outcome}`);
  return result.state;
}

describe("session usage limits (real PostgreSQL, non-bypass app role)", () => {
  test("AC01/AC03: new roots are complete and unlimited by default; null and zero differ; descendants inherit the root", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    const grandchild = await newSession(scope, child);
    const state = await read(scope, root);
    expect(state).toMatchObject({
      basis: "model_api_equivalent_v1",
      rootSessionId: root,
      inherited: false,
      status: "unlimited",
      limitMicros: null,
      usedMicros: 0,
      version: 0,
      history: "complete",
      coverage: "complete",
    });
    expect(Object.keys(state)).not.toContain("conflicts");
    expect(await read(scope, grandchild)).toMatchObject({ rootSessionId: root, inherited: true });

    const zero = await setLimit(scope, root, 0, 0);
    expect(zero.outcome).toBe("ok");
    // Zero is an immediate stop, not "no limit".
    expect(zero.state).toMatchObject({ status: "reached", limitMicros: 0, usedMicros: 0, version: 1 });
    const admission = await checkSessionUsageLimitAdmission(app.db, {
      ...scope,
      sessionId: grandchild,
    });
    expect(admission.allowed).toBe(false);
    const cleared = await setLimit(scope, root, null, 1);
    expect(cleared.state).toMatchObject({ status: "unlimited", limitMicros: null, version: 2 });
    expect(
      (await checkSessionUsageLimitAdmission(app.db, { ...scope, sessionId: grandchild })).allowed,
    ).toBe(true);
  });

  test("AC10/AC21: CAS, exact replay, operation conflict, root-only writes, producer gate and the durable event", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    const operationId = crypto.randomUUID();
    const first = await setLimit(scope, root, 5_000_000, 0, operationId);
    expect(first.outcome).toBe("ok");
    expect(first.eventId).toBeString();
    const replay = await setLimit(scope, root, 5_000_000, 0, operationId);
    expect(replay.outcome).toBe("replayed");
    expect(replay.state?.version).toBe(1);
    expect((await setLimit(scope, root, 6_000_000, 0, operationId)).outcome).toBe(
      "operation_conflict",
    );
    expect((await setLimit(scope, root, 6_000_000, 0)).outcome).toBe("conflict");
    const notRoot = await setLimit(scope, child, 6_000_000, 1);
    expect(notRoot).toMatchObject({ outcome: "not_root", rootSessionId: root });
    // Producer gate off: a new non-null limit is refused, clearing still works,
    // and the persisted limit keeps being enforced (state stays as stored).
    expect((await setLimit(scope, root, 7_000_000, 1, undefined, false)).outcome).toBe("disabled");
    expect((await read(scope, root)).limitMicros).toBe(5_000_000);
    const cleared = await setLimit(scope, root, null, 1, undefined, false);
    expect(cleared.outcome).toBe("ok");
    // A replay of the first operation cannot clear or replace the later state.
    expect((await setLimit(scope, root, 5_000_000, 0, operationId)).outcome).toBe("replayed");
    expect((await read(scope, root)).limitMicros).toBeNull();
    const events = await shared.admin`select payload from session_events
      where session_id=${root} and type='session.usage_limit.updated' order by sequence`;
    expect(events.map((row) => row.payload)).toEqual([
      { basis: "model_api_equivalent_v1", limitMicros: 5_000_000, previousLimitMicros: null, version: 1 },
      { basis: "model_api_equivalent_v1", limitMicros: null, previousLimitMicros: 5_000_000, version: 2 },
    ]);
    const audit = await shared.admin`select expected_version, previous_limit_micros, limit_micros,
        result_version, actor_type, actor_subject_id
      from opengeni_private.session_usage_limit_config_receipts
      where root_session_id=${root} order by result_version`;
    expect(audit.map((row) => [Number(row.result_version), row.actor_type])).toEqual([
      [1, "human"],
      [2, "human"],
    ]);
    expect(audit[1]!.previous_limit_micros).toBe("5000000");
  });

  test("AC11: agent-attributed requests cannot change a limit, even with a human-looking actor", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    await expect(
      withCreditDebitAttribution(
        { kind: "turn", turnId: crypto.randomUUID(), initiatingHumanSubjectId: scope.subjectId },
        () => setLimit(scope, root, 1, 0),
      ),
    ).rejects.toBeInstanceOf(SessionUsageLimitForbiddenError);
    expect((await read(scope, root)).version).toBe(0);
  });

  test("AC02/AC13: priced, known-free and unpriced receipts; duplicate, fill-once and conflict", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    expect((await settle(scope, root, "turn-a:r1", 1_250_000)).outcome).toBe("recorded");
    expect((await settle(scope, child, "turn-b:r1", 0)).outcome).toBe("recorded");
    expect((await settle(scope, child, "turn-b:r2", null, null)).outcome).toBe("recorded");
    let state = await read(scope, root);
    expect(state).toMatchObject({
      usedMicros: 1_250_000,
      pricedCalls: 1,
      freeCalls: 1,
      unpricedCalls: 1,
      coverage: "partial",
    });
    // A price without a pricing source is not a known price.
    expect((await settle(scope, child, "turn-b:r3", 99, null)).outcome).toBe("recorded");
    expect((await read(scope, root)).unpricedCalls).toBe(2);
    expect((await settle(scope, root, "turn-a:r1", 1_250_000)).outcome).toBe("duplicate");
    // An unknown receipt can be filled exactly once with an authoritative amount.
    expect((await settle(scope, child, "turn-b:r2", 300_000)).outcome).toBe("filled");
    expect((await settle(scope, child, "turn-b:r2", 300_000)).outcome).toBe("duplicate");
    // A later unknown observation never erases a known amount.
    expect((await settle(scope, child, "turn-b:r2", null, null)).outcome).toBe("duplicate");
    // A conflicting known amount is counted for diagnostics, never debited twice.
    expect((await settle(scope, root, "turn-a:r1", 9_000_000)).outcome).toBe("conflict");
    state = await read(scope, root);
    expect(state).toMatchObject({ usedMicros: 1_550_000, pricedCalls: 2, unpricedCalls: 1 });
    const [counter] = await shared.admin`select conflict_count from
      opengeni_private.session_usage_limit_roots where root_session_id=${root}`;
    expect(Number(counter!.conflict_count)).toBe(1);
  });

  test("AC04/AC22: twenty simultaneous sibling settlements sum exactly without deadlock; unrelated roots are isolated", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const other = await newSession(scope);
    const siblings = await Promise.all(Array.from({ length: 5 }, () => newSession(scope, root)));
    const [before] =
      await shared.admin`select deadlocks from pg_stat_database where datname=current_database()`;
    const amounts = Array.from({ length: 20 }, (_, index) => 1_000 + index * 7);
    const outcomes = await Promise.all(
      amounts.map((amount, index) =>
        settle(scope, siblings[index % siblings.length]!, `turn-${index}:r1`, amount),
      ),
    );
    expect(outcomes.every((result) => result.outcome === "recorded")).toBe(true);
    const [after] =
      await shared.admin`select deadlocks from pg_stat_database where datname=current_database()`;
    expect(Number(after!.deadlocks)).toBe(Number(before!.deadlocks));
    const state = await read(scope, root);
    expect(state.usedMicros).toBe(amounts.reduce((sum, value) => sum + value, 0));
    expect(state.pricedCalls).toBe(20);
    expect(state.usageRevision).toBe(20);
    expect((await read(scope, other)).usedMicros).toBe(0);
  });

  test("AC22: a held root counter lock does not block an unrelated root's settlement or the hot read", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const other = await newSession(scope);
    const holder = await shared.admin.reserve();
    try {
      await holder`begin`;
      await holder`select 1 from opengeni_private.session_usage_limit_roots
        where root_session_id=${root} for no key update`;
      const independent = await Promise.race([
        settle(scope, other, "turn-x:r1", 10).then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
      ]);
      expect(independent).toBe("settled");
      // The admission read of the locked root is lock-free.
      const hot = await Promise.race([
        read(scope, root).then(() => "read"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
      ]);
      expect(hot).toBe("read");
      const pending = settle(scope, root, "turn-y:r1", 20);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const [row] = await shared.admin`select exists(select 1 from pg_stat_activity a
          where cardinality(pg_blocking_pids(a.pid)) > 0
            and query like '%session_usage_limit_command%') as waiting`;
        waiting = row!.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await holder`commit`;
      expect((await pending).outcome).toBe("recorded");
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
    }
  });

  test("AC05: reached is derived from the latest counter; concurrently admitted usage stays recorded above the limit", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    await setLimit(scope, root, 1_000_000, 0);
    expect((await checkSessionUsageLimitAdmission(app.db, { ...scope, sessionId: child })).allowed).toBe(
      true,
    );
    // Three calls admitted before the limit was observed all settle in full.
    await Promise.all([
      settle(scope, root, "turn-1:r1", 600_000),
      settle(scope, child, "turn-2:r1", 700_000),
      settle(scope, child, "turn-3:r1", 800_000),
    ]);
    const admission = await checkSessionUsageLimitAdmission(app.db, { ...scope, sessionId: child });
    expect(admission.allowed).toBe(false);
    if (admission.allowed) return;
    expect(admission.refusal).toMatchObject({
      code: "session_usage_limit_reached",
      rootSessionId: root,
      limitMicros: 1_000_000,
      usedMicros: 2_100_000,
    });
    // Raising does not reset usage; lowering below usage reaches again.
    const raised = await setLimit(scope, root, 3_000_000, 1);
    expect(raised.state).toMatchObject({ status: "within", usedMicros: 2_100_000 });
    const lowered = await setLimit(scope, root, 2_000_000, 2);
    expect(lowered.state).toMatchObject({ status: "reached", usedMicros: 2_100_000 });
  });

  test("AC15: child deletion keeps the root's spend; root deletion removes the task's accounting; late settlement is source_gone", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    await settle(scope, child, "turn-c:r1", 400_000);
    await shared.admin`delete from sessions where id=${child}`;
    expect((await read(scope, root)).usedMicros).toBe(400_000);
    const [receipt] = await shared.admin`select source_session_id from
      opengeni_private.session_usage_limit_receipts where root_session_id=${root}`;
    expect(receipt!.source_session_id).toBe(child);
    expect((await settle(scope, child, "turn-c:r2", 1)).outcome).toBe("source_gone");
    expect((await read(scope, root)).usedMicros).toBe(400_000);
    await shared.admin`delete from sessions where id=${root}`;
    const remaining = await shared.admin`select count(*)::int as count from
      opengeni_private.session_usage_limit_receipts where root_session_id=${root}`;
    expect(remaining[0]!.count).toBe(0);
    expect(await readSessionUsageLimit(app.db, { ...scope, sessionId: root })).toEqual({
      outcome: "not_found",
    });
  });

  test("AC14: bounded resumable lifetime import of facts and events, exactly once with live receipts, stays legacy_partial", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    // Simulate a task that predates the feature: no counter row exists.
    await shared.admin`delete from opengeni_private.session_usage_limit_roots where root_session_id=${root}`;
    const turnA = crypto.randomUUID();
    const turnB = crypto.randomUUID();
    const facts: Array<[string, string, string, number | null, string | null, string]> = [];
    for (let index = 0; index < 7; index += 1) {
      facts.push([
        index < 4 ? root : child,
        index < 4 ? turnA : turnB,
        `response-${index}`,
        index === 5 ? null : 1_000 * (index + 1),
        index === 5 ? null : "configured_list_price",
        // Prior-year data is imported too (not a YTD window).
        index === 0 ? "2024-03-01T00:00:00Z" : `2026-0${(index % 9) + 1}-01T00:00:00Z`,
      ]);
    }
    for (const [sessionId, turnId, sourceKey, cost, pricing, occurredAt] of facts) {
      await shared.admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,
          source_key,provider,provider_api,model,billing_path,estimated_provider_cost_micros,
          pricing_source,occurred_at)
        values(${scope.accountId},${scope.workspaceId},${sessionId},${turnId},${sourceKey},'test',
          'responses','test','external',${cost},${pricing},${occurredAt})`;
    }
    // Recoverable events: one duplicates a fact identity, one exists only as an
    // event, one has no turn and one is malformed.
    const event = async (sessionId: string, turnId: string | null, payload: unknown) => {
      const [cursor] = await shared.admin`update sessions set last_sequence=last_sequence+1
        where id=${sessionId} returning last_sequence`;
      const sequence = Number(cursor!.last_sequence);
      await shared.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,
          turn_id,payload)
        values(${scope.accountId},${scope.workspaceId},${sessionId},${sequence},'agent.model.usage',
          ${turnId},${shared.admin.json(payload as never)})`;
    };
    await event(root, turnA, {
      sourceKey: "response-0",
      estimatedProviderCostMicros: 1_000,
      pricingSource: "configured_list_price",
    });
    await event(child, turnB, {
      sourceKey: "response-event-only",
      estimatedProviderCostMicros: 50_000,
      pricingSource: "gateway_reported",
      model: "gw",
    });
    await event(child, null, { sourceKey: "no-turn", estimatedProviderCostMicros: 5 });
    await event(child, turnB, { estimatedProviderCostMicros: 5 });
    // A live receipt that the import must not count again.
    const live = await settle(scope, child, `${turnB}:response-6`, 7_000);
    expect(live.outcome).toBe("recorded");
    expect(live.state).toMatchObject({ status: "preparing", usedMicros: null, history: "preparing" });
    // Preparing never presents a false zero and refuses a new limit.
    const preparing = await read(scope, root);
    expect(preparing).toMatchObject({ status: "preparing", usedMicros: null, coverage: "partial" });
    expect((await setLimit(scope, root, 1_000, 0)).outcome).toBe("preparing");
    // Bounded pages resume from the stored cursor.
    await shared.admin`update opengeni_private.session_usage_limit_roots set import_next_at=now()
      where root_session_id=${root}`;
    let steps = 0;
    for (; steps < 20; steps += 1) {
      const state = await read(scope, root);
      if (state.history !== "preparing") break;
      const processed = await withRlsContext(app.db, { accountId: scope.accountId }, async () =>
        maintainSessionUsageLimits(app.db, { limit: 5, budget: 2 }),
      );
      expect(processed).toBeGreaterThanOrEqual(0);
      await shared.admin`update opengeni_private.session_usage_limit_roots set import_next_at=now()
        where root_session_id=${root} and history_state='preparing'`;
    }
    expect(steps).toBeGreaterThan(2);
    const done = await read(scope, root);
    expect(done).toMatchObject({
      status: "unlimited",
      history: "legacy_partial",
      coverage: "partial",
      // 1k+2k+3k+4k+5k (+unknown) + 7k live + 50k event-only.
      usedMicros: 1_000 + 2_000 + 3_000 + 4_000 + 5_000 + 7_000 + 50_000,
      pricedCalls: 7,
      unpricedCalls: 1,
    });
    const legacy = await shared.admin`select origin, count(*)::int as count from
      opengeni_private.session_usage_limit_receipts where root_session_id=${root} group by origin
      order by origin`;
    expect(legacy.map((row) => [row.origin, row.count])).toEqual([
      ["legacy", 7],
      ["live", 1],
    ]);
    // A completed import never upgrades to complete; a limit can now be set.
    expect((await setLimit(scope, root, 100_000, 0)).state).toMatchObject({
      history: "legacy_partial",
      status: "within",
    });
  });

  test("AC14: an inline prepare read advances the import without the maintenance loop", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    await shared.admin`delete from opengeni_private.session_usage_limit_roots where root_session_id=${root}`;
    await shared.admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,
        source_key,provider,provider_api,model,billing_path,estimated_provider_cost_micros,
        pricing_source,occurred_at)
      values(${scope.accountId},${scope.workspaceId},${root},${crypto.randomUUID()},'r1','test',
        'responses','test','external',42,'configured_list_price',now())`;
    const state = await read(scope, root, true);
    expect(state).toMatchObject({ history: "legacy_partial", usedMicros: 42 });
  });

  test("AC12: runtime role has no direct private-table access; other tenants and hidden sessions see nothing", async () => {
    if (!shared) return;
    const scope = await fixture();
    const other = await fixture();
    const root = await newSession(scope);
    await settle(scope, root, "turn-p:r1", 10);
    for (const table of [
      "session_usage_limit_roots",
      "session_usage_limit_receipts",
      "session_usage_limit_config_receipts",
      "session_usage_limit_capabilities",
    ]) {
      await expect(
        withRlsContext(app.db, scope, (tx) =>
          tx.execute(sql.raw(`select count(*) from opengeni_private.${table}`)),
        ),
      ).rejects.toThrow();
    }
    for (const routine of [
      "select session_usage_limit_apply_receipt(null,null,null,null,null,null,null,null,null,null)",
      "select session_usage_limit_import_step(null,null,null,1)",
    ]) {
      await expect(withRlsContext(app.db, scope, (tx) => tx.execute(sql.raw(routine)))).rejects.toThrow();
    }
    // Another tenant's scope cannot see the session.
    expect(await readSessionUsageLimit(app.db, { ...other, sessionId: root })).toEqual({
      outcome: "not_found",
    });
    // A command whose explicit scope differs from the RLS context is denied.
    await expect(
      withRlsContext(app.db, other, (tx) =>
        tx.execute(sql`select session_usage_limit_command(${JSON.stringify({
          action: "read",
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId: root,
        })}::jsonb)`),
      ),
    ).rejects.toThrow();
    expect(
      (await settle(other, root, "turn-p:r2", 1)).outcome,
    ).toBe("source_gone");
    expect((await read(scope, root)).usedMicros).toBe(10);
  });

  test("AC20: complete current posture accepts the private storage and rejects drift", async () => {
    if (!shared) return;
    const owner = await acquireOwnerMigratedTestDatabase("session-usage-limit-posture");
    if (!owner) throw new Error("Owner-migrated PostgreSQL database unavailable");
    let currentApp: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owner.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
      await provisionRoles(owner.adminUrl, {
        appRole: "opengeni_app",
        appPassword: owner.appPassword,
        rlsStrategy: "force",
      });
      const options = {
        expectedRole: "opengeni_app",
        rlsStrategy: "force" as const,
        targetSchema: "public",
      };
      const runtimeUrl = new URL(owner.adminUrl);
      runtimeUrl.username = "opengeni_app";
      runtimeUrl.password = owner.appPassword;
      currentApp = createDb(runtimeUrl.toString());
      const current = await inspectRuntimeDatabasePosture(currentApp.db, options);
      expect(evaluateRuntimeDatabasePosture(current, options)).toEqual([]);
      for (const name of RUNTIME_SESSION_USAGE_LIMIT_PRIVATE_TABLES) {
        expect(current.privateTables.some((table) => table.name === name)).toBe(true);
      }
      const unsafe = structuredClone(current);
      unsafe.privateTables.find((table) => table.name === "session_usage_limit_receipts")!.update =
        true;
      expect(evaluateRuntimeDatabasePosture(unsafe, options)).toContain(
        "session usage limit private table session_usage_limit_receipts is missing or unsafe",
      );
      await owner.admin`grant update(amount_micros) on opengeni_private.session_usage_limit_receipts to opengeni_app`;
      const columnGrant = await inspectRuntimeDatabasePosture(currentApp.db, options);
      expect(evaluateRuntimeDatabasePosture(columnGrant, options)).toContain(
        "session usage limit private table session_usage_limit_receipts is missing or unsafe",
      );
      // Re-provisioning converges the drift away.
      await provisionRoles(owner.adminUrl, {
        appRole: "opengeni_app",
        appPassword: owner.appPassword,
        rlsStrategy: "force",
      });
      const repaired = await inspectRuntimeDatabasePosture(currentApp.db, options);
      expect(evaluateRuntimeDatabasePosture(repaired, options)).toEqual([]);
    } finally {
      await currentApp?.close();
      await owner.release();
    }
  }, 300_000);
});
