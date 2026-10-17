import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  effectiveSessionPolicyQuery,
  withWorkspaceSubjectRls,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("effective-session-policy-plan");
  if (!acquired) throw new Error("PostgreSQL application-role plan fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const TURNS = 1500;
const BACKGROUND_SESSIONS = 6000;
// Leave room for whatever events session creation appended.
const FIRST_SEQUENCE = 1000;

test("effective session policy reads recent history only, however long the session", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Effective policy plans",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Effective policy plans",
    subjectId: `effective-policy-plan-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "stored-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });

  // Synthetic history from the disposable harness administrator, writer
  // triggers off: a long run of automated turns, each queued then started.
  // The newest one ran on its own per-occurrence model.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, resources, tools, metadata, started_at, finished_at
      ) select gen_random_uuid(), ${grant.accountId}::uuid, ${grant.workspaceId}::uuid,
        ${session.id}::uuid, gen_random_uuid(), ${`session-${session.id}`}, 'completed',
        'scheduled_task', n, 'turn',
        case when n = ${TURNS} then 'newest-model' else 'older-model' end,
        'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now(), now()
      from generate_series(1, ${TURNS}) n`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${session.id}::uuid, turn.id,
        ${FIRST_SEQUENCE} + turn.position * 2 + step.offset_value,
        case when step.offset_value = 0 then 'turn.queued' else 'turn.started' end, '{}'::jsonb
      from session_turns turn cross join (values (0), (1)) step(offset_value)
      where turn.workspace_id = ${grant.workspaceId}::uuid and turn.session_id = ${session.id}::uuid`;
    // Production-like statistics: most sessions in a workspace are short, so
    // a generic plan estimates a handful of turns per session. That estimate
    // must not turn the newest-first walk into a scan of every turn.
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, resources, tools, metadata, started_at, finished_at
      ) select gen_random_uuid(), ${grant.accountId}::uuid, ${grant.workspaceId}::uuid,
        gen_random_uuid(), gen_random_uuid(), 'background', 'completed', 'user', 1, 'turn',
        'background-model', 'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb,
        '{}'::jsonb, now(), now()
      from generate_series(1, ${BACKGROUND_SESSIONS})`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      select turn.account_id, turn.workspace_id, turn.session_id, turn.id, step.offset_value,
        case when step.offset_value = 1 then 'turn.queued' else 'turn.started' end, '{}'::jsonb
      from session_turns turn cross join (values (1), (2)) step(offset_value)
      where turn.workspace_id = ${grant.workspaceId}::uuid and turn.temporal_workflow_id = 'background'`;
  });
  await shared.admin`analyze session_events`;
  await shared.admin`analyze session_turns`;

  const measure = async (expected: { model: string; walked: number }) => {
    const query = effectiveSessionPolicyQuery(client.db, grant.workspaceId, [session.id]).toSQL();
    for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
      await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, async (tx) => {
        const [row] = await effectiveSessionPolicyQuery(tx, grant.workspaceId, [session.id]);
        expect(row?.model).toBe(expected.model);
        await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
        await tx.execute(sql.raw(`prepare effective_policy_plan as ${query.sql}`));
        let plan: unknown;
        try {
          const literal = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
          const explained = await tx.execute(
            sql.raw(
              `explain (analyze, buffers, format json) execute effective_policy_plan(${query.params
                .map(literal)
                .join(", ")})`,
            ),
          );
          plan = explained[0]?.["QUERY PLAN"];
          const root = (plan as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan;
          const startedScans: Record<string, unknown>[] = [];
          const walk = (value: unknown): void => {
            if (Array.isArray(value)) return value.forEach(walk);
            if (!value || typeof value !== "object") return;
            const node = value as Record<string, unknown>;
            // The start-event walk: aliased `started`, or unaliased in older shapes.
            if (
              node["Relation Name"] === "session_events" &&
              (node["Alias"] === "started" || node["Alias"] === "session_events")
            ) {
              startedScans.push(node);
            }
            Object.values(node).forEach(walk);
          };
          walk(root);
          // Start events are walked newest-first and the walk stops early.
          expect(startedScans).toHaveLength(1);
          const walked =
            Number(startedScans[0]!["Actual Rows"]) * Number(startedScans[0]!["Actual Loops"]) +
            Number(startedScans[0]!["Rows Removed by Filter"] ?? 0);
          expect(walked).toBeLessThanOrEqual(expected.walked);
          expect(
            Number(root["Shared Hit Blocks"] ?? 0) + Number(root["Shared Read Blocks"] ?? 0),
          ).toBeLessThan(300);
        } catch (error) {
          console.error("effective policy plan failure", JSON.stringify({ mode, plan }));
          throw error;
        } finally {
          await tx.execute(sql.raw("deallocate effective_policy_plan"));
        }
      });
    }
  };

  // No settings write: the newest started turn decides.
  await measure({ model: "newest-model", walked: 1 });

  // An explicit settings write after all of that history: automated turns can
  // no longer replace the stored defaults, and the walk ends at the write
  // instead of visiting every older start looking for an eligible turn.
  const boundary = FIRST_SEQUENCE + TURNS * 2 + 10;
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
    insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    values (${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${session.id}::uuid,
      ${boundary}, 'session.model_settings.updated', '{}'::jsonb)`;
  });
  await measure({ model: "stored-model", walked: 0 });

  // A person's turn queued after the write is honoured again.
  const personTurnId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, resources, tools, metadata, started_at, finished_at
      ) values (${personTurnId}::uuid, ${grant.accountId}::uuid, ${grant.workspaceId}::uuid,
        ${session.id}::uuid, gen_random_uuid(), ${`session-${session.id}`}, 'completed', 'user',
        ${TURNS + 1}, 'turn', 'person-model', 'medium', 'standard', 'none', '[]'::jsonb,
        '[]'::jsonb, '{}'::jsonb, now(), now())`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      values
        (${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${session.id}::uuid,
          ${personTurnId}::uuid, ${boundary + 1}, 'turn.queued', '{}'::jsonb),
        (${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${session.id}::uuid,
          ${personTurnId}::uuid, ${boundary + 2}, 'turn.started', '{}'::jsonb)`;
  });
  await measure({ model: "person-model", walked: 1 });
}, 180_000);
