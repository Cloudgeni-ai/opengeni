import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { sqlParameterLiteral } from "./helpers/sql-literal";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  getSessionForSubject,
  effectiveSessionPolicyQuery,
  listSessionEntriesForSubject,
  listSessionsForSubject,
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

test("a session detail read projects effective policy only once", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Policy read count",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Policy read count",
    subjectId: `policy-read-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "hello",
    resources: [],
    metadata: {},
    model: "stored-model",
    reasoningEffort: "high",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const debug = driver.options.debug;
  const queries: string[] = [];
  driver.options.debug = (_id, query) => {
    queries.push(query);
  };
  try {
    const detail = await getSession(client.db, grant.workspaceId, session.id);
    expect(detail).toMatchObject({
      id: session.id,
      model: "stored-model",
      reasoningEffort: "high",
      latencyMode: "standard",
    });
    expect(queries.filter((query) => query.includes('"latest_started_policy"'))).toHaveLength(1);
    queries.length = 0;
    const personal = await getSessionForSubject(
      client.db,
      grant.workspaceId,
      session.id,
      grant.subjectId,
    );
    expect(personal).toMatchObject({
      model: "stored-model",
      reasoningEffort: "high",
      latencyMode: "standard",
    });
    expect(queries.filter((query) => query.includes('"latest_started_policy"'))).toHaveLength(1);
  } finally {
    driver.options.debug = debug;
  }
});

test("a session list page names models with fixed probes, never the effective-policy walk", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Policy list",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Policy list",
    subjectId: `policy-list-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "hello",
    resources: [],
    metadata: {},
    model: "stored-model",
    reasoningEffort: "high",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const debug = driver.options.debug;
  const queries: string[] = [];
  driver.options.debug = (_id, query) => {
    queries.push(query);
  };
  try {
    const options = { subjectId: grant.subjectId };
    const full = await listSessionsForSubject(client.db, grant.workspaceId, options);
    const compact = await listSessionEntriesForSubject(client.db, grant.workspaceId, options);
    expect(full.sessions.find((row) => row.id === session.id)).toMatchObject({
      model: "stored-model",
      reasoningEffort: "high",
    });
    expect(compact.sessions.find((row) => row.id === session.id)).toMatchObject({
      model: "stored-model",
    });
    // The walk can scan every turn started since the last settings write;
    // a list page reads two fixed index probes per row instead.
    expect(queries.filter((query) => query.includes('"latest_started_policy"'))).toHaveLength(0);
    expect(queries.filter((query) => query.includes('"latest_started_turn_event"'))).toHaveLength(
      2,
    );
  } finally {
    driver.options.debug = debug;
  }
});

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
          const explained = await tx.execute(
            sql.raw(
              `explain (analyze, buffers, format json) execute effective_policy_plan(${query.params
                .map(sqlParameterLiteral)
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

async function policyWorkspace(name: string) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: name,
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: name,
    subjectId: `policy-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

async function policySession(grant: { accountId: string; workspaceId: string }) {
  return await createSession(client.db, {
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
}

type SyntheticTurn = { id: string; sessionId: string; source: string; model: string };
type SyntheticEvent = {
  sessionId: string;
  turnId: string | null;
  sequence: number;
  type: "turn.queued" | "turn.started" | "session.model_settings.updated";
};

/** Synthetic history from the harness administrator, writer triggers off. */
async function insertHistory(
  grant: { accountId: string; workspaceId: string },
  turns: SyntheticTurn[],
  events: SyntheticEvent[],
) {
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    if (turns.length > 0) {
      await tx`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
          status, source, position, prompt, model, reasoning_effort, latency_mode,
          sandbox_backend, resources, tools, metadata, started_at, finished_at
        ) select turn.id, ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, turn.session_id,
          gen_random_uuid(), 'synthetic', 'completed', turn.source, turn.position,
          repeat('prompt ', 200), turn.model, 'medium', 'standard', 'none', '[]'::jsonb,
          '[]'::jsonb, '{}'::jsonb, now(), now()
        from unnest(
          ${turns.map((turn) => turn.id)}::uuid[], ${turns.map((turn) => turn.sessionId)}::uuid[],
          ${turns.map((turn) => turn.source)}::text[], ${turns.map((turn) => turn.model)}::text[],
          ${turns.map((_, index) => index + 1)}::bigint[]
        ) as turn(id, session_id, source, model, position)`;
    }
    await tx`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, event.session_id, event.turn_id,
        event.sequence, event.type, '{}'::jsonb
      from unnest(
        ${events.map((event) => event.sessionId)}::uuid[],
        ${events.map((event) => event.turnId)}::uuid[],
        ${events.map((event) => event.sequence)}::bigint[],
        ${events.map((event) => event.type)}::text[]
      ) as event(session_id, turn_id, sequence, type)`;
  });
  await shared.admin`analyze session_events`;
  await shared.admin`analyze session_turns`;
}

/** Plan statistics of one effective-policy read under the caller's RLS. */
async function explainEffectivePolicy(
  grant: { workspaceId: string; subjectId: string },
  sessionId: string,
  mode: "force_generic_plan" | "force_custom_plan",
) {
  const query = effectiveSessionPolicyQuery(client.db, grant.workspaceId, [sessionId]).toSQL();
  return await withWorkspaceSubjectRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    async (tx) => {
      const [row] = await effectiveSessionPolicyQuery(tx, grant.workspaceId, [sessionId]);
      await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
      await tx.execute(sql.raw(`prepare effective_policy_walk as ${query.sql}`));
      try {
        const explained = await tx.execute(
          sql.raw(
            `explain (analyze, buffers, format json) execute effective_policy_walk(${query.params
              .map(sqlParameterLiteral)
              .join(", ")})`,
          ),
        );
        const plan = explained[0]?.["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>;
        const root = plan[0]!.Plan;
        // Every primary-key probe of a turn the walk considered.
        let turnProbes = 0;
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) return value.forEach(walk);
          if (!value || typeof value !== "object") return;
          const node = value as Record<string, unknown>;
          if (
            node["Relation Name"] === "session_turns" &&
            String(node["Alias"]).startsWith("candidate")
          ) {
            turnProbes += Number(node["Actual Loops"] ?? 0);
          }
          Object.values(node).forEach(walk);
        };
        walk(root);
        return {
          row,
          turnProbes,
          blocks: Number(root["Shared Hit Blocks"] ?? 0) + Number(root["Shared Read Blocks"] ?? 0),
        };
      } finally {
        await tx.execute(sql.raw("deallocate effective_policy_walk"));
      }
    },
  );
}

