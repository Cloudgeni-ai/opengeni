import type { ResourceRef, SessionEvent, SessionStatus, ToolRef } from "@opengeni/sdk";
import { stringifyPayload, tryParseJson } from "./lib/format";

/* ----------------------------------------------------------------------------
   Timeline projection

   `buildTimeline` folds a session's raw event log (replayed + live, ordered by
   sequence) into renderable items: chat messages with accumulated streaming
   deltas, reasoning summaries, tool calls matched to their outputs, sandbox
   operations with command output, spawned-worker status (the manager's
   `session_create` / `session_send_message` orchestration calls), goal
   markers, status changes, and turn failures.

   It is a pure function — same events in, same items out — so it can be
   memoized, unit-tested, and re-run incrementally as new events stream in.
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
  status: "running" | "complete";
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
  status: "running" | "complete";
  occurredAt: string;
};

export type SandboxItem = {
  kind: "sandbox";
  id: string;
  turnId: string | null;
  name: string;
  command: string | null;
  output: string;
  status: "running" | "complete" | "failed";
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

/** Tool names on the first-party OpenGeni MCP server that operate on sessions. */
const WORKER_SPAWN_TOOL = "session_create";
const WORKER_MESSAGE_TOOL = "session_send_message";

export function buildTimeline(events: SessionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  const last = (): TimelineItem | undefined => items[items.length - 1];

  /** A new item of a different kind ends whatever was streaming at the tail. */
  const closeStreamingTail = (): void => {
    const open = last();
    if ((open?.kind === "agent-message" || open?.kind === "reasoning") && open.streaming) {
      open.streaming = false;
    }
  };

  const finalizeOpen = (turnId?: string | null): void => {
    for (const item of items) {
      if (turnId !== undefined && "turnId" in item && item.turnId && turnId && item.turnId !== turnId) {
        continue;
      }
      if ((item.kind === "agent-message" || item.kind === "reasoning") && item.streaming) {
        item.streaming = false;
      }
      if ((item.kind === "tool-call" || item.kind === "worker") && item.status === "running") {
        item.status = "complete";
      }
      if (item.kind === "sandbox" && item.status === "running") {
        item.status = "complete";
      }
    }
  };

  for (const event of ordered) {
    const payload = asRecord(event.payload);
    const turnId = event.turnId ?? null;

    switch (event.type) {
      case "user.message": {
        // A steering message must not mark in-flight tools complete; it only
        // ends whatever text was streaming. Turn lifecycle events finalize.
        closeStreamingTail();
        items.push({
          kind: "user-message",
          id: event.id,
          text: typeof payload.text === "string" ? payload.text : "",
          resources: resourceRefs(payload.resources),
          tools: toolRefs(payload.tools),
          occurredAt: event.occurredAt,
        });
        break;
      }

      case "agent.message.delta": {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!text) {
          break;
        }
        const open = last();
        if (open?.kind === "agent-message" && open.streaming && open.turnId === turnId) {
          open.text += text;
          break;
        }
        closeStreamingTail();
        items.push({
          kind: "agent-message",
          id: event.id,
          turnId,
          text,
          streaming: true,
          occurredAt: event.occurredAt,
        });
        break;
      }

      case "agent.message.completed": {
        const text = typeof payload.text === "string" ? payload.text : "";
        // Reconcile the most recent same-turn agent message — even when
        // activity (tool calls, reasoning) landed after its deltas — so the
        // completed text never duplicates the streamed one.
        const open = [...items]
          .reverse()
          .find((item): item is AgentMessageItem => item.kind === "agent-message" && item.turnId === turnId);
        if (open && (open.streaming || !open.text || text === open.text || text.startsWith(open.text))) {
          // The completed text is authoritative when it extends what streamed.
          if (!open.text || (text && text.startsWith(open.text))) {
            open.text = text || open.text;
          }
          open.streaming = false;
          break;
        }
        if (text) {
          items.push({
            kind: "agent-message",
            id: event.id,
            turnId,
            text,
            streaming: false,
            occurredAt: event.occurredAt,
          });
        }
        break;
      }

      case "agent.reasoning.delta": {
        const text = reasoningText(event.payload);
        if (!text) {
          break;
        }
        const open = last();
        if (open?.kind === "reasoning" && open.streaming && open.turnId === turnId) {
          open.text += text;
          break;
        }
        closeStreamingTail();
        items.push({
          kind: "reasoning",
          id: event.id,
          turnId,
          text,
          streaming: true,
          occurredAt: event.occurredAt,
        });
        break;
      }

      case "agent.toolCall.created": {
        const name = typeof payload.name === "string" ? payload.name : "tool";
        const callId = typeof payload.id === "string" ? payload.id : null;
        const args = payload.arguments ?? null;
        closeStreamingTail();
        if (name === WORKER_SPAWN_TOOL || name === WORKER_MESSAGE_TOOL) {
          items.push({
            kind: "worker",
            id: event.id,
            turnId,
            callId,
            action: name === WORKER_SPAWN_TOOL ? "spawn" : "message",
            prompt: workerPrompt(args),
            workerSessionId: extractSessionRef(args),
            status: "running",
            occurredAt: event.occurredAt,
          });
          break;
        }
        items.push({
          kind: "tool-call",
          id: event.id,
          turnId,
          callId,
          name,
          arguments: args,
          output: undefined,
          status: "running",
          occurredAt: event.occurredAt,
        });
        break;
      }

      case "agent.toolCall.output": {
        const callId = typeof payload.id === "string" ? payload.id : null;
        const target = findOpenCall(items, callId);
        if (!target) {
          break;
        }
        if (target.kind === "worker") {
          target.status = "complete";
          target.workerSessionId = target.workerSessionId ?? extractSessionRef(payload.output);
          break;
        }
        target.status = "complete";
        target.output = payload.output;
        break;
      }

      case "sandbox.operation.started":
      case "sandbox.operation.completed":
      case "sandbox.operation.failed": {
        const name = typeof payload.name === "string" ? payload.name : "sandbox";
        const status = event.type.endsWith(".failed") ? "failed" : event.type.endsWith(".completed") ? "complete" : "running";
        const existing = findOpenSandbox(items, name);
        if (existing && status !== "running") {
          existing.status = status;
          const message = failureMessage(payload);
          if (message) {
            existing.output = existing.output ? `${existing.output}\n${message}` : message;
          }
          break;
        }
        if (!existing) {
          closeStreamingTail();
          items.push({
            kind: "sandbox",
            id: event.id,
            turnId,
            name,
            command: typeof payload.command === "string" ? payload.command : null,
            output: failureMessage(payload) ?? "",
            status,
            occurredAt: event.occurredAt,
          });
        }
        break;
      }

      case "sandbox.command.output.delta": {
        const text = typeof payload.text === "string" ? payload.text : typeof payload.output === "string" ? payload.output : "";
        if (!text) {
          break;
        }
        // Attach to the named operation when the payload carries one;
        // otherwise the latest running operation is the best available owner.
        const open =
          (typeof payload.name === "string" ? findOpenSandbox(items, payload.name) : undefined) ??
          [...items].reverse().find((item): item is SandboxItem => item.kind === "sandbox" && item.status === "running");
        if (open) {
          open.output += text;
        }
        break;
      }

      case "session.status.changed": {
        const status = payload.status;
        if (!isSessionStatus(status)) {
          break;
        }
        const previous = [...items].reverse().find((item): item is SessionStatusItem => item.kind === "session-status");
        if (previous?.status === status) {
          break;
        }
        items.push({ kind: "session-status", id: event.id, status, occurredAt: event.occurredAt });
        break;
      }

      case "session.requiresAction": {
        finalizeOpen(turnId);
        items.push({
          kind: "notice",
          id: event.id,
          tone: "waiting",
          text: "Approval needed — the turn is paused until someone decides.",
          occurredAt: event.occurredAt,
        });
        break;
      }

      case "turn.completed": {
        finalizeOpen(turnId);
        break;
      }

      case "turn.failed": {
        finalizeOpen(turnId);
        items.push({
          kind: "notice",
          id: event.id,
          tone: "failed",
          text: failureMessage(payload) ?? "The turn failed.",
          occurredAt: event.occurredAt,
        });
        break;
      }

      case "turn.cancelled": {
        finalizeOpen(turnId);
        items.push({
          kind: "notice",
          id: event.id,
          tone: "cancelled",
          text: "Interrupted.",
          occurredAt: event.occurredAt,
        });
        break;
      }

      case "goal.set":
      case "goal.updated":
      case "goal.completed":
      case "goal.paused":
      case "goal.resumed":
      case "goal.continuation": {
        items.push({
          kind: "goal",
          id: event.id,
          action: event.type.slice("goal.".length) as GoalItem["action"],
          text: goalText(payload),
          occurredAt: event.occurredAt,
        });
        break;
      }

      default:
        break;
    }
  }

  return items;
}

