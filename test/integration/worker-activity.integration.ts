import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendSessionEvents,
  createDb,
  createSession,
  getSession,
  getLatestRunState,
  listSessionEvents,
} from "@infra-agents/db";
import { createNatsEventBus, type EventBus } from "@infra-agents/events";
import { createProductionAgentRuntime } from "@infra-agents/runtime";
import { createActivities } from "../../apps/worker/src/activities";
import { ScriptedModel, latestStatus, startTestServices, testSettings, type TestServices } from "@infra-agents/testing";

describe("worker activities integration", () => {
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

  test("streams scripted SDK model deltas into persisted session events", async () => {
    const session = await createSession(dbClient.db, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "hello from model", chunks: ["hello ", "from ", "model"] }]),
      }),
    });

    const result = await activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-activity",
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, session.id, 0, 50);
    expect(events.some((event) => event.type === "agent.message.delta")).toBe(true);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(latestStatus(events)).toBe("idle");
    expect((await getSession(dbClient.db, session.id))?.status).toBe("idle");
    expect(await getLatestRunState(dbClient.db, session.id)).not.toBeNull();
  });

  test("uses saved SDK history for follow-up turns", async () => {
    const model = new ScriptedModel([
      { outputText: "first answer", chunks: ["first ", "answer"] },
      { outputText: "second answer", chunks: ["second ", "answer"] },
    ]);
    const session = await createSession(dbClient.db, {
      initialMessage: "first question",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    const [firstTrigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "first question" } },
    ]);
    await activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: firstTrigger!.id,
      workflowId: "workflow-followup",
    });
    const [secondTrigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "second question" } },
    ]);
    await activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: secondTrigger!.id,
      workflowId: "workflow-followup",
    });

    expect(model.calls).toBe(2);
    const secondRequest = JSON.stringify(model.requests[1]?.input ?? {});
    expect(secondRequest).toContain("first question");
    expect(secondRequest).toContain("first answer");
    expect(secondRequest).toContain("second question");
  });

  test("marks session failed when scripted model throws", async () => {
    const session = await createSession(dbClient.db, {
      initialMessage: "fail",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "fail" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error: new Error("scripted failure") }]),
      }),
    });

    await expect(activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-fail",
    })).resolves.toEqual({ status: "failed" });
    const events = await listSessionEvents(dbClient.db, session.id, 0, 50);
    expect(events.some((event) => event.type === "turn.failed")).toBe(true);
    expect((await getSession(dbClient.db, session.id))?.status).toBe("failed");
  });
});
