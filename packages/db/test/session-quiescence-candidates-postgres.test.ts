import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  peekSessionWork,
  withWorkspaceSubjectRls,
} from "../src";
import {
  sessionAttemptPendingWritersSql,
  sessionPendingWriterAttemptIdsSql,
} from "../src/session-attempt-writers";
import { sqlParameterLiteral } from "./helpers/sql-literal";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const captured: { query: string; parameters: unknown[] }[] = [];
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-quiescence-candidates");
  if (!acquired) throw new Error("Quiescence candidate tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 1 });
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  driver.options.debug = (_id, query, parameters) => {
    if (query.startsWith("select") && query.includes("from session_turn_attempts successor")) {
      captured.push({ query, parameters });
    }
  };
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(attempts = 3) {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Quiescence candidates",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Quiescence candidates",
    subjectId: `quiescence-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  // Model old completed attempts whose quiescence receipt was not stored.
  // The disposable administrator bypasses writer triggers only for fixture
  // construction. All observations below use the restricted application role.
  const rows = await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    return tx<{ id: string; turn_id: string; execution_generation: number }[]>`
      with turns as (
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
          status, source, position, prompt, model, reasoning_effort, latency_mode,
          sandbox_backend, resources, tools, metadata, started_at, finished_at
        ) select gen_random_uuid(), ${grant.accountId}::uuid, ${grant.workspaceId}::uuid,
          ${session.id}::uuid, gen_random_uuid(), ${`session-${session.id}`}, 'completed', 'user',
          n, 'historical turn', 'test-model', 'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb,
          '{}'::jsonb, now() - make_interval(secs => ${attempts} - n + 1),
          now() - make_interval(secs => ${attempts} - n)
        from generate_series(1, ${attempts}) n
        returning id, position, started_at, finished_at
      )
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, outcome, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, authority_epoch, authority_visibility, mcp_approval_policies,
        started_at, closed_at
      ) select gen_random_uuid(), ${grant.accountId}::uuid, ${grant.workspaceId}::uuid,
        ${session.id}::uuid, turns.id, turns.position, 'closed', 'completed',
        ${`session-${session.id}`}, gen_random_uuid()::text, gen_random_uuid()::text,
        0, 1, 'workspace_shared', '{}'::jsonb,
        turns.started_at, turns.finished_at
      from turns
      returning id, turn_id, execution_generation`;
  });
  rows.sort((a, b) => a.execution_generation - b.execution_generation);
  return { grant, session, rows, scope: { workspaceId: grant.workspaceId, sessionId: session.id } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function observe(ctx: Fixture) {
  return withWorkspaceSubjectRls(client.db, ctx.grant.workspaceId, ctx.grant.subjectId, (db) =>
    peekSessionWork(db, ctx.grant.workspaceId, ctx.session.id),
  );
}

async function writer(ctx: Fixture, kind: "attempt" | "process-admission" | "active-process") {
  const attempt = ctx.rows[0]!;
  const leaseId = crypto.randomUUID(),
    admissionId = crypto.randomUUID(),
    processId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into sandbox_leases ${tx({
      id: leaseId,
      account_id: ctx.grant.accountId,
      workspace_id: ctx.grant.workspaceId,
      sandbox_group_id: ctx.session.sandboxGroupId,
      backend: "modal",
      expires_at: new Date(Date.now() + 60_000),
    })}`;
    const base = {
      account_id: ctx.grant.accountId,
      workspace_id: ctx.grant.workspaceId,
      session_id: ctx.session.id,
      lease_id: leaseId,
      sandbox_group_id: ctx.session.sandboxGroupId,
      lease_epoch: 0,
      provider_backend: "modal",
      provider_instance_id: "sb-test",
      route_kind: "home",
      route_epoch: 0,
    };
    await tx`insert into sandbox_workspace_mutation_admissions ${tx({
      ...base,
      id: admissionId,
      actor_kind: "turn",
      actor_id: attempt.id,
      turn_id: attempt.turn_id,
      attempt_id: attempt.id,
      execution_generation: attempt.execution_generation,
      holder_kind: "turn",
      holder_id: `turn:${attempt.id}`,
      workspace_generation: 1,
      operation: "execCommand",
      provider_outcome: kind === "attempt" ? null : "resolved",
      settled_at: kind === "attempt" ? null : new Date(),
    })}`;
    if (kind !== "attempt") {
      await tx`insert into sandbox_retained_processes ${tx({
        ...base,
        id: processId,
        parent_admission_id: admissionId,
        holder_id: `process:${processId}`,
        owner_actor_kind: "turn",
        owner_actor_id: attempt.id,
        owner_attempt_id: attempt.id,
        owner_turn_id: attempt.turn_id,
        owner_execution_generation: attempt.execution_generation,
        provider_session_id: 1,
        state: kind === "active-process" ? "active" : "exited",
        settled_at: kind === "active-process" ? null : new Date(),
      })}`;
      if (kind === "process-admission") {
        await tx`insert into sandbox_workspace_mutation_admissions ${tx({
          ...base,
          id: crypto.randomUUID(),
          actor_kind: "process",
          actor_id: processId,
          holder_kind: "process",
          holder_id: `process:${processId}`,
          workspace_generation: 2,
          operation: "writeStdin",
        })}`;
      }
    }
  });
  return { attemptId: attempt.id, processId, admissionId };
}

