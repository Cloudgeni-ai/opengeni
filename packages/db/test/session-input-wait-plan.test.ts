import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  currentSessionInputWaitTurnsQuery,
  withWorkspaceSubjectRls,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-input-wait-plan");
  if (!acquired) throw new Error("PostgreSQL application-role plan fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const TURNS = 1200;

test("a held wait on a long session reads its deciding turn without walking history", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Input wait plans",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Input wait plans",
    subjectId: `input-wait-plan-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  // Synthetic history written by the disposable harness administrator with
  // writer triggers off: a long run of finished person turns, each of which
  // the deciding-turn predicate must otherwise probe for consumed machine
  // input, plus a large set of delivered updates for those probes to scan.
  // The newest turn declared the wait that is still held.
  const waitTurnId = await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const turns = await tx<{ id: string; position: number }[]>`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, resources, tools, metadata, started_at, finished_at
      ) select gen_random_uuid(), ${grant.accountId}::uuid, ${grant.workspaceId}::uuid,
        ${session.id}::uuid, gen_random_uuid(), ${`session-${session.id}`}, 'completed', 'user',
        n, 'turn', 'test-model', 'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb,
        '{}'::jsonb, now() - make_interval(secs => ${TURNS} - n + 1),
        now() - make_interval(secs => ${TURNS} - n)
      from generate_series(1, ${TURNS}) n
      returning id, position`;
    await tx`
      insert into session_system_updates (
        account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary,
        state, delivered_turn_id, delivered_history_item_id
      ) select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${session.id}::uuid,
        'agent_message', 'fixture-' || turn.id, 'fixture-' || turn.id, 'fixture',
        'delivered', turn.id, gen_random_uuid()
      from session_turns turn
      where turn.workspace_id = ${grant.workspaceId}::uuid and turn.session_id = ${session.id}::uuid
        and turn.position < ${TURNS}`;
    const newest = turns.find((turn) => Number(turn.position) === TURNS)!;
    await tx`update sessions set status = 'idle', active_turn_id = null,
      input_wait_turn_id = ${newest.id}::uuid, input_wait_until = now() + interval '1 hour',
      input_wait_reason = 'plan fixture', input_wait_set_at = now()
      where id = ${session.id}::uuid`;
    return newest.id;
  });
  await shared.admin`analyze session_turns`;
  await shared.admin`analyze session_system_updates`;

  const query = currentSessionInputWaitTurnsQuery(client.db, grant.workspaceId, [
    session.id,
  ]).toSQL();
  const literal = (value: unknown) =>
    typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
    await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, async (tx) => {
      const rows = await currentSessionInputWaitTurnsQuery(tx, grant.workspaceId, [session.id]);
      expect(rows).toEqual([{ id: session.id, turnId: waitTurnId }]);
      await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
      // PREPARE exercises the real generic/custom plan-cache decision.
      await tx.execute(sql.raw(`prepare input_wait_plan as ${query.sql}`));
      let plan: unknown;
      try {
        const explained = await tx.execute(
          sql.raw(
            `explain (analyze, buffers, format json) execute input_wait_plan(${query.params
              .map(literal)
              .join(", ")})`,
          ),
        );
        plan = explained[0]?.["QUERY PLAN"];
        const root = (plan as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan;
        const turnScans: Record<string, unknown>[] = [];
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) return value.forEach(walk);
          if (!value || typeof value !== "object") return;
          const node = value as Record<string, unknown>;
          if (node["Relation Name"] === "session_turns" && node["Alias"] === "session_turns") {
            turnScans.push(node);
          }
          Object.values(node).forEach(walk);
        };
        walk(root);
        expect(turnScans).toHaveLength(1);
        // The newest finished turn decides; nothing older is read or sorted.
        expect(turnScans[0]!["Actual Rows"]).toBe(1);
        expect(
          Number(root["Shared Hit Blocks"] ?? 0) + Number(root["Shared Read Blocks"] ?? 0),
        ).toBeLessThan(200);
      } catch (error) {
        console.error("input wait plan failure", JSON.stringify({ mode, plan }));
        throw error;
      } finally {
        await tx.execute(sql.raw("deallocate input_wait_plan"));
      }
    });
  }
}, 180_000);
