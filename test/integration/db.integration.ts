import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendSessionEvents,
  createDb,
  createSession,
  createTurn,
  finishTurn,
  getLatestRunState,
  listSessionEvents,
  saveRunState,
  setSessionStatus,
} from "@infra-agents/db";
import { expectContiguousSequences, startTestServices, type TestServices } from "@infra-agents/testing";

describe("DB integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("migrates, creates sessions, and replays ordered events", async () => {
    const session = await createSession(dbClient.db, {
      initialMessage: "inspect this",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const events = await appendSessionEvents(dbClient.db, session.id, [
      { type: "session.created" },
      { type: "user.message", payload: { text: "inspect this" }, clientEventId: "client-1" },
      { type: "session.status.changed", payload: { status: "queued" } },
    ]);
    expectContiguousSequences(events);
    expect(await listSessionEvents(dbClient.db, session.id)).toHaveLength(3);
    expect(await listSessionEvents(dbClient.db, session.id, 1)).toHaveLength(2);
  });

  test("serializes concurrent event appends into contiguous sequence numbers", async () => {
    const session = await createSession(dbClient.db, {
      initialMessage: "concurrency",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      appendSessionEvents(dbClient.db, session.id, [{
        type: "agent.message.delta",
        payload: { text: String(index) },
        producerId: "producer",
        producerSeq: index,
      }])
    ));
    const events = await listSessionEvents(dbClient.db, session.id, 0, 20);
    expect(events).toHaveLength(10);
    expectContiguousSequences(events);
  });

  test("enforces client and producer idempotency constraints", async () => {
    const session = await createSession(dbClient.db, {
      initialMessage: "dedupe",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "one" }, clientEventId: "same-client" },
      { type: "agent.message.delta", payload: { text: "a" }, producerId: "p", producerSeq: 1 },
    ]);
    await expect(appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "two" }, clientEventId: "same-client" },
    ])).rejects.toThrow();
    await expect(appendSessionEvents(dbClient.db, session.id, [
      { type: "agent.message.delta", payload: { text: "b" }, producerId: "p", producerSeq: 1 },
    ])).rejects.toThrow();
  });

  test("persists run state versions and turn status transitions", async () => {
    const session = await createSession(dbClient.db, {
      initialMessage: "turns",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "turns" } },
    ]);
    const turnId = await createTurn(dbClient.db, {
      sessionId: session.id,
      triggerEventId: trigger!.id,
      temporalWorkflowId: "workflow",
    });
    await saveRunState(dbClient.db, {
      sessionId: session.id,
      turnId,
      serializedRunState: "state-1",
      pendingApprovals: [],
    });
    await saveRunState(dbClient.db, {
      sessionId: session.id,
      turnId,
      serializedRunState: "state-2",
      pendingApprovals: [{ id: "approval" }],
    });
    const latest = await getLatestRunState(dbClient.db, session.id);
    expect(latest?.serializedRunState).toBe("state-2");
    await finishTurn(dbClient.db, turnId, "idle");
    await setSessionStatus(dbClient.db, session.id, "idle", null);
  });
});
