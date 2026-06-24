import type { ResourceRef, SessionStatus, ToolRef } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Timeline item types

   The projected, renderable shapes that `buildTimeline` folds a session's raw
   event log into. These are the data contract the renderer registry and every
   row component consume — the SINGLE SOURCE OF TRUTH used by both the live app
   and the component demo.
   -------------------------------------------------------------------------- */

export type UserMessageItem = {
  kind: "user-message";
  id: string;
  text: string;
  /** Resources attached to this message (file uploads, repositories). */
  resources: ResourceRef[];
  /** Tools requested for the turn this message starts. */
  tools: ToolRef[];
  occurredAt: string;
};

export type AgentMessageItem = {
  kind: "agent-message";
  id: string;
  turnId: string | null;
  text: string;
  /** Still receiving deltas (no completed/turn-end seen yet). */
  streaming: boolean;
  occurredAt: string;
};

export type ReasoningItem = {
  kind: "reasoning";
  id: string;
  turnId: string | null;
  text: string;
  streaming: boolean;
  occurredAt: string;
};

export type ToolCallItem = {
  kind: "tool-call";
  id: string;
  turnId: string | null;
  callId: string | null;
  name: string;
  arguments: unknown;
  output: unknown;
  /**
   * The provider-native tool item (`agent.toolCall.created.payload.raw`). Carries
   * `type` (e.g. `apply_patch_call`, `computer_call`, `hosted_tool_call`) and the
   * tool-specific fields the per-tool renderers read (`operation`, `action`,
   * `providerData`, …). `undefined` for first-party MCP tools, which carry their
   * payload in `arguments`/`output` instead.
   */
  raw: unknown;
  status: "running" | "complete" | "failed" | "cancelled";
  occurredAt: string;
};

/**
 * An orchestration call against another session — the manager spawning or
 * messaging a worker. Rendered as a first-class "worker" row, not a generic
 * tool call.
 */
export type WorkerItem = {
  kind: "worker";
  id: string;
  turnId: string | null;
  callId: string | null;
  action: "spawn" | "message";
  /** The worker's initial message / the message sent to it, when parseable. */
  prompt: string | null;
  /** The target/spawned worker session id, when parseable from args/output. */
  workerSessionId: string | null;
  status: "running" | "complete" | "failed" | "cancelled";
  occurredAt: string;
};

export type SandboxItem = {
  kind: "sandbox";
  id: string;
  turnId: string | null;
  name: string;
  command: string | null;
  output: string;
  status: "running" | "complete" | "failed" | "cancelled";
  occurredAt: string;
};

export type SessionStatusItem = {
  kind: "session-status";
  id: string;
  status: SessionStatus;
  occurredAt: string;
};

export type GoalItem = {
  kind: "goal";
  id: string;
  action: "set" | "updated" | "completed" | "paused" | "resumed" | "continuation";
  text: string | null;
  occurredAt: string;
};

export type NoticeItem = {
  kind: "notice";
  id: string;
  tone: "waiting" | "cancelled" | "failed";
  text: string;
  occurredAt: string;
};

export type TimelineItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | WorkerItem
  | SandboxItem
  | SessionStatusItem
  | GoalItem
  | NoticeItem;

/** Activity items cluster between chat messages (reasoning, tools, workers, sandbox). */
export type ActivityItem = ReasoningItem | ToolCallItem | WorkerItem | SandboxItem;

export type TimelineGroup =
  | { kind: "item"; item: TimelineItem }
  | { kind: "activity"; id: string; items: ActivityItem[] };
