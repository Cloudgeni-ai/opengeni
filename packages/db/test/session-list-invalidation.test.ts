import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { waitFor } from "@opengeni/testing/process";
import postgres from "postgres";
import {
  createSessionListChangeSource,
  type SessionListNotification,
} from "../src/session-list-notifications";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  grantWorkspaceAccess,
  listVisibleSessionInvalidationIds,
  withSessionRlsActorContext,
  SessionListAccessError,
  setSessionArchive,
  setSessionPin,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let listener: postgres.Sql;
const changes: Array<Record<string, unknown>> = [];
const barriers = new Map<string, () => void>();
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-list-invalidation");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl);
  listener = postgres(shared.appUrl, { max: 1 });
  await listener.listen("opengeni_session_lists", (payload) => {
    const barrier = barriers.get(payload);
    if (barrier) {
      barriers.delete(payload);
      barrier();
    } else changes.push(JSON.parse(payload));
  });
}, 180_000);
afterAll(async () => {
  await listener?.end();
  await client?.close();
  await shared?.release();
});

test("hint IDs use list RLS, exact host scope and current membership", async () => {
  const id = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client.db, {
    userId: id,
    email: `${id}@example.test`,
    name: "Hint authority",
  });
  const grant = access.workspaceGrants.find(
    (item) => item.workspaceId === access.defaultWorkspaceId,
  )!;
  const viewer = `user:viewer-${crypto.randomUUID()}`;
  await grantWorkspaceAccess(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: viewer,
    role: "member",
    permissions: ["sessions:read"],
  });
  const input = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Hint visibility",
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
    resources: [],
    metadata: {},
  };
  const root = await createSession(client.db, input);
  const child = await createSession(client.db, { ...input, parentSessionId: root.id });
  const privateOwner = grant.subjectId;
  const hidden = await withSessionRlsActorContext({ subjectId: privateOwner }, () =>
    createSession(client.db, {
      ...input,
      visibility: "user_private",
      subjectId: privateOwner,
      createdBy: { kind: "subject", subjectId: privateOwner },
    }),
  );
  const candidates = [root.id, child.id, hidden.id, crypto.randomUUID()];
  const authority = { subjectId: viewer };
  expect(
    (
      await listVisibleSessionInvalidationIds(client.db, grant.workspaceId, candidates, authority)
    ).sort(),
  ).toEqual([root.id, child.id].sort());
  expect(
    await listVisibleSessionInvalidationIds(client.db, grant.workspaceId, candidates, {
      ...authority,
      authorizationScope: { kind: "scoped", rootSessionIds: [], sessionIds: [child.id] },
    }),
  ).toEqual([child.id]);
  await expect(
    listVisibleSessionInvalidationIds(client.db, grant.workspaceId, candidates, {
      subjectId: `user:${crypto.randomUUID()}`,
    }),
  ).rejects.toBeInstanceOf(SessionListAccessError);
});

test("one listener serves consumers and forces reconciliation after connection loss", async () => {
  const source = createSessionListChangeSource(shared.appUrl, { reconnectDelayMs: 5 });
  const first: SessionListNotification[] = [];
  const second: SessionListNotification[] = [];
  const releaseFirst = source.subscribe((event) => first.push(event));
  const releaseSecond = source.subscribe((event) => second.push(event));
  try {
    await waitFor(() => first.some((event) => event.type === "connected"));
    expect(second.some((event) => event.type === "connected")).toBe(true);
    const backends = await shared.admin<{ pid: number }[]>`
      select pid from pg_stat_activity where datname=current_database()
        and usename=${new URL(shared.appUrl).username}
        and query='select current_schema() as schema'`;
    expect(backends).toHaveLength(1);
    await shared.admin`select pg_terminate_backend(${backends[0]!.pid})`;
    await waitFor(() => first.filter((event) => event.type === "connected").length === 2);
    expect(first.map((event) => event.type)).toEqual([
      "disconnected",
      "connected",
      "disconnected",
      "connected",
    ]);
    const payload = {
      schema: "public",
      workspaceId: crypto.randomUUID(),
      sessionId: null,
      subjectId: null,
      all: true,
    };
    await shared.admin`select pg_notify('opengeni_session_lists', ${JSON.stringify(payload)})`;
    await waitFor(() => first.some((event) => event.type === "change"));
    expect(second.at(-1)).toEqual({ type: "change", change: payload });
    // Another embedded installation's schema must not enter this source.
    await shared.admin`select pg_notify('opengeni_session_lists', ${JSON.stringify({ ...payload, schema: "other" })})`;
    await drain();
    expect(first.filter((event) => event.type === "change")).toHaveLength(1);
  } finally {
    releaseFirst();
    releaseSecond();
    await source.close();
  }
});

