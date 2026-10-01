import { expect, test } from "bun:test";
import { EMPTY_FINAL_REPLY_NOTICE, type SessionEvent } from "@opengeni/sdk";
import { buildTimeline, groupTimeline } from "../src/timeline";

test("a repeated-empty completion renders an informational notice, not failure or a fake answer", () => {
  const event = {
    id: "empty-completion",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    sequence: 1,
    type: "turn.completed",
    payload: { output: "", emptyFinalReply: true },
    occurredAt: "2026-09-30T17:30:00.000Z",
  } as SessionEvent;
  const items = buildTimeline([event]);
  expect(items).toContainEqual(
    expect.objectContaining({
      kind: "notice",
      tone: "input",
      recordedOutcome: true,
      text: EMPTY_FINAL_REPLY_NOTICE,
    }),
  );
  expect(items.some((item) => item.kind === "agent-message")).toBe(false);
  expect(items.some((item) => item.kind === "turn-end" && item.outcome === "failed")).toBe(false);
  expect(
    groupTimeline(items).some((group) => group.kind === "item" && group.item.kind === "notice"),
  ).toBe(true);
});
