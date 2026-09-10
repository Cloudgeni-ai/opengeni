import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  createDb,
  getContextCompactionPendingSummary,
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

type AttemptFixture = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
};

let shared: SharedTestDatabase | null = null;
let appClient: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0391-context-compaction-pending");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("migration 0392 requires real PostgreSQL");
    }
    return;
  }
  appClient = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await appClient?.close();
  await shared?.release();
}, 180_000);

async function seedRunningAttempt(label: string): Promise<AttemptFixture> {
  if (!shared || !appClient) throw new Error("PostgreSQL fixture unavailable");
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const triggerEventId = crypto.randomUUID();
  const workflowId = `session-${sessionId}`;
  const metadata = {
    dispatchGeneration: 1,
    dispatchAttempt: {
      id: `activity-${attemptId}`,
      generation: 1,
      triggerEventId,
    },
  };

  await shared.admin`
    insert into managed_accounts (id, name)
    values (${accountId}, ${`context compaction pending ${label}`})`;
  await shared.admin`
    insert into workspaces (id, account_id, name)
    values (${workspaceId}, ${accountId}, ${`context compaction pending ${label}`})`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}, ${accountId})`;
  await withWorkspaceSessionActivityRls(appClient.db, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into sessions (
        id, account_id, workspace_id, initial_message, model,
        reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id,
        status, temporal_workflow_id, tool_policy
      ) values (
        ${sessionId}, ${accountId}, ${workspaceId}, ${`pending ${label}`},
        'codex/gpt-5.6-sol', 'medium', 'standard', 'modal', ${sessionId},
        'running', ${workflowId},
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
      )
    `);
    await tx.execute(sql`
      update sessions
      set active_turn_id = ${turnId}
      where workspace_id = ${workspaceId} and id = ${sessionId}
    `);
    await tx.execute(sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, resources, tools, metadata,
        execution_generation, active_attempt_id
      ) values (
        ${turnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${triggerEventId},
        ${workflowId}, 'running', 1, ${`pending ${label}`}, 'codex/gpt-5.6-sol',
        'xhigh', 'modal', '[]'::jsonb, '[]'::jsonb, ${JSON.stringify(metadata)}::jsonb,
        1, ${attemptId}
      )
    `);
    await tx.execute(sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id,
        execution_generation, state, temporal_workflow_id,
        temporal_workflow_run_id, temporal_activity_id, verified_control_revision,
        mcp_approval_policies
      ) values (
        ${attemptId}, ${accountId}, ${workspaceId}, ${sessionId}, ${turnId},
        1, 'running', ${workflowId}, ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0,
        '{}'::jsonb
      )
    `);
  });

  return { accountId, workspaceId, sessionId, turnId, attemptId };
}

async function appendCompactionEvent(
  fixture: AttemptFixture,
  sequence: number,
  type:
    | "session.context.compaction.started"
    | "session.context.compacted"
    | "session.context.compaction.skipped",
  occurredAt: Date,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!appClient) throw new Error("PostgreSQL fixture unavailable");
  await withWorkspaceSessionActivityRls(appClient.db, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into session_events (
        account_id, workspace_id, session_id, turn_id, turn_generation,
        turn_attempt_id, turn_association, sequence, type, payload, occurred_at
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.sessionId},
        ${fixture.turnId}, 1, ${fixture.attemptId}, 'current', ${sequence},
        ${type}, ${JSON.stringify(payload)}::jsonb, ${occurredAt.toISOString()}::timestamptz
      )
    `);
  });
}

async function summary() {
  if (!appClient) throw new Error("PostgreSQL fixture unavailable");
  return await getContextCompactionPendingSummary(appClient.db);
}

describe("migration 0392 durable context compaction projection", () => {
  test("one completion cannot erase another concurrent automatic start", async () => {
    if (!shared || !appClient) return;
    const first = await seedRunningAttempt("first overlap");
    const second = await seedRunningAttempt("second overlap");
    const firstStartedAt = new Date("2026-09-02T00:00:00.000Z");
    const secondStartedAt = new Date("2026-09-02T00:00:01.000Z");

    await appendCompactionEvent(first, 1, "session.context.compaction.started", firstStartedAt, {
      trigger: "auto",
    });
    await appendCompactionEvent(second, 1, "session.context.compaction.started", secondStartedAt, {
      trigger: "auto",
    });
    expect(await summary()).toEqual({ pendingCount: 2, oldestStartedAt: firstStartedAt });

    await appendCompactionEvent(first, 2, "session.context.compacted", new Date(), {
      trigger: "auto",
    });
    expect(await summary()).toEqual({ pendingCount: 1, oldestStartedAt: secondStartedAt });

    await appendCompactionEvent(second, 2, "session.context.compaction.skipped", new Date(), {
      reason: "replacement_not_smaller",
    });
    expect(await summary()).toEqual({ pendingCount: 0, oldestStartedAt: null });
  });

  test("pending state survives a reader restart and clears when the attempt closes", async () => {
    if (!shared || !appClient) return;
    const fixture = await seedRunningAttempt("restart");
    const startedAt = new Date("2026-09-02T00:30:00.000Z");
    await appendCompactionEvent(fixture, 1, "session.context.compaction.started", startedAt, {
      trigger: "auto",
    });
    expect(await summary()).toEqual({ pendingCount: 1, oldestStartedAt: startedAt });

    await appClient.close();
    appClient = createDb(shared.appUrl);
    expect(await summary()).toEqual({ pendingCount: 1, oldestStartedAt: startedAt });

    await withWorkspaceSessionActivityRls(appClient.db, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update session_turn_attempts
        set state = 'closed', outcome = 'failed', closed_at = now(), updated_at = now()
        where workspace_id = ${fixture.workspaceId} and id = ${fixture.attemptId}
      `);
    });
    expect(await summary()).toEqual({ pendingCount: 0, oldestStartedAt: null });
  });

  test("operator starts never enter the automatic pending projection", async () => {
    if (!shared || !appClient) return;
    const fixture = await seedRunningAttempt("operator");
    await appendCompactionEvent(fixture, 1, "session.context.compaction.started", new Date(), {
      trigger: "operator",
    });
    expect(await summary()).toEqual({ pendingCount: 0, oldestStartedAt: null });
  });
});
