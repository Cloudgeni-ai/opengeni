import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline } from "../src/timeline";

const event = (sequence: number, type: string, payload: unknown): SessionEvent => ({
  id: `event-${sequence}`,
  workspaceId: "ws",
  sessionId: "session",
  turnId: "turn",
  sequence,
  type,
  payload,
  occurredAt: "2026-09-14T13:00:00Z",
});

test("partial replay never exposes an interactive message suffix", () => {
  const suffix = event(500, "agent.message.delta", {
    messageId: "preview",
    text: "body { color: red; }",
  });
  expect(buildTimeline([suffix], { partialStart: true })).toEqual([]);
  const text = "```opengeni-html\n<style>body { color: red; }</style>\n```";
  const complete = event(501, "agent.message.completed", {
    messageId: "preview",
    text,
  });
  const items = buildTimeline([suffix, complete], { partialStart: true });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    kind: "agent-message",
    text,
    streaming: false,
  });
});

test("known boundaries and subsequent messages still stream normally", () => {
  const delta = event(501, "agent.message.delta", { messageId: "new", text: "Hello" });
  for (const type of [
    "user.message",
    "turn.started",
    "session.created",
    "agent.message.completed",
  ]) {
    const items = buildTimeline([event(500, type, { text: "Prior", messageId: "prior" }), delta], {
      partialStart: true,
    });
    expect(items.at(-1)).toMatchObject({ kind: "agent-message", text: "Hello", streaming: true });
  }
  expect(buildTimeline([delta]).at(-1)).toMatchObject({ text: "Hello", streaming: true });
});

test("late deltas for a missing-prefix message do not leak after another receipt", () => {
  const items = buildTimeline(
    [
      event(500, "agent.message.delta", { messageId: "preview", text: "body {" }),
      event(501, "agent.message.completed", { messageId: "other", text: "Another response" }),
      event(502, "agent.message.delta", { messageId: "preview", text: " color: red; }" }),
    ],
    { partialStart: true },
  );
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ text: "Another response" });
});

test("accepted Steer cannot expose the old turn's partial preview", () => {
  for (const steer of [{ delivery: "steer" }, { routing: "accepted_for_steering" }]) {
    const accepted = {
      ...event(500, "user.message", { text: "Change direction", ...steer }),
      turnId: null,
    };
    const suffix = event(501, "agent.message.delta", {
      messageId: "old-preview",
      text: "body { color: red; }",
    });
    const partial = buildTimeline([accepted, suffix], { partialStart: true });
    expect(partial.filter((item) => item.kind === "agent-message")).toEqual([]);
    const text = "```opengeni-html\n<style>body { color: red; }</style>\n```";
    const restored = buildTimeline(
      [
        accepted,
        suffix,
        event(502, "agent.message.completed", { messageId: "old-preview", text }),
        { ...event(503, "turn.started", {}), turnId: "replacement" },
        {
          ...event(504, "agent.message.delta", { messageId: "new", text: "New direction" }),
          turnId: "replacement",
        },
      ],
      { partialStart: true },
    );
    expect(restored.filter((item) => item.kind === "agent-message")).toMatchObject([
      { text, streaming: false },
      { text: "New direction", streaming: true },
    ]);
  }
});

test("a boundary in another turn does not authorize an old message suffix", () => {
  const items = buildTimeline(
    [
      { ...event(500, "turn.started", {}), turnId: "replacement" },
      event(501, "agent.message.delta", { messageId: "old-preview", text: "body { color: red; }" }),
    ],
    { partialStart: true },
  );
  expect(items.filter((item) => item.kind === "agent-message")).toEqual([]);
});
