import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  SESSION_ARCHIVE_FORMAT_VERSION,
  SESSION_ARCHIVE_RESTORE_TABLES,
  SESSION_ARCHIVE_TRANSCRIPT_FORMAT,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  persistModelContextSnapshot,
  readSessionArchiveTranscriptEvents,
  submitHumanPromptInTransaction,
  toPostgresLosslessJson,
  unarchiveSession,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import { writeCompressedJsonLines } from "@opengeni/storage";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createSessionArchiveActivities } from "../src/activities/session-archive";
import type { ActivityServices } from "../src/activities/types";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("worker-session-archive");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function idleSession(into?: { accountId: string; workspaceId: string; subjectId: string }) {
  const suffix = crypto.randomUUID();
  const grant =
    into ??
    (
      await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: suffix,
        accountName: "Worker archive",
        workspaceExternalSource: "test",
        workspaceExternalId: suffix,
        workspaceName: "Worker archive",
        subjectId: `subject-${suffix}`,
      })
    ).workspaceGrants[0]!;
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
    subjectId: grant.subjectId,
    sessionId: session.id,
  };
  await withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        ...scope,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Write the report",
        resources: [],
        source: "user",
        reasoningEffortFallback: "medium",
      }),
    ),
  );
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
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
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
      { type: "agent.message.delta", payload: { delta: "Report" } },
      { type: "agent.message.completed", payload: { text: "Report written." } },
      { type: "turn.completed", payload: { output: "Report written." } },
    ],
  });
  await shared.admin`insert into session_history_items
    (id, account_id, workspace_id, session_id, turn_id, position, item, created_at, active)
    values (${crypto.randomUUID()}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
      ${claimed.turn.id}, 1, ${shared.admin.json({ type: "message", role: "assistant", content: "Report written." })}, now(), true)`;
  await shared.admin.begin(async (sql) => {
    await sql`set local session_replication_role = replica`;
    await sql`update session_turns set created_at = created_at - interval '40 days',
        updated_at = updated_at - interval '40 days'
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    await sql`update sessions set created_at = created_at - interval '40 days',
        updated_at = updated_at - interval '40 days'
      where workspace_id = ${scope.workspaceId} and id = ${scope.sessionId}`;
    // Its workflow got every wake long ago.
    await sql`update session_workflow_wake_outbox set delivered_revision = wake_revision
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
  });
  return scope;
}

/** The session workflow received every wake registered so far. */
async function deliverWakes(scope: { workspaceId: string; sessionId: string }) {
  await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision
    where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
}

