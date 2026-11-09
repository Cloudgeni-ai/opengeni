import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  computeTurnTimingProfile,
  createDb,
  loadTurnTimingInputs,
  recordMissingTurnTimingProfiles,
  recordTurnTimingProfile,
  rlsContextForWorkspace,
  withRlsContext,
  withWorkspaceSessionActivityRls,
  type DbClient,
  type TurnTimingProfileTurn,
} from "../src/index";
import { rawRows } from "../src/database";
import {
  fixtureInput,
  loadTurnTimingFixture,
  projectTurnTimingPayload,
  type TurnTimingFixture,
} from "./turn-timing-fixtures";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const FIXTURES = [
  "responses-mcp-tools",
  "capacity-wait-recovery",
  "messages-provider-no-server-timing",
] as const;

let shared: SharedTestDatabase | null = null;
let appClient: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("turn-timing-profiles");
  if (!shared) {
    if (requireRealDatabase) throw new Error("turn timing profiles require real PostgreSQL");
    return;
  }
  appClient = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await appClient?.close();
  await shared?.release();
}, 180_000);

type SeededTurn = TurnTimingProfileTurn & { workspaceId: string; fixture: TurnTimingFixture };

async function seedWorkspace(label: string): Promise<{ accountId: string; workspaceId: string }> {
  if (!shared) throw new Error("PostgreSQL fixture unavailable");
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  await shared.admin`insert into managed_accounts (id, name) values (${accountId}, ${`timing ${label}`})`;
  await shared.admin`
    insert into workspaces (id, account_id, name) values (${workspaceId}, ${accountId}, ${`timing ${label}`})`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id) values (${workspaceId}, ${accountId})`;
  return { accountId, workspaceId };
}

/**
 * Bulky content every real event carries (prompts, tool arguments and
 * outputs). The profile must never read it.
 */
function withContent(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const bulky = "content that must stay in the database ".repeat(40);
  const out: Record<string, unknown> = { ...payload, content: bulky, input: [{ text: bulky }] };
  if (type === "agent.toolCall.created") {
    const args = payload.arguments;
    out.arguments =
      args && typeof args === "object" && !Array.isArray(args)
        ? { ...args, query: bulky }
        : { query: bulky };
  }
  if (
    type === "agent.model.request" &&
    payload.transport &&
    typeof payload.transport === "object"
  ) {
    out.transport = {
      ...(payload.transport as Record<string, unknown>),
      headers: { secret: bulky },
    };
  }
  return out;
}

async function seedTurn(
  workspace: { accountId: string; workspaceId: string },
  fixtureName: string,
  options: { archived?: boolean; shiftMs?: number } = {},
): Promise<SeededTurn> {
  if (!appClient) throw new Error("PostgreSQL fixture unavailable");
  const fixture = await loadTurnTimingFixture(fixtureName);
  const shift = options.shiftMs ?? 0;
  const iso = (value: string) => new Date(Date.parse(value) + shift).toISOString();
  const { accountId, workspaceId } = workspace;
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const workflowId = `session-${sessionId}`;
  const attemptIds = new Map(fixture.attempts.map((attempt) => [attempt.id, crypto.randomUUID()]));
  // A session's event sequence is gapless; the fixture keeps only the events a
  // profile reads, so number them again in order.
  fixture.events = [...fixture.events]
    .sort((a, b) => a.sequence - b.sequence)
    .map((event, index) => ({ ...event, sequence: index + 1 }));
  // The rows go through the turn's real lifecycle: the turn runs, each attempt
  // opens and closes in order, then the turn finishes and its events land.
  await withWorkspaceSessionActivityRls(appClient.db, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into sessions (
        id, account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode,
        sandbox_backend, sandbox_group_id, status, temporal_workflow_id, tool_policy
      ) values (
        ${sessionId}, ${accountId}, ${workspaceId}, 'timing', 'provider/model-a', 'high', 'standard',
        'modal', ${sessionId}, 'running', ${workflowId},
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
      )`);
    await tx.execute(sql`
      update sessions set active_turn_id = ${turnId}
      where workspace_id = ${workspaceId} and id = ${sessionId}`);
    await tx.execute(sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status,
        position, prompt, model, reasoning_effort, sandbox_backend, resources, tools, metadata,
        execution_generation, created_at, started_at
      ) values (
        ${turnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${crypto.randomUUID()}, ${workflowId},
        'running', 1, 'timing', 'provider/model-a', 'high', 'modal', '[]'::jsonb,
        '[]'::jsonb, '{}'::jsonb, 1, ${iso(fixture.turn.createdAt)}::timestamptz,
        ${fixture.turn.startedAt ? iso(fixture.turn.startedAt) : null}::timestamptz
      )`);
  });
  for (const attempt of fixture.attempts) {
    const attemptId = attemptIds.get(attempt.id)!;
    await withWorkspaceSessionActivityRls(appClient.db, workspaceId, async (tx) => {
      await tx.execute(sql`
        update session_turns set active_attempt_id = ${attemptId}
        where workspace_id = ${workspaceId} and id = ${turnId}`);
      await tx.execute(sql`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation, state,
          temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, mcp_approval_policies, started_at
        ) values (
          ${attemptId}, ${accountId}, ${workspaceId}, ${sessionId}, ${turnId}, 1, 'running',
          ${workflowId}, ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb,
          ${iso(attempt.startedAt)}::timestamptz
        )`);
    });
    await withWorkspaceSessionActivityRls(appClient.db, workspaceId, async (tx) => {
      await tx.execute(sql`
        update session_turn_attempts
        set state = 'closed', outcome = ${attempt.outcome},
          closed_at = ${attempt.closedAt ? iso(attempt.closedAt) : iso(fixture.turn.finishedAt)}::timestamptz
        where workspace_id = ${workspaceId} and id = ${attemptId}`);
    });
  }
  await withWorkspaceSessionActivityRls(appClient.db, workspaceId, async (tx) => {
    await tx.execute(sql`
      update session_turns
      set status = ${fixture.turn.status}, finished_at = ${iso(fixture.turn.finishedAt)}::timestamptz,
        active_attempt_id = null
      where workspace_id = ${workspaceId} and id = ${turnId}`);
    await tx.execute(sql`
      update sessions set active_turn_id = null, status = 'idle'
      where workspace_id = ${workspaceId} and id = ${sessionId}`);
    for (const event of fixture.events) {
      await tx.execute(sql`
        insert into session_events (
          account_id, workspace_id, session_id, turn_id, turn_generation, turn_attempt_id,
          turn_association, sequence, type, payload, occurred_at
        ) values (
          ${accountId}, ${workspaceId}, ${sessionId}, ${turnId}, 1,
          ${event.attemptId ? attemptIds.get(event.attemptId)! : null}, 'current', ${event.sequence},
          ${event.type}, ${JSON.stringify(withContent(event.type, event.payload))}::jsonb,
          ${iso(event.occurredAt)}::timestamptz
        )`);
    }
    // An event the profile does not read, so the type filter is exercised.
    await tx.execute(sql`
      insert into session_events (
        account_id, workspace_id, session_id, turn_id, turn_generation, turn_association,
        sequence, type, payload, occurred_at
      ) values (
        ${accountId}, ${workspaceId}, ${sessionId}, ${turnId}, 1, 'current', ${fixture.events.length + 1},
        'agent.message.delta', '{"delta":"hello"}'::jsonb, ${iso(fixture.turn.finishedAt)}::timestamptz
      )`);
  });
  if (options.archived) {
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        update sessions set content_archive_state = 'archiving', content_archive_started_at = now(),
          content_archive = '{}'::jsonb
        where workspace_id = ${workspaceId} and id = ${sessionId}`;
    });
  }
  // Shift the fixture so its timestamps line up with the seeded rows.
  const shifted: TurnTimingFixture = {
    ...fixture,
    turn: {
      ...fixture.turn,
      createdAt: iso(fixture.turn.createdAt),
      startedAt: fixture.turn.startedAt ? iso(fixture.turn.startedAt) : null,
      finishedAt: iso(fixture.turn.finishedAt),
    },
    attempts: fixture.attempts.map((attempt) => ({
      ...attempt,
      id: attemptIds.get(attempt.id)!,
      startedAt: iso(attempt.startedAt),
      closedAt: attempt.closedAt ? iso(attempt.closedAt) : null,
    })),
    events: fixture.events.map((event) => ({
      ...event,
      attemptId: event.attemptId ? attemptIds.get(event.attemptId)! : null,
      occurredAt: iso(event.occurredAt),
    })),
  };
  return {
    id: turnId,
    accountId,
    workspaceId,
    sessionId,
    status: fixture.turn.status,
    model: "provider/model-a",
    reasoningEffort: "high",
    latencyMode: "standard",
    surface: null,
    source: "user",
    createdAt: new Date(shifted.turn.createdAt),
    startedAt: shifted.turn.startedAt ? new Date(shifted.turn.startedAt) : null,
    finishedAt: new Date(shifted.turn.finishedAt),
    fixture: shifted,
  };
}