test("after a settings write, a schedule's long run of automated turns is not walked", async () => {
  const grant = await policyWorkspace("Policy automated run");
  const session = await policySession(grant);
  // A person changed the chat's model and sent a turn; a schedule then ran
  // on the chat many times. Only the person's turn can set the effective
  // policy, and the read must not visit every automated start to find it.
  const turns: SyntheticTurn[] = [];
  const events: SyntheticEvent[] = [
    { sessionId: session.id, turnId: null, sequence: 1000, type: "session.model_settings.updated" },
  ];
  const person = crypto.randomUUID();
  turns.push({ id: person, sessionId: session.id, source: "user", model: "person-model" });
  events.push(
    { sessionId: session.id, turnId: person, sequence: 1001, type: "turn.queued" },
    { sessionId: session.id, turnId: person, sequence: 1002, type: "turn.started" },
  );
  for (let index = 0; index < AUTOMATED_RUNS; index += 1) {
    const id = crypto.randomUUID();
    turns.push({ id, sessionId: session.id, source: "scheduled_task", model: "automated-model" });
    events.push(
      { sessionId: session.id, turnId: id, sequence: 2000 + index * 2, type: "turn.queued" },
      { sessionId: session.id, turnId: id, sequence: 2001 + index * 2, type: "turn.started" },
    );
  }
  await insertHistory(grant, turns, events);
  for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
    const measured = await explainEffectivePolicy(grant, session.id, mode);
    expect(measured.row?.model).toBe("person-model");
    // The newest few starts, then the person's turns: never one probe per run.
    expect(measured.turnProbes).toBeLessThanOrEqual(16);
    expect(measured.blocks).toBeLessThan(300);
  }

  // With no person turn since the write, the stored defaults apply, still
  // without walking the automated runs.
  const quiet = await policySession(grant);
  const quietEvents: SyntheticEvent[] = [
    { sessionId: quiet.id, turnId: null, sequence: 1000, type: "session.model_settings.updated" },
  ];
  const quietTurns: SyntheticTurn[] = [];
  for (let index = 0; index < AUTOMATED_RUNS; index += 1) {
    const id = crypto.randomUUID();
    quietTurns.push({ id, sessionId: quiet.id, source: "event_trigger", model: "automated-model" });
    quietEvents.push(
      { sessionId: quiet.id, turnId: id, sequence: 2000 + index * 2, type: "turn.queued" },
      { sessionId: quiet.id, turnId: id, sequence: 2001 + index * 2, type: "turn.started" },
    );
  }
  await insertHistory(grant, quietTurns, quietEvents);
  const measured = await explainEffectivePolicy(grant, quiet.id, "force_generic_plan");
  expect(measured.row?.model).toBe("stored-model");
  expect(measured.turnProbes).toBeLessThanOrEqual(16);
  expect(measured.blocks).toBeLessThan(300);
}, 180_000);

