import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  appendTurnCapabilityCardOnce,
  createDb,
  withWorkspaceSessionActivityRls,
  type Database,
} from "../src/index";

// The Connected Machine card posted on a permission refusal is reused within a
// turn, atomically, so parallel refusals cannot stack copies. No other card is
// limited: a different capability in the same turn and the same capability in
// a later turn each get their own card.

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("turn-capability-card-once");
  if (!shared) {
    available = false;
    console.warn("[turn-capability-card-once] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl, { max: 10 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

type Turn = { turnId: string; attemptId: string };

async function seedSession() {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('capability card once') returning id
  `;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'capability card once')
    returning id
  `;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})
  `;
  const accountId = account!.id;
  const workspaceId = workspace!.id;
  const sessionId = crypto.randomUUID();
  const workflowId = `session-${sessionId}`;
  await withWorkspaceSessionActivityRls(db, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into sessions (
        id, account_id, workspace_id, initial_message, model,
        reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, status,
        temporal_workflow_id, tool_policy
      ) values (
        ${sessionId}, ${accountId}, ${workspaceId}, 'capability card once',
        'codex/gpt-5.6-sol', 'medium', 'standard', 'modal', ${sessionId}, 'running',
        ${workflowId}, jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
      )
    `);
  });
  let position = 0;
  const startTurn = async (): Promise<Turn> => {
    const turnId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const triggerEventId = crypto.randomUUID();
    position += 1;
    const metadata = {
      dispatchGeneration: 1,
      dispatchAttempt: { id: `activity-${attemptId}`, generation: 1, triggerEventId },
    };
    await withWorkspaceSessionActivityRls(db, workspaceId, async (tx) => {
      await tx.execute(sql`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`);
      await tx.execute(sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model,
          reasoning_effort, sandbox_backend, resources, tools, metadata,
          execution_generation, active_attempt_id
        ) values (
          ${turnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${triggerEventId},
          ${workflowId}, 'running', ${position}, 'capability card once', 'codex/gpt-5.6-sol',
          'medium', 'modal', '[]'::jsonb, '[]'::jsonb, ${JSON.stringify(metadata)}::jsonb,
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
    return { turnId, attemptId };
  };
  const card = (turn: Turn, capabilityId: string) =>
    appendTurnCapabilityCardOnce(
      db,
      workspaceId,
      sessionId,
      turn.turnId,
      1,
      turn.attemptId,
      capabilityId,
      {
        type: "tool.auth_needed",
        payload: {
          serverId: "opengeni",
          toolName: "run_on",
          providerDomain: "opengeni.local",
          reason: "missing_connection",
          capability: { id: capabilityId, name: capabilityId, action: "connect" },
        },
      },
    );
  const cards = async (turnId: string) =>
    (
      await shared!.admin<{ id: string; capabilityId: string }[]>`
      select id, payload -> 'capability' ->> 'id' as "capabilityId"
      from session_events
      where session_id = ${sessionId} and turn_id = ${turnId} and type = 'tool.auth_needed'
      order by sequence
    `
    ).map((row) => ({ id: row.id, capabilityId: row.capabilityId }));
  const endTurn = async (turn: Turn) =>
    await shared!.admin.begin(async (tx) => {
      await tx`
        update session_turn_attempts
        set state = 'closed', outcome = 'completed', closed_at = now()
        where id = ${turn.attemptId}
      `;
      await tx`
        update session_turns set status = 'completed', active_attempt_id = null
        where id = ${turn.turnId}
      `;
    });
  return { startTurn, endTurn, card, cards };
}

describe("appendTurnCapabilityCardOnce", () => {
  test("parallel machine refusals in one turn post exactly one card", async () => {
    if (!available) return;
    const chat = await seedSession();
    const turn = await chat.startTurn();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => chat.card(turn, "api:connected-machine")),
    );
    const posted = await chat.cards(turn.turnId);
    expect(posted).toHaveLength(1);
    expect(results.every((result) => result.accepted)).toBe(true);
    expect(results.filter((result) => result.events.length === 1)).toHaveLength(1);
    for (const result of results) {
      expect(result.existingEventId ?? result.events[0]?.id).toBe(posted[0]!.id);
    }
  });

  test("other cards are never limited, before or after the machine card", async () => {
    if (!available) return;
    const chat = await seedSession();
    const turn = await chat.startTurn();
    await chat.card(turn, "mcp:slack");
    await chat.card(turn, "api:github-app");
    const machine = await chat.card(turn, "api:connected-machine");
    expect(machine.existingEventId).toBeNull();
    expect(machine.events).toHaveLength(1);
    // Many unrelated cards later, a repeat machine refusal still finds the card.
    for (let index = 0; index < 55; index += 1) {
      await chat.card(turn, `mcp:other-${index}`);
    }
    const repeat = await chat.card(turn, "api:connected-machine");
    expect(repeat.existingEventId).toBe(machine.events[0]!.id);
    const posted = await chat.cards(turn.turnId);
    expect(posted.map((row) => row.capabilityId).slice(0, 3)).toEqual([
      "mcp:slack",
      "api:github-app",
      "api:connected-machine",
    ]);
    expect(posted.filter((row) => row.capabilityId === "api:connected-machine")).toHaveLength(1);
    expect(posted).toHaveLength(58);
  });

  test("a later turn gets its own machine card", async () => {
    if (!available) return;
    const chat = await seedSession();
    const first = await chat.startTurn();
    const firstCard = await chat.card(first, "api:connected-machine");
    // The first turn ends and the next becomes the session's active turn.
    await chat.endTurn(first);
    const second = await chat.startTurn();
    const secondCard = await chat.card(second, "api:connected-machine");
    expect(secondCard.existingEventId).toBeNull();
    expect(secondCard.events).toHaveLength(1);
    expect(secondCard.events[0]!.id).not.toBe(firstCard.events[0]!.id);
  });
});
