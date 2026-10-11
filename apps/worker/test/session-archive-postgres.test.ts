import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
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

async function idleSession() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Worker archive",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Worker archive",
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
  await shared.admin.begin(async (sql) => {
    await sql`set local session_replication_role = replica`;
    await sql`update session_turns set created_at = created_at - interval '40 days',
        updated_at = updated_at - interval '40 days'
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    await sql`update sessions set created_at = created_at - interval '40 days',
        updated_at = updated_at - interval '40 days'
      where workspace_id = ${scope.workspaceId} and id = ${scope.sessionId}`;
  });
  return scope;
}

function lines(bytes: Uint8Array): Record<string, unknown>[] {
  return new TextDecoder()
    .decode(zstdDecompressSync(bytes))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
});
