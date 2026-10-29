import { describe, expect, test } from "bun:test";
import { WORKSPACE_WEBHOOK_EVENT_TYPES } from "@opengeni/contracts";
import {
  boundEvent,
  workspaceActivityEvent,
  workspaceDeliveryBody,
  workspaceDeliveryEvents,
  workspaceEventTypeCatalog,
  workspaceEventTypesNotOffered,
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