/** The latest session status carried in the event log, if any. */
export function sessionStatusFromEvents(events: SessionEvent[]): SessionStatus | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "session.status.changed") {
      continue;
    }
    const status = asRecord(event.payload).status;
    if (isSessionStatus(status)) {
      return status;
    }
  }
  return null;
}

/* ----------------------------------------------------------------------------
   Visual grouping: consecutive activity items (reasoning / tools / workers /
   sandbox) cluster into one collapsible block between chat messages.
   -------------------------------------------------------------------------- */

export type TimelineGroup =
  | { kind: "item"; item: TimelineItem }
  | { kind: "activity"; id: string; items: (ReasoningItem | ToolCallItem | WorkerItem | SandboxItem)[] };

const ACTIVITY_KINDS = new Set(["reasoning", "tool-call", "worker", "sandbox"]);

export function groupTimeline(items: TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const item of items) {
    if (ACTIVITY_KINDS.has(item.kind)) {
      const open = groups[groups.length - 1];
      const activity = item as ReasoningItem | ToolCallItem | WorkerItem | SandboxItem;
      if (open?.kind === "activity") {
        open.items.push(activity);
      } else {
        groups.push({ kind: "activity", id: `activity-${item.id}`, items: [activity] });
      }
      continue;
    }
    groups.push({ kind: "item", item });
  }
  return groups;
}