test.each(["attempt", "process-admission", "active-process"] as const)(
  "an old %s writer survives candidate filtering and blocks its exact attempt",
  async (kind) => {
    const ctx = await fixture();
    const owner = await writer(ctx, kind);
    expect(await observe(ctx)).toEqual({ kind: "cancellation-wait", attemptId: owner.attemptId });
    // Candidate discovery is not authority: a subject in another
    // workspace cannot read the old attempt or turn it into work.
    const foreign = await fixture();
    const visible = await withWorkspaceSubjectRls(
      client.db,
      foreign.grant.workspaceId,
      foreign.grant.subjectId,
      (db) =>
        db.execute(sql`select id from session_turn_attempts
        where id in ${sessionPendingWriterAttemptIdsSql(ctx.scope)}`),
    );
    expect(visible).toHaveLength(0);
  },
);

test("an independently adopted background command does not hold its old turn open", async () => {
  const ctx = await fixture();
  const owner = await writer(ctx, "active-process");
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into session_background_commands ${tx({
      id: owner.processId,
      account_id: ctx.grant.accountId,
      workspace_id: ctx.grant.workspaceId,
      session_id: ctx.session.id,
      retained_process_id: owner.processId,
      provider: "managed",
      state: "running",
    })}`;
  });
  expect(await observe(ctx)).toEqual({ kind: "idle" });
});

test("legacy lost Modal exec stays a physical writer while inference may inspect it", async () => {
  const ctx = await fixture();
  const owner = await writer(ctx, "attempt");
  await shared.admin`update session_turn_attempts set outcome = 'lease_lost_recoverable'
    where id = ${owner.attemptId}`;
  const [row] = await withWorkspaceSubjectRls(
    client.db,
    ctx.grant.workspaceId,
    ctx.grant.subjectId,
    (db) =>
      db.execute(sql`select
      ${sessionAttemptPendingWritersSql(sql`attempt`, "physical")} as physical,
      ${sessionAttemptPendingWritersSql(sql`attempt`, "inference")} as inference
      from session_turn_attempts attempt
      where attempt.id = ${owner.attemptId} and attempt.id in ${sessionPendingWriterAttemptIdsSql(ctx.scope)}`),
  );
  expect(row).toEqual({ physical: true, inference: false });
  expect(await observe(ctx)).toEqual({ kind: "idle" });
});

test.each(["settled", "rejected_stale"] as const)(
  "an older %s interruption still requires its own receipt",
  async (state) => {
    const ctx = await fixture();
    const attemptId = ctx.rows[0]!.id;
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into session_attempt_interruptions ${tx({
        account_id: ctx.grant.accountId,
        workspace_id: ctx.grant.workspaceId,
        session_id: ctx.session.id,
        operation_id: crypto.randomUUID(),
        attempt_id: attemptId,
        kind: "steer",
        control_revision: 0,
        state,
      })}`;
    });
    expect(await observe(ctx)).toEqual({ kind: "cancellation-wait", attemptId });
    await shared.admin`update session_turn_attempts set quiesced_at = now() where id = ${attemptId}`;
    expect(await observe(ctx)).toEqual({ kind: "idle" });
  },
);

