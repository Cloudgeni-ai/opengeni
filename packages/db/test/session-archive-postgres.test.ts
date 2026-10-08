import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  SESSION_ARCHIVE_EXPORT_TABLES,
  SESSION_ARCHIVE_PURGE_TABLES,
  SessionArchivedError,
  abandonSessionArchive,
  applySessionTurnSettlement,
  beginSessionArchive,
  bootstrapWorkspace,
  claimSessionArchiveObjectDeletions,
  claimSessionWorkForAttempt,
  completeSessionArchive,
  completeSessionArchiveObjectDeletion,
  createDb,
  createSession,
  deleteSessionTreeIfQuiescent,
  getSession,
  listSessionArchiveCandidates,
  persistModelContextSnapshot,
  purgeArchivedSessionContent,
  readSessionArchiveRows,
  readSessionArchiveTranscriptEvents,
  setSessionKeepLive,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
  type SessionArchiveManifest,
  type SessionArchiveScope,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const IDLE_SECONDS = 30 * 24 * 60 * 60;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-archive");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function send(scope: SessionArchiveScope, subjectId: string, text: string) {
  return withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        ...scope,
        subjectId,
        actor: { type: "human", subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text,
        resources: [],
        source: "user",
        reasoningEffortFallback: "medium",
      }),
    ),
  );
}