const WINDOW = { since: new Date("2026-01-01T00:00:00Z"), until: new Date("2027-01-01T00:00:00Z") };

describe("turn timing profiles in PostgreSQL", () => {
  test("the sweep profiles every finished turn once from the event log, without reading content", async () => {
    if (!shared || !appClient) return;
    const db = appClient.db;
    const workspace = await seedWorkspace("sweep");
    const turns: SeededTurn[] = [];
    for (const name of FIXTURES) turns.push(await seedTurn(workspace, name));
    const archived = await seedTurn(workspace, "messages-provider-no-server-timing", {
      archived: true,
      shiftMs: 60_000,
    });

    // The SQL projection returns exactly the TypeScript mirror's fields.
    const context = await rlsContextForWorkspace(db, workspace.workspaceId);
    const inputs = await withRlsContext(db, context, (scoped) =>
      loadTurnTimingInputs(scoped, workspace.workspaceId, turns),
    );
    for (const turn of turns) {
      const loaded = inputs.get(turn.id)!;
      const expected = fixtureInput(turn.fixture);
      expect(
        [...loaded.attempts].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
      ).toEqual(expected.attempts);
      expect([...loaded.events].sort((a, b) => a.sequence - b.sequence)).toEqual(
        expected.events.map((event) => ({
          ...event,
          payload: projectTurnTimingPayload(event.type, withContent(event.type, event.payload)),
        })),
      );
      expect(JSON.stringify(loaded.events)).not.toContain("content that must stay");
    }

    // Small pages, so the keyset cursor is crossed.
    const started = performance.now();
    const pass = await recordMissingTurnTimingProfiles(db, {
      workspaceId: workspace.workspaceId,
      ...WINDOW,
      pageSize: 2,
    });
    const elapsedMs = performance.now() - started;
    expect(pass.failed).toBe(0);
    expect(pass.turns).toBe(FIXTURES.length);
    expect(pass.inserted).toBe(FIXTURES.length);
    console.info(
      `turn timing sweep: ${(elapsedMs / pass.turns).toFixed(1)} ms per turn (load, compute, write)`,
    );

    const rows = await withRlsContext(db, context, (scoped) =>
      rawRows<Record<string, unknown>>(
        scoped,
        sql`select * from turn_timing_profiles where workspace_id = ${workspace.workspaceId}::uuid`,
      ),
    );
    expect(rows.map((row) => String(row.turn_id)).sort()).toEqual(
      turns.map((turn) => turn.id).sort(),
    );
    expect(rows.some((row) => String(row.turn_id) === archived.id)).toBe(false);
    for (const turn of turns) {
      const row = rows.find((candidate) => String(candidate.turn_id) === turn.id)!;
      const profile = computeTurnTimingProfile(fixtureInput(turn.fixture));
      expect(Number(row.wall_ms)).toBe(profile.wallMs);
      for (const [category, ms] of Object.entries(profile.segments)) {
        expect(Number(row[`${category}_ms`])).toBe(ms);
      }
      expect(row.session_id).toBe(turn.sessionId);
      expect(row.model).toBe("provider/model-a");
      expect(row.reasoning_effort).toBe("high");
      expect(row.status).toBe("completed");
      expect(Number(row.tool_calls)).toBe(profile.toolCalls);
      expect(row.steps).toEqual(JSON.parse(JSON.stringify(profile.steps)));
    }

    // Per-call MCP identity is queryable straight from the steps.
    const mcpCalls = await withRlsContext(db, context, (scoped) =>
      rawRows<{
        session_id: string;
        turn_id: string;
        call_id: string;
        tool: string;
        outcome: string;
        ms: number;
      }>(
        scoped,
        sql`select p.session_id, p.turn_id, step->>'callId' as call_id, step->>'name' as tool,
              step->>'outcome' as outcome, (step->>'ms')::bigint as ms, step->>'start' as started,
              step->>'end' as ended
            from turn_timing_profiles p, jsonb_array_elements(p.steps) step
            where p.workspace_id = ${workspace.workspaceId}::uuid and step->>'category' = 'mcp_tool'`,
      ),
    );
    expect(mcpCalls.length).toBeGreaterThanOrEqual(40);
    for (const call of mcpCalls) {
      expect(call.call_id).toBeTruthy();
      expect(call.tool).toContain("__");
      expect(call.outcome).toBeTruthy();
    }

    // A second pass finds nothing; recomputing a turn replaces its row.
    const again = await recordMissingTurnTimingProfiles(db, {
      workspaceId: workspace.workspaceId,
      ...WINDOW,
    });
    expect(again).toEqual({ turns: 0, inserted: 0, updated: 0, failed: 0 });
    const recomputed = await withRlsContext(db, context, (scoped) =>
      recordTurnTimingProfile(scoped, workspace.workspaceId, turns[0]!),
    );
    expect(recomputed.inserted).toBe(false);
    expect(recomputed.profile.wallMs).toBe(908_879);

    // Another workspace cannot see the profiles.
    const other = await seedWorkspace("other");
    const otherContext = await rlsContextForWorkspace(db, other.workspaceId);
    const leaked = await withRlsContext(db, otherContext, (scoped) =>
      rawRows(scoped, sql`select turn_id from turn_timing_profiles`),
    );
    expect(leaked).toEqual([]);

    // Deleting a chat deletes its turns' profiles.
    await shared.admin`delete from sessions where id = ${turns[2]!.sessionId}`;
    const remaining = await shared.admin<{ count: string }[]>`
      select count(*)::text as count from turn_timing_profiles where workspace_id = ${workspace.workspaceId}`;
    expect(remaining[0]!.count).toBe(String(FIXTURES.length - 1));
  }, 120_000);

  test("the window bounds the sweep and a wide window backfills older turns", async () => {
    if (!shared || !appClient) return;
    const db = appClient.db;
    const workspace = await seedWorkspace("window");
    const inside = await seedTurn(workspace, "messages-provider-no-server-timing");
    const outside = await seedTurn(workspace, "messages-provider-no-server-timing", {
      shiftMs: -30 * 24 * 60 * 60 * 1000,
    });
    const recorded: string[] = [];
    const pass = await recordMissingTurnTimingProfiles(db, {
      workspaceId: workspace.workspaceId,
      since: new Date(inside.finishedAt.getTime() - 1),
      until: new Date(inside.finishedAt.getTime() + 1),
      onRecorded: (entry) => recorded.push(entry.turn.id),
    });
    expect(pass).toEqual({ turns: 1, inserted: 1, updated: 0, failed: 0 });
    expect(recorded).toEqual([inside.id]);

    // The backfill's wide window picks up the older turn.
    const backfill = await recordMissingTurnTimingProfiles(db, {
      workspaceId: workspace.workspaceId,
      ...WINDOW,
    });
    expect(backfill).toEqual({ turns: 1, inserted: 1, updated: 0, failed: 0 });
    expect(outside.finishedAt < inside.finishedAt).toBe(true);
  }, 120_000);
});