const AUTOMATED_RUNS = 1500;

test("the bounded read picks the same turn as the full walk for any history", async () => {
  const grant = await policyWorkspace("Policy equivalence");
  // Deterministic pseudo-random histories: mixed sources, settings writes
  // anywhere, re-queued and restarted turns, a person's turn accepted before
  // a write that starts after it, and starts whose turn row is missing.
  let seed = 0x5eed;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const sources = ["user", "api", "scheduled_task", "event_trigger", "agent"];
  const sessions: string[] = [];
  const turns: SyntheticTurn[] = [];
  const events: SyntheticEvent[] = [];
  for (let sessionIndex = 0; sessionIndex < 60; sessionIndex += 1) {
    const session = await policySession(grant);
    sessions.push(session.id);
    let sequence = 1000;
    const own: SyntheticTurn[] = [];
    // Schedule-driven sessions after a write exercise the person/API read
    // past the probed starts; the rest mix sources freely.
    const scheduled = random() < 0.4;
    if (scheduled) {
      events.push({
        sessionId: session.id,
        turnId: null,
        sequence: sequence++,
        type: "session.model_settings.updated",
      });
    }
    const turnCount = scheduled ? 20 + Math.floor(random() * 40) : Math.floor(random() * 60);
    const automatedShare = scheduled ? 0.97 : random();
    const writeChance = scheduled ? 0.01 : 0.06;
    for (let index = 0; index < turnCount; index += 1) {
      if (random() < writeChance) {
        events.push({
          sessionId: session.id,
          turnId: null,
          sequence: sequence++,
          type: "session.model_settings.updated",
        });
      }
      const source =
        random() < automatedShare
          ? sources[2 + Math.floor(random() * 3)]!
          : sources[Math.floor(random() * 2)]!;
      const turn = {
        id: crypto.randomUUID(),
        sessionId: session.id,
        source,
        model: `model-${sessionIndex}-${index}`,
      };
      // A start without a turn row, as in imported history.
      if (random() >= 0.04) {
        turns.push(turn);
        own.push(turn);
      }
      if (random() >= 0.05) {
        events.push({
          sessionId: session.id,
          turnId: turn.id,
          sequence: sequence++,
          type: "turn.queued",
        });
      }
      // A write between admission and start.
      if (random() < 0.04) {
        events.push({
          sessionId: session.id,
          turnId: null,
          sequence: sequence++,
          type: "session.model_settings.updated",
        });
      }
      if (random() >= 0.1) {
        events.push({
          sessionId: session.id,
          turnId: turn.id,
          sequence: sequence++,
          type: "turn.started",
        });
      }
    }
    // Re-queues and restarts of earlier turns.
    for (const turn of own) {
      if (random() < 0.05) {
        events.push({
          sessionId: session.id,
          turnId: turn.id,
          sequence: sequence++,
          type: "turn.queued",
        });
      }
      if (random() < 0.05) {
        events.push({
          sessionId: session.id,
          turnId: turn.id,
          sequence: sequence++,
          type: "turn.started",
        });
      }
    }
  }
  // Around the person/API cap: either side must pick the same turn. Some
  // person turns were queued before the write and start after it.
  for (const personTurns of [195, 199, 200, 201, 205]) {
    for (const variant of ["after", "straddling", "none"] as const) {
      const session = await policySession(grant);
      sessions.push(session.id);
      let sequence = 1000;
      const turn = (source: string, model: string) => {
        const id = crypto.randomUUID();
        turns.push({ id, sessionId: session.id, source, model });
        return id;
      };
      const event = (turnId: string | null, type: SyntheticEvent["type"]) =>
        events.push({ sessionId: session.id, turnId, sequence: sequence++, type });
      const before = personTurns - (variant === "none" ? 0 : 1);
      for (let index = 0; index < before; index += 1) {
        const id = turn(index % 2 === 0 ? "user" : "api", `person-${personTurns}-${index}`);
        event(id, "turn.queued");
        event(id, "turn.started");
      }
      const late = variant === "none" ? null : turn("api", `late-${personTurns}-${variant}`);
      if (late && variant === "straddling") event(late, "turn.queued");
      event(null, "session.model_settings.updated");
      if (late && variant === "after") event(late, "turn.queued");
      if (late) event(late, "turn.started");
      for (let index = 0; index < 20; index += 1) {
        const id = turn("scheduled_task", "automated-model");
        event(id, "turn.queued");
        event(id, "turn.started");
      }
    }
  }
  await insertHistory(grant, turns, events);

  // The rule itself, applied to the whole history of each session.
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const expected = new Map<string, string>();
  let personApiFallbacks = 0;
  for (const sessionId of sessions) {
    const own = events.filter((event) => event.sessionId === sessionId);
    const boundary = Math.max(
      -1,
      ...own
        .filter((event) => event.type === "session.model_settings.updated")
        .map((event) => event.sequence),
    );
    const firstQueued = (turnId: string) => {
      const queued = own
        .filter((event) => event.type === "turn.queued" && event.turnId === turnId)
        .map((event) => event.sequence);
      return queued.length > 0 ? Math.min(...queued) : null;
    };
    const starts = own
      .filter((event) => event.type === "turn.started" && event.sequence > boundary)
      .sort((left, right) => right.sequence - left.sequence);
    const eligible = (event: SyntheticEvent) => {
      const turn = turnById.get(event.turnId!);
      if (!turn) return false;
      if (boundary < 0) return true;
      if (turn.source !== "user" && turn.source !== "api") return false;
      return (firstQueued(turn.id) ?? 0) > boundary;
    };
    const chosen = starts.find(eligible);
    // Sessions the newest starts cannot answer: the person/API turn read does.
    if (boundary >= 0 && starts.length > 16 && !starts.slice(0, 16).some(eligible)) {
      personApiFallbacks += 1;
    }
    expected.set(sessionId, chosen ? turnById.get(chosen.turnId!)!.model : "stored-model");
  }

  const fallbacks = [...expected.values()].filter((model) => model === "stored-model").length;
  expect(fallbacks).toBeGreaterThan(0);
  expect(fallbacks).toBeLessThan(sessions.length);
  expect(personApiFallbacks).toBeGreaterThan(0);
  for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
    const { current, previous } = await currentAndPreviousPolicies(grant, sessions, mode);
    // The statement this replaced, run on the same rows: same turn everywhere.
    expect(current).toEqual(previous);
    expect(new Map([...current].map(([id, policy]) => [id, policy.model]))).toEqual(expected);
  }
}, 180_000);

