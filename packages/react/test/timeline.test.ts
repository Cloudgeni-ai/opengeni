import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import {
  buildTimeline,
  extractSessionRef,
  groupTimeline,
  sessionStatusFromEvents,
  type AgentMessageItem,
  type SandboxItem,
  type ToolCallItem,
  type UserMessageItem,
  type WorkerItem,
} from "../src/timeline";

let sequence = 0;

function event(type: string, payload: unknown, options: { turnId?: string | null } = {}): SessionEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(1718000000000 + sequence * 1000).toISOString(),
    turnId: options.turnId ?? "turn-1",
  };
}

function reset(): void {
  sequence = 0;
}

describe("buildTimeline", () => {
  test("accumulates streaming deltas into one agent message and finalizes on completed", () => {
    reset();
    const items = buildTimeline([
      event("user.message", { text: "Deploy staging" }),
      event("agent.message.delta", { text: "On it — " }),
      event("agent.message.delta", { text: "checking the cluster." }),
      event("agent.message.completed", { text: "On it — checking the cluster." }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user-message", "agent-message"]);
    const message = items[1] as AgentMessageItem;
    expect(message.text).toBe("On it — checking the cluster.");
    expect(message.streaming).toBe(false);
  });

  test("keeps accumulated text when completed text does not extend it", () => {
    reset();
    const items = buildTimeline([
      event("agent.message.delta", { text: "Streamed body" }),
      event("agent.message.completed", { text: "different" }),
    ]);
    const message = items[0] as AgentMessageItem;
    expect(message.text).toBe("Streamed body");
    expect(message.streaming).toBe(false);
  });

  test("completed reconciles the same-turn message even after intervening activity", () => {
    reset();
    const items = buildTimeline([
      event("agent.message.delta", { text: "Checking the cluster" }),
      event("agent.toolCall.created", { id: "call-1", name: "exec", arguments: { cmd: "kubectl get pods" } }),
      event("agent.toolCall.output", { id: "call-1", output: "ok" }),
      event("agent.message.completed", { text: "Checking the cluster now." }),
    ]);
    const messages = items.filter((item) => item.kind === "agent-message");
    expect(messages).toHaveLength(1);
    expect((messages[0] as AgentMessageItem).text).toBe("Checking the cluster now.");
    expect((messages[0] as AgentMessageItem).streaming).toBe(false);
  });

  test("a steering user message does not complete in-flight tool calls", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "terraform_apply", arguments: {} }),
      event("user.message", { text: "Hold off on the database changes" }),
    ]);
    expect((items[0] as ToolCallItem).status).toBe("running");
    expect(items[1]?.kind).toBe("user-message");
  });

  test("user messages carry their attached resources and requested tools", () => {
    reset();
    const items = buildTimeline([
      event("user.message", {
        text: "Review the repo",
        resources: [
          { kind: "repository", uri: "https://github.com/org/repo.git", ref: "main" },
          { kind: "file", fileId: "file-1" },
          { kind: "file" }, // malformed: dropped
          "garbage",
        ],
        tools: [{ kind: "mcp", id: "opengeni" }, { kind: "other", id: "x" }],
      }),
    ]);
    expect(items[0]?.kind).toBe("user-message");
    const message = items[0] as UserMessageItem;
    expect(message.resources).toEqual([
      { kind: "repository", uri: "https://github.com/org/repo.git", ref: "main" },
      { kind: "file", fileId: "file-1" },
    ]);
    expect(message.tools).toEqual([{ kind: "mcp", id: "opengeni" }]);
  });

  test("user messages without payload extras get empty resource and tool lists", () => {
    reset();
    const items = buildTimeline([event("user.message", { text: "hi" })]);
    const message = items[0] as UserMessageItem;
    expect(message.resources).toEqual([]);
    expect(message.tools).toEqual([]);
  });

  test("a delta after a tool call starts a new message instead of appending", () => {
    reset();
    const items = buildTimeline([
      event("agent.message.delta", { text: "First." }),
      event("agent.toolCall.created", { id: "call-1", name: "exec", arguments: { cmd: "ls" } }),
      event("agent.toolCall.output", { id: "call-1", output: "ok" }),
      event("agent.message.delta", { text: "Second." }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["agent-message", "tool-call", "agent-message"]);
    expect((items[0] as AgentMessageItem).streaming).toBe(false);
  });

  test("matches tool outputs to calls by id and marks them complete", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "terraform_plan", arguments: { dir: "infra" } }),
      event("agent.toolCall.created", { id: "call-2", name: "read_file", arguments: { path: "main.tf" } }),
      event("agent.toolCall.output", { id: "call-2", output: "resource {}" }),
    ]);
    const first = items[0] as ToolCallItem;
    const second = items[1] as ToolCallItem;
    expect(first.status).toBe("running");
    expect(second.status).toBe("complete");
    expect(second.output).toBe("resource {}");
  });

  test("session_create becomes a worker item with prompt and spawned session id from MCP output", () => {
    reset();
    const worker = {
      id: "0b3ba745-1111-4222-8333-9c76ad9e0000",
      workspaceId: "ws-1",
      status: "queued",
    };
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_create",
        arguments: JSON.stringify({ initialMessage: "Run the drift check on prod" }),
      }),
      event("agent.toolCall.output", {
        id: "call-1",
        output: { content: [{ type: "text", text: JSON.stringify(worker) }] },
      }),
    ]);
    expect(items).toHaveLength(1);
    const item = items[0] as WorkerItem;
    expect(item.kind).toBe("worker");
    expect(item.action).toBe("spawn");
    expect(item.prompt).toBe("Run the drift check on prod");
    expect(item.status).toBe("complete");
    expect(item.workerSessionId).toBe(worker.id);
  });

  test("session_send_message becomes a worker message item targeting the session in the arguments", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_send_message",
        arguments: { sessionId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", message: "Status?" },
      }),
    ]);
    const item = items[0] as WorkerItem;
    expect(item.action).toBe("message");
    expect(item.workerSessionId).toBe("7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d");
    expect(item.prompt).toBe("Status?");
  });

  test("groups sandbox operations by name and appends command output deltas", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "exec", command: "terraform apply" }),
      event("sandbox.command.output.delta", { text: "Applying…\n" }),
      event("sandbox.command.output.delta", { text: "Done." }),
      event("sandbox.operation.completed", { name: "exec" }),
    ]);
    expect(items).toHaveLength(1);
    const sandbox = items[0] as SandboxItem;
    expect(sandbox.command).toBe("terraform apply");
    expect(sandbox.output).toBe("Applying…\nDone.");
    expect(sandbox.status).toBe("complete");
  });

  test("named output deltas route to their own operation among concurrent ones", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "build", command: "docker build ." }),
      event("sandbox.operation.started", { name: "test", command: "bun test" }),
      event("sandbox.command.output.delta", { name: "build", text: "Step 1/4\n" }),
      event("sandbox.command.output.delta", { name: "test", text: "3 pass\n" }),
    ]);
    const build = items.find((item): item is SandboxItem => item.kind === "sandbox" && item.name === "build");
    const test_ = items.find((item): item is SandboxItem => item.kind === "sandbox" && item.name === "test");
    expect(build?.output).toBe("Step 1/4\n");
    expect(test_?.output).toBe("3 pass\n");
  });

  test("failed sandbox operations carry the error message", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "exec", command: "kubectl apply" }),
      event("sandbox.operation.failed", { name: "exec", error: "connection refused" }),
    ]);
    const sandbox = items[0] as SandboxItem;
    expect(sandbox.status).toBe("failed");
    expect(sandbox.output).toContain("connection refused");
  });

  test("collapses repeated status changes and surfaces notices for failures and interrupts", () => {
    reset();
    const items = buildTimeline([
      event("session.status.changed", { status: "running" }),
      event("session.status.changed", { status: "running" }),
      event("turn.failed", { error: "model provider unavailable" }),
      event("turn.cancelled", {}),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["session-status", "notice", "notice"]);
    expect(items[1]).toMatchObject({ tone: "failed", text: "model provider unavailable" });
    expect(items[2]).toMatchObject({ tone: "cancelled" });
  });

  test("turn.completed finalizes the turn's streaming and running items", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "exec", arguments: {} }),
      event("agent.message.delta", { text: "Wrapping up." }),
      event("turn.completed", {}),
    ]);
    expect((items[0] as ToolCallItem).status).toBe("complete");
    expect((items[1] as AgentMessageItem).streaming).toBe(false);
  });

  test("goal events become goal markers with text", () => {
    reset();
    const items = buildTimeline([event("goal.set", { goal: { text: "Keep staging green" } })]);
    expect(items[0]).toMatchObject({ kind: "goal", action: "set", text: "Keep staging green" });
  });

  test("session.requiresAction becomes a waiting notice", () => {
    reset();
    const items = buildTimeline([event("session.requiresAction", { approvals: [] })]);
    expect(items[0]).toMatchObject({ kind: "notice", tone: "waiting" });
  });

  test("unknown event types are ignored, keeping the projection forward-compatible", () => {
    reset();
    const items = buildTimeline([
      event("user.message", { text: "hi" }),
      event("billing.snapshot.created", { amount: 1 }),
    ]);
    expect(items).toHaveLength(1);
  });

  test("is order-insensitive on input (sorts by sequence)", () => {
    reset();
    const ordered = [
      event("user.message", { text: "hi" }),
      event("agent.message.delta", { text: "a" }),
      event("agent.message.delta", { text: "b" }),
    ];
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];
    const items = buildTimeline(shuffled);
    expect((items[1] as AgentMessageItem).text).toBe("ab");
  });
});

