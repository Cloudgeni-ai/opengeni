import type { SessionEvent, SessionStatus } from "@opengeni/sdk";
import { tryParseJson } from "../lib/format";
import type {
  AgentMessageItem,
  ActivityItem,
  GoalItem,
  SandboxItem,
  SessionStatusItem,
  TimelineGroup,
  TimelineItem,
  TurnEndItem,
  ToolCallItem,
  WorkerItem,
} from "./types";

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

/** Tool names on the first-party OpenGeni MCP server that operate on sessions. */
const WORKER_SPAWN_TOOL = "session_create";
const WORKER_MESSAGE_TOOL = "session_send_message";
const WORKER_INTERRUPT_TOOL = "session_interrupt";

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

  const finalizeOpen = (turnId?: string | null, disposition: "complete" | "failed" | "cancelled" = "complete"): void => {
    for (const item of items) {
      if (turnId !== undefined && "turnId" in item && item.turnId && turnId && item.turnId !== turnId) {
        continue;
      }
      if ((item.kind === "agent-message" || item.kind === "reasoning") && item.streaming) {
        item.streaming = false;
      }
      if ((item.kind === "tool-call" || item.kind === "worker") && item.status === "running") {
        item.status = disposition;
      }
      if (item.kind === "sandbox" && item.status === "running") {
        item.status = disposition;
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
        if (name === WORKER_INTERRUPT_TOOL) {
          // stop (default) vs steer — the target keeps its goal on steer and
          // picks up its next queued turn (pair with session_send_message).
          items.push({
            kind: "worker",
            id: event.id,
            turnId,
            callId,
            action: "interrupt",
            prompt: null,
            workerSessionId: extractSessionRef(args),
            mode: workerInterruptMode(args),
            status: "running",
            occurredAt: event.occurredAt,
          });
          break;
        }
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
          // The provider-native item drives the per-tool renderers (apply_patch
          // operation, computer_call action, web_search providerData, …).
          raw: payload.raw,
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
          // A worker spawn/message that returns an error flag (or an MCP
          // isError result) settles to "failed" too, so WorkerRow surfaces it.
          target.status = isErrorOutput(payload) ? "failed" : "complete";
          target.workerSessionId = target.workerSessionId ?? extractSessionRef(payload.output);
          break;
        }
        // An output carrying an explicit error flag (or an MCP isError result)
        // settles the tool to "failed" so the renderer can surface it loudly.
        target.status = isErrorOutput(payload) ? "failed" : "complete";
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
        items.push(turnEndItem(event, "complete", null));
        break;
      }

      case "turn.failed": {
        const hadActivity = hasTurnActivity(items, turnId);
        const failureText = failureMessage(payload);
        finalizeOpen(turnId, "failed");
        items.push(turnEndItem(event, "failed", failureText));
        if (!hadActivity) {
          items.push({
            kind: "notice",
            id: event.id,
            tone: "failed",
            text: failureText ?? "The turn failed.",
            occurredAt: event.occurredAt,
          });
        }
        break;
      }

      case "turn.cancelled": {
        const hadActivity = hasTurnActivity(items, turnId);
        finalizeOpen(turnId, "cancelled");
        items.push(turnEndItem(event, "cancelled", null));
        if (!hadActivity) {
          items.push({
            kind: "notice",
            id: event.id,
            tone: "cancelled",
            text: "Interrupted.",
            occurredAt: event.occurredAt,
          });
        }
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
   sandbox) cluster into collapsible blocks. Once a turn settles, the full
   non-user span folds behind a turn group, with activity blocks nested inside.
   -------------------------------------------------------------------------- */

/**
 * Whether an item clusters into an activity block. A `switch` (not a stringly-
 * typed set) so adding an {@link ActivityItem} kind is a compile-time prompt to
 * decide its grouping — and it narrows `item` to `ActivityItem` with no cast.
 */
function isActivityItem(item: TimelineItem): item is ActivityItem {
  switch (item.kind) {
    case "reasoning":
    case "tool-call":
    case "worker":
    case "sandbox":
      return true;
    default:
      return false;
  }
}

export function groupTimeline(items: TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const item of items) {
    if (isActivityItem(item)) {
      const open = groups[groups.length - 1];
      if (open?.kind === "activity" && open.outcome === undefined) {
        open.items.push(item);
      } else {
        groups.push({ kind: "activity", id: `activity-${item.id}`, items: [item] });
      }
      continue;
    }
    if (item.kind === "turn-end") {
      stampTurnOutcome(groups, item);
      foldSettledTurn(groups, item);
      continue;
    }
    groups.push({ kind: "item", item });
  }
  return groups;
}

/* --- helpers ---------------------------------------------------------------- */

function turnEndItem(
  event: SessionEvent,
  outcome: TurnEndItem["outcome"],
  failureText: string | null,
): TurnEndItem {
  return {
    kind: "turn-end",
    id: `${event.id}-turn-end`,
    turnId: event.turnId ?? null,
    outcome,
    failureText,
    occurredAt: event.occurredAt,
  };
}

function hasTurnActivity(items: TimelineItem[], turnId: string | null): boolean {
  if (turnId) {
    return items.some((item) => isActivityItem(item) && item.turnId === turnId);
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.kind === "turn-end" || item.kind === "user-message") {
      return false;
    }
    if (isActivityItem(item)) {
      return true;
    }
  }
  return false;
}

