import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import {
  buildTimeline,
  extractSessionRef,
  groupTimeline,
  sessionStatusFromEvents,
  type AgentMessageItem,
  type SandboxItem,
  type TimelineGroup,
  type TurnEndItem,
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
    turnId: options.turnId === undefined ? "turn-1" : options.turnId,
  };
}

function eventAt(sequenceNumber: number, type: string, payload: unknown, options: { turnId?: string | null } = {}): SessionEvent {
  return {
    id: `evt-${sequenceNumber}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence: sequenceNumber,
    type,
    payload,
    occurredAt: new Date(1718000000000 + sequenceNumber * 1000).toISOString(),
    turnId: options.turnId === undefined ? "turn-1" : options.turnId,
  };
}

function reset(): void {
  sequence = 0;
}

type ActivityGroup = Extract<TimelineGroup, { kind: "activity" }>;
type TurnGroup = Extract<TimelineGroup, { kind: "turn" }>;

function activityGroups(groups: TimelineGroup[]): ActivityGroup[] {
  const activities: ActivityGroup[] = [];
  for (const group of groups) {
    if (group.kind === "activity") {
      activities.push(group);
    } else if (group.kind === "turn") {
      activities.push(...activityGroups(group.groups));
    }
  }
  return activities;
}

function turnGroups(groups: TimelineGroup[]): TurnGroup[] {
  return groups.filter((group): group is TurnGroup => group.kind === "turn");
}

function flattenActivityIds(group: TurnGroup | undefined): string[] {
  return activityGroups(group?.groups ?? []).flatMap((activity) => activity.items.map((item) => item.id));
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

  test("legacy user messages with no queued turn keep their ledger position", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } }, { turnId: "turn-a" }),
      event("user.message", { text: "legacy steering" }, { turnId: null }),
      event("agent.toolCall.created", { id: "call-2", name: "exec_command", arguments: { cmd: "make test" } }, { turnId: "turn-a" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["tool-call", "user-message", "tool-call"]);
    expect((items[1] as UserMessageItem).text).toBe("legacy steering");
  });

  test("a genesis user message with queued and started events stays first", () => {
    const items = buildTimeline([
      eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
      eventAt(4, "turn.queued", { turnId: "turn-a", triggerEventId: "evt-2", source: "user" }, { turnId: "turn-a" }),
      eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
      eventAt(9, "agent.message.completed", { text: "First answer." }, { turnId: "turn-a" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user-message", "agent-message"]);
    expect((items[0] as UserMessageItem).text).toBe("First message");
  });

  test("a queued user message anchors where its turn starts instead of its ledger sequence", () => {
    const groups = groupTimeline(
      buildTimeline([
        eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
        eventAt(4, "turn.queued", { turnId: "turn-a", triggerEventId: "evt-2", source: "user" }, { turnId: "turn-a" }),
        eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
        eventAt(9, "agent.toolCall.created", { id: "call-a-1", name: "exec_command", arguments: { cmd: "first step" } }, { turnId: "turn-a" }),
        eventAt(16, "user.message", { text: "QUEUED-MSG" }, { turnId: null }),
        eventAt(17, "turn.queued", { turnId: "turn-b", triggerEventId: "evt-16", source: "user" }, { turnId: "turn-b" }),
        eventAt(41, "agent.toolCall.created", { id: "call-a-2", name: "exec_command", arguments: { cmd: "second step" } }, { turnId: "turn-a" }),
        eventAt(57, "agent.message.completed", { text: "Turn A final answer." }, { turnId: "turn-a" }),
        eventAt(58, "turn.completed", {}, { turnId: "turn-a" }),
        eventAt(61, "turn.started", { triggerEventId: "evt-16" }, { turnId: "turn-b" }),
        eventAt(62, "agent.toolCall.created", { id: "call-b-1", name: "exec_command", arguments: { cmd: "queued work" } }, { turnId: "turn-b" }),
        eventAt(80, "agent.message.completed", { text: "Turn B final answer." }, { turnId: "turn-b" }),
        eventAt(94, "turn.completed", {}, { turnId: "turn-b" }),
      ]),
    );

    expect(groups.map((group) => (group.kind === "item" ? `${group.kind}:${group.item.kind}` : group.kind))).toEqual([
      "item:user-message",
      "turn",
      "item:agent-message",
      "item:user-message",
      "turn",
      "item:agent-message",
    ]);
    const turns = turnGroups(groups);
    expect(turns).toHaveLength(2);
    expect(flattenActivityIds(turns[0])).toEqual(["evt-9", "evt-41"]);
    expect(flattenActivityIds(turns[1])).toEqual(["evt-62"]);
    expect(groups[2]?.kind === "item" ? groups[2].item : null).toMatchObject({ kind: "agent-message", text: "Turn A final answer." });
    expect(groups[3]?.kind === "item" ? groups[3].item : null).toMatchObject({ kind: "user-message", text: "QUEUED-MSG" });
  });

  test("a queued user message stays pending at the end until the queued turn starts", () => {
    const pendingItems = buildTimeline([
      eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
      eventAt(4, "turn.queued", { turnId: "turn-a", triggerEventId: "evt-2", source: "user" }, { turnId: "turn-a" }),
      eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
      eventAt(9, "agent.message.delta", { text: "Still working." }, { turnId: "turn-a" }),
      eventAt(16, "user.message", { text: "Queued follow-up" }, { turnId: null }),
      eventAt(17, "turn.queued", { turnId: "turn-b", triggerEventId: "evt-16", source: "user" }, { turnId: "turn-b" }),
    ]);
    expect(pendingItems.at(-1)).toMatchObject({ kind: "user-message", text: "Queued follow-up", pending: true });

    const anchoredItems = buildTimeline([
      eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
      eventAt(4, "turn.queued", { turnId: "turn-a", triggerEventId: "evt-2", source: "user" }, { turnId: "turn-a" }),
      eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
      eventAt(9, "agent.message.delta", { text: "Still working." }, { turnId: "turn-a" }),
      eventAt(16, "user.message", { text: "Queued follow-up" }, { turnId: null }),
      eventAt(17, "turn.queued", { turnId: "turn-b", triggerEventId: "evt-16", source: "user" }, { turnId: "turn-b" }),
      eventAt(57, "agent.message.completed", { text: "Turn A done." }, { turnId: "turn-a" }),
      eventAt(58, "turn.completed", {}, { turnId: "turn-a" }),
      eventAt(61, "turn.started", { triggerEventId: "evt-16" }, { turnId: "turn-b" }),
      eventAt(62, "agent.toolCall.created", { id: "call-b-1", name: "exec_command", arguments: { cmd: "follow-up" } }, { turnId: "turn-b" }),
    ]);
    const followUpIndex = anchoredItems.findIndex((item) => item.kind === "user-message" && item.text === "Queued follow-up");
    const turnBIndex = anchoredItems.findIndex((item) => item.kind === "tool-call" && item.turnId === "turn-b");
    expect(followUpIndex).toBeGreaterThan(-1);
    expect(turnBIndex).toBeGreaterThan(followUpIndex);
    expect(anchoredItems[followUpIndex]).not.toHaveProperty("pending");
  });

  test("a queued user message cancelled before start is omitted without touching a running turn", () => {
    const groups = groupTimeline(
      buildTimeline([
        eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
        eventAt(4, "turn.queued", { turnId: "turn-a", triggerEventId: "evt-2", source: "user" }, { turnId: "turn-a" }),
        eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
        eventAt(9, "agent.toolCall.created", { id: "call-a-1", name: "exec_command", arguments: { cmd: "first step" } }, { turnId: "turn-a" }),
        eventAt(16, "user.message", { text: "Retracted follow-up" }, { turnId: null }),
        eventAt(17, "turn.queued", { turnId: "turn-b", triggerEventId: "evt-16", source: "user" }, { turnId: "turn-b" }),
        eventAt(18, "turn.cancelled", { turnId: "turn-b", triggerEventId: "evt-16" }, { turnId: "turn-b" }),
        eventAt(41, "agent.toolCall.created", { id: "call-a-2", name: "exec_command", arguments: { cmd: "second step" } }, { turnId: "turn-a" }),
        eventAt(57, "agent.message.completed", { text: "Turn A final answer." }, { turnId: "turn-a" }),
        eventAt(58, "turn.completed", {}, { turnId: "turn-a" }),
      ]),
    );

    expect(JSON.stringify(groups)).not.toContain("Retracted follow-up");
    expect(JSON.stringify(groups)).not.toContain("Interrupted.");
    expect(groups.map((group) => (group.kind === "item" ? `${group.kind}:${group.item.kind}` : group.kind))).toEqual([
      "item:user-message",
      "turn",
      "item:agent-message",
    ]);
    const [turn] = turnGroups(groups);
    expect(turn?.outcome).toBe("complete");
    expect(flattenActivityIds(turn)).toEqual(["evt-9", "evt-41"]);
  });

  test("a queued turn without turn.started anchors on the first same-turn activity", () => {
    const items = buildTimeline([
      eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
      eventAt(4, "turn.queued", { turnId: "turn-a", triggerEventId: "evt-2", source: "user" }, { turnId: "turn-a" }),
      eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
      eventAt(16, "user.message", { text: "Crash-resumed follow-up" }, { turnId: null }),
      eventAt(17, "turn.queued", { turnId: "turn-b", triggerEventId: "evt-16", source: "user" }, { turnId: "turn-b" }),
      eventAt(61, "agent.toolCall.created", { id: "call-b-1", name: "exec_command", arguments: { cmd: "follow-up" } }, { turnId: "turn-b" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user-message", "user-message", "tool-call"]);
    expect(items[1]).toMatchObject({ kind: "user-message", text: "Crash-resumed follow-up" });
    expect(items[1]).not.toHaveProperty("pending");
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

  test("a worker spawn whose output carries an error flag settles to failed, not complete", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_create",
        arguments: JSON.stringify({ initialMessage: "Run the drift check on prod" }),
      }),
      event("agent.toolCall.output", { id: "call-1", output: "spawn rejected", error: true }),
    ]);
    expect((items[0] as WorkerItem).kind).toBe("worker");
    expect((items[0] as WorkerItem).status).toBe("failed");
  });

  test("a worker message whose MCP output isError settles to failed", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_send_message",
        arguments: JSON.stringify({ sessionId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", message: "go" }),
      }),
      event("agent.toolCall.output", { id: "call-1", output: { isError: true, content: [{ type: "text", text: "delivery failed" }] } }),
    ]);
    expect((items[0] as WorkerItem).status).toBe("failed");
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

  test("session_interrupt becomes a distinct interrupt worker item (default stop mode)", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_interrupt",
        arguments: { sessionId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d" },
      }),
    ]);
    const item = items[0] as WorkerItem;
    expect(item.kind).toBe("worker");
    expect(item.action).toBe("interrupt");
    expect(item.mode).toBe("stop");
    expect(item.workerSessionId).toBe("7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d");
    expect(item.status).toBe("running");
  });

  test("session_interrupt with mode 'steer' carries the steer mode and settles on its output", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_interrupt",
        arguments: JSON.stringify({ sessionId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", mode: "steer" }),
      }),
      event("agent.toolCall.output", { id: "call-1", output: { content: [{ type: "text", text: "{}" }] } }),
    ]);
    const item = items[0] as WorkerItem;
    expect(item.action).toBe("interrupt");
    expect(item.mode).toBe("steer");
    expect(item.workerSessionId).toBe("7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d");
    expect(item.status).toBe("complete");
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

  test("only attention statuses project dividers; repeats collapse; failure/interrupt notices surface", () => {
    reset();
    const items = buildTimeline([
      // Machinery telemetry — the header pill owns these; no timeline rows.
      event("session.status.changed", { status: "queued" }),
      event("session.status.changed", { status: "running" }),
      event("session.status.changed", { status: "idle" }),
      // Attention statuses earn a divider, collapsed on repeat.
      event("session.status.changed", { status: "requires_action" }),
      event("session.status.changed", { status: "requires_action" }),
      event("turn.started", { triggerEventId: "evt-start" }),
      event("turn.failed", { error: "model provider unavailable" }),
      event("turn.cancelled", {}),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["session-status", "turn-end", "notice", "turn-end", "notice"]);
    expect(items[0]).toMatchObject({ kind: "session-status", status: "requires_action" });
    expect(items[1]).toMatchObject({ outcome: "failed", failureText: "model provider unavailable" });
    expect(items[2]).toMatchObject({ tone: "failed", text: "model provider unavailable" });
    expect(items[3]).toMatchObject({ outcome: "cancelled", failureText: null });
    expect(items[4]).toMatchObject({ tone: "cancelled" });
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

  test("turn lifecycle events emit turn-end items with their outcome metadata", () => {
    reset();
    const items = buildTimeline([
      event("turn.completed", {}, { turnId: "turn-complete" }),
      event("turn.failed", { error: "model provider unavailable" }, { turnId: "turn-failed" }),
      event("turn.started", { triggerEventId: "evt-cancelled" }, { turnId: "turn-cancelled" }),
      event("turn.cancelled", {}, { turnId: "turn-cancelled" }),
    ]);
    const turnEnds = items.filter((item): item is TurnEndItem => item.kind === "turn-end");
    expect(turnEnds.map(({ turnId, outcome, failureText }) => ({ turnId, outcome, failureText }))).toEqual([
      { turnId: "turn-complete", outcome: "complete", failureText: null },
      { turnId: "turn-failed", outcome: "failed", failureText: "model provider unavailable" },
      { turnId: "turn-cancelled", outcome: "cancelled", failureText: null },
    ]);
  });

  test("failed turns with activity fold the failure into turn-end instead of emitting a duplicate notice", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } }),
      event("turn.failed", { error: "model provider unavailable" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["tool-call", "turn-end"]);
    expect(items[1]).toMatchObject({ outcome: "failed", failureText: "model provider unavailable" });
  });

  test("failed turns without activity keep the failure notice", () => {
    reset();
    const items = buildTimeline([event("turn.failed", { error: "model provider unavailable" })]);
    expect(items.map((item) => item.kind)).toEqual(["turn-end", "notice"]);
    expect(items[1]).toMatchObject({ tone: "failed", text: "model provider unavailable" });
  });

  test("cancelled turns with activity fold interruption into turn-end instead of emitting a duplicate notice", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make test" } }),
      event("turn.cancelled", {}),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["tool-call", "turn-end"]);
    expect(items[1]).toMatchObject({ outcome: "cancelled", failureText: null });
  });

  test("cancelled turns without activity keep the interruption notice", () => {
    reset();
    const items = buildTimeline([event("turn.started", { triggerEventId: "evt-start" }), event("turn.cancelled", {})]);
    expect(items.map((item) => item.kind)).toEqual(["turn-end", "notice"]);
    expect(items[1]).toMatchObject({ tone: "cancelled", text: "Interrupted." });
  });

  test("null-turn failures use activity since the last turn boundary for notice suppression", () => {
    reset();
    const withActivity = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } }, { turnId: null }),
      event("turn.failed", { error: "boom" }, { turnId: null }),
    ]);
    expect(withActivity.map((item) => item.kind)).toEqual(["tool-call", "turn-end"]);

    reset();
    const afterUserBoundary = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } }, { turnId: null }),
      event("user.message", { text: "new turn" }),
      event("turn.failed", { error: "boom" }, { turnId: null }),
    ]);
    expect(afterUserBoundary.map((item) => item.kind)).toEqual(["tool-call", "user-message", "turn-end", "notice"]);
  });

  // Fix 3: in-flight tools when turn.failed must become "failed", not "complete"
  test("turn.failed marks in-flight tool calls as failed (not complete)", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } }),
      event("turn.failed", { error: "model provider unavailable" }),
    ]);
    expect((items[0] as ToolCallItem).status).toBe("failed");
  });

  test("turn.cancelled marks in-flight tool calls as cancelled (not failed, not complete)", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make test" } }),
      event("turn.cancelled", {}),
    ]);
    expect((items[0] as ToolCallItem).status).toBe("cancelled");
  });

  test("turn.failed marks in-flight sandbox operations as failed", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "exec", command: "terraform apply" }),
      event("turn.failed", { error: "storage error" }),
    ]);
    expect((items[0] as SandboxItem).status).toBe("failed");
  });

  test("turn.cancelled marks in-flight sandbox operations as cancelled (not failed)", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "exec", command: "kubectl logs -f" }),
      event("turn.cancelled", {}),
    ]);
    expect((items[0] as SandboxItem).status).toBe("cancelled");
  });

  test("turn.cancelled marks in-flight worker items as cancelled (not failed)", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "session_create", arguments: JSON.stringify({ initialMessage: "go" }) }),
      event("turn.cancelled", {}),
    ]);
    expect((items[0] as WorkerItem).status).toBe("cancelled");
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

  test("settled activity groups carry outcome and failure text", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } }),
        event("turn.failed", { error: "model provider unavailable" }),
      ]),
    );
    const [activity] = activityGroups(groups);
    expect(activity?.outcome).toBe("failed");
    expect(activity?.failureText).toBe("model provider unavailable");
  });

  test("a settled turn folds the full span and leaves the final agent message after it", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("user.message", { text: "ship it" }, { turnId: null }),
        event("agent.reasoning.delta", { text: "checking" }, { turnId: "turn-fold" }),
        event("agent.message.completed", { text: "The tests need one patch first." }, { turnId: "turn-fold" }),
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "bun test" } }, { turnId: "turn-fold" }),
        event("agent.toolCall.output", { id: "call-1", output: "ok" }, { turnId: "turn-fold" }),
        event("agent.message.completed", { text: "Final answer: tests are green." }, { turnId: "turn-fold" }),
        event("turn.completed", {}, { turnId: "turn-fold" }),
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual(["item", "turn", "item"]);
    const [turn] = turnGroups(groups);
    expect(turn?.id).toBe("turn-turn-fold");
    expect(turn?.outcome).toBe("complete");
    expect(turn?.groups.map((group) => group.kind)).toEqual(["activity", "item", "activity"]);
    const final = groups[2];
    expect(final?.kind).toBe("item");
    expect(final?.kind === "item" ? final.item : null).toMatchObject({ kind: "agent-message", text: "Final answer: tests are green." });
  });

  test("a turn that ends on activity folds everything and extracts nothing", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("user.message", { text: "run it" }, { turnId: null }),
        event("agent.message.completed", { text: "Starting with the build." }, { turnId: "turn-activity-end" }),
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } }, { turnId: "turn-activity-end" }),
        event("agent.toolCall.output", { id: "call-1", output: "ok" }, { turnId: "turn-activity-end" }),
        event("turn.completed", {}, { turnId: "turn-activity-end" }),
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual(["item", "turn"]);
    const [turn] = turnGroups(groups);
    expect(turn?.groups.map((group) => group.kind)).toEqual(["item", "activity"]);
  });

  test("a steering user message bounds the turn walk-back", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("user.message", { text: "first request" }, { turnId: null }),
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "setup" } }, { turnId: "turn-steer" }),
        event("user.message", { text: "actually run tests only" }, { turnId: null }),
        event("agent.toolCall.created", { id: "call-2", name: "exec_command", arguments: { cmd: "bun test" } }, { turnId: "turn-steer" }),
        event("agent.message.completed", { text: "Final answer after steering." }, { turnId: "turn-steer" }),
        event("turn.completed", {}, { turnId: "turn-steer" }),
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual(["item", "activity", "item", "turn", "item"]);
    const [turn] = turnGroups(groups);
    expect(turn?.groups.map((group) => group.kind)).toEqual(["activity"]);
    expect(activityGroups(turn?.groups ?? [])[0]?.items[0]?.id).toBe("evt-4");
  });

  test("sequential turns fold independently and leave between-turn dividers top-level", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("user.message", { text: "setup" }, { turnId: null }),
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "setup" } }, { turnId: "turn-1" }),
        event("agent.message.completed", { text: "Setup complete." }, { turnId: "turn-1" }),
        event("turn.completed", {}, { turnId: "turn-1" }),
        event("session.status.changed", { status: "idle" }, { turnId: null }),
        event("user.message", { text: "deploy" }, { turnId: null }),
        event("session.status.changed", { status: "running" }, { turnId: null }),
        event("agent.toolCall.created", { id: "call-2", name: "exec_command", arguments: { cmd: "deploy" } }, { turnId: "turn-2" }),
        event("agent.message.completed", { text: "Deploy failed." }, { turnId: "turn-2" }),
        event("turn.failed", { error: "deploy failed" }, { turnId: "turn-2" }),
      ]),
    );
    // The idle/running ticks between and inside turns project no rows at all —
    // the shape is purely user → turn → answer, twice.
    expect(groups.map((group) => group.kind)).toEqual(["item", "turn", "item", "item", "turn", "item"]);
    const turns = turnGroups(groups);
    expect(turns.map((turn) => turn.id)).toEqual(["turn-turn-1", "turn-turn-2"]);
    expect(turns[0]?.groups.map((group) => group.kind)).toEqual(["activity"]);
    expect(turns[1]?.groups.map((group) => group.kind)).toEqual(["activity"]);
  });

  test("sequential turns without a user boundary do not absorb the previous final message", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "setup" } }, { turnId: "turn-1" }),
        event("agent.message.completed", { text: "Setup complete." }, { turnId: "turn-1" }),
        event("turn.completed", {}, { turnId: "turn-1" }),
        event("session.status.changed", { status: "idle" }, { turnId: null }),
        event("agent.toolCall.created", { id: "call-2", name: "exec_command", arguments: { cmd: "deploy" } }, { turnId: "turn-2" }),
        event("agent.message.completed", { text: "Deploy complete." }, { turnId: "turn-2" }),
        event("turn.completed", {}, { turnId: "turn-2" }),
      ]),
    );
    // No divider row separates the turns anymore; the foreign-turn guard alone
    // keeps turn-2's walk-back from absorbing turn-1's final message.
    expect(groups.map((group) => (group.kind === "item" ? `${group.kind}:${group.item.kind}` : group.kind))).toEqual([
      "turn",
      "item:agent-message",
      "turn",
      "item:agent-message",
    ]);
    const turns = turnGroups(groups);
    expect(turns.map((turn) => turn.groups.map((group) => group.kind))).toEqual([["activity"], ["activity"]]);
  });

  test("activity-less turns create no turn group and keep their notice", () => {
    reset();
    const groups = groupTimeline(buildTimeline([event("turn.failed", { error: "model provider unavailable" })]));
    expect(groups.map((group) => group.kind)).toEqual(["item"]);
    expect(groups[0]?.kind === "item" ? groups[0].item : null).toMatchObject({ kind: "notice", tone: "failed" });
  });

  test("machinery status ticks vanish; attention statuses inside a settled turn fold into the body", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("user.message", { text: "run checks" }, { turnId: null }),
        event("session.status.changed", { status: "running" }, { turnId: null }),
        event("session.status.changed", { status: "requires_action" }, { turnId: null }),
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "bun test" } }, { turnId: "turn-status" }),
        event("agent.message.completed", { text: "Checks passed." }, { turnId: "turn-status" }),
        event("turn.completed", {}, { turnId: "turn-status" }),
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual(["item", "turn", "item"]);
    const [turn] = turnGroups(groups);
    // The running tick projected nothing; the requires_action divider folds.
    expect(turn?.groups.map((group) => (group.kind === "item" ? group.item.kind : group.kind))).toEqual(["session-status", "activity"]);
    const folded = turn?.groups[0];
    expect(folded?.kind === "item" ? folded.item : null).toMatchObject({ kind: "session-status", status: "requires_action" });
  });

  test("live activity groups have no turn outcome", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } })]),
    );
    const [activity] = activityGroups(groups);
    expect(activity?.outcome).toBeUndefined();
    expect(activity?.failureText).toBeUndefined();
  });

  test("a turn split by an interleaved agent message stamps both activity clusters", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.reasoning.delta", { text: "thinking" }, { turnId: "turn-split" }),
        event("agent.message.completed", { text: "Checking this first." }, { turnId: "turn-split" }),
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } }, { turnId: "turn-split" }),
        event("turn.failed", { error: "compiler exploded" }, { turnId: "turn-split" }),
      ]),
    );
    const activities = activityGroups(groups);
    expect(groups.map((group) => group.kind)).toEqual(["turn"]);
    const [turn] = turnGroups(groups);
    expect(turn?.groups.map((group) => group.kind)).toEqual(["activity", "item", "activity"]);
    expect(activities).toHaveLength(2);
    expect(activities.map((group) => group.outcome)).toEqual(["failed", "failed"]);
    expect(activities.map((group) => group.failureText)).toEqual(["compiler exploded", "compiler exploded"]);
  });

  test("sequential settled turns stamp only their own activity groups", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "setup" } }, { turnId: "turn-1" }),
        event("turn.completed", {}, { turnId: "turn-1" }),
        event("agent.toolCall.created", { id: "call-2", name: "exec_command", arguments: { cmd: "deploy" } }, { turnId: "turn-2" }),
        event("turn.failed", { error: "deploy failed" }, { turnId: "turn-2" }),
      ]),
    );
    const activities = activityGroups(groups);
    expect(groups.map((group) => group.kind)).toEqual(["turn", "turn"]);
    expect(activities).toHaveLength(2);
    expect(activities.map((group) => group.outcome)).toEqual(["complete", "failed"]);
    expect(activities.map((group) => group.items.map((item) => item.turnId))).toEqual([["turn-1"], ["turn-2"]]);
    expect(activities[0]?.failureText).toBeUndefined();
    expect(activities[1]?.failureText).toBe("deploy failed");
  });

  test("a null-turn failure stamps the trailing activity group", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "tail logs" } }, { turnId: null }),
        event("turn.failed", { error: "tail failed" }, { turnId: null }),
      ]),
    );
    const [activity] = activityGroups(groups);
    expect(activity?.outcome).toBe("failed");
  });

  test("a null-turn cancellation keeps the legacy finalize path (not a queued retraction)", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "tail logs" } }, { turnId: null }),
        event("turn.cancelled", {}, { turnId: null }),
      ]),
    );
    const [activity] = activityGroups(groups);
    // Null turnId proves nothing about queued-turn retraction; the trailing
    // group still settles as cancelled exactly as before.
    expect(activity?.outcome).toBe("cancelled");
    expect(activity?.items[0]).toMatchObject({ status: "cancelled" });
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
