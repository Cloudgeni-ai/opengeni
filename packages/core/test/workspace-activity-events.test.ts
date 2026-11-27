import { describe, expect, test } from "bun:test";
import { WORKSPACE_WEBHOOK_EVENT_TYPES } from "@opengeni/contracts";
import {
  boundEvent,
  workspaceActivityEvent,
  workspaceDeliveryBody,
  workspaceDeliveryEvents,
  workspaceEventTypeCatalog,
  workspaceEventTypesNotOffered,
  workspaceRecordingEvent,
  type WorkspaceActivityFact,
  type WorkspaceRecordingFact,
} from "../src/domain/event-triggers";

const ada = "subject-ada";
const bob = "subject-bob";

function fact(overrides: Partial<WorkspaceActivityFact> = {}): WorkspaceActivityFact {
  return {
    id: "8b0c7f0e-1111-4c2b-9a51-000000000001",
    type: "turn.completed",
    occurredAt: "2026-10-29T12:00:00.000Z",
    sessionId: "8b0c7f0e-2222-4c2b-9a51-000000000002",
    turnId: "8b0c7f0e-3333-4c2b-9a51-000000000003",
    subjectId: ada,
    automationId: null,
    automationRunId: null,
    chainDepth: 0,
    data: { answerExcerpt: "Done." },
    chatTitle: "Weekly report",
    automationName: null,
    subjectLabel: "Ada",
    url: "https://opengeni.example/workspaces/w/sessions/s",
    ...overrides,
  };
}

describe("This workspace event types", () => {
  test("the catalog is the webhook list, in its order, minus the explicit exclusions", () => {
    expect(workspaceEventTypesNotOffered()).toEqual([
      "session.status.changed",
      "session.notification.withdrawn",
      "session.agentCall.ringing",
      "session.agentCall.settled",
      "turn.superseded",
    ]);
    expect(workspaceEventTypeCatalog().map((entry) => entry.type)).toEqual(
      WORKSPACE_WEBHOOK_EVENT_TYPES.filter(
        (type) => !workspaceEventTypesNotOffered().includes(type),
      ),
    );
    for (const entry of workspaceEventTypeCatalog()) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.fields.length).toBeGreaterThan(0);
    }
    expect(
      workspaceEventTypeCatalog()
        .find((entry) => entry.type === "turn.completed")
        ?.fields.map((field) => field.field),
    ).toEqual(
      expect.arrayContaining(["data.sessionId", "data.startedByYou", "data.answerExcerpt"]),
    );
  });
});

