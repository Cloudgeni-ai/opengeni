import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  buildChildCompletionDigest,
  cancelQueuedSessionTurns,
  createSession,
  enqueueSessionTurn,
  finishTurn,
  listPendingSessionTurns,
  recordContextCompactionRecoveryProgress,
  setSessionChildNotificationsMode,
  updateSessionTitle,
  wakeParentSessionForChildCompletion,
  createDb,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function makeParent(accountId: string, workspaceId: string) {
  return await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "manager",
    resources: [],
    metadata: {},
    model: "gpt",
    sandboxBackend: "none",
  });
}

// Read an event's payload straight off the raw admin connection. Verification
// reads MUST bypass the @opengeni/db package API: in the full-monorepo test run
// another suite's unconditional `mock.module("@opengeni/db")` can leak a fixture
// for getSessionEvent/listSessionEvents (opengeni#373), which would make these
// assertions read empty payloads even though the fold wrote real rows.
async function eventPayloadById(eventId: string): Promise<{ text?: string } | null> {
  const [row] = await admin<{ payload: { text?: string } }[]>`
    select payload from session_events where id = ${eventId}`;
  return row?.payload ?? null;
}

function wakeInput(workspaceId: string, parentSessionId: string, childId: string) {
  return {
    workspaceId,
    parentSessionId,
    clientEventId: `child-completion:${childId}:1`,
    childSummary: `A worker session you spawned has FAILED. Worker session id: ${childId}.`,
    trailing: "Read each worker's output, then continue.",
    childCompletion: { childSessionId: childId, status: "failed" as const },
    reasoningEffortFallback: "medium" as const,
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("child-completion-digest");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[child-completion-digest] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
});

describe("buildChildCompletionDigest (pure)", () => {
  test("one child reads as a plain wake with no numbering", () => {
    expect(buildChildCompletionDigest(["worker A summary"], "do X")).toBe(
      "worker A summary\n\ndo X",
    );
  });
  test("N children collapse into ONE numbered digest with one trailing", () => {
    const digest = buildChildCompletionDigest(["A", "B", "C"], "do X");
    expect(digest).toContain("3 worker sessions you spawned reached a terminal state:");
    expect(digest).toContain("1. A");
    expect(digest).toContain("2. B");
    expect(digest).toContain("3. C");
    // Exactly one trailing instruction, at the end.
    expect(digest.endsWith("do X")).toBe(true);
    expect(digest.split("do X").length - 1).toBe(1);
  });
});

describe("wakeParentSessionForChildCompletion coalescing", () => {
  test("three terminating workers fold into ONE queued turn (N model runs -> 1)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const parent = await makeParent(accountId, workspaceId);

    const r1 = await wakeParentSessionForChildCompletion(
      db,
      wakeInput(workspaceId, parent.id, "child-1"),
    );
    const r2 = await wakeParentSessionForChildCompletion(
      db,
      wakeInput(workspaceId, parent.id, "child-2"),
    );
    const r3 = await wakeParentSessionForChildCompletion(
      db,
      wakeInput(workspaceId, parent.id, "child-3"),
    );

    expect(r1.delivered).toBe(true);
    expect(r2.delivered).toBe(true);
    expect(r3.delivered).toBe(true);
    if (r1.delivered && !r1.passive && r2.delivered && !r2.passive && r3.delivered && !r3.passive) {
      expect(r1.folded).toBe(false); // opened the digest
      expect(r2.folded).toBe(true); // folded in
      expect(r3.folded).toBe(true);
      // All three point at the SAME turn.
      expect(r2.turn.id).toBe(r1.turn.id);
      expect(r3.turn.id).toBe(r1.turn.id);
    }

    // Exactly ONE queued turn exists for the parent, and its trigger text is the
    // full 3-child digest.
    const pending = await listPendingSessionTurns(db, workspaceId, parent.id);
    expect(pending.length).toBe(1);
    const digestTurn = pending[0]!;
    const text = (await eventPayloadById(digestTurn.triggerEventId))?.text ?? "";
    expect(text).toContain("3 worker sessions you spawned reached a terminal state:");
    expect(text).toContain("child-1");
    expect(text).toContain("child-2");
    expect(text).toContain("child-3");
  });

  test("idempotent per child: a re-delivered terminal episode does not double-fold", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const parent = await makeParent(accountId, workspaceId);

    await wakeParentSessionForChildCompletion(db, wakeInput(workspaceId, parent.id, "child-1"));
    const dup = await wakeParentSessionForChildCompletion(
      db,
      wakeInput(workspaceId, parent.id, "child-1"),
    );
    expect(dup.delivered).toBe(false);
    if (!dup.delivered) {
      expect(dup.reason).toBe("already_delivered");
    }
    const pending = await listPendingSessionTurns(db, workspaceId, parent.id);
    expect(pending.length).toBe(1);
    const text = (await eventPayloadById(pending[0]!.triggerEventId))?.text ?? "";
    // Single child => plain wake, no "N worker sessions" digest header.
    expect(text).not.toContain("worker sessions you spawned reached");
  });

  test("once the digest turn is claimed, the next child opens a fresh turn", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const parent = await makeParent(accountId, workspaceId);

    const first = await wakeParentSessionForChildCompletion(
      db,
      wakeInput(workspaceId, parent.id, "child-1"),
    );
    expect(first.delivered).toBe(true);
    if (!first.delivered || first.passive) return;
    // Simulate the workflow claiming the digest turn (queued -> running).
    await admin`update session_turns set status = 'running' where id = ${first.turn.id}`;

    const next = await wakeParentSessionForChildCompletion(
      db,
      wakeInput(workspaceId, parent.id, "child-2"),
    );
    expect(next.delivered).toBe(true);
    if (next.delivered && !next.passive) {
      expect(next.folded).toBe(false); // could not fold into a running turn
      expect(next.turn.id).not.toBe(first.turn.id);
    }
    // One running (claimed) + one fresh queued.
    const pending = await listPendingSessionTurns(db, workspaceId, parent.id);
    const queued = pending.filter((t) => t.status === "queued");
    expect(queued.length).toBe(1);
  });
});