/* --- helpers ---------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const SESSION_STATUSES: readonly SessionStatus[] = ["queued", "running", "idle", "requires_action", "failed", "cancelled"];

/** Keep only entries that match the wire shapes; user payloads are untyped. */
function resourceRefs(value: unknown): ResourceRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is ResourceRef => {
    const record = asRecord(entry);
    if (record.kind === "repository") {
      return typeof record.uri === "string" && typeof record.ref === "string";
    }
    return record.kind === "file" && typeof record.fileId === "string";
  });
}

function toolRefs(value: unknown): ToolRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is ToolRef => {
    const record = asRecord(entry);
    return record.kind === "mcp" && typeof record.id === "string";
  });
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

function findOpenCall(items: TimelineItem[], callId: string | null): ToolCallItem | WorkerItem | undefined {
  const reversed = [...items].reverse();
  const isCall = (item: TimelineItem): item is ToolCallItem | WorkerItem => item.kind === "tool-call" || item.kind === "worker";
  if (callId) {
    const byId = reversed.find((item) => isCall(item) && item.callId === callId);
    if (byId) {
      return byId as ToolCallItem | WorkerItem;
    }
  }
  return reversed.find((item): item is ToolCallItem | WorkerItem => isCall(item) && item.status === "running");
}

function findOpenSandbox(items: TimelineItem[], name: string): SandboxItem | undefined {
  return [...items].reverse().find((item): item is SandboxItem => item.kind === "sandbox" && item.name === name && item.status === "running");
}

function failureMessage(payload: Record<string, unknown>): string | null {
  for (const key of ["error", "message"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function goalText(payload: Record<string, unknown>): string | null {
  if (typeof payload.text === "string" && payload.text) {
    return payload.text;
  }
  const goal = asRecord(payload.goal);
  if (typeof goal.text === "string" && goal.text) {
    return goal.text;
  }
  if (typeof payload.prompt === "string" && payload.prompt) {
    return payload.prompt;
  }
  return null;
}

function reasoningText(payload: unknown): string {
  const record = asRecord(payload);
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = asRecord(asRecord(record.item).rawItem).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const text = asRecord(part).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/** The worker's initial/sent message from `session_create`/`session_send_message` args. */
function workerPrompt(args: unknown): string | null {
  const record = asRecord(typeof args === "string" ? tryParseJson(args) : args);
  for (const key of ["initialMessage", "message", "text", "prompt"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Find a session id in orchestration tool arguments or output. Handles raw
 * objects, JSON strings, and MCP tool results (`{ content: [{ type: "text",
 * text: "{...}" }], structuredContent? }`).
 */
export function extractSessionRef(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return extractSessionRef(tryParseJson(value), depth + 1);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractSessionRef(entry, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId === "string" && looksLikeId(record.sessionId)) {
    return record.sessionId;
  }
  if (typeof record.id === "string" && looksLikeId(record.id) && ("status" in record || "workspaceId" in record || "initialMessage" in record)) {
    return record.id;
  }
  for (const key of ["structuredContent", "session", "result", "content"] as const) {
    if (key in record) {
      const found = extractSessionRef(record[key], depth + 1);
      if (found) {
        return found;
      }
    }
  }
  if (typeof record.text === "string") {
    return extractSessionRef(tryParseJson(record.text), depth + 1);
  }
  return null;
}

function looksLikeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Readable label for a tool call ("session_create" -> "session create"). */
export function toolDisplayName(name: string): string {
  return name.replace(/[_-]+/g, " ").trim();
}

/** Compact, single-line preview of tool arguments/outputs for collapsed rows. */
export function compactPayloadPreview(value: unknown, maxLength = 120): string {
  const text = stringifyPayload(value).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