describe("activity facts as events", () => {
  test("a person's chat is theirs; startedByYou follows the reader", () => {
    const forAda = workspaceActivityEvent(fact(), ada);
    expect(forAda).toMatchObject({
      externalId: fact().id,
      type: "turn.completed",
      subject: "Weekly report",
      summary: "Chat finished: Weekly report",
      url: fact().url,
      actor: { kind: "person", name: "Ada" },
      chainDepth: 0,
      data: {
        answerExcerpt: "Done.",
        sessionId: fact().sessionId,
        turnId: fact().turnId,
        chatTitle: "Weekly report",
        startedByYou: true,
      },
    });
    expect(workspaceActivityEvent(fact(), bob).data.startedByYou).toBe(false);
    expect(workspaceActivityEvent(fact({ chatTitle: null }), ada).summary).toBe("Chat finished");
  });

  test("a chat an automation run caused is Opengeni's own and keeps its depth", () => {
    const event = workspaceActivityEvent(
      fact({
        type: "turn.failed",
        automationId: "task-1",
        automationRunId: "run-1",
        automationName: "Nightly report",
        chainDepth: 2,
        data: { error: { code: "model_error", message: "The model failed" } },
      }),
      ada,
    );
    expect(event).toMatchObject({
      summary: "Chat failed: Weekly report",
      actor: { kind: "opengeni", name: "Nightly report" },
      chainDepth: 2,
      data: { automationId: "task-1", automationRunId: "run-1", startedByYou: true },
    });
    // Opengeni's own notices carry no turn.
    expect(workspaceActivityEvent(fact({ turnId: null }), ada).actor.kind).toBe("opengeni");
    expect(boundEvent(event, new Date()).chainDepth).toBe(2);
  });

  test("a notification says whether it was for the reader", () => {
    const posted = fact({
      type: "session.notification.posted",
      data: { title: "Build broke", recipientSubjectId: bob },
    });
    expect(workspaceActivityEvent(posted, bob).data.forYou).toBe(true);
    expect(workspaceActivityEvent(posted, ada).data.forYou).toBe(false);
  });

  test("usage facts name whose limit and whether it is the reader's", () => {
    const usage = fact({
      type: "usage.threshold_reached",
      sessionId: null,
      turnId: null,
      subjectId: null,
      chatTitle: null,
      subjectLabel: null,
      url: null,
      data: { scope: "workspace", threshold: 0.8, usedCredits: 80, limitCredits: 100 },
    });
    expect(workspaceActivityEvent(usage, ada)).toMatchObject({
      subject: null,
      summary: "Usage reached 80% of the workspace's limit",
      actor: { kind: "unknown" },
      chainDepth: 0,
      data: { scope: "workspace", threshold: 0.8, forYou: false },
    });
    const own = { ...usage, type: "usage.exhausted", subjectId: bob, data: { scope: "member" } };
    expect(workspaceActivityEvent(own, bob)).toMatchObject({
      summary: "Usage used up your limit",
      data: { forYou: true },
    });
    expect(workspaceActivityEvent(own, ada).summary).toBe("Usage used up a member's limit");
  });

  test("replaying a delivery produces the same events, depth included", () => {
    const recording: WorkspaceRecordingFact = {
      id: "8b0c7f0e-4444-4c2b-9a51-000000000004",
      recordingId: "8b0c7f0e-5555-4c2b-9a51-000000000005",
      type: "recording.transcript.ready",
      occurredAt: "2026-10-29T12:00:00.000Z",
      data: { ownerSubjectId: ada, visibility: "private" },
      title: "Weekly sync",
      purpose: "meeting",
    };
    const activity = [fact(), fact({ id: "other", automationRunId: "run-1", chainDepth: 3 })];
    const body = workspaceDeliveryBody([recording], activity);
    expect(workspaceDeliveryEvents(body, ada)).toEqual([
      expect.objectContaining({ type: "recording.transcript.ready" }),
      workspaceActivityEvent(activity[0]!, ada),
      workspaceActivityEvent(activity[1]!, ada),
    ]);
    // A recordings-only body keeps its earlier shape.
    expect(JSON.parse(new TextDecoder().decode(workspaceDeliveryBody([recording])))).toEqual({
      recordingEvents: [recording],
    });
  });
});

describe("App data change facts as events", () => {
  const appFact = (overrides: Partial<WorkspaceActivityFact> = {}) =>
    fact({
      type: "app.record.added",
      sessionId: null,
      turnId: null,
      appId: "8b0c7f0e-6666-4c2b-9a51-000000000006",
      appTitle: "Leads",
      data: {
        collection: "contacts",
        recordId: "r1",
        recordKey: "ada@example.com",
      },
      url: "https://opengeni.example/workspaces/w/apps/a",
      ...overrides,
    });

  test("a person's write is theirs and names the App and collection", () => {
    const event = workspaceActivityEvent(appFact(), ada);
    expect(event).toMatchObject({
      type: "app.record.added",
      subject: "ada@example.com",
      summary: "Record added in Leads / contacts",
      actor: { kind: "person", name: "Ada" },
      chainDepth: 0,
      data: {
        appId: appFact().appId,
        appTitle: "Leads",
        collection: "contacts",
        writtenByYou: true,
      },
    });
    expect(workspaceActivityEvent(appFact(), bob).data).toMatchObject({
      writtenByYou: false,
    });
  });

  test("an automation's write is Opengeni's own and keeps its chain depth", () => {
    const event = workspaceActivityEvent(
      appFact({
        automationId: "a1",
        automationRunId: "run-1",
        automationName: "Sync",
        chainDepth: 2,
      }),
      ada,
    );
    expect(event.actor).toEqual({ kind: "opengeni", name: "Sync" });
    expect(event.chainDepth).toBe(2);
    expect(event.data).toMatchObject({
      automationId: "a1",
      automationRunId: "run-1",
    });
  });

  test("a write without a person, such as a guest or key, has an unknown actor", () => {
    expect(workspaceActivityEvent(appFact({ subjectId: null }), ada).actor).toEqual({
      kind: "unknown",
      name: null,
    });
  });

  test("every App event type is offered with fields", () => {
    const types = workspaceEventTypeCatalog().map((entry) => entry.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "app.record.added",
        "app.record.changed",
        "app.record.removed",
        "app.sql.changed",
      ]),
    );
  });
});

