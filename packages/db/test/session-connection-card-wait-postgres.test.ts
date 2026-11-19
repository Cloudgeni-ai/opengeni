import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  listSessionEntriesForSubject,
} from "../src";

// A connection card the agent waits on needs the person, as an approval does
// (migration 1502): its `connection-card:` notice marks the idle chat as
// needing them until the card is withdrawn or the agent starts working again.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-connection-card-wait");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("a connection card notice marks the idle chat as needing the person until it is done", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-connection-card-wait",
    accountExternalId: `account-${suffix}`,
    accountName: "Connection card wait",
    workspaceExternalSource: "session-connection-card-wait",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Connection card wait",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    createdBy: { kind: "subject" as const, subjectId: grant.subjectId },
    initialMessage: "Read my mail",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  expect(session.status).toBe("idle");
  const cardA = "connection-card:00000000000000aa";
  const cardB = "connection-card:00000000000000bb";
  const post = (key: string) =>
    appendSessionEvents(client.db, workspaceId, session.id, [
      {
        type: "session.notification.posted",
        payload: { key, title: "Connect Mail", body: "The agent is waiting for you in this chat." },
      },
    ]);
  const withdraw = (key: string) =>
    appendSessionEvents(client.db, workspaceId, session.id, [
      { type: "session.notification.withdrawn", payload: { key } },
    ]);
  const state = async () => {
    const [row] = await shared.admin<
      Array<{ since: Date | null; keys: string[] | null }>
    >`select awaiting_connection_since as since, awaiting_connection_keys as keys
      from sessions where id = ${session.id}::uuid`;
    return row!;
  };
  const needsYou = async () => {
    const page = await listSessionEntriesForSubject(client.db, workspaceId, {
      subjectId: grant.subjectId,
      parentSessionId: null,
      includeTotals: true,
      includePinned: false,
      needsYouOnly: true,
      limit: 10,
    });
    return {
      ids: page.sessions.map((row) => row.id),
      count: page.totals?.needsYouCount ?? 0,
      since: page.sessions[0]?.awaitingConnectionSince ?? null,
    };
  };
  const inboxStatus = async (key: string) => {
    const [row] = await shared.admin<Array<{ status: string }>>`
      select status from opengeni_private.inbox_items
      where session_id = ${session.id}::uuid and kind = 'notification' and source_key = ${key}`;
    return row?.status ?? null;
  };

  // Another notification asks nothing of the person here.
  await appendSessionEvents(client.db, workspaceId, session.id, [
    { type: "session.notification.posted", payload: { key: "report-ready", title: "Report" } },
  ]);
  expect(await state()).toEqual({ since: null, keys: null });
  expect((await needsYou()).ids).toEqual([]);

  await post(cardA);
  const first = await state();
  expect(first.keys).toEqual([cardA]);
  expect(first.since).not.toBeNull();
  const since = first.since!.toISOString();
  expect((await getSession(client.db, workspaceId, session.id))?.awaitingConnectionSince).toBe(
    since,
  );
  expect(await needsYou()).toEqual({ ids: [session.id], count: 1, since });

  // A second card, and a repeat of the first, keep when the wait began.
  await post(cardB);
  await post(cardA);
  expect(await state()).toEqual({ since: first.since, keys: [cardA, cardB] });

  // Done with one card: the other still waits.
  await withdraw(cardA);
  expect(await state()).toEqual({ since: first.since, keys: [cardB] });
  await withdraw(cardB);
  expect(await state()).toEqual({ since: null, keys: null });
  expect((await getSession(client.db, workspaceId, session.id))?.awaitingConnectionSince).toBe(
    undefined,
  );
  expect(await needsYou()).toEqual({ ids: [], count: 0, since: null });

  // Once the agent works again (the person wrote, or the card's setup woke
  // it) it no longer waits, in the chat and the inbox; a card it still needs
  // is posted again by that turn. A message alone (a steer while the turn
  // runs) leaves the card waiting.
  await post(cardA);
  expect(await inboxStatus(cardA)).toBe("open");
  expect((await state()).keys).toEqual([cardA]);
  await appendSessionEvents(client.db, workspaceId, session.id, [
    { type: "user.message", payload: { text: "Never mind, skip the mail." } },
  ]);
  expect((await state()).keys).toEqual([cardA]);
  expect(await inboxStatus(cardA)).toBe("open");
  await appendSessionEvents(client.db, workspaceId, session.id, [
    { type: "turn.started", payload: {} },
  ]);
  expect(await state()).toEqual({ since: null, keys: null });
  expect(await inboxStatus(cardA)).toBe("withdrawn");
  expect(await inboxStatus("report-ready")).toBe("open");
});
