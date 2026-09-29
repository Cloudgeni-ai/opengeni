import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { creationHandoffReconciled } from "./session-creation-handoff";
import { projectSessionTimeline } from "./events";
import type { Session } from "@opengeni/sdk";
import type { TimelineItem } from "@opengeni/react";

const handoff = { session: { id: "A", workspaceId: "workspace" }, clientEventId: "create-request" };
const firstPrompt = {
  type: "user.message",
  sessionId: "A",
  workspaceId: "workspace",
  clientEventId: "create-request",
} as SessionEvent;

test("creation fallback remains pending until its exact durable first prompt is observed", () => {
  expect(creationHandoffReconciled(handoff, [])).toBe(false);
  for (const overrides of [
    { type: "agent.message.completed" },
    { sessionId: "B" },
    { workspaceId: "other" },
    { clientEventId: "another-prompt" },
  ])
    expect(
      creationHandoffReconciled(handoff, [{ ...firstPrompt, ...overrides } as SessionEvent]),
    ).toBe(false);
  expect(creationHandoffReconciled(handoff, [firstPrompt])).toBe(true);
  expect(creationHandoffReconciled(null, [firstPrompt])).toBe(false);
});

test("retiring the shared handoff is permanent through window eviction, failed reload and a later visit", () => {
  let current: typeof handoff | null = handoff;
  const observe = (events: SessionEvent[]) => {
    if (creationHandoffReconciled(current, events)) current = null;
  };
  observe([firstPrompt]);
  expect(current).toBeNull();
  observe([]); // pending/failed/latest tail no longer contains first prompt
  observe([{ ...firstPrompt, sessionId: "B" }]);
  observe([]); // return to A: cannot reinstall the consumed handoff
  expect(current).toBeNull();
  current = { ...handoff, clientEventId: "fresh-create" };
  observe([firstPrompt]);
  expect(current?.clientEventId).toBe("fresh-create");
});

test("web projection retains hook-owned navigation evidence instead of rebuilding only the raw window", () => {
  const session = {
    id: "A",
    initialMessage: "First",
    resources: [],
    tools: [],
    createdAt: "2026-01-01T00:00:00Z",
  } as unknown as Session;
  const witness = [
    {
      kind: "user-message",
      id: "queued-question",
      text: "Started later",
      resources: [],
      tools: [],
      occurredAt: session.createdAt,
    },
  ] as TimelineItem[];
  expect(projectSessionTimeline(session, [], undefined, witness)).toBe(witness);
  expect(projectSessionTimeline(session, [], undefined, witness)[0]?.id).toBe("queued-question");
});