describe("what everyone in the workspace may see", () => {
  const meeting = (overrides: Partial<WorkspaceRecordingFact> = {}): WorkspaceRecordingFact => ({
    id: "8b0c7f0e-7777-4c2b-9a51-000000000007",
    recordingId: "8b0c7f0e-8888-4c2b-9a51-000000000008",
    type: "recording.transcript.ready",
    occurredAt: "2026-10-29T12:00:00.000Z",
    data: { ownerSubjectId: ada, visibility: "workspace" },
    title: "Salary talk",
    purpose: "meeting",
    ...overrides,
  });
  const visibilityOf = (recording: WorkspaceRecordingFact) =>
    workspaceRecordingEvent(recording, ada).data.visibility;

  test("a meeting is workspace only while the workspace may see it", () => {
    expect(visibilityOf(meeting({ sharedWithWorkspace: true }))).toBe("workspace");
    // Made private since the event: the feed's current view wins over the event's data.
    expect(visibilityOf(meeting({ sharedWithWorkspace: false }))).toBe("private");
    // A body stored before the feed said so falls back to the event's own visibility.
    expect(visibilityOf(meeting())).toBe("workspace");
    expect(visibilityOf(meeting({ data: { ownerSubjectId: ada, visibility: "private" } }))).toBe(
      "private",
    );
  });

  test("chats, Apps and usage are private unless the feed says everyone may see them", () => {
    const visibility = (value: WorkspaceActivityFact) =>
      workspaceActivityEvent(value, ada).data.visibility;
    expect(visibility(fact({ sharedWithWorkspace: true }))).toBe("workspace");
    expect(visibility(fact())).toBe("private");
    // A fact's own data never claims a wider audience than the feed gave it.
    expect(visibility(fact({ data: { visibility: "workspace" } }))).toBe("private");
    const app = fact({ type: "app.record.added", sessionId: null, appId: "app", data: {} });
    expect(visibility(app)).toBe("private");
    expect(visibility({ ...app, sharedWithWorkspace: true })).toBe("workspace");
    const usage = fact({ type: "usage.exhausted", sessionId: null, data: { scope: "workspace" } });
    expect(visibility(usage)).toBe("private");
  });

  test("the visibility survives a replay and data cut down to its first scalars", () => {
    const body = workspaceDeliveryBody(
      [meeting({ sharedWithWorkspace: false })],
      [fact({ sharedWithWorkspace: true }), fact()],
    );
    expect(workspaceDeliveryEvents(body, ada).map((event) => event.data.visibility)).toEqual([
      "private",
      "workspace",
      "private",
    ]);
    const huge = fact({ data: { answerExcerpt: "x".repeat(200_000) } });
    const bounded = boundEvent(workspaceActivityEvent(huge, ada), new Date());
    expect(bounded.dataTruncated).toBe(true);
    expect(bounded.data.visibility).toBe("private");
  });

  test("every offered type documents data.visibility", () => {
    for (const entry of workspaceEventTypeCatalog()) {
      expect(entry.fields.map((field) => field.field)).toContain("data.visibility");
    }
  });
});