describe("groupTimeline", () => {
  test("clusters consecutive activity between messages", () => {
    reset();
    const items = buildTimeline([
      event("user.message", { text: "go" }),
      event("agent.reasoning.delta", { text: "thinking" }),
      event("agent.toolCall.created", { id: "c1", name: "exec", arguments: {} }),
      event("agent.toolCall.output", { id: "c1", output: "done" }),
      event("agent.message.delta", { text: "All done." }),
    ]);
    const groups = groupTimeline(items);
    expect(groups.map((group) => group.kind)).toEqual(["item", "activity", "item"]);
    const activity = groups[1];
    if (activity?.kind !== "activity") {
      throw new Error("expected activity group");
    }
    expect(activity.items.map((item) => item.kind)).toEqual(["reasoning", "tool-call"]);
  });
});

describe("sessionStatusFromEvents", () => {
  test("returns the latest status and null when absent", () => {
    reset();
    const events = [
      event("session.status.changed", { status: "running" }),
      event("session.status.changed", { status: "idle" }),
    ];
    expect(sessionStatusFromEvents(events)).toBe("idle");
    expect(sessionStatusFromEvents([event("user.message", { text: "x" })])).toBeNull();
  });
});

describe("extractSessionRef", () => {
  const id = "3f6e1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";

  test("finds ids in raw objects, json strings, and MCP content wrappers", () => {
    expect(extractSessionRef({ sessionId: id })).toBe(id);
    expect(extractSessionRef({ id, status: "queued" })).toBe(id);
    expect(extractSessionRef(JSON.stringify({ session: { id, workspaceId: "ws" } }))).toBe(id);
    expect(extractSessionRef({ content: [{ type: "text", text: JSON.stringify({ id, status: "queued" }) }] })).toBe(id);
    expect(extractSessionRef({ structuredContent: { sessionId: id } })).toBe(id);
  });

  test("rejects non-uuid ids and unrelated payloads", () => {
    expect(extractSessionRef({ id: "not-a-uuid", status: "queued" })).toBeNull();
    expect(extractSessionRef("plain text output")).toBeNull();
    expect(extractSessionRef(null)).toBeNull();
  });
});
