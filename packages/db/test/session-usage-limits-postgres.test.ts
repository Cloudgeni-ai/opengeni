import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireRestrictedRuntimeTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { dbSearchPath } from "@opengeni/config";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  checkSessionUsageLimitAdmission,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  forkSessionContent,
  deleteSessionTreeIfQuiescent,
  fenceSessionUsageReceipt,
  getOrganizationPrivateSessionSettings,
  inspectRuntimeDatabasePosture,
  maintainSessionUsageLimits,
  migrate,
  provisionRoles,
  readSessionUsageLimit,
  releaseSessionUsageReceipt,
  RUNTIME_SESSION_USAGE_LIMIT_PRIVATE_TABLES,
  SessionUsageLimitForbiddenError,
  SessionUsageLimitUnavailableError,
  setSessionUsageLimitInTransaction,
  settleSessionUsageReceipt,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withCreditDebitAttribution,
  withRlsContext,
  withSessionRlsActorContext,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";

// per-task (root session) API-equivalent usage limits on real
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
    expect(zero.state).toMatchObject({
      status: "reached",
      limitMicros: 0,
      usedMicros: 0,
      version: 1,
    });
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

  test("AC01: one multi-row insert seeds every new root once per statement and leaves no capability open", async () => {
    if (!shared) return;
    const scope = await fixture();
    const count = 2_000;
    const started = performance.now();
    const inserted = await withWorkspaceSubjectSessionActivityRls(
      app.db,
      scope.workspaceId,
      scope.subjectId,
      (db) =>
        db.execute<{ id: string }>(sql`
          insert into sessions (
            account_id, workspace_id, initial_message, resources, tools, metadata,
            model, reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy
          )
          select ${scope.accountId}, ${scope.workspaceId}, 'bulk-' || n::text,
            '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'scripted-model', 'medium', 'standard', 'none',
            gen_random_uuid(), jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
          from generate_series(1, ${count}) as generated(n)
          returning id
        `),
    );
    const elapsedMs = performance.now() - started;
    expect(inserted).toHaveLength(count);
    const [seeded] = await shared.admin<Array<{ complete: number; other: number }>>`
      select count(*) filter (where history_state = 'complete')::int as complete,
        count(*) filter (where history_state <> 'complete')::int as other
      from opengeni_private.session_usage_limit_roots where workspace_id = ${scope.workspaceId}`;
    expect(seeded).toEqual({ complete: count, other: 0 });
    const [open] = await shared.admin<Array<{ open: number }>>`
      select count(*)::int as open from opengeni_private.session_usage_limit_capabilities
      where workspace_id = ${scope.workspaceId}`;
    expect(open!.open).toBe(0);
    // Seeding is per statement: a per-row seed reopens one capability key per
    // row and makes a bulk insert quadratic in the number of new roots.
    const [trigger] = await shared.admin<
      Array<{ perRow: boolean; transitionTable: string | null }>
    >`
      select (t.tgtype & 1) = 1 as "perRow", t.tgnewtable::text as "transitionTable"
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = 'sessions' and t.tgname = 'session_usage_limit_root_seed'`;
    expect(trigger).toEqual({ perRow: false, transitionTable: "inserted_sessions" });
    expect(elapsedMs).toBeLessThan(30_000);
    expect(await read(scope, inserted[0]!.id)).toMatchObject({
      rootSessionId: inserted[0]!.id,
      history: "complete",
      coverage: "complete",
      usedMicros: 0,
    });
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
      {
        basis: "model_api_equivalent_v1",
        limitMicros: 5_000_000,
        previousLimitMicros: null,
        version: 1,
      },
      {
        basis: "model_api_equivalent_v1",
        limitMicros: null,
        previousLimitMicros: 5_000_000,
        version: 2,
      },
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
    // A managed person in their personal workspace: the real fork authority.
    const userId = `usage-limit-fork-${crypto.randomUUID()}`;
    const context = await ensureManagedAccessForUser(app.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Fork owner",
    });
    const personal = context.workspaceGrants.find(
      (grant) => grant.workspaceId !== context.defaultWorkspaceId,
    )!;
    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${personal.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test'
      ) on conflict (account_id) do nothing`;
    const scope: Scope = {
      accountId: personal.accountId,
      workspaceId: personal.workspaceId!,
      subjectId: `user:${userId}`,
    };
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    await setLimit(scope, root, 1_000_000, 0);
    expect(
      (await checkSessionUsageLimitAdmission(app.db, { ...scope, sessionId: child })).allowed,
    ).toBe(true);
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

  test("AC15: a person's fork is a new unlimited root without copied usage; the source keeps its spend", async () => {
    if (!shared) return;
    // A managed person in their personal workspace: the real fork authority.
    const userId = `usage-limit-fork-${crypto.randomUUID()}`;
    const context = await ensureManagedAccessForUser(app.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Fork owner",
    });
    const personal = context.workspaceGrants.find(
      (grant) => grant.workspaceId !== context.defaultWorkspaceId,
    )!;
    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${personal.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test'
      ) on conflict (account_id) do nothing`;
    const scope: Scope = {
      accountId: personal.accountId,
      workspaceId: personal.workspaceId!,
      subjectId: `user:${userId}`,
    };
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    await setLimit(scope, root, 1_000_000, 0);
    await settle(scope, root, "turn-r:r1", 600_000);
    await settle(scope, child, "turn-c:r1", 500_000);
    expect((await read(scope, root)).status).toBe("reached");
    const fork = await forkSessionContent(app.db, {
      sourceWorkspaceId: scope.workspaceId,
      sourceSessionId: root,
      actorSubjectId: scope.subjectId,
      destinationWorkspaceId: scope.workspaceId,
      destinationVisibility: "user_private",
      workspaceSharedAcknowledged: false,
      operationKey: crypto.randomUUID(),
    });
    expect(fork.sessionId).not.toBe(root);
    expect(await read(scope, fork.sessionId)).toMatchObject({
      rootSessionId: fork.sessionId,
      inherited: false,
      status: "unlimited",
      limitMicros: null,
      usedMicros: 0,
      history: "complete",
      coverage: "complete",
      pricedCalls: 0,
    });
    // Usage made in the fork is its own; the source root is unchanged.
    await settle(scope, fork.sessionId, "turn-f:r1", 100);
    expect((await read(scope, fork.sessionId)).usedMicros).toBe(100);
    expect(await read(scope, root)).toMatchObject({ usedMicros: 1_100_000, status: "reached" });
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
          pricing_source,input_tokens,output_tokens,occurred_at)
        values(${scope.accountId},${scope.workspaceId},${sessionId},${turnId},${sourceKey},'test',
          'responses','test','external',${cost},${pricing},100,10,${occurredAt})`;
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
      inputTokens: 100,
      outputTokens: 10,
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
    expect(live.state).toMatchObject({
      status: "preparing",
      usedMicros: null,
      history: "preparing",
    });
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
      expect(processed.processed).toBeGreaterThanOrEqual(0);
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
        pricing_source,input_tokens,occurred_at)
      values(${scope.accountId},${scope.workspaceId},${root},${crypto.randomUUID()},'r1','test',
        'responses','test','external',42,'configured_list_price',5,now())`;
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
      await expect(
        withRlsContext(app.db, scope, (tx) => tx.execute(sql.raw(routine))),
      ).rejects.toThrow();
    }
    // Another tenant's scope cannot see the session.
    expect(await readSessionUsageLimit(app.db, { ...other, sessionId: root })).toEqual({
      outcome: "not_found",
    });
    // A command whose explicit scope differs from the RLS context is denied.
    await expect(
      withRlsContext(app.db, other, (tx) =>
        tx.execute(
          sql`select session_usage_limit_command(${JSON.stringify({
            action: "read",
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            sessionId: root,
          })}::jsonb)`,
        ),
      ),
    ).rejects.toThrow();
    expect((await settle(other, root, "turn-p:r2", 1)).outcome).toBe("source_gone");
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
      // The event meter and its amount rules are owner-internal too.
      await owner.admin`grant execute on function public.meter_session_usage_limit_event(), public.session_usage_limit_event_amount(jsonb) to opengeni_app`;
      const helperGrant = evaluateRuntimeDatabasePosture(
        await inspectRuntimeDatabasePosture(currentApp.db, options),
        options,
      );
      expect(helperGrant).toContain(
        "runtime role has forbidden owner-internal helper meter_session_usage_limit_event()",
      );
      expect(helperGrant).toContain(
        "runtime role has forbidden owner-internal helper session_usage_limit_event_amount(jsonb)",
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

  test("AC20: a dedicated-schema deployment passes the posture check through the production search path", async () => {
    if (!shared) return;
    // The API and workers reach a dedicated schema with dbSearchPath(), which
    // puts opengeni_private on the path. Routine identities must not depend on
    // it (a private row-type argument would render unqualified and vanish).
    const restricted = await acquireRestrictedRuntimeTestDatabase("session-usage-limit-schema");
    if (!restricted) throw new Error("Restricted PostgreSQL database unavailable");
    const searchPath = dbSearchPath({ dbSchema: restricted.schema });
    if (!searchPath?.includes("opengeni_private")) {
      throw new Error(`unexpected deployment search path: ${String(searchPath)}`);
    }
    const runtime = createDb(restricted.appUrl, { searchPath, rlsStrategy: "force" });
    try {
      const options = {
        expectedRole: "opengeni_app",
        rlsStrategy: "force" as const,
        targetSchema: restricted.schema,
      };
      const posture = await inspectRuntimeDatabasePosture(runtime.db, options);
      expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
      expect(posture.targetRoutines.map((routine) => routine.name)).toContain(
        "session_usage_limit_state(jsonb, boolean)",
      );
    } finally {
      await runtime.close();
      await restricted.release();
    }
  }, 600_000);
});