/** A chat with `personTurns` API turns, then a settings write, one person
 * turn and `runs` schedule runs; the person's turn is the answer. */
async function personHeavyChat(personTurns: number, runs: number) {
  const grant = await policyWorkspace("Policy API chat");
  const session = await policySession(grant);
  const turns: SyntheticTurn[] = [];
  const events: SyntheticEvent[] = [];
  let sequence = 1000;
  const add = (source: string, model: string) => {
    const id = crypto.randomUUID();
    turns.push({ id, sessionId: session.id, source, model });
    events.push(
      { sessionId: session.id, turnId: id, sequence: sequence++, type: "turn.queued" },
      { sessionId: session.id, turnId: id, sequence: sequence++, type: "turn.started" },
    );
  };
  for (let index = 0; index < personTurns; index += 1) add("api", "api-model");
  events.push({
    sessionId: session.id,
    turnId: null,
    sequence: sequence++,
    type: "session.model_settings.updated",
  });
  add("user", "person-model");
  for (let index = 0; index < runs; index += 1) add("scheduled_task", "automated-model");
  await insertHistory(grant, turns, events);
  return { grant, session };
}

test("a long API-driven chat after a settings write is not read turn by turn", async () => {
  // Reading all 5,000 API turns took about 50,000 buffers on every read; past
  // the cap the read walks the 300 runs since the write instead.
  const long = await personHeavyChat(5000, 300);
  // At the cap the person/API read is used: 200 turns, a few runs.
  const atCap = await personHeavyChat(199, 30);
  // Past the cap with few runs: reading 1,000 person turns cost about 11,000.
  const pastCap = await personHeavyChat(999, 20);
  for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
    for (const [chat, limit] of [
      [long, 6_000],
      [atCap, 3_000],
      [pastCap, 3_000],
    ] as const) {
      const measured = await explainEffectivePolicy(chat.grant, chat.session.id, mode);
      expect(measured.row?.model).toBe("person-model");
      expect(measured.blocks).toBeLessThan(limit);
      console.info(
        "effective-policy-person-heavy",
        JSON.stringify({ mode, limit, blocks: measured.blocks }),
      );
      const { current, previous } = await currentAndPreviousPolicies(
        chat.grant,
        [chat.session.id],
        mode,
      );
      expect(current).toEqual(previous);
    }
  }
}, 180_000);