/** A session with one settled turn, purgeable content, and timestamps backdated past the idle period. */
async function idleSession(options: { backdateDays?: number } = {}) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Session archive",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Session archive",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
  };
  await send(scope, grant.subjectId, "Summarize the plan");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("turn was not claimed");
  await persistModelContextSnapshot(client.db, {
    ...scope,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    snapshot: {
      version: 1,
      capturedAt: new Date().toISOString(),
      source: "model_request",
      requestIndex: 1,
      instructions: "Be helpful.",
      providerRequest: { provider: "openai", body: '{"input":[]}', parts: [] },
      layers: [],
      tools: [],
      skills: [],
      tokens: { instructions: 3, tools: 0, prefix: 3 },
    },
  });
  await applySessionTurnSettlement(client.db, scope.workspaceId, {
    sessionId: session.id,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [
      { type: "agent.message.delta", payload: { delta: "The plan" } },
      { type: "agent.model.request", payload: { model: "scripted-model", phase: "response" } },
      { type: "agent.message.completed", payload: { text: "The plan is ready." } },
      { type: "turn.completed", payload: { output: "The plan is ready." } },
    ],
  });
  await shared.admin`insert into session_history_items
    (id, account_id, workspace_id, session_id, turn_id, position, item, created_at, active)
    values (${crypto.randomUUID()}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
      ${claimed.turn.id}, 1, ${shared.admin.json({ type: "message", role: "assistant" })}, now(), true)`;
  const days = options.backdateDays ?? 45;
  // Simulate elapsed time only: bypass activity triggers for this fixture write.
  await shared.admin.begin(async (sql) => {
    await sql`set local session_replication_role = replica`;
    await sql`update session_turns set created_at = created_at - make_interval(days => ${days}),
        updated_at = updated_at - make_interval(days => ${days})
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    await sql`update sessions set created_at = created_at - make_interval(days => ${days}),
        updated_at = updated_at - make_interval(days => ${days})
      where workspace_id = ${scope.workspaceId} and id = ${scope.sessionId}`;
  });
  return { scope, subjectId: grant.subjectId };
}

async function countRows(table: string, scope: SessionArchiveScope): Promise<number> {
  const [row] = await shared.admin.unsafe(
    `select count(*)::int as count from ${table} where workspace_id = $1 and session_id = $2`,
    [scope.workspaceId, scope.sessionId],
  );
  return (row as unknown as { count: number }).count;
}

function manifest(keys: string[]): SessionArchiveManifest {
  return {
    format: "opengeni.session-archive",
    version: 1,
    objectKeys: keys,
    bundle: { key: keys[0]!, bytes: 10, sha256: "a".repeat(64) },
    transcript: { key: keys[1]!, bytes: 5, sha256: "b".repeat(64), events: 3 },
    sha256: "a".repeat(64),
    rowCounts: {},
    createdAt: new Date().toISOString(),
  };
}

describe("idle-session archive lifecycle", () => {
  test("archives an idle session, refuses new work, purges bulky content and keeps the readable timeline", async () => {
    const { scope, subjectId } = await idleSession();
    const candidates = await listSessionArchiveCandidates(client.db, {
      idleSeconds: IDLE_SECONDS,
      limit: 100,
    });
    expect(candidates.map((candidate) => candidate.sessionId)).toContain(scope.sessionId);

    const keys = [`archive/${scope.sessionId}/bundle`, `archive/${scope.sessionId}/transcript`];
    expect(
      await beginSessionArchive(client.db, scope, { idleSeconds: IDLE_SECONDS, objectKeys: keys }),
    ).toBe(true);
    expect(
      await beginSessionArchive(client.db, scope, { idleSeconds: IDLE_SECONDS, objectKeys: keys }),
    ).toBe(false);
    await expect(send(scope, subjectId, "one more thing")).rejects.toBeInstanceOf(
      SessionArchivedError,
    );

    // Every export table is readable for the bundle while archiving.
    const exported: Record<string, number> = {};
    for (const spec of SESSION_ARCHIVE_EXPORT_TABLES) {
      const page = await readSessionArchiveRows(client.db, scope, spec, {
        after: null,
        limit: 1000,
      });
      exported[spec.table] = page.rows.length;
      for (const row of page.rows) expect(typeof JSON.parse(row)).toBe("object");
    }
    expect(exported.session_events).toBeGreaterThan(3);
    expect(exported.session_history_items).toBeGreaterThanOrEqual(1);
    expect(exported.session_attempt_model_context_snapshots).toBe(1);
    expect(exported.session_turns).toBeGreaterThanOrEqual(1);

    const transcript = await readSessionArchiveTranscriptEvents(client.db, scope, {
      afterSequence: 0,
      limit: 1000,
    });
    expect(transcript.some((event) => event.type === "agent.message.completed")).toBe(true);
    expect(transcript.some((event) => event.type === "agent.message.delta")).toBe(false);

    // Purge refuses until the archive is verified and recorded.
    await expect(
      purgeArchivedSessionContent(client.db, scope, { batchSize: 100 }),
    ).rejects.toThrow();
    expect(await completeSessionArchive(client.db, scope, manifest(keys))).toBe(true);
    let step = await purgeArchivedSessionContent(client.db, scope, { batchSize: 1 });
    while (!step.complete)
      step = await purgeArchivedSessionContent(client.db, scope, { batchSize: 1 });

    for (const table of SESSION_ARCHIVE_PURGE_TABLES.filter((name) => name !== "session_events")) {
      expect(await countRows(table, scope)).toBe(0);
    }
    const remaining = await shared.admin`select type from session_events
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    const types = remaining.map((row) => row.type as string);
    expect(types).toContain("agent.message.completed");
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("agent.message.delta");
    expect(types).not.toContain("agent.model.request");
    expect(await countRows("session_turns", scope)).toBeGreaterThanOrEqual(1);

    const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
    expect(session?.retention?.archive?.state).toBe("archived");
    expect(session?.retention?.archive?.archivedAt).toBeString();

    // The setting cannot change once archived, and work is still refused.
    expect((await setSessionKeepLive(client.db, { ...scope, keepLive: true })).status).toBe(
      "archived",
    );
    await expect(send(scope, subjectId, "still there?")).rejects.toBeInstanceOf(
      SessionArchivedError,
    );

    // A recorded archive is permanent, even for a direct writer.
    // postgres.js queries are lazy thenables; run it inside a real promise.
    const reopen = async () => {
      await shared.admin`update sessions set content_archive_state = null,
          content_archive_started_at = null, content_archived_at = null, content_archive = null,
          content_archive_purged_at = null
        where id = ${scope.sessionId}`;
    };
    await expect(reopen()).rejects.toThrow(/SESSION_ARCHIVED_READ_ONLY/);

    // Deleting the session queues its archive objects for deletion.
    expect(
      (
        await deleteSessionTreeIfQuiescent(client.db, {
          workspaceId: scope.workspaceId,
          subjectId,
          sessionId: scope.sessionId,
        })
      ).status,
    ).toBe("deleted");
    const claims = await claimSessionArchiveObjectDeletions(client.db, {
      claimTimeoutSeconds: 600,
      limit: 1000,
    });
    expect(
      claims
        .filter((claim) => claim.sessionId === scope.sessionId)
        .map((c) => c.objectKey)
        .sort(),
    ).toEqual([...keys].sort());
    for (const key of keys)
      expect(await completeSessionArchiveObjectDeletion(client.db, key)).toBe(true);
  }, 120_000);

  test("keep-live, recent activity and pending human input keep a session live", async () => {
    const kept = await idleSession();
    expect((await setSessionKeepLive(client.db, { ...kept.scope, keepLive: true })).status).toBe(
      "updated",
    );
    const recent = await idleSession({ backdateDays: 3 });
    const waiting = await idleSession();
    await shared.admin`insert into session_human_input_requests
      (id, account_id, workspace_id, session_id, turn_id, turn_generation, creation_attempt_id,
       tool_call_id, status, questions, allow_skip, created_at, updated_at)
      select ${crypto.randomUUID()}, t.account_id, t.workspace_id, t.session_id, t.id, t.execution_generation,
        t.active_attempt_id, 'call-1', 'pending', '[]'::jsonb, true, now(), now()
      from session_turns t where t.workspace_id = ${waiting.scope.workspaceId}
        and t.session_id = ${waiting.scope.sessionId} limit 1`.catch(() => undefined);
    const eligible = await idleSession();

    const ids = (
      await listSessionArchiveCandidates(client.db, { idleSeconds: IDLE_SECONDS, limit: 100 })
    ).map((candidate) => candidate.sessionId);
    expect(ids).toContain(eligible.scope.sessionId);
    expect(ids).not.toContain(kept.scope.sessionId);
    expect(ids).not.toContain(recent.scope.sessionId);
    const [pending] =
      await shared.admin`select count(*)::int as count from session_human_input_requests
      where session_id = ${waiting.scope.sessionId} and status = 'pending'`;
    if ((pending as { count: number }).count > 0)
      expect(ids).not.toContain(waiting.scope.sessionId);
  }, 120_000);

  test("an abandoned archive returns the session to live and queues its planned objects", async () => {
    const { scope, subjectId } = await idleSession();
    const keys = [`archive/${scope.sessionId}/partial`];
    expect(
      await beginSessionArchive(client.db, scope, { idleSeconds: IDLE_SECONDS, objectKeys: keys }),
    ).toBe(true);
    expect(await abandonSessionArchive(client.db, scope)).toBe(true);
    expect(await abandonSessionArchive(client.db, scope)).toBe(false);
    const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
    expect(session?.retention?.archive).toBeNull();
    await send(scope, subjectId, "back to work");
    const claims = await claimSessionArchiveObjectDeletions(client.db, {
      claimTimeoutSeconds: 600,
      limit: 1000,
    });
    expect(claims.map((claim) => claim.objectKey)).toContain(keys[0]!);
  }, 120_000);
});