describe("cancelQueuedSessionTurns (stop-drains-the-queue)", () => {
  test("cancels every queued turn and returns their ids; leaves the running turn", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const session = await makeParent(accountId, workspaceId);
    const base = {
      accountId,
      workspaceId,
      sessionId: session.id,
      temporalWorkflowId: `session-${session.id}`,
      source: "user" as const,
      resources: [],
      tools: [],
      model: "gpt",
      reasoningEffort: "medium" as const,
      sandboxBackend: "none" as const,
      metadata: {},
    };
    const running = await enqueueSessionTurn(db, {
      ...base,
      triggerEventId: crypto.randomUUID(),
      prompt: "running",
    });
    await admin`update session_turns set status = 'running' where id = ${running.id}`;
    const q1 = await enqueueSessionTurn(db, {
      ...base,
      triggerEventId: crypto.randomUUID(),
      prompt: "q1",
    });
    const q2 = await enqueueSessionTurn(db, {
      ...base,
      triggerEventId: crypto.randomUUID(),
      prompt: "q2",
    });

    const drained = await cancelQueuedSessionTurns(db, workspaceId, session.id);
    expect(drained.sort()).toEqual([q1.id, q2.id].sort());

    const pending = await listPendingSessionTurns(db, workspaceId, session.id);
    // Only the running turn remains non-terminal; both queued turns are gone.
    expect(pending.map((t) => t.id)).toEqual([running.id]);

    // Idempotent: a second drain finds nothing.
    const again = await cancelQueuedSessionTurns(db, workspaceId, session.id);
    expect(again).toEqual([]);

    // Finishing the running turn as cancelled is unaffected by the drain.
    await finishTurn(db, workspaceId, running.id, "cancelled");
    const afterFinish = await listPendingSessionTurns(db, workspaceId, session.id);
    expect(afterFinish.length).toBe(0);
  });
});

describe("context compaction recovery progress", () => {
  test("continues only while post-compaction tokens strictly shrink across dispatches", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const session = await makeParent(accountId, workspaceId);
    const turn = await enqueueSessionTurn(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "long task",
      resources: [],
      tools: [],
      model: "gpt",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: { unrelated: "preserved" },
    });

    expect(await recordContextCompactionRecoveryProgress(db, workspaceId, turn.id, 23_091)).toBe(
      true,
    );
    expect(await recordContextCompactionRecoveryProgress(db, workspaceId, turn.id, 23_178)).toBe(
      false,
    );
    expect(await recordContextCompactionRecoveryProgress(db, workspaceId, turn.id, 23_091)).toBe(
      false,
    );
    expect(await recordContextCompactionRecoveryProgress(db, workspaceId, turn.id, 22_000)).toBe(
      true,
    );

    const [stored] = await admin<
      Array<{ metadata: { unrelated?: string; contextCompactionRecoveryAfterTokens?: number } }>
    >`select metadata from session_turns where id = ${turn.id}`;
    expect(stored?.metadata).toEqual({
      unrelated: "preserved",
      contextCompactionRecoveryAfterTokens: 22_000,
    });
  });
});