function stampTurnOutcome(groups: TimelineGroup[], turnEnd: TurnEndItem): void {
  if (turnEnd.turnId === null) {
    const trailing = groups[groups.length - 1];
    if (trailing?.kind === "activity" && trailing.outcome === undefined) {
      applyTurnOutcome(trailing, turnEnd);
    }
    return;
  }
  for (const group of groups) {
    if (group.kind !== "activity" || group.outcome !== undefined) {
      continue;
    }
    if (group.items.some((activity) => activity.turnId === turnEnd.turnId)) {
      applyTurnOutcome(group, turnEnd);
    }
  }
}

function applyTurnOutcome(group: Extract<TimelineGroup, { kind: "activity" }>, turnEnd: TurnEndItem): void {
  group.outcome = turnEnd.outcome;
  if (turnEnd.failureText) {
    group.failureText = turnEnd.failureText;
  }
}

function foldSettledTurn(groups: TimelineGroup[], turnEnd: TurnEndItem): void {
  let startIndex = groups.length;
  let stoppedAtForeignTurn = false;
  while (startIndex > 0) {
    const previous = groups[startIndex - 1];
    if (isTurnBoundary(previous)) {
      break;
    }
    if (belongsToDifferentTurn(previous, turnEnd.turnId)) {
      stoppedAtForeignTurn = true;
      break;
    }
    startIndex -= 1;
  }
  if (stoppedAtForeignTurn) {
    while (startIndex < groups.length && isBetweenTurnDivider(groups[startIndex])) {
      startIndex += 1;
    }
  }

  const collected = groups.slice(startIndex);
  if (collected.length === 0) {
    return;
  }

  const finalMessage = extractFinalAgentMessage(collected, turnEnd);
  const body = finalMessage ? collected.slice(0, -1) : collected;
  if (body.length === 0) {
    return;
  }

  const firstOccurredAt = groupStartedAt(body[0]) ?? turnEnd.occurredAt;
  const turnGroup: TimelineGroup = {
    kind: "turn",
    id: `turn-${turnEnd.turnId ?? turnEnd.id}`,
    outcome: turnEnd.outcome,
    startedAt: firstOccurredAt,
    endedAt: turnEnd.occurredAt,
    groups: body,
  };
  if (turnEnd.failureText) {
    turnGroup.failureText = turnEnd.failureText;
  }

  groups.splice(startIndex, collected.length, ...(finalMessage ? [turnGroup, finalMessage] : [turnGroup]));
}

function isTurnBoundary(group: TimelineGroup | undefined): boolean {
  return group?.kind === "turn" || (group?.kind === "item" && group.item.kind === "user-message");
}

function belongsToDifferentTurn(group: TimelineGroup | undefined, turnId: string | null): boolean {
  if (!group || !turnId) {
    return false;
  }
  if (group.kind === "activity") {
    return group.items.length > 0 && group.items.every((item) => item.turnId !== null && item.turnId !== turnId);
  }
  return group.kind === "item" && group.item.kind === "agent-message" && group.item.turnId !== null && group.item.turnId !== turnId;
}

function isBetweenTurnDivider(group: TimelineGroup | undefined): boolean {
  return group?.kind === "item" && group.item.kind === "session-status" && group.item.status !== "running";
}

function extractFinalAgentMessage(groups: TimelineGroup[], turnEnd: TurnEndItem): Extract<TimelineGroup, { kind: "item" }> | null {
  const tail = groups[groups.length - 1];
  if (tail?.kind !== "item" || tail.item.kind !== "agent-message" || tail.item.streaming) {
    return null;
  }
  if (tail.item.turnId && turnEnd.turnId && tail.item.turnId !== turnEnd.turnId) {
    return null;
  }
  return tail;
}

function groupStartedAt(group: TimelineGroup | undefined): string | undefined {
  if (!group) {
    return undefined;
  }
  switch (group.kind) {
    case "item":
      return group.item.occurredAt;
    case "activity":
      return group.items[0]?.occurredAt;
    case "turn":
      return group.startedAt;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const SESSION_STATUSES: readonly SessionStatus[] = ["queued", "running", "idle", "requires_action", "failed", "cancelled"];

/** Keep only entries that match the wire shapes; user payloads are untyped. */
function resourceRefs(value: unknown): import("@opengeni/sdk").ResourceRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is import("@opengeni/sdk").ResourceRef => {
    const record = asRecord(entry);
    if (record.kind === "repository") {
      return typeof record.uri === "string" && typeof record.ref === "string";
    }
    return record.kind === "file" && typeof record.fileId === "string";
  });
}

function toolRefs(value: unknown): import("@opengeni/sdk").ToolRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is import("@opengeni/sdk").ToolRef => {
    const record = asRecord(entry);
    return record.kind === "mcp" && typeof record.id === "string";
  });
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

/** Does this tool output represent an error (explicit flag or MCP `isError`)? */
function isErrorOutput(payload: Record<string, unknown>): boolean {
  if (payload.error === true || payload.failed === true) {
    return true;
  }
  const output = payload.output;
  return !!output && typeof output === "object" && (output as { isError?: unknown }).isError === true;
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

/** The interrupt mode from `session_interrupt` args; defaults to "stop". */
function workerInterruptMode(args: unknown): "stop" | "steer" {
  const record = asRecord(typeof args === "string" ? tryParseJson(args) : args);
  return record.mode === "steer" ? "steer" : "stop";
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
