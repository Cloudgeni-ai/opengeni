import { describe, expect, test } from "bun:test";
import { projectConversation } from "./App";
import type { Session, SessionEvent } from "./types";

describe("projectConversation", () => {
  test("keeps assistant messages and activity groups in event order", () => {
    const events = [
      event(1, "user.message", { text: "Inspect the repo" }),
      event(2, "turn.started", {}),
      event(3, "agent.message.delta", { text: "I will inspect first." }),
      event(4, "agent.reasoning.delta", { text: "raw private reasoning should never render" }),
      event(5, "agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" }),
      event(6, "agent.toolCall.output", { id: "call-1", output: "ok" }),
      event(7, "agent.message.delta", { text: "The repo is ready." }),
    ];

    const turns = projectConversation(session(), events);

    expect(turns.map((turn) => turn.kind)).toEqual(["user", "assistant", "activity", "assistant"]);
    expect(turns[1]).toMatchObject({ kind: "assistant", text: "I will inspect first.", status: "complete" });
    expect(turns[2]).toMatchObject({ kind: "activity", status: "complete" });
    expect(turns[3]).toMatchObject({ kind: "assistant", text: "The repo is ready.", status: "running" });
  });

  test("summarizes reasoning without exposing raw reasoning text", () => {
    const turns = projectConversation(session(), [
      event(1, "user.message", { text: "Think" }),
      event(2, "agent.reasoning.delta", { text: "sensitive raw reasoning" }),
    ]);

    const activity = turns.find((turn) => turn.kind === "activity");
    expect(activity).toBeDefined();
    expect(JSON.stringify(activity)).not.toContain("sensitive raw reasoning");
    expect(JSON.stringify(activity)).toContain("Internal reasoning is hidden.");
  });

  test("keeps per-turn attachments on user messages", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    const turns = projectConversation(session(), [
      event(1, "user.message", {
        text: "Use this file",
        resources: [{ kind: "file", fileId, mountPath: `files/${fileId}` }],
        tools: [{ kind: "mcp", id: "docs" }],
      }),
    ]);

    expect(turns[0]).toMatchObject({
      kind: "user",
      resources: [{ kind: "file", fileId, mountPath: `files/${fileId}` }],
      tools: [{ kind: "mcp", id: "docs" }],
    });
  });
});

function session(): Session {
  return {
    id: "session-1",
    status: "running",
    initialMessage: "Inspect the repo",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
    temporalWorkflowId: null,
    activeTurnId: "turn-1",
    lastSequence: 0,
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
  };
}

function event(sequence: number, type: string, payload: unknown): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    turnId: "turn-1",
    sequence,
    type,
    payload,
    occurredAt: `2026-05-07T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}
