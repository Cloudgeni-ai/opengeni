import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  deleteSessionTreeIfQuiescent,
  withWorkspaceSubjectRls,
} from "../src";
import { parseConcurrentIndexMigration } from "../src/migrate";

const migration = "0887_session_events_attempt_reference_index.sql";
const indexName = "session_events_workspace_attempt_idx";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("event-attempt-reference", {
    withheldMigrations: [migration],
  });
  if (!acquired) throw new Error("Attempt reference index requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("online attempt-reference index bounds chat deletion without weakening RESTRICT or tenant isolation", async () => {
  const source = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
  const parsed = parseConcurrentIndexMigration(migration, source)!;
  expect(parsed.indexName).toBe(indexName);
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Attempt references",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Attempt references",
    subjectId: `attempt-index-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const create = () =>
    createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "",
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      resources: [],
      metadata: {},
    });
  const target = await create(),
    unrelated = await create();
  const seedAttempts = async (sessionId: string, count: number) =>
    shared.admin.begin(async (tx) => {
      // Construct historical rows only. The measured application deletion and
      // explicit FK rejection below run with every ordinary trigger enabled.
      await tx`set local session_replication_role = replica`;
      return tx<{ id: string; turn_id: string }[]>`
      with turns as (
        insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model, reasoning_effort,
          latency_mode, sandbox_backend, resources, tools, metadata, started_at, finished_at)
        select gen_random_uuid(), ${grant.accountId}, ${grant.workspaceId}, ${sessionId},
          gen_random_uuid(), ${`session-${sessionId}`}, 'completed', 'user', n, 'historical',
          'test-model', 'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
          now()-interval '1 hour', now()-interval '30 minutes'
        from generate_series(1, ${count}) n returning id
      ) insert into session_turn_attempts (id,account_id,workspace_id,session_id,turn_id,
        execution_generation,state,outcome,temporal_workflow_id,temporal_workflow_run_id,
        temporal_activity_id,verified_control_revision,authority_epoch,authority_visibility,
        mcp_approval_policies,started_at,closed_at,quiesced_at)
      select gen_random_uuid(),${grant.accountId},${grant.workspaceId},${sessionId},turns.id,
        1,'closed','completed',${`session-${sessionId}`},gen_random_uuid()::text,
        gen_random_uuid()::text,0,1,'workspace_shared','{}'::jsonb,now()-interval '1 hour',
        now()-interval '30 minutes',now()-interval '30 minutes' from turns returning id,turn_id`;
    });
  const attempts = await seedAttempts(target.id, 100);
  const [otherAttempt] = await seedAttempts(unrelated.id, 1000);
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`with owners as (
        select array_agg(id order by id) as ids from session_turn_attempts where session_id=${unrelated.id}
      ) insert into session_events(account_id,workspace_id,session_id,sequence,type,payload,turn_attempt_id)
      select ${grant.accountId},${grant.workspaceId},${unrelated.id},n,'agent.message.delta',
        '{}'::jsonb,owners.ids[((n-1)%1000)+1] from generate_series(1,100000)n cross join owners`;
  });
  await shared.admin`analyze session_events`;
  const explain = async (attemptId: string, mode = "force_custom_plan") =>
    shared.admin.begin(async (tx) => {
      // Native RI uses this parameterized query and limits rows through SPI,
      // rather than a SQL LIMIT. Exercise both PostgreSQL cached-plan modes.
      await tx.unsafe(`set local plan_cache_mode = ${mode}`);
      await tx`prepare attempt_reference(uuid,uuid) as select 1 from only session_events x
      where workspace_id=$1 and turn_attempt_id=$2 for key share of x`;
      try {
        const [row] = await tx.unsafe(`explain(analyze,buffers,format json)
        execute attempt_reference('${grant.workspaceId}'::uuid,'${attemptId}'::uuid)`);
        return row!["QUERY PLAN"][0] as { Plan: Record<string, unknown>; "Execution Time": number };
      } finally {
        await tx`deallocate attempt_reference`;
      }
    });
  const rollback = new Error("rollback measured chat deletion");
  const remove = async () => {
    const start = performance.now();
    try {
      await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, async (db) => {
        expect(
          await deleteSessionTreeIfQuiescent(db, {
            workspaceId: grant.workspaceId,
            subjectId: grant.subjectId,
            sessionId: target.id,
          }),
        ).toEqual({ status: "deleted", deletedSessionCount: 1 });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    return performance.now() - start;
  };
  const before = await explain(attempts[0]!.id);
  const beforeDeleteMs = await remove();
  await shared.admin.unsafe(parsed.statement);
  await shared.admin.unsafe(parsed.statement);
  const after = await explain(attempts[0]!.id);
  expect(JSON.stringify(after.Plan)).toContain(indexName);
  expect(JSON.stringify(after.Plan)).not.toContain('"Seq Scan"');
  const blocks = (plan: typeof after) =>
    Number(plan.Plan["Shared Hit Blocks"]) + Number(plan.Plan["Shared Read Blocks"]);
  expect(blocks(after)).toBeLessThan(20);
  expect(blocks(before)).toBeGreaterThan(100);
  const afterDeleteMs = await remove();
  const positive = await explain(otherAttempt!.id);
  expect(positive.Plan["Actual Rows"]).toBe(100);
  expect(JSON.stringify(positive.Plan)).toContain(indexName);
  const generic = await explain(attempts[0]!.id, "force_generic_plan");
  expect(JSON.stringify(generic.Plan)).toContain(indexName);
  expect(blocks(generic)).toBeLessThan(20);
  // A real referenced parent deletion still fails, with no trigger bypass.
  await expect(
    (async () =>
      await shared.admin`delete from session_turn_attempts where id=${otherAttempt!.id}`)(),
  ).rejects.toMatchObject({
    code: "23503",
    constraint_name: "session_events_workspace_attempt_fk",
  });
  const foreignIdentity = crypto.randomUUID();
  const foreign = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: foreignIdentity,
      accountName: "Other tenant",
      workspaceExternalSource: "test",
      workspaceExternalId: foreignIdentity,
      workspaceName: "Other tenant",
      subjectId: `foreign-${foreignIdentity}`,
    })
  ).workspaceGrants[0]!;
  expect(
    await deleteSessionTreeIfQuiescent(client.db, {
      workspaceId: foreign.workspaceId,
      subjectId: foreign.subjectId,
      sessionId: target.id,
    }),
  ).toEqual({ status: "not_found" });
  const [size] =
    await shared.admin`select pg_relation_size(${indexName}::regclass)::bigint AS bytes`;
  if (process.env.OPENGENI_BENCH_ATTEMPT_DELETE === "1") {
    console.log(
      JSON.stringify({
        unrelatedEvents: 100000,
        deletedAttempts: attempts.length,
        beforeDeleteMs,
        afterDeleteMs,
        before,
        after,
        indexBytes: Number(size!.bytes),
      }),
    );
  }
  expect(
    await deleteSessionTreeIfQuiescent(client.db, {
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      sessionId: target.id,
    }),
  ).toEqual({ status: "deleted", deletedSessionCount: 1 });
  const [remaining] =
    await shared.admin`select count(*)::int AS count from session_events where session_id=${unrelated.id}`;
  expect(remaining!.count).toBe(100000);
}, 180_000);
