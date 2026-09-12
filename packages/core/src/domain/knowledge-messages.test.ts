import { afterAll, beforeEach, expect, mock, test } from "bun:test";
const actor = {
  kind: "agent",
  sessionId: "session-a",
  turnId: "turn-a",
  attemptId: "attempt-a",
  executionGeneration: 1,
} as const;
const context = { accountId: "account", workspaceId: "workspace", actor };
let event: any;
let existing: any;
const policy = mock(async () => ({ defaultScope: "personal", subjectId: "user-a" }));
const save = mock(async (_db: any, _context: any, request: any) => ({
  entryId: request.entryId,
  revisionId: "revision",
  outcome: "pending",
}));
mock.module("@opengeni/db", () => ({
  freezeAgentLearningPolicy: policy,
  nestedPostgresSqlState: (error: any) => error.code,
  getSessionTurn: async () => ({ sessionId: "session-a", triggerEventId: "message-a" }),
  getSessionEvent: async () => event,
  getKnowledgeEntry: async () => existing,
  saveKnowledgeEntry: save,
}));
const { retainKnowledgeMessage } = await import("./knowledge-messages");
afterAll(() => mock.restore());
beforeEach(() => {
  event = {
    id: "message-a",
    sessionId: "session-a",
    type: "user.message",
    payload: { text: "I confirm it is 21k.\nKeep this exact." },
    occurredAt: "2026-09-11T12:00:00Z",
  };
  existing = null;
  save.mockClear();
});
test("retains exact text with message identity and preserves the review receipt", async () => {
  const result = await retainKnowledgeMessage({} as never, context);
  expect(result).toMatchObject({ retained: true, outcome: "pending", messageId: "message-a" });
  expect(save.mock.calls[0]?.[2].entry).toMatchObject({
    content: event.payload.text,
    source: {
      kind: "conversation",
      sessionId: "session-a",
      externalId: "message-a",
      capturedAt: event.occurredAt,
    },
  });
  expect(save.mock.calls[0]?.[2].scope).toBeUndefined();
});
test("refuses foreign-session and non-user events without writing", async () => {
  event.sessionId = "private-foreign";
  expect(await retainKnowledgeMessage({} as never, context, "foreign-event")).toMatchObject({
    retained: false,
  });
  event.sessionId = "session-a";
  event.type = "assistant.message";
  expect(await retainKnowledgeMessage({} as never, context)).toMatchObject({ retained: false });
  expect(save).not.toHaveBeenCalled();
});
test("reuses a retained message without creating another review request", async () => {
  existing = {
    archived: false,
    revision: {
      id: "already-retained",
      outcome: "pending",
      entry: { content: event.payload.text },
    },
  };
  expect(await retainKnowledgeMessage({} as never, context)).toMatchObject({
    retained: true,
    reused: true,
    revisionId: "already-retained",
    outcome: "pending",
  });
  expect(save).not.toHaveBeenCalled();
});
test("never revives rejected, archived, or edited retained content", async () => {
  for (const revision of [
    { outcome: "rejected", content: event.payload.text },
    { outcome: "published", content: "edited" },
  ]) {
    existing = { archived: false, revision: { ...revision, entry: { content: revision.content } } };
    expect(await retainKnowledgeMessage({} as never, context)).toMatchObject({ retained: false });
  }
  existing.archived = true;
  expect(await retainKnowledgeMessage({} as never, context)).toMatchObject({ retained: false });
  expect(save).not.toHaveBeenCalled();
});
