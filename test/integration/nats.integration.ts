import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, createSession, listSessionEvents } from "@infra-agents/db";
import { appendAndPublishEvents, createNatsEventBus, type EventBus } from "@infra-agents/events";
import { expectContiguousSequences, startTestServices, waitFor, type TestServices } from "@infra-agents/testing";
import type { SessionEvent } from "@infra-agents/contracts";

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
    const session = await createSession(dbClient.db, {
      initialMessage: "fanout",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const seenA: SessionEvent[] = [];
    const seenB: SessionEvent[] = [];
    const unsubA = await bus.subscribe(session.id, (events) => seenA.push(...events));
    const unsubB = await bus.subscribe(session.id, (events) => seenB.push(...events));

    const appended = await appendAndPublishEvents(dbClient.db, bus, session.id, [
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
    const session = await createSession(dbClient.db, {
      initialMessage: "replay",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const live: SessionEvent[] = [];
    const unsubscribe = await bus.subscribe(session.id, (events) => live.push(...events));
    await appendAndPublishEvents(dbClient.db, bus, session.id, [
      { type: "session.created" },
    ]);
    await waitFor(() => live.length === 1);
    unsubscribe();

    await appendAndPublishEvents(dbClient.db, bus, session.id, [
      { type: "agent.message.delta", payload: { text: "missed" } },
      { type: "session.status.changed", payload: { status: "idle" } },
    ]);

    const replay = await listSessionEvents(dbClient.db, session.id, live[0]!.sequence);
    expect(replay.map((event) => event.type)).toEqual(["agent.message.delta", "session.status.changed"]);
    expectContiguousSequences([...live, ...replay]);
  });
});
