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
  /** Queued for a future turn whose start has not appeared in the event log. */
  pending?: boolean;
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
  action: "spawn" | "message" | "interrupt";
  /** The worker's initial message / the message sent to it, when parseable. */
  prompt: string | null;
  /** The target/spawned worker session id, when parseable from args/output. */
  workerSessionId: string | null;
  /**
   * For an `interrupt` action, whether it stops the target (default) or steers
   * it (cancel the current turn, keep the goal). Absent on spawn/message.
   */
  mode?: "stop" | "steer";
  status: "running" | "complete" | "failed" | "cancelled";
  occurredAt: string;
};

export type WorkerCompletionItem = {
  kind: "worker-completion";
  id: string;
  turnId: string | null;
  occurredAt: string;
  childSessionId: string;
  childStatus: string;
  goalStatus: string | null;
  goalText: string | null;
  evidence: string | null;
  pausedReason: string | null;
  text: string;
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

/**
 * A first-party workspace-memory write the agent made mid-turn — a `memory.saved`
 * (it committed a new preference / fact / procedure / decision / history) or a
 * `memory.corrected` (it updated or archived an existing one). A settled save is
 * ordinary progress, not an exceptional state, so it renders as a calm NEUTRAL
 * step on the rail (never accent/color). When the host app supplies an
 * `onMemoryClick` handler the row also deep-links to the record in its memory
 * pane; without one it is non-interactive rich content.
 */
export type MemoryItem = {
  kind: "memory";
  id: string;
  turnId: string | null;
  variant: "saved" | "corrected";
  /** The memory's kind enum (`"preference" | "semantic" | …`); mapped to a human label at render. */
  memoryKind: string;
  /** The memory text, ellipsized to ≤120 chars server-side. For a supersede this is the OLD text. */
  preview: string;
  /** The save collapsed into an existing memory (no new row was written). Saved variant only. */
  deduped?: boolean;
  /** The NEW text when a correction superseded the memory with a replacement; absent = updated-in-place or archived. */
  replacementPreview?: string;
  /** The saved / corrected memory's id — the deep-link target for a save. */
  memoryId: string;
  /** The replacement memory's id when a correction produced one — the LIVE record the deep-link targets. */
  replacementMemoryId?: string;
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
  action: "set" | "updated" | "completed" | "paused" | "resumed" | "cleared" | "continuation";
  text: string | null;
  occurredAt: string;
};

export type NoticeItem = {
  kind: "notice";
  id: string;
  tone: "waiting" | "cancelled" | "failed";
  text: string;
  action?: { label: string; url: string };
  occurredAt: string;
};

/**
 * A tool call hit a connection whose credential lapsed — the broker asked the
 * user to reconnect the provider before the turn can continue. Carries the
 * structured `tool.auth_needed` payload so the renderer can draw a clean inline
 * reconnect affordance (provider logo + one human line + a Reconnect button)
 * and the app can start the right recovery flow (OAuth reconnect for the
 * surviving connection, or credential re-entry for an api-key one). The `reason`
 * shapes the human copy but is never shown raw.
 */
export type AuthNeededItem = {
  kind: "auth-needed";
  id: string;
  turnId: string | null;
  /** The connection's registrable domain, e.g. "linear.app". */
  providerDomain: string;
  /** The lapsed connection to reconnect, when the row survived. */
  connectionId: string | null;
  reason: "missing_connection" | "expired" | "insufficient_scope" | "refresh_failed" | null;
  /** Scopes the provider now needs; may inform the copy, never shown as a raw label. */
  scopes: string[];
  /** The OAuth `resource` (RFC 8707) the reconnect should target, when supplied. */
  resource: string | null;
  /** The tool whose call triggered the reauth, for context. */
  toolName: string | null;
  /** A pre-minted authorization URL, when the broker already produced one. */
  authorizationUrl: string | null;
  occurredAt: string;
};

export type TurnOutcome = "complete" | "failed" | "cancelled";

export type TurnEndItem = {
  kind: "turn-end";
  id: string;
  turnId: string | null;
  outcome: TurnOutcome;
  failureText: string | null;
  occurredAt: string;
};

export type TimelineItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | WorkerItem
  | WorkerCompletionItem
  | SandboxItem
  | SessionStatusItem
  | GoalItem
  | NoticeItem
  | AuthNeededItem
  | MemoryItem
  | TurnEndItem;

/** Activity items cluster between chat messages (reasoning, tools, workers, sandbox, memory). */
export type ActivityItem = ReasoningItem | ToolCallItem | WorkerItem | SandboxItem | MemoryItem;

export type TimelineGroup =
  | { kind: "item"; item: TimelineItem }
  | { kind: "activity"; id: string; items: ActivityItem[]; outcome?: TurnOutcome; failureText?: string }
  | {
      kind: "turn";
      id: string;
      outcome: TurnOutcome;
      failureText?: string;
      startedAt: string;
      endedAt: string;
      groups: TimelineGroup[];
    };