// One notification from a later committed transaction is an ordered barrier,
// avoiding timing sleeps and negative assertions against an undrained socket.
async function drain(): Promise<void> {
  const marker = crypto.randomUUID();
  const received = new Promise<void>((resolve) => barriers.set(marker, resolve));
  await shared.admin`select pg_notify('opengeni_session_lists', ${marker})`;
  await received;
}

test("commit hints coalesce, roll back, and ignore raw deltas and unrelated metadata", async () => {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "List hints",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "List hints",
    subjectId: `reader:${id}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "List fixture",
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    metadata: {},
  });
  await drain();
  changes.length = 0;
  const installed =
    await shared.admin`select tgname,tgenabled from pg_trigger where tgname='sessions_list_update'`;
  expect(installed).toHaveLength(1);
  await shared.admin.begin(async (tx) => {
    const changed =
      await tx`update sessions set title='First',title_source='user' where id=${session.id} returning title`;
    expect([...changed]).toEqual([{ title: "First" }]);
    await tx`update sessions set title='Second' where id=${session.id}`;
    await tx`update sessions set title='Final' where id=${session.id}`;
    expect(changes).toHaveLength(0);
  });
  await drain();
  expect(changes).toEqual([
    {
      schema: "public",
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: null,
      all: false,
    },
  ]);
  changes.length = 0;
  await expect(
    shared.admin.begin(async (tx) => {
      await tx`update sessions set title='Rolled back' where id=${session.id}`;
      throw new Error("rollback fixture");
    }),
  ).rejects.toThrow("rollback fixture");
  await appendSessionEvents(
    client.db,
    grant.workspaceId,
    session.id,
    Array.from({ length: 30 }, () => ({
      type: "agent.message.delta" as const,
      payload: { text: "token" },
    })),
  );
  await shared.admin`update sessions set metadata=metadata || '{"unrelated":"value"}'::jsonb where id=${session.id}`;
  await shared.admin`update sessions set title=title where id=${session.id}`;
  await drain();
  expect(changes).toHaveLength(0);

  await appendSessionEvents(client.db, grant.workspaceId, session.id, [
    {
      type: "session.title_set",
      payload: { title: "Semantic activity" },
    },
  ]);
  await drain();
  expect(changes).toHaveLength(1);
  expect(changes[0]?.sessionId).toBe(session.id);
  changes.length = 0;
  await setSessionPin(client.db, {
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    subjectId: grant.subjectId,
    pinned: true,
  });
  await drain();
  expect(changes).toHaveLength(1);
  expect(changes[0]?.subjectId).toBe(grant.subjectId);
  changes.length = 0;
  await setSessionArchive(client.db, {
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    subjectId: grant.subjectId,
    archived: true,
  });
  await drain();
  expect(changes).toHaveLength(1);
  expect(changes[0]?.subjectId).toBe(grant.subjectId);

  changes.length = 0;
  await shared.admin`delete from sessions where id=${session.id}`;
  await drain();
  expect(changes).toContainEqual({
    schema: "public",
    workspaceId: grant.workspaceId,
    sessionId: null,
    subjectId: null,
    all: true,
  });
});
