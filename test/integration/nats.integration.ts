import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bootstrapWorkspace, createDb, createSession, listSessionEvents } from "@opengeni/db";
import { appendAndPublishEvents, createNatsEventBus, type EventBus } from "@opengeni/events";
import {
  expectContiguousSequences,
  startTestServices,
  waitFor,
  type TestServices,
} from "@opengeni/testing";
import type { AccessGrant, SessionEvent } from "@opengeni/contracts";

describe("NATS integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;
  let bus: EventBus;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
    bus = await createNatsEventBus(services.natsUrl);
  }, 180_000);

  afterAll(async () => {
    await bus?.close();
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("publishes one batch to multiple subscribers", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "fanout",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const seenA: SessionEvent[] = [];
    const seenB: SessionEvent[] = [];
    const unsubA = await bus.subscribe(grant.workspaceId, session.id, (events) =>
      seenA.push(...events),
    );
    const unsubB = await bus.subscribe(grant.workspaceId, session.id, (events) =>
      seenB.push(...events),
    );

    const appended = await appendAndPublishEvents(dbClient.db, bus, grant.workspaceId, session.id, [
      { type: "session.created" },
      { type: "agent.message.delta", payload: { text: "hi" } },
    ]);

    await waitFor(() => seenA.length === 2 && seenB.length === 2);
    expect(seenA.map((event) => event.id)).toEqual(appended.map((event) => event.id));
    expect(seenB.map((event) => event.id)).toEqual(appended.map((event) => event.id));
    unsubA();
    unsubB();
  });

  test("missed live messages are recoverable from DB replay by sequence", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "replay",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const live: SessionEvent[] = [];
    const unsubscribe = await bus.subscribe(grant.workspaceId, session.id, (events) =>
      live.push(...events),
    );
    await appendAndPublishEvents(dbClient.db, bus, grant.workspaceId, session.id, [
      { type: "session.created" },
    ]);
    await waitFor(() => live.length === 1);
    unsubscribe();

    await appendAndPublishEvents(dbClient.db, bus, grant.workspaceId, session.id, [
      { type: "agent.message.delta", payload: { text: "missed" } },
      { type: "session.status.changed", payload: { status: "idle" } },
    ]);

    const replay = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      session.id,
      live[0]!.sequence,
    );
    expect(replay.map((event) => event.type)).toEqual([
      "agent.message.delta",
      "session.status.changed",
    ]);
    expectContiguousSequences([...live, ...replay]);
  });
});

async function testGrant(db: ReturnType<typeof createDb>["db"]): Promise<AccessGrant> {
  const id = crypto.randomUUID();
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:nats",
    accountExternalId: `account:${id}`,
    accountName: "NATS integration account",
    workspaceExternalSource: "test:nats",
    workspaceExternalId: `workspace:${id}`,
    workspaceName: "NATS integration workspace",
    subjectId: `test:nats:${id}`,
    subjectLabel: "NATS integration",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("NATS test did not create a workspace grant");
  }
  return grant;
}