describe("human messages preempt machine notifications (lever 5)", () => {
  function humanTurn(accountId: string, workspaceId: string, sessionId: string, preempt: boolean) {
    return enqueueSessionTurn(db, {
      accountId,
      workspaceId,
      sessionId,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${sessionId}`,
      source: "user" as const,
      prompt: "human message",
      resources: [],
      tools: [],
      model: "gpt",
      reasoningEffort: "medium" as const,
      sandboxBackend: "none" as const,
      metadata: {},
      preemptChildNotifications: preempt,
    });
  }

  test("a human turn jumps AHEAD of queued child-completion turns", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const parent = await makeParent(accountId, workspaceId);
    // Two machine notifications sit in the queue (folded into one digest turn).
    await wakeParentSessionForChildCompletion(db, wakeInput(workspaceId, parent.id, "child-1"));
    await wakeParentSessionForChildCompletion(db, wakeInput(workspaceId, parent.id, "child-2"));

    const human = await humanTurn(accountId, workspaceId, parent.id, true);

    // Ordered by claim position: the human turn is first, the machine digest after.
    const pending = await listPendingSessionTurns(db, workspaceId, parent.id);
    expect(pending[0]!.id).toBe(human.id);
    expect(pending[0]!.metadata).not.toHaveProperty("childCompletion");
    expect(pending[pending.length - 1]!.metadata).toHaveProperty("childCompletion");
  });

  test("without the flag, a human turn appends to the back (unchanged default)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const parent = await makeParent(accountId, workspaceId);
    await wakeParentSessionForChildCompletion(db, wakeInput(workspaceId, parent.id, "child-1"));

    const human = await humanTurn(accountId, workspaceId, parent.id, false);
    const pending = await listPendingSessionTurns(db, workspaceId, parent.id);
    // Machine turn was queued first, so it stays ahead of a non-preempting turn.
    expect(pending[pending.length - 1]!.id).toBe(human.id);
  });
});

describe("child-completion suppression opt-in (lever 6)", () => {
  test("persistent session settings are idempotent and preserve a human title", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const parent = await makeParent(accountId, workspaceId);

    expect(await setSessionChildNotificationsMode(db, workspaceId, parent.id, "passive")).toBe(
      true,
    );
    expect(await setSessionChildNotificationsMode(db, workspaceId, parent.id, "passive")).toBe(
      false,
    );

    expect(
      await updateSessionTitle(db, {
        workspaceId,
        sessionId: parent.id,
        title: "OpenGeni Main Orchestrator",
        source: "agent",
      }),
    ).toEqual({ updated: true, title: "OpenGeni Main Orchestrator" });
    expect(
      await updateSessionTitle(db, {
        workspaceId,
        sessionId: parent.id,
        title: "OpenGeni Main Orchestrator",
        source: "agent",
      }),
    ).toEqual({ updated: false, title: "OpenGeni Main Orchestrator" });

    expect(
      await updateSessionTitle(db, {
        workspaceId,
        sessionId: parent.id,
        title: "Human title",
        source: "user",
      }),
    ).toEqual({ updated: true, title: "Human title" });
    expect(
      await updateSessionTitle(db, {
        workspaceId,
        sessionId: parent.id,
        title: "Agent overwrite",
        source: "agent",
      }),
    ).toEqual({ updated: false, title: "Human title" });
  });

  test("passive mode lands a card event with NO queued turn and no wake", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const parent = await makeParent(accountId, workspaceId);
    await setSessionChildNotificationsMode(db, workspaceId, parent.id, "passive");

    const result = await wakeParentSessionForChildCompletion(
      db,
      wakeInput(workspaceId, parent.id, "child-1"),
    );
    expect(result.delivered).toBe(true);
    if (result.delivered) {
      expect(result.passive).toBe(true);
    }
    // No queued turn = no model run.
    const pending = await listPendingSessionTurns(db, workspaceId, parent.id);
    expect(pending.length).toBe(0);
    // The completion is still visible as a card event in the timeline (read via
    // the raw admin connection so a leaked db mock cannot mask it).
    const cards = await admin<{ id: string }[]>`
      select id from session_events
      where session_id = ${parent.id}
        and type = 'user.message'
        and payload ? 'childCompletion'`;
    expect(cards.length).toBe(1);
  });

  test("passive mode stays idempotent per child episode", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const parent = await makeParent(accountId, workspaceId);
    await setSessionChildNotificationsMode(db, workspaceId, parent.id, "passive");
    await wakeParentSessionForChildCompletion(db, wakeInput(workspaceId, parent.id, "child-1"));
    const dup = await wakeParentSessionForChildCompletion(
      db,
      wakeInput(workspaceId, parent.id, "child-1"),
    );
    expect(dup.delivered).toBe(false);
  });

  test("digest remains the default when no mode is set", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const parent = await makeParent(accountId, workspaceId);
    const result = await wakeParentSessionForChildCompletion(
      db,
      wakeInput(workspaceId, parent.id, "child-1"),
    );
    expect(result.delivered).toBe(true);
    if (result.delivered) {
      expect(result.passive).toBe(false);
    }
    const pending = await listPendingSessionTurns(db, workspaceId, parent.id);
    expect(pending.length).toBe(1);
  });
});