function lines(bytes: Uint8Array): Record<string, unknown>[] {
  return new TextDecoder()
    .decode(zstdDecompressSync(bytes))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every row a restore puts back, per table, as JSON in a stable order. */
async function restorableRows(scope: { workspaceId: string; sessionId: string }) {
  const tables: Record<string, unknown[]> = {};
  for (const table of SESSION_ARCHIVE_RESTORE_TABLES) {
    const rows = await shared.admin.unsafe(
      `select to_jsonb(t) as row from ${table} t
        where workspace_id = $1 and session_id = $2 order by to_jsonb(t)::text`,
      [scope.workspaceId, scope.sessionId],
    );
    tables[table] = rows.map((row) => (row as unknown as { row: unknown }).row);
  }
  return tables;
}

/** Archive activities whose object storage is an in-memory map. */
function inMemoryArchive(objects: Map<string, Uint8Array>) {
  return createSessionArchiveActivities(
    async () =>
      ({
        db: client.db,
        bus: { publish: async () => undefined },
        objectStorage: { deleteObject: async (key: string) => void objects.delete(key) } as never,
        observability: { info: () => undefined, warn: () => undefined } as never,
        settings: testSettings({ sessionArchiveEnabled: true, sessionArchiveIdleDays: 30 }),
      }) as unknown as ActivityServices,
    {
      upload: async (_storage, key, spool) => {
        objects.set(key, new Uint8Array(await readFile(spool.path)));
      },
      download: async (_storage, object) => {
        const bytes = objects.get(object.key);
        if (!bytes) throw new Error(`missing object ${object.key}`);
        expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(object.sha256);
        const dir = await mkdtemp(join(tmpdir(), "session-archive-restore-"));
        const path = join(dir, "bundle.jsonl.zst");
        await writeFile(path, bytes);
        return { path, dispose: async () => await rm(dir, { recursive: true, force: true }) };
      },
    },
  );
}

async function contentState(sessionId: string) {
  const [row] = await shared.admin<
    {
      archived_at: Date | null;
      content_archive_state: string | null;
      content_archive: { objectKeys?: string[] } | null;
      content_restore_requested_at: Date | null;
    }[]
  >`select archived_at, content_archive_state, content_archive, content_restore_requested_at
    from sessions where id = ${sessionId}`;
  return row!;
}

describe("idle-session archive worker", () => {
  test("does nothing but recovery while the deployment leaves archiving off", async () => {
    await idleSession();
    const upload = mock(async () => undefined);
    const activities = createSessionArchiveActivities(
      async () =>
        ({
          db: client.db,
          objectStorage: { deleteObject: async () => undefined } as never,
          observability: { info: () => undefined, warn: () => undefined } as never,
          settings: testSettings({ sessionArchiveEnabled: false }),
        }) as unknown as ActivityServices,
      { upload },
    );
    const result = await activities.archiveIdleSessions();
    expect(result).toMatchObject({ enabled: false, archived: 0 });
    expect(upload).not.toHaveBeenCalled();
  }, 120_000);

  test("writes a verified full bundle and a readable transcript, then purges", async () => {
    const scope = await idleSession();
    const objects = new Map<string, Uint8Array>();
    const activities = createSessionArchiveActivities(
      async () =>
        ({
          db: client.db,
          objectStorage: { deleteObject: async (key: string) => void objects.delete(key) } as never,
          observability: { info: () => undefined, warn: () => undefined } as never,
          settings: testSettings({ sessionArchiveEnabled: true, sessionArchiveIdleDays: 30 }),
        }) as unknown as ActivityServices,
      {
        upload: async (_storage, key, spool) => {
          objects.set(key, new Uint8Array(await readFile(spool.path)));
        },
      },
    );
    const result = await activities.archiveIdleSessions();
    expect(result.failed).toBe(0);
    expect(result.archived).toBeGreaterThanOrEqual(1);

    const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
    expect(session?.retention?.archive?.state).toBe("archived");
    const [row] = await shared.admin`select content_archive, content_archive_purged_at
      from sessions where id = ${scope.sessionId}`;
    const manifest = row!.content_archive as {
      bundle: { key: string; bytes: number; sha256: string };
      transcript: { key: string; events: number };
      rowCounts: Record<string, number>;
    };
    expect(row!.content_archive_purged_at).not.toBeNull();

    const bundleBytes = objects.get(manifest.bundle.key)!;
    expect(bundleBytes.byteLength).toBe(manifest.bundle.bytes);
    expect(new Bun.CryptoHasher("sha256").update(bundleBytes).digest("hex")).toBe(
      manifest.bundle.sha256,
    );
    const bundle = lines(bundleBytes);
    expect(bundle[0]).toMatchObject({ format: "opengeni.session-archive", version: 1 });
    expect((bundle[0]!.session as { id: string }).id).toBe(scope.sessionId);
    expect(bundle.at(-1)).toMatchObject({ end: true, rowCounts: manifest.rowCounts });
    const eventRows = bundle.filter((line) => line.table === "session_events");
    expect(eventRows.length).toBe(manifest.rowCounts.session_events);
    expect(
      eventRows.some((line) => (line.row as { type: string }).type === "agent.message.delta"),
    ).toBe(true);

    const transcript = lines(objects.get(manifest.transcript.key)!);
    expect(transcript[0]).toMatchObject({ format: "opengeni.session-transcript", version: 1 });
    const events = transcript.slice(1, -1).map((line) => line.event as { type: string });
    expect(events.length).toBe(manifest.transcript.events);
    expect(events.some((event) => event.type === "agent.message.completed")).toBe(true);
    expect(events.some((event) => event.type === "agent.message.delta")).toBe(false);

    const [deltas] = await shared.admin`select count(*)::int as count from session_events
      where session_id = ${scope.sessionId} and type = 'agent.message.delta'`;
    expect((deltas as { count: number }).count).toBe(0);
  }, 120_000);

  test("the stored transcript is byte for byte what reading the kept events again writes", async () => {
    const scope = await idleSession();
    const types = [
      "agent.message.delta",
      "agent.message.completed",
      "agent.model.request",
      "user.message",
      "system.update.pending",
      "turn.completed",
    ];
    const encoded = toPostgresLosslessJson({ text: "nul \u0000 and lone \ud800", big: 2 ** 60 });
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      // More events than one bundle page (200) or one old transcript page (500).
      await sql`insert into session_events (account_id, workspace_id, session_id, sequence, type,
          payload, payload_codec_version, occurred_at, client_event_id)
        select ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId}, m.last + n,
          (${types}::text[])[1 + n % ${types.length}],
          case when n % 5 = 0 then ${sql.json(encoded as never)}::jsonb
            else jsonb_build_object('text', 'event ' || n, 'n', n) end,
          case when n % 5 = 0 then 1 end,
          now() - interval '40 days' + n * interval '1.0004567 seconds',
          case when n % 3 = 0 then 'client-' || n end
        from (select max(sequence) as last from session_events
          where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}) m,
          generate_series(1, 2100) n`;
    });
    // What the archive wrote before it made the transcript from the bundle's
    // rows: a second read of every kept event, 500 at a time.
    const directory = await mkdtemp(join(tmpdir(), "session-archive-transcript-"));
    let expectedEvents = 0;
    const expected = await writeCompressedJsonLines(
      join(directory, "transcript.jsonl.zst"),
      async (write) => {
        await write(
          JSON.stringify({
            format: SESSION_ARCHIVE_TRANSCRIPT_FORMAT,
            version: SESSION_ARCHIVE_FORMAT_VERSION,
            workspaceId: scope.workspaceId,
            sessionId: scope.sessionId,
          }),
        );
        for (let afterSequence = 0; ;) {
          const page = await readSessionArchiveTranscriptEvents(client.db, scope, {
            afterSequence,
            limit: 500,
          });
          for (const event of page) await write(JSON.stringify({ event }));
          expectedEvents += page.length;
          if (page.length < 500) break;
          afterSequence = page.at(-1)!.sequence;
        }
        await write(JSON.stringify({ end: true, events: expectedEvents }));
      },
    );
    const expectedBytes = new Uint8Array(await readFile(expected.path));
    await rm(directory, { recursive: true, force: true });

    const objects = new Map<string, Uint8Array>();
    const result = await inMemoryArchive(objects).archiveIdleSessions();
    expect(result.failed).toBe(0);
    const [row] =
      await shared.admin`select content_archive from sessions where id = ${scope.sessionId}`;
    const manifest = row!.content_archive as {
      transcript: { key: string; bytes: number; sha256: string; events: number };
    };
    expect(expectedEvents).toBeGreaterThan(1000);
    const stored = objects.get(manifest.transcript.key)!;
    expect(new TextDecoder().decode(zstdDecompressSync(stored))).toBe(
      new TextDecoder().decode(zstdDecompressSync(expectedBytes)),
    );
    expect(manifest.transcript).toMatchObject({
      bytes: expected.byteSize,
      sha256: expected.sha256,
      events: expectedEvents,
    });
    expect(Buffer.compare(stored, expectedBytes)).toBe(0);
  }, 120_000);

  test("one pass keeps taking batches until no idle session is left", async () => {
    const scopes = [await idleSession(), await idleSession(), await idleSession()];
    const activities = createSessionArchiveActivities(
      async () =>
        ({
          db: client.db,
          objectStorage: { deleteObject: async () => undefined } as never,
          observability: { info: () => undefined, warn: () => undefined } as never,
          settings: testSettings({ sessionArchiveEnabled: true, sessionArchiveIdleDays: 30 }),
        }) as unknown as ActivityServices,
      { upload: async () => undefined, candidatesPerPass: 1 },
    );
    const result = await activities.archiveIdleSessions();
    expect(result.failed).toBe(0);
    for (const scope of scopes) {
      const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
      expect(session?.retention?.archive?.state).toBe("archived");
    }
  }, 120_000);

  test("an archived chat whose goal is still active is stopped, then stored", async () => {
    const scope = await idleSession();
    // Archived (for example by the backfill of personally hidden chats) with
    // a goal no stop step paused: the pass pauses it, the next one stores it.
    await shared.admin`update sessions set archived_at = now() - interval '1 minute',
        archive_requested_by = 'subject-archiver'
      where workspace_id = ${scope.workspaceId} and id = ${scope.sessionId}`;
    await shared.admin`insert into session_goals (account_id, workspace_id, session_id, text, status)
      values (${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId}, 'keep going', 'active')`;
    const activities = createSessionArchiveActivities(
      async () =>
        ({
          db: client.db,
          bus: { publish: async () => undefined },
          objectStorage: { deleteObject: async () => undefined } as never,
          observability: { info: () => undefined, warn: () => undefined } as never,
          settings: testSettings({ sessionArchiveEnabled: true, sessionArchiveIdleDays: 30 }),
        }) as unknown as ActivityServices,
      { upload: async () => undefined },
    );
    const first = await activities.archiveIdleSessions();
    expect(first.failed).toBe(0);
    const [goal] = await shared.admin`select status from session_goals
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    expect(goal!.status).toBe("paused");
    expect(
      (await getSession(client.db, scope.workspaceId, scope.sessionId))?.retention?.archive,
    ).toBeNull();

    const second = await activities.archiveIdleSessions();
    expect(second.failed).toBe(0);
    const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
    expect(session?.retention?.archive?.state).toBe("archived");
  }, 120_000);

  test("stopping an archived chat skips its sub-chats that are already stored", async () => {
    const activities = createSessionArchiveActivities(
      async () =>
        ({
          db: client.db,
          bus: { publish: async () => undefined },
          objectStorage: { deleteObject: async () => undefined } as never,
          observability: { info: () => undefined, warn: () => undefined } as never,
          settings: testSettings({ sessionArchiveEnabled: true, sessionArchiveIdleDays: 30 }),
        }) as unknown as ActivityServices,
      { upload: async () => undefined },
    );
    // A sub-chat stored on its own earlier...
    const child = await idleSession();
    expect((await activities.archiveIdleSessions()).failed).toBe(0);
    expect(
      (await getSession(client.db, child.workspaceId, child.sessionId))?.retention?.archive?.state,
    ).toBe("archived");
    // ...under a chat that was archived later while it still had work.
    const scope = await idleSession(child);
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update sessions set parent_session_id = ${scope.sessionId},
          root_session_id = ${scope.sessionId}
        where workspace_id = ${scope.workspaceId} and id = ${child.sessionId}`;
    });
    // It still had a queued message when it was archived, so the pass must
    // cancel its work.
    await withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          subjectId: scope.subjectId,
          actor: { type: "human", subjectId: scope.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "One more thing",
          resources: [],
          source: "user",
          reasoningEffortFallback: "medium",
        }),
      ),
    );

    await shared.admin`update sessions set archived_at = now() - interval '1 minute',
        archive_requested_by = 'subject-archiver'
      where workspace_id = ${scope.workspaceId} and id = ${scope.sessionId}`;

    const first = await activities.archiveIdleSessions();
    expect(first.failed).toBe(0);

    // The cancel's wake has not reached the workflow yet: storing waits for
    // it, so the wake outbox never holds an undeliverable row.
    await activities.archiveIdleSessions();
    expect(
      (await getSession(client.db, scope.workspaceId, scope.sessionId))?.retention?.archive,
    ).toBeNull();
    await deliverWakes(scope);

    const third = await activities.archiveIdleSessions();
    expect(third.failed).toBe(0);
    const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
    expect(session?.retention?.archive?.state).toBe("archived");
  }, 120_000);

  test("an archived chat held back only by an undelivered update is stopped, then stored", async () => {
    const scope = await idleSession();
    // A failed chat with a notice it never got to read: it will never run
    // again, so the notice is cancelled with its work.
    await shared.admin`insert into session_system_updates (
        account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary, payload
      ) values (${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
        'agent_message', ${crypto.randomUUID()}, ${`archive-${crypto.randomUUID()}`},
        'late notice', ${shared.admin.json({ type: "agent_message", text: "late" })})`;
    await shared.admin`update sessions set status = 'failed',
        archived_at = now() - interval '1 minute', archive_requested_by = 'subject-archiver'
      where workspace_id = ${scope.workspaceId} and id = ${scope.sessionId}`;
    const activities = createSessionArchiveActivities(
      async () =>
        ({
          db: client.db,
          bus: { publish: async () => undefined },
          objectStorage: { deleteObject: async () => undefined } as never,
          observability: { info: () => undefined, warn: () => undefined } as never,
          settings: testSettings({ sessionArchiveEnabled: true, sessionArchiveIdleDays: 30 }),
        }) as unknown as ActivityServices,
      { upload: async () => undefined },
    );
    expect((await activities.archiveIdleSessions()).failed).toBe(0);
    const [update] = await shared.admin`select state from session_system_updates
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    expect(update!.state).toBe("cancelled");
    await deliverWakes(scope);
    expect((await activities.archiveIdleSessions()).failed).toBe(0);
    const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
    expect(session?.retention?.archive?.state).toBe("archived");
  }, 120_000);

  test("an archived sub-chat still at work under a stored chat is stopped, then stored", async () => {
    const activities = createSessionArchiveActivities(
      async () =>
        ({
          db: client.db,
          bus: { publish: async () => undefined },
          objectStorage: { deleteObject: async () => undefined } as never,
          observability: { info: () => undefined, warn: () => undefined } as never,
          settings: testSettings({ sessionArchiveEnabled: true, sessionArchiveIdleDays: 30 }),
        }) as unknown as ActivityServices,
      { upload: async () => undefined },
    );
    const parent = await idleSession();
    expect((await activities.archiveIdleSessions()).failed).toBe(0);
    const child = await idleSession(parent);
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update sessions set parent_session_id = ${parent.sessionId},
          root_session_id = ${parent.sessionId}
        where workspace_id = ${child.workspaceId} and id = ${child.sessionId}`;
    });
    // It still had a queued message, so stopping it also cancels work.
    await withWorkspaceSessionActivityRls(client.db, child.workspaceId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: child.accountId,
          workspaceId: child.workspaceId,
          sessionId: child.sessionId,
          subjectId: child.subjectId,
          actor: { type: "human", subjectId: child.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "One more thing",
          resources: [],
          source: "user",
          reasoningEffortFallback: "medium",
        }),
      ),
    );
    await shared.admin`update sessions set archived_at = now() - interval '1 minute',
        archive_requested_by = 'subject-archiver'
      where workspace_id = ${child.workspaceId} and id = ${child.sessionId}`;
    await shared.admin`insert into session_goals (account_id, workspace_id, session_id, text, status)
      values (${child.accountId}, ${child.workspaceId}, ${child.sessionId}, 'keep going', 'active')`;

    const first = await activities.archiveIdleSessions();
    expect(first.failed).toBe(0);
    const [goal] = await shared.admin`select status from session_goals
      where workspace_id = ${child.workspaceId} and session_id = ${child.sessionId}`;
    expect(goal!.status).toBe("paused");
    await deliverWakes(child);
    await activities.archiveIdleSessions();
    const session = await getSession(client.db, child.workspaceId, child.sessionId);
    expect(session?.retention?.archive?.state).toBe("archived");
  }, 120_000);
});