async function insertUsageEvent(
  scope: Scope,
  sessionId: string,
  turnId: string | null,
  payload: Record<string, unknown> | string,
) {
  const [cursor] = await shared.admin`update sessions set last_sequence=last_sequence+1
    where id=${sessionId} returning last_sequence`;
  const sequence = Number(cursor!.last_sequence);
  const json = typeof payload === "string" ? payload : JSON.stringify(payload);
  await shared.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,
      turn_id,payload)
    values(${scope.accountId},${scope.workspaceId},${sessionId},${sequence},'agent.model.usage',
      ${turnId},${json}::text::jsonb)`;
}

async function receiptRow(sourceId: string) {
  const [row] = await shared.admin`select status, amount_micros::text as amount, fenced, origin
    from opengeni_private.session_usage_limit_receipts where source_id=${sourceId}`;
  return row ?? null;
}

function runtimeAdmission(scope: Scope, sessionId: string, openSourceId?: string) {
  return checkSessionUsageLimitAdmission(app.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId,
    runtime: true,
    ...(openSourceId ? { openSourceId } : {}),
  });
}

async function makeLegacyRoot(rootSessionId: string) {
  await shared.admin`delete from opengeni_private.session_usage_limit_roots
    where root_session_id=${rootSessionId}`;
}

async function runMaintenanceUntilSettled(scope: Scope, root: string) {
  for (let step = 0; step < 30; step += 1) {
    if ((await read(scope, root)).history !== "preparing") return;
    await shared.admin`update opengeni_private.session_usage_limit_roots set import_next_at=now()
      where root_session_id=${root} and history_state='preparing'`;
    await maintainSessionUsageLimits(app.db, { limit: 100, budget: 50 });
  }
  throw new Error("import did not converge");
}

async function quiesceTree(scope: Scope, root: string) {
  await shared.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.lossless_content_writer','1',true),
      set_config('opengeni.sandbox_recovery_protocol_v2','1',true),
      set_config('opengeni.pending_tool_event_output_v1','1',true),
      set_config('opengeni.session_variable_set_attachments_v1','1',true),
      set_config('opengeni.shared_personal_choice_v1','1',true),
      set_config('opengeni.account_id', ${scope.accountId}, true),
      set_config('opengeni.workspace_id', ${scope.workspaceId}, true)`;
    await tx`update sessions set status='idle' where root_session_id=${root}`;
  });
}