type PolicyColumns = { model: string; reasoningEffort: string; latencyMode: string };

/** The effective policy of each session from the current statement and from
 * the statement it replaced (an unbounded walk of every start since the last
 * settings write), in one transaction with the given plan cache mode. */
async function currentAndPreviousPolicies(
  grant: { workspaceId: string; subjectId: string },
  sessionIds: string[],
  mode: "force_generic_plan" | "force_custom_plan",
) {
  return await withWorkspaceSubjectRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    async (tx) => {
      await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
      const byId = (rows: Array<PolicyColumns & { id: string }>) =>
        new Map(
          rows.map((row) => [
            row.id,
            {
              model: row.model,
              reasoningEffort: row.reasoningEffort,
              latencyMode: row.latencyMode,
            },
          ]),
        );
      const current = byId(await effectiveSessionPolicyQuery(tx, grant.workspaceId, sessionIds));
      const previousRows = await tx.execute(previousPolicyStatement(grant.workspaceId, sessionIds));
      const previous = byId(previousRows as unknown as Array<PolicyColumns & { id: string }>);
      return { current, previous };
    },
  );
}

/** The statement {@link effectiveSessionPolicyQuery} replaced: an unbounded walk
 * of every start since the last settings write. */
function previousPolicyStatement(workspaceId: string, sessionIds: string[]) {
  const boundary = sql`(
    select coalesce(max(boundary.sequence), -1) from session_events boundary
    where boundary.workspace_id = ${workspaceId}
      and boundary.session_id = sessions.id
      and boundary.type = 'session.model_settings.updated'
  )`;
  return sql`
    select sessions.id::text as id,
      coalesce(latest.model, sessions.model) as model,
      coalesce(latest.reasoning_effort, sessions.reasoning_effort) as "reasoningEffort",
      coalesce(latest.latency_mode, sessions.latency_mode) as "latencyMode"
    from sessions
    left join lateral (
      select session_turns.model, session_turns.reasoning_effort, session_turns.latency_mode
      from session_turns
      where session_turns.workspace_id = ${workspaceId}
        and session_turns.session_id = sessions.id
        and session_turns.id = (
          select started.turn_id from session_events started
          where started.workspace_id = ${workspaceId}
            and started.session_id = sessions.id
            and started.type = 'turn.started'
            and started.sequence > ${boundary}
            and (
              select true from session_turns candidate
              where candidate.workspace_id = started.workspace_id
                and candidate.session_id = started.session_id
                and candidate.id = started.turn_id
                and coalesce(case when candidate.source in ('user', 'api') then (
                  select min(accepted.sequence) from session_events accepted
                  where accepted.workspace_id = ${workspaceId}
                    and accepted.session_id = sessions.id
                    and accepted.turn_id = candidate.id
                    and accepted.type = 'turn.queued'
                ) end, 0) > ${boundary}
              limit 1
            )
          order by started.sequence desc
          limit 1
        )
      limit 1
    ) latest on true
    where sessions.workspace_id = ${workspaceId}
      and sessions.id in (${sql.join(
        sessionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;
}
