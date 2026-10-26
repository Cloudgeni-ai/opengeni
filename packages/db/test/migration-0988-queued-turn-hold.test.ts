import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  countQueuedTurns,
  createDb,
  createSession,
  enqueueSessionTurn,
  initializeSessionStartAtomically,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  QUEUED_TURN_HOLDS,
  summarizeQueuedTurnsByHold,
  withWorkspaceSessionActivityRls as withWorkspaceRls,
  type QueuedTurnHold,
} from "../src/index";

// The summary is a global, cross-workspace aggregate. This file owns its
// database, so every assertion below is an exact absolute count.
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0988-queued-turn-hold");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A workspace with a root session and a child, each holding one queued initial turn. */
async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Queued turn holds",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Queued turn holds",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const sessionInput = {
    accountId: grant.accountId,
    workspaceId,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
  const root = await createSession(client.db, { ...sessionInput, initialMessage: "root" });
  const child = await createSession(client.db, {
    ...sessionInput,
    parentSessionId: root.id,
    initialMessage: "child",
  });
  for (const sessionId of [root.id, child.id]) {
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
  }
  return { grant, workspaceId, root, child };
}

async function sessionControl(value: Fixture, sessionId: string, action: "pause" | "resume") {
  return await withWorkspaceRls(client.db, value.workspaceId, (db) =>
    mutateSessionControlInTransaction(db, {
      accountId: value.grant.accountId,
      workspaceId: value.workspaceId,
      sessionId,
      actor: { type: "human", subjectId: value.grant.subjectId },
      operationKey: crypto.randomUUID(),
      action,
    }),
  );
}

async function workspaceControl(value: Fixture, action: "pause" | "resume") {
  return await withWorkspaceRls(client.db, value.workspaceId, (db) =>
    mutateWorkspaceControlInTransaction(db, {
      accountId: value.grant.accountId,
      workspaceId: value.workspaceId,
      actor: { type: "human", subjectId: value.grant.subjectId },
      operationKey: crypto.randomUUID(),
      action,
    }),
  );
}

/** Project a session's public status directly; the classifier reads only durable state. */
async function setSessionStatus(value: Fixture, sessionId: string, status: string) {
  await shared.admin`
    update sessions set status = ${status}
    where workspace_id = ${value.workspaceId} and id = ${sessionId}`;
}

async function counts(): Promise<Record<QueuedTurnHold, number>> {
  const summary = await summarizeQueuedTurnsByHold(client.db);
  if (!summary) throw new Error("queued-turn hold summary is not granted");
  return Object.fromEntries(QUEUED_TURN_HOLDS.map((hold) => [hold, summary[hold].count])) as Record<
    QueuedTurnHold,
    number
  >;
}

function expected(
  partial: Partial<Record<QueuedTurnHold, number>>,
): Record<QueuedTurnHold, number> {
  return Object.fromEntries(QUEUED_TURN_HOLDS.map((hold) => [hold, partial[hold] ?? 0])) as Record<
    QueuedTurnHold,
    number
  >;
}

