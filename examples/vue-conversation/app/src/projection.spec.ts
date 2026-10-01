import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { project } from "./projection";
import { friendlyError } from "./useConversation";
import { OpenGeniApiError } from "@opengeni/sdk";

export function event(
  sequence: number,
  type: SessionEvent["type"],
  payload: unknown,
  turnId = "turn-a",
): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "ws-a",
    sessionId: "session-a",
    sequence,
    type,
    payload,
    turnId,
    occurredAt: "2026-10-01T12:00:00Z",
  };
}
test("completed messages replace deltas; terminal output does not duplicate text", () => {
  const result = project([
    event(1, "user.message", { text: "Plan a day out" }),
    event(2, "agent.message.delta", { text: "Visit", messageId: "m1" }),
    event(3, "agent.message.delta", { text: " the harbor", messageId: "m1" }),
    event(4, "agent.message.completed", { text: "Visit the harbor.", messageId: "m1" }),
    event(5, "turn.completed", { output: "Visit the harbor." }),
  ]);
  expect(result.messages.map((m) => m.text)).toEqual(["Plan a day out", "Visit the harbor."]);
  expect(result.messages[1]?.streaming).toBe(false);
});
test("replay shows only undecided approvals and does not clear another turn's approval", () => {
  const events = [
    event(1, "session.requiresAction", {
      approvals: [{ id: "call-a", name: "reserve", arguments: { guests: 2 } }],
    }),
  ];
  expect(
    project([...events, event(2, "turn.cancelled", {}, "queued-other")]).approvals.length,
  ).toBe(1);
  expect(
    project([
      ...events,
      event(2, "user.approvalDecision", { approvalId: "call-a", decision: "reject" }),
    ]).approvals,
  ).toEqual([]);
  expect(project([...events, event(2, "turn.failed", {})]).approvals).toEqual([]);
});
test("future events do not become chat prose and failures are visible", () => {
  expect(
    project([
      event(1, "future.additive" as SessionEvent["type"], { text: "secret-looking tool payload" }),
    ]).messages,
  ).toEqual([]);
  expect(
    project([event(1, "turn.failed", { error: "OpenGeni internal error" })]).failure,
  ).toContain("could not finish");
});
test("host error copy never leaks provider branding or raw diagnostic bodies", () => {
  for (const status of [401, 402, 403, 409, 422, 500, 503]) {
    expect(
      friendlyError(new OpenGeniApiError(status, "OpenGeni internal diagnostic")),
    ).not.toContain("OpenGeni");
  }
});