describe("restoring an archived chat from long-term storage", () => {
  test("a stored chat and its sub-chat come back with every row they had, and stay live", async () => {
    const objects = new Map<string, Uint8Array>();
    const activities = inMemoryArchive(objects);
    const parent = await idleSession();
    const child = await idleSession(parent);
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update sessions set parent_session_id = ${parent.sessionId},
          root_session_id = ${parent.sessionId}
        where workspace_id = ${child.workspaceId} and id = ${child.sessionId}`;
    });
    const before = {
      parent: await restorableRows(parent),
      child: await restorableRows(child),
    };
    expect(before.parent.session_history_items!.length).toBeGreaterThan(0);
    expect(before.parent.session_attempt_model_context_snapshots!.length).toBeGreaterThan(0);
    // One person's Archive of the chat took the sub-chat with it.
    await shared.admin`update sessions set archived_at = now() - interval '1 hour',
        archive_requested_by = ${parent.subjectId}
      where workspace_id = ${parent.workspaceId}
        and id in (${parent.sessionId}, ${child.sessionId})`;
    for (let pass = 0; pass < 4; pass += 1) {
      expect((await activities.archiveIdleSessions()).failed).toBe(0);
      for (const scope of [parent, child]) {
        if ((await contentState(scope.sessionId)).content_archive_state === null) {
          await deliverWakes(scope);
        }
      }
    }
    for (const scope of [parent, child]) {
      const stored = await contentState(scope.sessionId);
      expect(stored.content_archive_state).toBe("archived");
      expect(await restorableRows(scope)).toMatchObject({ session_history_items: [] });
    }
    const storedKeys = (await contentState(parent.sessionId)).content_archive!.objectKeys!;
    expect(storedKeys.length).toBeGreaterThan(0);

    const unarchived = await unarchiveSession(client.db, parent);
    expect(unarchived?.outcome).toBe("restoring");
    expect([...unarchived!.restoringSessionIds].sort()).toEqual(
      [parent.sessionId, child.sessionId].sort(),
    );
    expect(
      (await getSession(client.db, parent.workspaceId, parent.sessionId))?.retention?.archive,
    ).toMatchObject({ state: "archived", restoring: true });

    expect(await activities.restoreArchivedSessions(parent)).toEqual({ restored: 2 });
    for (const [scope, rows] of [
      [parent, before.parent],
      [child, before.child],
    ] as const) {
      const state = await contentState(scope.sessionId);
      expect(state.content_archive_state).toBeNull();
      expect(state.archived_at).toBeNull();
      expect(await restorableRows(scope)).toEqual(rows);
      const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
      expect(session?.retention?.archive).toBeNull();
    }
    // Streamed fragments are not put back; the readable timeline never left.
    const [events] = await shared.admin<{ deltas: number; completed: number }[]>`
      select count(*) filter (where type = 'agent.message.delta')::int as deltas,
        count(*) filter (where type = 'agent.message.completed')::int as completed
      from session_events where session_id = ${parent.sessionId}`;
    expect(events).toEqual({ deltas: 0, completed: 1 });
    // The stored copies are no longer the chat's content; they are deleted.
    const queued = await shared.admin<{ object_key: string }[]>`
      select object_key from opengeni_private.session_archive_object_deletions
      where session_id = ${parent.sessionId}`;
    expect(queued.map((row) => row.object_key).sort()).toEqual([...storedKeys].sort());

    // Restoring again does nothing, the next pass does not store it again,
    // and it takes new messages.
    expect(await activities.restoreArchivedSessions(parent)).toEqual({ restored: 0 });
    expect((await activities.archiveIdleSessions()).failed).toBe(0);
    expect((await contentState(parent.sessionId)).content_archive_state).toBeNull();
    await withWorkspaceSessionActivityRls(client.db, parent.workspaceId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          ...parent,
          actor: { type: "human", subjectId: parent.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "Carry on",
          resources: [],
          source: "user",
          reasoningEffortFallback: "medium",
        }),
      ),
    );
  }, 180_000);

  test("a chat that was busy when archived is stored, then restored ready for new messages", async () => {
    const objects = new Map<string, Uint8Array>();
    const activities = inMemoryArchive(objects);
    const parent = await idleSession();
    const child = await idleSession(parent);
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update sessions set parent_session_id = ${parent.sessionId},
          root_session_id = ${parent.sessionId}
        where workspace_id = ${child.workspaceId} and id = ${child.sessionId}`;
    });
    const prompt = async (text: string) =>
      await withWorkspaceSessionActivityRls(client.db, parent.workspaceId, (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof db, {
            ...parent,
            actor: { type: "human", subjectId: parent.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text,
            resources: [],
            source: "user",
            reasoningEffortFallback: "medium",
          }),
        ),
      );
    // Busy with new work when someone archives it with its sub-chat.
    await prompt("Keep going");
    const [archived] = await shared.admin<{ archived_at: Date }[]>`
      update sessions set archived_at = now() - interval '1 hour',
        archive_requested_by = ${parent.subjectId}
      where workspace_id = ${parent.workspaceId}
        and id in (${parent.sessionId}, ${child.sessionId})
      returning archived_at`;
    // The undo window ends: the Archive stops that work like Cancel does.
    expect(
      await activities.stopArchivedSessionWork({
        ...parent,
        archivedAt: archived!.archived_at.toISOString(),
      }),
    ).toEqual({ pending: true });
    for (const scope of [parent, child]) {
      expect((await getSession(client.db, scope.workspaceId, scope.sessionId))?.status).toBe(
        "cancelled",
      );
    }
    for (let pass = 0; pass < 4; pass += 1) {
      expect((await activities.archiveIdleSessions()).failed).toBe(0);
      for (const scope of [parent, child]) {
        if ((await contentState(scope.sessionId)).content_archive_state === null) {
          await deliverWakes(scope);
        }
      }
    }
    for (const scope of [parent, child]) {
      expect((await contentState(scope.sessionId)).content_archive_state).toBe("archived");
    }

    expect((await unarchiveSession(client.db, parent))?.outcome).toBe("restoring");
    expect(
      await activities.restoreArchivedSessions({ ...parent, subjectId: parent.subjectId }),
    ).toEqual({ restored: 2 });
    for (const scope of [parent, child]) {
      const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
      expect(session?.status).toBe("idle");
      expect(session?.retention?.archive).toBeNull();
    }
    const [resumed] = await shared.admin<{ direct_control_state: string }[]>`
      select direct_control_state from sessions where id = ${parent.sessionId}`;
    expect(resumed!.direct_control_state).toBe("active");
    // It takes a new message (a cancelled chat refuses it).
    await prompt("Carry on");
    const [queued] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from session_turns
      where session_id = ${parent.sessionId} and status = 'queued'`;
    expect(queued!.count).toBe(1);
  }, 180_000);

  test("the maintenance pass finishes a restore whose workflow never ran", async () => {
    const objects = new Map<string, Uint8Array>();
    const activities = inMemoryArchive(objects);
    const scope = await idleSession();
    const before = await restorableRows(scope);
    expect((await activities.archiveIdleSessions()).failed).toBe(0);
    expect((await contentState(scope.sessionId)).content_archive_state).toBe("archived");
    expect((await unarchiveSession(client.db, scope))?.outcome).toBe("restoring");
    // Not yet: its own workflow gets the first few minutes.
    await activities.archiveIdleSessions();
    expect((await contentState(scope.sessionId)).content_archive_state).toBe("archived");

    await shared.admin`update sessions
      set content_restore_requested_at = content_restore_requested_at - interval '10 minutes'
      where id = ${scope.sessionId}`;
    const pass = await activities.archiveIdleSessions();
    expect(pass.failed).toBe(0);
    expect(pass.restored).toBeGreaterThanOrEqual(1);
    expect((await contentState(scope.sessionId)).content_archive_state).toBeNull();
    expect(await restorableRows(scope)).toEqual(before);
  }, 180_000);
});