describe("session usage limit remediation (real PostgreSQL, non-bypass app role)", () => {
  test("F2/AC13: a single call's durable custody marker is filled once, fenced, overdue, released or disclosed", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    await setLimit(scope, root, 1_000_000, 0);
    // Admission opens the marker in the same statement; people reads cannot.
    expect((await runtimeAdmission(scope, child, "model_call:a")).allowed).toBe(true);
    expect(await receiptRow("model_call:a")).toMatchObject({ status: "pending", fenced: false });
    await expect(
      readSessionUsageLimit(app.db, { ...scope, sessionId: child, openSourceId: "model_call:x" }),
    ).rejects.toThrow(/runtime/);
    // A pending marker is neither spend nor a disclosed gap while it is fresh.
    expect(await read(scope, root)).toMatchObject({ usedMicros: 0, coverage: "complete" });
    expect((await settle(scope, child, "model_call:a", 300_000)).outcome).toBe("recorded");
    expect((await settle(scope, child, "model_call:a", 300_000)).outcome).toBe("duplicate");
    expect(await read(scope, root)).toMatchObject({ usedMicros: 300_000, pricedCalls: 1 });

    // Another process could not record its call: the fence blocks the whole
    // tree on every replica at once, and coverage is no longer complete.
    expect((await runtimeAdmission(scope, child, "model_call:b")).allowed).toBe(true);
    expect(
      await fenceSessionUsageReceipt(app.db, {
        ...scope,
        sessionId: child,
        sourceId: "model_call:b",
      }),
    ).toBe("fenced");
    await expect(runtimeAdmission(scope, root)).rejects.toBeInstanceOf(
      SessionUsageLimitUnavailableError,
    );
    expect((await read(scope, root)).coverage).toBe("partial");
    expect((await settle(scope, child, "model_call:b", 100)).outcome).toBe("recorded");
    expect((await runtimeAdmission(scope, root)).allowed).toBe(true);
    expect(await read(scope, root)).toMatchObject({ usedMicros: 300_100, coverage: "complete" });

    // A crashed process never fences: the marker blocks once overdue and is
    // disclosed as unpriced by maintenance; a late fill still lands its price.
    expect((await runtimeAdmission(scope, child, "model_call:c")).allowed).toBe(true);
    await shared.admin`update opengeni_private.session_usage_limit_receipts
      set recorded_at = now() - interval '16 minutes' where source_id='model_call:c'`;
    await expect(runtimeAdmission(scope, child)).rejects.toBeInstanceOf(
      SessionUsageLimitUnavailableError,
    );
    await shared.admin`update opengeni_private.session_usage_limit_receipts
      set recorded_at = now() - interval '31 minutes' where source_id='model_call:c'`;
    const maintenance = await maintainSessionUsageLimits(app.db, { limit: 100, budget: 10 });
    expect(maintenance.resolvedLost).toBeGreaterThanOrEqual(1);
    expect(await receiptRow("model_call:c")).toMatchObject({ status: "unpriced", fenced: false });
    expect(await read(scope, root)).toMatchObject({ unpricedCalls: 1, coverage: "partial" });
    expect((await runtimeAdmission(scope, child)).allowed).toBe(true);
    expect((await settle(scope, child, "model_call:c", 50)).outcome).toBe("filled");
    expect(await read(scope, root)).toMatchObject({ usedMicros: 300_150, unpricedCalls: 0 });

    // A provider failure releases its unfenced marker; a fenced one stays.
    expect((await runtimeAdmission(scope, child, "model_call:d")).allowed).toBe(true);
    expect(
      await releaseSessionUsageReceipt(app.db, {
        ...scope,
        sessionId: child,
        sourceId: "model_call:d",
      }),
    ).toBe("released");
    expect(await receiptRow("model_call:d")).toBeNull();

    // A reached task opens nothing.
    await setLimit(scope, root, 1_000, 1);
    const refused = await runtimeAdmission(scope, child, "model_call:e");
    expect(refused.allowed).toBe(false);
    expect(await receiptRow("model_call:e")).toBeNull();
  });

  test("F5/AC14/AC21: an old writer's usage event during the rollout window is metered on a complete root", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    await setLimit(scope, root, 1_000_000, 0);
    const turn = crypto.randomUUID();
    // An upgraded-schema/old-binary writer appends only the usage event.
    await insertUsageEvent(scope, child, turn, {
      sourceKey: "old-writer-1",
      model: "test",
      estimatedProviderCostMicros: 2_500_000,
      pricingSource: "configured_list_price",
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(await read(scope, root)).toMatchObject({
      usedMicros: 2_500_000,
      status: "reached",
      history: "complete",
      coverage: "complete",
    });
    expect((await runtimeAdmission(scope, child)).allowed).toBe(false);
    // The new writer's direct receipt for the same response is the same call.
    expect((await settle(scope, child, `${turn}:old-writer-1`, 2_500_000)).outcome).toBe(
      "duplicate",
    );
    // A zero-token response without a provider-reported cost is unknown, not free.
    await insertUsageEvent(scope, child, turn, {
      sourceKey: "old-writer-2",
      estimatedProviderCostMicros: 0,
      pricingSource: "configured_list_price",
      inputTokens: 0,
      outputTokens: 0,
    });
    // A provider-reported amount needs no token telemetry.
    await insertUsageEvent(scope, child, turn, {
      sourceKey: "old-writer-3",
      estimatedProviderCostMicros: 7,
      pricingSource: "gateway_reported",
    });
    expect(await read(scope, root)).toMatchObject({
      usedMicros: 2_500_007,
      pricedCalls: 2,
      freeCalls: 0,
      unpricedCalls: 1,
      coverage: "partial",
    });
    // A tree whose counter does not exist yet is left to the import.
    const legacyRoot = await newSession(scope);
    await makeLegacyRoot(legacyRoot);
    await insertUsageEvent(scope, legacyRoot, turn, {
      sourceKey: "legacy-1",
      estimatedProviderCostMicros: 9,
      pricingSource: "gateway_reported",
    });
    const [counter] = await shared.admin`select count(*)::int as count from
      opengeni_private.session_usage_limit_roots where root_session_id=${legacyRoot}`;
    expect(counter!.count).toBe(0);
    await read(scope, legacyRoot);
    await runMaintenanceUntilSettled(scope, legacyRoot);
    expect(await read(scope, legacyRoot)).toMatchObject({
      usedMicros: 9,
      history: "legacy_partial",
    });
  });

  test("F6/AC14/AC23: malformed historical amounts, byte-long models and turnless events never wedge the import", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    await makeLegacyRoot(root);
    const turn = crypto.randomUUID();
    const fact = async (
      turnId: string | null,
      sourceKey: string,
      cost: string | null,
      model = "test",
      inputTokens = 10,
    ) => {
      await shared.admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,
          source_key,provider,provider_api,model,billing_path,estimated_provider_cost_micros,
          pricing_source,input_tokens,occurred_at)
        values(${scope.accountId},${scope.workspaceId},${root},${turnId},${sourceKey},'test',
          'responses',${model},'external',${cost}::numeric,'configured_list_price',${inputTokens},now())`;
    };
    await fact(turn, "ok", "1000");
    await fact(turn, "above-safe-integer", "9007199254740992");
    await fact(turn, "zero-tokens", "4000", "test", 0);
    // Facts always carry a turn; a turnless event has no stable source and is skipped.
    await insertUsageEvent(scope, root, null, {
      sourceKey: "turnless",
      estimatedProviderCostMicros: 3000,
      pricingSource: "configured_list_price",
      inputTokens: 5,
    });
    // Facts bound model bytes; an older event payload does not.
    await insertUsageEvent(scope, root, turn, {
      sourceKey: "long-model",
      model: "é".repeat(300),
      estimatedProviderCostMicros: 2000,
      pricingSource: "configured_list_price",
      inputTokens: 5,
    });
    await insertUsageEvent(
      scope,
      root,
      turn,
      '{"sourceKey":"too-big","estimatedProviderCostMicros":9999999999999999,"pricingSource":"configured_list_price","inputTokens":5}',
    );
    await read(scope, root);
    await runMaintenanceUntilSettled(scope, root);
    expect(await read(scope, root)).toMatchObject({
      history: "legacy_partial",
      coverage: "partial",
      usedMicros: 1_000 + 2_000,
      pricedCalls: 2,
      unpricedCalls: 3,
    });
    const [model] =
      await shared.admin`select model from opengeni_private.session_usage_limit_receipts
      where source_id=${`${turn}:long-model`}`;
    expect(model!.model).toBeNull();
  });

  test("F6/AC14: a failing import page backs off with its SQLSTATE and recovers", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    await makeLegacyRoot(root);
    await read(scope, root);
    await shared.admin`update opengeni_private.session_usage_limit_roots
      set import_cursor='{"session":"not-a-uuid"}'::jsonb, import_next_at=now()
      where root_session_id=${root}`;
    const failed = await maintainSessionUsageLimits(app.db, { limit: 100, budget: 10 });
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(failed.errors["22P02"]).toBeGreaterThanOrEqual(1);
    const [row] = await shared.admin`select import_attempts, import_error,
      import_next_at > now() + interval '50 seconds' as backed_off
      from opengeni_private.session_usage_limit_roots where root_session_id=${root}`;
    expect(row).toMatchObject({ import_attempts: 1, import_error: "22P02", backed_off: true });
    // Never a false zero while preparing.
    expect(await read(scope, root)).toMatchObject({ status: "preparing", usedMicros: null });
    await shared.admin`update opengeni_private.session_usage_limit_roots set import_cursor=null
      where root_session_id=${root}`;
    await runMaintenanceUntilSettled(scope, root);
    expect((await read(scope, root)).history).toBe("legacy_partial");
  });

  test("F4/AC10: an exact replay returns the operation's committed configuration, not a later one", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const operationA = crypto.randomUUID();
    const first = await setLimit(scope, root, 5_000_000, 0, operationA);
    expect(first.state).toMatchObject({ limitMicros: 5_000_000, version: 1 });
    await settle(scope, root, "turn-r:replay", 123);
    expect((await setLimit(scope, root, 10_000_000, 1)).state?.version).toBe(2);
    const replay = await setLimit(scope, root, 5_000_000, 0, operationA);
    expect(replay.outcome).toBe("replayed");
    expect(replay.state).toMatchObject({ limitMicros: 5_000_000, version: 1, usedMicros: 123 });
    // The live configuration is unchanged by the replay.
    expect(await read(scope, root)).toMatchObject({ limitMicros: 10_000_000, version: 2 });
  });

  test("F7/AC12/AC13: a private root hidden from the worker's causal context is still enforced and metered", async () => {
    if (!shared) return;
    // The definer function must run as a non-superuser migration owner so
    // FORCE RLS and private visibility apply exactly as in production.
    const owner = await acquireOwnerMigratedTestDatabase("session-usage-limit-private");
    if (!owner) throw new Error("Owner-migrated PostgreSQL database unavailable");
    let ownerApp: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owner.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
      await provisionRoles(owner.adminUrl, {
        appRole: "opengeni_app",
        appPassword: owner.appPassword,
        rlsStrategy: "force",
      });
      const runtimeUrl = new URL(owner.adminUrl);
      runtimeUrl.username = "opengeni_app";
      runtimeUrl.password = owner.appPassword;
      ownerApp = createDb(runtimeUrl.toString());
      await privateRootScenario(ownerApp.db, owner.admin);
    } finally {
      await ownerApp?.close();
      await owner.release();
    }
  }, 300_000);

  async function privateRootScenario(
    db: ReturnType<typeof createDb>["db"],
    admin: SharedTestDatabase["admin"],
  ) {
    const ownerUserId = `usage-limit-private-${crypto.randomUUID()}`;
    const ownerSubjectId = `user:${ownerUserId}`;
    const access = await ensureManagedAccessForUser(db, {
      userId: ownerUserId,
      email: `${ownerUserId}@example.test`,
      name: "Private owner",
    });
    const grant = access.workspaceGrants[0]!;
    await admin`insert into session_tenancy_activations (account_id, activation_version,
        inventory_digest, parity_digest, activated_by)
      values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
      on conflict (account_id) do nothing`;
    const settings = await getOrganizationPrivateSessionSettings(db, {
      organizationId: grant.accountId,
      actorSubjectId: ownerSubjectId,
    });
    await updateOrganizationPrivateSessionSettings(db, {
      organizationId: grant.accountId,
      actorSubjectId: ownerSubjectId,
      enabled: true,
      expectedVersion: settings.version,
      operationId: crypto.randomUUID(),
    });
    const scope: Scope = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId: ownerSubjectId,
    };
    const root = (
      await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
        createSession(db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          initialMessage: "private usage limit",
          resources: [],
          metadata: {},
          model: "test",
          reasoningEffort: "low",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: ownerSubjectId },
          createdByContext: {},
        }),
      )
    ).id;
    const transition = await transitionSessionVisibility(db, {
      workspaceId: scope.workspaceId,
      sessionId: root,
      actorSubjectId: ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `private-${root}`,
    });
    expect(transition.visibility).toBe("user_private");
    // People-facing reads keep private visibility.
    expect(
      await readSessionUsageLimit(db, {
        ...scope,
        sessionId: root,
        subjectId: `user:outsider-${root}`,
      }),
    ).toEqual({ outcome: "not_found" });
    const set = await withWorkspaceSubjectSessionActivityRls(
      db,
      scope.workspaceId,
      scope.subjectId,
      async (tx) =>
        await setSessionUsageLimitInTransaction(tx, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId: root,
          limitMicros: 0,
          expectedVersion: 0,
          operationId: crypto.randomUUID(),
          actor: { subjectId: scope.subjectId, type: "human" },
          producerEnabled: true,
        }),
    );
    expect(set.outcome).toBe("ok");
    // The worker's ambient actor without a causal human cannot see the root,
    // yet runtime admission refuses and settlement records.
    const worker = <T>(fn: () => Promise<T>) =>
      withSessionRlsActorContext(
        { subjectId: "service:agent-turn", initiatingHumanSubjectId: null },
        fn,
      );
    const tenant = { accountId: scope.accountId, workspaceId: scope.workspaceId };
    // A people-style read in that context really cannot see it (the failure
    // mode the runtime path must not inherit).
    expect(
      await readSessionUsageLimit(db, {
        ...tenant,
        sessionId: root,
        subjectId: "service:agent-turn",
      }),
    ).toEqual({ outcome: "not_found" });
    const admission = await worker(() =>
      checkSessionUsageLimitAdmission(db, { ...tenant, sessionId: root, runtime: true }),
    );
    expect(admission.allowed).toBe(false);
    expect(
      (
        await worker(() =>
          settleSessionUsageReceipt(db, {
            ...tenant,
            sessionId: root,
            sourceId: "private:r1",
            amountMicros: 77,
            pricingSource: "configured_list_price",
          }),
        )
      ).outcome,
    ).toBe("recorded");
    // A missing tree under runtime admission fails closed.
    await expect(
      checkSessionUsageLimitAdmission(db, {
        ...tenant,
        sessionId: crypto.randomUUID(),
        runtime: true,
      }),
    ).rejects.toBeInstanceOf(SessionUsageLimitUnavailableError);
  }

  test("a serialization failure inside the caller's transaction reaches the caller, whose retry records the receipt once", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    expect((await settle(scope, root, "turn-rr:r0", 5)).outcome).toBe("recorded");
    const sqlStateOf = (error: unknown): string | undefined => {
      let current: unknown = error;
      for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
        const code = (current as { code?: unknown }).code;
        if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
        current = (current as { cause?: unknown }).cause;
      }
      return undefined;
    };
    let attempts = 0;
    let firstFailure: unknown;
    const runOuter = async () =>
      await app.db.transaction(
        async (tx) => {
          attempts += 1;
          // The repeatable-read snapshot starts here.
          await tx.execute(sql`select 1`);
          if (attempts === 1) {
            // Another writer advances the same root's counter after the snapshot.
            expect((await settle(scope, root, "turn-rr:r1", 7)).outcome).toBe("recorded");
          }
          return await settleSessionUsageReceipt(tx, {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            sessionId: root,
            sourceId: "turn-rr:r2",
            turnId: null,
            amountMicros: 11,
            pricingSource: "configured_list_price",
            model: "test",
          });
        },
        { isolationLevel: "repeatable read" },
      );
    try {
      await runOuter();
    } catch (error) {
      firstFailure = error;
    }
    // The settlement does not swallow or mask the caller's 40001 (and never
    // retries inside the caller's snapshot); the caller's own retry succeeds.
    expect(sqlStateOf(firstFailure)).toBe("40001");
    expect((await runOuter()).outcome).toBe("recorded");
    expect(attempts).toBe(2);
    expect((await read(scope, root)).usedMicros).toBe(23);
  });

  test("F9: the scheduled refusal guard accepts the session_usage_limit reason", async () => {
    if (!shared) return;
    const [row] = await shared.admin`select
      pg_get_functiondef('opengeni_private.guard_scheduled_admission_refusal()'::regprocedure)
        like '%''session_usage_limit''%' as accepts`;
    expect(row!.accepts).toBe(true);
  });

  test("AC15: the real tree deletion helper races settlements without deadlock; late receipts are source_gone", async () => {
    if (!shared) return;
    const scope = await fixture();
    const root = await newSession(scope);
    const child = await newSession(scope, root);
    await setLimit(scope, root, 10_000_000, 0);
    await settle(scope, child, "delete:0", 1_000);
    await quiesceTree(scope, root);
    const [deadlocksBefore] = await shared.admin`select deadlocks::int as count
      from pg_stat_database where datname = current_database()`;
    const settlements = Array.from({ length: 8 }, (_, index) =>
      settle(scope, child, `delete:${index + 1}`, 10),
    );
    const deletion = deleteSessionTreeIfQuiescent(app.db, {
      workspaceId: scope.workspaceId,
      subjectId: scope.subjectId,
      sessionId: root,
    });
    const [outcomes, deleted] = await Promise.all([Promise.all(settlements), deletion]);
    expect(deleted.status).toBe("deleted");
    for (const outcome of outcomes) expect(["recorded", "source_gone"]).toContain(outcome.outcome);
    expect((await settle(scope, child, "delete:late", 10)).outcome).toBe("source_gone");
    const [left] = await shared.admin`select
      (select count(*) from opengeni_private.session_usage_limit_roots where root_session_id=${root})::int as roots,
      (select count(*) from opengeni_private.session_usage_limit_receipts where root_session_id=${root})::int as receipts`;
    expect(left).toMatchObject({ roots: 0, receipts: 0 });
    const [deadlocksAfter] = await shared.admin`select deadlocks::int as count
      from pg_stat_database where datname = current_database()`;
    expect(deadlocksAfter!.count).toBe(deadlocksBefore!.count);
  });
});