test("recovery-only receipt debt blocks the newest attempt, not a superseded predecessor", async () => {
  const ctx = await fixture();
  const latest = ctx.rows.at(-1)!;
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update session_turn_attempts set outcome = 'interrupted_recoverable'
      where session_id = ${ctx.session.id}`;
    await tx`insert into session_events (account_id, workspace_id, session_id, sequence,
      turn_id, turn_attempt_id, type, payload)
      select account_id, workspace_id, session_id, execution_generation, turn_id, id,
        'turn.recovery.requested', '{}'::jsonb
      from session_turn_attempts where session_id = ${ctx.session.id}`;
  });
  expect(await observe(ctx)).toEqual({ kind: "cancellation-wait", attemptId: latest.id });
  await shared.admin`update session_turn_attempts set quiesced_at = now() where id = ${latest.id}`;
  // The older attempts still lack receipts and have exact recovery events.
  // A successor proves that historical recovery boundary was already crossed.
  expect(await observe(ctx)).toEqual({ kind: "idle" });
});

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
function nodes(root: PlanNode): PlanNode[] {
  return [root, ...(root.Plans ?? []).flatMap(nodes)];
}

test("the real work peek evaluates writer subqueries only for candidates in a long idle session", async () => {
  const ctx = await fixture(1200);
  await shared.admin`analyze session_turn_attempts`;
  captured.length = 0;
  expect(await observe(ctx)).toEqual({ kind: "idle" });
  const query = captured.at(-1);
  if (!query) throw new Error("The real quiescence query was not captured");
  for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
    await withWorkspaceSubjectRls(
      client.db,
      ctx.grant.workspaceId,
      ctx.grant.subjectId,
      async (db) => {
        await db.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
        await db.execute(sql.raw(`prepare quiescence_candidates as ${query.query}`));
        try {
          const result = await db.execute(
            sql.raw(`explain (analyze, buffers, format json)
          execute quiescence_candidates(${query.parameters.map(sqlParameterLiteral).join(", ")})`),
          );
          const plans = result[0]!["QUERY PLAN"] as { Plan: PlanNode; "Execution Time": number }[];
          const root = plans[0]!.Plan;
          const writerProbes = nodes(root).filter((node) => node.Alias === "admission");
          // The original correlated predicate probed admissions once for each
          // closed historical attempt. One candidate here is the latest attempt.
          if (process.env.OPENGENI_BENCH_QUIESCENCE === "1") {
            console.log(
              JSON.stringify({
                mode,
                executionMs: plans[0]!["Execution Time"],
                sharedBlocks:
                  Number(root["Shared Hit Blocks"]) + Number(root["Shared Read Blocks"]),
                admissionLoops: writerProbes.map((node) => node["Actual Loops"]),
              }),
            );
          }
          expect(writerProbes.length).toBeGreaterThan(0);
          expect(
            Math.max(...writerProbes.map((node) => Number(node["Actual Loops"]))),
          ).toBeLessThanOrEqual(2);
        } finally {
          await db.execute(sql.raw("deallocate quiescence_candidates"));
        }
      },
    );
  }
}, 180_000);