describe("queued turns classified by what holds them (migration 0988)", () => {
  test("separates dispatchable prompts from prompts held by session state", async () => {
    // 0988 withholds the runtime grant for one release; until a later
    // migration grants it the worker sees no summary rather than an error.
    expect(await summarizeQueuedTurnsByHold(client.db)).toBeNull();
    await grantDeferredRuntimeAccess(shared.admin);
    expect(await counts()).toEqual(expected({}));

    // Fresh initial turns are waiting only for dispatch.
    const ready = await fixture();
    expect(await counts()).toEqual(expected({ ready: 2 }));
    const summary = await summarizeQueuedTurnsByHold(client.db);
    expect(summary?.ready.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(summary?.paused.oldestAgeSeconds).toBe(0);

    // A direct Pause holds only that session's prompt.
    const direct = await fixture();
    await sessionControl(direct, direct.child.id, "pause");
    expect(await counts()).toEqual(expected({ ready: 3, paused: 1 }));

    // An ancestor Pause also holds the child's prompt.
    const ancestor = await fixture();
    await sessionControl(ancestor, ancestor.root.id, "pause");
    expect(await counts()).toEqual(expected({ ready: 3, paused: 3 }));

    // A selected child Resume defeats the older ancestor pause.
    await sessionControl(ancestor, ancestor.child.id, "resume");
    expect(await counts()).toEqual(expected({ ready: 4, paused: 2 }));

    // A workspace Pause holds every session in it.
    const workspace = await fixture();
    await workspaceControl(workspace, "pause");
    expect(await counts()).toEqual(expected({ ready: 4, paused: 4 }));
    await workspaceControl(workspace, "resume");
    expect(await counts()).toEqual(expected({ ready: 6, paused: 2 }));

    // Session lifecycle states hold their queue until a message, a person or capacity.
    const lifecycle = await fixture();
    await setSessionStatus(lifecycle, lifecycle.root.id, "failed");
    await setSessionStatus(lifecycle, lifecycle.child.id, "requires_action");
    const capacity = await fixture();
    await setSessionStatus(capacity, capacity.root.id, "waiting_capacity");
    await setSessionStatus(capacity, capacity.child.id, "cancelled");
    expect(await counts()).toEqual(
      expected({
        ready: 6,
        paused: 2,
        failed: 1,
        requires_action: 1,
        waiting_capacity: 1,
        cancelled: 1,
      }),
    );

    // Pause takes precedence over the session's own lifecycle status, and the
    // root Pause also covers its requires_action child.
    await sessionControl(lifecycle, lifecycle.root.id, "pause");
    expect(await counts()).toEqual(
      expected({ ready: 6, paused: 4, waiting_capacity: 1, cancelled: 1 }),
    );

    // A session whose turn is running holds the rest of its queue.
    await setSessionStatus(ready, ready.root.id, "running");
    expect((await counts()).behind_active_turn).toBe(1);

    // The classes always sum to the legacy total.
    const all = await counts();
    const total = Object.values(all).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(await countQueuedTurns(client.db));

    // Claiming the only queued turn removes it from every class.
    const claimed = await claimSessionWorkForAttempt(client.db, ready.workspaceId, {
      sessionId: ready.child.id,
      workflowId: `session-${ready.child.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    expect((await counts()).ready).toBe(all.ready - 1);
  }, 180_000);

  test("keeps the canonical override depth rules and finds prompts behind a claimed turn", async () => {
    await grantDeferredRuntimeAccess(shared.admin);
    const delta = async (before: Record<QueuedTurnHold, number>) => {
      const after = await counts();
      return Object.fromEntries(
        QUEUED_TURN_HOLDS.map((hold) => [hold, after[hold] - before[hold]]),
      ) as Record<QueuedTurnHold, number>;
    };

    // An ancestor Resume issued after a descendant Pause is not descendant-side,
    // so the child's own Pause still holds its prompt.
    let before = await counts();
    const ancestorResume = await fixture();
    await sessionControl(ancestorResume, ancestorResume.child.id, "pause");
    await sessionControl(ancestorResume, ancestorResume.root.id, "pause");
    await sessionControl(ancestorResume, ancestorResume.root.id, "resume");
    expect(await delta(before)).toEqual(expected({ ready: 1, paused: 1 }));

    // A newer session Resume overrides an active workspace Pause for that
    // session's subtree only.
    before = await counts();
    const sessionResume = await fixture();
    await workspaceControl(sessionResume, "pause");
    expect(await delta(before)).toEqual(expected({ paused: 2 }));
    await sessionControl(sessionResume, sessionResume.child.id, "resume");
    expect(await delta(before)).toEqual(expected({ ready: 1, paused: 1 }));
    await workspaceControl(sessionResume, "resume");

    // A real claim makes the initial turn active; a later prompt waits behind it.
    before = await counts();
    const active = await fixture();
    const claimed = await claimSessionWorkForAttempt(client.db, active.workspaceId, {
      sessionId: active.root.id,
      workflowId: `session-${active.root.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    await enqueueSessionTurn(client.db, {
      accountId: active.grant.accountId,
      workspaceId: active.workspaceId,
      sessionId: active.root.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${active.root.id}`,
      source: "api",
      prompt: "follow-up",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "service", subjectId: "host" },
    });
    expect(await delta(before)).toEqual(expected({ ready: 1, behind_active_turn: 1 }));
  }, 180_000);

  test("classifies a large backlog without rescanning pauses per queued turn", async () => {
    // The first form evaluated the pause check per queued turn and per
    // candidate session, so 500 sessions already took tens of seconds. Clone
    // one idle session with its queued prompt into thousands of sessions, a
    // third of them directly paused, and require the summary to stay fast.
    await grantDeferredRuntimeAccess(shared.admin);
    const template = await fixture();
    const before = await counts();
    const clones = 3_000;
    await shared.admin.begin(async (tx) => {
      // Bulk fixture only: skip row triggers and FK triggers for the clones.
      // LATERAL evaluates each record once; `(f()).*` would call it per column.
      await tx`set local session_replication_role = replica`;
      await tx`
        with source as (
          select to_jsonb(s) as row from sessions s
          where s.workspace_id = ${template.workspaceId} and s.id = ${template.root.id}
        ), clone as (
          select gen_random_uuid() as id, n from generate_series(1, ${clones}::integer) n
        ), inserted as (
          insert into sessions
          select cloned.*
          from source, clone, lateral jsonb_populate_record(null::sessions, source.row || jsonb_build_object(
            'id', clone.id,
            'create_idempotency_key', null,
            'parent_session_id', null,
            'control_version', greatest((source.row->>'control_version')::bigint, 1),
            'direct_control_state',
              case when clone.n % 3 = 0 then 'paused' else source.row->>'direct_control_state' end,
            'direct_pause_revision',
              case when clone.n % 3 = 0 then to_jsonb(1) else source.row->'direct_pause_revision' end
          )) cloned
          returning id
        )
        insert into session_turns
        select cloned.*
        from inserted, session_turns turn,
          lateral jsonb_populate_record(null::session_turns, to_jsonb(turn) || jsonb_build_object(
            'id', gen_random_uuid(),
            'session_id', inserted.id
          )) cloned
        where turn.workspace_id = ${template.workspaceId}
          and turn.session_id = ${template.root.id}
          and turn.status = 'queued'
      `;
    });
    const started = performance.now();
    const after = await counts();
    const elapsedMs = performance.now() - started;
    expect(after.ready - before.ready).toBe(clones - clones / 3);
    expect(after.paused - before.paused).toBe(clones / 3);
    expect(Object.values(after).reduce((sum, value) => sum + value, 0)).toBe(
      await countQueuedTurns(client.db),
    );
    // Generous for loaded CI hosts; the per-turn form needs minutes here.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 180_000);

  test("keeps the least-privilege content-free function contract", async () => {
    const [definition] = await shared.admin<
      { security_definer: boolean; config: string[] | null; public_execute: boolean }[]
    >`
      select p.prosecdef as security_definer,
             p.proconfig as config,
             has_function_privilege('public', p.oid, 'EXECUTE') as public_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'opengeni_private' and p.proname = 'summarize_queued_turns_by_hold'
    `;
    expect(definition?.security_definer).toBe(true);
    expect(definition?.config?.some((setting) => setting.startsWith("search_path="))).toBe(true);
    expect(definition?.public_execute).toBe(false);
    const rows = await shared.admin<{ hold: string }[]>`
      select hold from opengeni_private.summarize_queued_turns_by_hold()
    `;
    expect(rows.map((row) => row.hold)).toEqual([...QUEUED_TURN_HOLDS].sort());
  }, 60_000);
});
