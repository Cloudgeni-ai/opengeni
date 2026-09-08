import type { SessionEvent } from "../types";
import { OpenGeniChatError, type ChatChunk, type ChatPending, type ChatReply } from "./types";

/**
 * Event folding shared by `send`, `stream`, and every protocol adapter.
 *
 * One fold covers one logical turn: text deltas accumulate into message
 * segments (a tool call closes the current segment, the completed event
 * reconciles it), tool call/output pairs become tool chunks, and the turn
 * settles on a terminal event or a human wait. Events that carry a different
 * turn id than the expected one are ignored so a queued follow-up never ends
 * early on the previous turn's settlement.
 */

export type ChatTurnTerminal = "completed" | "failed" | "cancelled" | "pending";

export type ChatFoldStep = {
  chunks: ChatChunk[];
  terminal: ChatTurnTerminal | null;
};

type Segment = { text: string; open: boolean };

export class ChatTurnFold {
  readonly events: SessionEvent[] = [];
  turnId: string | null;
  pending: ChatPending | null = null;
  failure: SessionEvent | null = null;
  private readonly segments: Segment[] = [];
  private readonly openTools = new Map<string, string>();

  constructor(
    private readonly workspaceId: string,
    private readonly sessionId: string,
    expectedTurnId: string | null,
  ) {
    this.turnId = expectedTurnId;
  }

  get text(): string {
    return this.segments
      .map((segment) => segment.text)
      .filter((text) => text.length > 0)
      .join("\n\n");
  }

  push(event: SessionEvent): ChatFoldStep {
    const eventTurnId = typeof event.turnId === "string" ? event.turnId : null;
    if (this.turnId && eventTurnId && eventTurnId !== this.turnId) {
      return { chunks: [], terminal: null };
    }
    if (!this.turnId && eventTurnId && isTurnScopedType(event.type)) {
      this.turnId = eventTurnId;
    }
    this.events.push(event);
    const payload = asRecord(event.payload);
    switch (event.type) {
      case "agent.message.delta": {
        const text = stringValue(payload.text);
        if (!text) return { chunks: [], terminal: null };
        const open = this.segments.at(-1);
        if (open?.open) {
          open.text += text;
        } else {
          this.segments.push({ text, open: true });
        }
        return { chunks: [{ type: "text", text }], terminal: null };
      }
      case "agent.message.completed": {
        const text = stringValue(payload.text) ?? "";
        const target = this.segments.at(-1);
        if (!target || (!target.open && target.text && !text.startsWith(target.text))) {
          if (!text) return { chunks: [], terminal: null };
          this.segments.push({ text, open: false });
          return { chunks: [{ type: "text", text }], terminal: null };
        }
        target.open = false;
        if (text.length > target.text.length && text.startsWith(target.text)) {
          const remainder = text.slice(target.text.length);
          target.text = text;
          return { chunks: [{ type: "text", text: remainder }], terminal: null };
        }
        if (!target.text && text) {
          target.text = text;
          return { chunks: [{ type: "text", text }], terminal: null };
        }
        return { chunks: [], terminal: null };
      }
      case "agent.toolCall.created": {
        this.closeSegment();
        const name = stringValue(payload.name) ?? "tool";
        const callId = stringValue(payload.id);
        if (callId) this.openTools.set(callId, name);
        return {
          chunks: [
            {
              type: "tool",
              name,
              status: "started",
              ...(callId ? { callId } : {}),
              ...("arguments" in payload ? { input: payload.arguments } : {}),
            },
          ],
          terminal: null,
        };
      }
      case "agent.toolCall.output": {
        const callId = stringValue(payload.id);
        const name = (callId ? this.openTools.get(callId) : undefined) ?? "tool";
        if (callId) this.openTools.delete(callId);
        return {
          chunks: [
            {
              type: "tool",
              name,
              status: isErrorOutput(payload) ? "failed" : "completed",
              ...(callId ? { callId } : {}),
            },
          ],
          terminal: null,
        };
      }
      case "session.requiresAction": {
        const pending = approvalPending(payload);
        if (!pending) return { chunks: [], terminal: null };
        this.closeSegment();
        this.pending = pending;
        return { chunks: [{ type: "pending", pending }], terminal: "pending" };
      }
      case "session.humanInput.requested": {
        const pending = humanInputPending(payload);
        if (!pending) return { chunks: [], terminal: null };
        this.closeSegment();
        this.pending = pending;
        return { chunks: [{ type: "pending", pending }], terminal: "pending" };
      }
      case "turn.completed":
        this.closeSegment();
        return { chunks: [], terminal: "completed" };
      case "turn.failed":
        this.closeSegment();
        this.failure = event;
        return { chunks: [], terminal: "failed" };
      case "turn.cancelled":
        this.closeSegment();
        return { chunks: [], terminal: "cancelled" };
      default:
        return { chunks: [], terminal: null };
    }
  }

  reply(terminal: ChatTurnTerminal): ChatReply {
    const text = this.text;
    return {
      text,
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      turnId: this.turnId,
      status:
        terminal === "pending" ? "pending" : terminal === "cancelled" ? "cancelled" : "completed",
      pending: this.pending,
      events: [...this.events],
      toString: () => text,
    };
  }

  /** The error to throw for a `turn.failed` settlement. */
  failureError(): OpenGeniChatError {
    const payload = asRecord(this.failure?.payload);
    const code = stringValue(payload.code) ?? "turn_failed";
    const message =
      stringValue(payload.error) ?? stringValue(payload.message) ?? "The turn failed.";
    return new OpenGeniChatError(code, message, this.failure);
  }

  private closeSegment(): void {
    const open = this.segments.at(-1);
    if (open) open.open = false;
  }
}

function isTurnScopedType(type: string): boolean {
  return type.startsWith("turn.") || type.startsWith("agent.") || type === "user.message";
}

export function approvalPending(payload: Record<string, unknown>): ChatPending | null {
  const approvals = Array.isArray(payload.approvals) ? payload.approvals : [];
  const first = approvals[0];
  if (!first) return null;
  const raw = asRecord(first);
  const rawItem = asRecord(raw.rawItem);
  const requestId =
    stringValue(rawItem.callId) ??
    stringValue(rawItem.id) ??
    stringValue(raw.id) ??
    stringValue(raw.callId);
  if (!requestId) return null;
  return {
    kind: "approval",
    requestId,
    name: stringValue(raw.name) ?? stringValue(raw.toolName) ?? stringValue(rawItem.name) ?? null,
    payload: first,
  };
}

export function humanInputPending(payload: Record<string, unknown>): ChatPending | null {
  const request = asRecord(payload.request);
  const requestId = stringValue(request.id);
  if (!requestId || !Array.isArray(request.questions)) return null;
  return { kind: "human_input", requestId, name: null, payload: payload.request };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isErrorOutput(payload: Record<string, unknown>): boolean {
  if (payload.error === true || payload.failed === true) return true;
  const output = payload.output;
  return (
    !!output && typeof output === "object" && (output as { isError?: unknown }).isError === true
  );
}
