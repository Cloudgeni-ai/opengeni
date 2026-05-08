import { describe, expect, test } from "bun:test";
import { applySessionStatusEvents, buildTools, projectConversation } from "./App";
import type { Session, SessionEvent } from "./types";

describe("projectConversation", () => {
  test("keeps assistant messages and activity groups in event order", () => {
    const events = [
      event(1, "user.message", { text: "Inspect the repo" }),
      event(2, "turn.started", {}),
      event(3, "agent.message.delta", { text: "I will inspect first." }),
      event(4, "agent.reasoning.delta", { text: "Checking the repository state." }),
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

  test("renders reasoning summary text", () => {
    const turns = projectConversation(session(), [
      event(1, "user.message", { text: "Think" }),
      event(2, "agent.reasoning.delta", { text: "Checking credentials" }),
      event(3, "agent.reasoning.delta", { text: " and repository state." }),
    ]);

    const activity = turns.find((turn) => turn.kind === "activity");
    expect(activity).toBeDefined();
    expect(JSON.stringify(activity)).toContain("Reasoning summary");
    expect(JSON.stringify(activity)).toContain("Checking credentials and repository state.");
    expect(JSON.stringify(activity)).not.toContain("Internal reasoning is hidden.");
  });

  test("renders legacy reasoning item payloads safely", () => {
    const turns = projectConversation(session(), [
      event(1, "user.message", { text: "Think" }),
      event(2, "agent.reasoning.delta", {
        item: {
          rawItem: {
            content: [{ type: "input_text", text: "Legacy summary text." }],
          },
        },
      }),
    ]);

    const activity = turns.find((turn) => turn.kind === "activity");
    expect(JSON.stringify(activity)).toContain("Legacy summary text.");
    expect(JSON.stringify(activity)).not.toContain("rawItem");
  });

  test("turn completion completes earlier running activity groups", () => {
    const turns = projectConversation(session(), [
      event(1, "user.message", { text: "Check auth" }),
      event(2, "agent.reasoning.delta", { text: "Checking auth." }),
      event(3, "agent.message.completed", { text: "Done." }),
      event(4, "turn.completed", { output: "Done." }),
    ]);

    const activity = turns.find((turn) => turn.kind === "activity");
    expect(activity).toMatchObject({ kind: "activity", status: "complete" });
    expect(JSON.stringify(activity)).not.toContain("running");
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

describe("buildTools", () => {
  test("adds document search once when enabled", () => {
    expect(buildTools(undefined, true)).toEqual([{ kind: "mcp", id: "docs" }]);
    expect(buildTools([{ kind: "mcp", id: "docs" }], true)).toEqual([{ kind: "mcp", id: "docs" }]);
  });

  test("preserves existing tools when document search is disabled", () => {
    expect(buildTools([{ kind: "mcp", id: "custom" }], false)).toEqual([{ kind: "mcp", id: "custom" }]);
  });
});

describe("applySessionStatusEvents", () => {
  test("trusts terminal status events without requiring a session refetch", () => {
    const next = applySessionStatusEvents(session(), [
      event(1, "session.status.changed", { status: "idle" }),
    ]);

    expect(next.status).toBe("idle");
    expect(next.activeTurnId).toBeNull();
  });

  test("ignores invalid status payloads", () => {
    const current = session();
    expect(applySessionStatusEvents(current, [
      event(1, "session.status.changed", { status: "done" }),
    ])).toBe(current);
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
