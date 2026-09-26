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
 *
 * A segment belongs to one provider message when events carry `messageId`: a
 * delta for another message starts a new segment, and a completion reconciles
 * only the segment of its own message. Completions may arrive after later
 * messages already streamed, so matching by position would let one message's
 * completion close another's segment and repeat its text.
 *
 * Commentary (`phase: "commentary"`) narrates the work, like a tool chunk, so
 * it is held back from the reply text. Only a turn that settles without any
 * answer text falls back to its latest commentary, emitted at settlement.
 */

export type ChatTurnTerminal = "completed" | "failed" | "cancelled" | "pending";

export type ChatFoldStep = {
  chunks: ChatChunk[];
  terminal: ChatTurnTerminal | null;
};

/** Incremental replay of unresolved requests, without retaining the event log. */
export class ChatPendingFold {
  private readonly requests = new Map<string, { pending: ChatPending; turnId: string | null }>();

  push(event: SessionEvent): void {
    const payload = asRecord(event.payload);
    if (event.type === "session.requiresAction") {
      for (const [key, request] of this.requests) {
        if (request.pending.kind === "approval") this.requests.delete(key);
      }
      for (const approval of Array.isArray(payload.approvals) ? payload.approvals : []) {
        const pending = approvalPending({ approvals: [approval] });
        if (pending) this.put(pending, event.turnId ?? null);
      }
    } else if (event.type === "session.humanInput.requested") {
      const pending = humanInputPending(payload);
      if (pending) this.put(pending, event.turnId ?? null);
    } else if (event.type === "user.approvalDecision") {
      this.requests.delete(`approval:${payload.approvalId}`);
    } else if (event.type === "user.humanInputResponse") {
      this.requests.delete(`human_input:${payload.requestId}`);
    } else if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) {
      for (const [key, request] of this.requests) {
        if (request.turnId === null || event.turnId == null || request.turnId === event.turnId) {
          this.requests.delete(key);
        }
      }
    }
  }

  pending(now = Date.now()): ChatPending[] {
    return [...this.requests.values()]
      .map((request) => request.pending)
      .filter((pending) => {
        if (pending.kind !== "human_input") return true;
        const expiresAt = asRecord(pending.payload).expiresAt;
        return expiresAt == null || (typeof expiresAt === "string" && Date.parse(expiresAt) > now);
      });
  }

  private put(pending: ChatPending, turnId: string | null): void {
    this.requests.set(`${pending.kind}:${pending.requestId}`, { pending, turnId });
  }
}

type Segment = {
  text: string;
  open: boolean;
  commentary: boolean;
  /** Provider message identity; `null` for events that carry none. */
  messageId: string | null;
};

function noStep(): ChatFoldStep {
  return { chunks: [], terminal: null };
}

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
      .filter((segment) => !segment.commentary)
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
        if (!text) return noStep();
        const messageId = stringValue(payload.messageId) || null;
        if (messageId) return this.messageDelta(messageId, text, isCommentary(payload));
        const open = this.segments.at(-1);
        if (isCommentary(payload)) {
          if (open?.open && open.commentary) {
            open.text += text;
          } else {
            this.closeSegments();
            this.segments.push({ text, open: true, commentary: true, messageId: null });
          }
          return noStep();
        }
        if (open?.open && !open.commentary) {
          open.text += text;
        } else {
          this.closeSegments();
          return { chunks: [this.startSegment(text, true, null)], terminal: null };
        }
        return { chunks: [{ type: "text", text }], terminal: null };
      }
      case "agent.message.completed": {
        const text = stringValue(payload.text) ?? "";
        const messageId = stringValue(payload.messageId) || null;
        if (messageId) return this.messageCompleted(messageId, text, isCommentary(payload));
        const last = this.segments.at(-1);
        if (isCommentary(payload)) {
          if (last?.commentary && (last.open || text.startsWith(last.text))) {
            last.open = false;
            if (text) last.text = text;
            return noStep();
          }
          // Undeclared deltas that the completion reveals as commentary were
          // already streamed as reply text; keep the reply equal to the stream.
          const streamed = last && !last.commentary && last.open && text.startsWith(last.text);
          if (!streamed) {
            if (text) {
              this.closeSegments();
              this.segments.push({ text, open: false, commentary: true, messageId: null });
            }
            return noStep();
          }
        }
        const target = last?.commentary ? undefined : last;
        if (!target || (!target.open && target.text && !text.startsWith(target.text))) {
          if (!text) return noStep();
          // The phase-less settlement copy of an answer this turn already
          // completed message by message.
          if (payload.phase === undefined && this.latestAnswer()?.text === text) return noStep();
          this.closeSegments();
          return { chunks: [this.startSegment(text, false, null)], terminal: null };
        }
        target.open = false;
        return { chunks: this.extendAnswer(target, text), terminal: null };
      }
      case "agent.toolCall.created": {
        this.closeSegments();
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
        this.pending = pending;
        return {
          chunks: [...this.settleSegments(), { type: "pending", pending }],
          terminal: "pending",
        };
      }
      case "session.humanInput.requested": {
        const pending = humanInputPending(payload);
        if (!pending) return { chunks: [], terminal: null };
        this.pending = pending;
        return {
          chunks: [...this.settleSegments(), { type: "pending", pending }],
          terminal: "pending",
        };
      }
      case "turn.completed":
        return { chunks: this.settleSegments(), terminal: "completed" };
      case "turn.failed":
        this.failure = event;
        return { chunks: this.settleSegments(), terminal: "failed" };
      case "turn.cancelled":
        return { chunks: this.settleSegments(), terminal: "cancelled" };
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

  private messageDelta(messageId: string, text: string, commentary: boolean): ChatFoldStep {
    const segment = this.segmentOf(messageId);
    if (segment?.open) {
      segment.text += text;
      return segment.commentary ? noStep() : { chunks: [{ type: "text", text }], terminal: null };
    }
    // Providers stream messages one after another: every earlier one is done.
    this.closeSegments();
    if (commentary) {
      this.segments.push({ text, open: true, commentary: true, messageId });
      return noStep();
    }
    return { chunks: [this.startSegment(text, true, messageId)], terminal: null };
  }

  private messageCompleted(messageId: string, text: string, commentary: boolean): ChatFoldStep {
    const segment = this.segmentOf(messageId) ?? this.unidentifiedStreamingSegment(text);
    if (segment) {
      segment.messageId = messageId;
      segment.open = false;
      if (segment.commentary) {
        if (text) segment.text = text;
        return noStep();
      }
      // Streamed as reply text, even when the completion reveals commentary:
      // the reply stays equal to what append-only consumers already have.
      return { chunks: this.extendAnswer(segment, text), terminal: null };
    }
    if (!text) return noStep();
    if (commentary) {
      this.segments.push({ text, open: false, commentary: true, messageId });
      return noStep();
    }
    return { chunks: [this.startSegment(text, false, messageId)], terminal: null };
  }

  private segmentOf(messageId: string): Segment | undefined {
    return this.findLastSegment((segment) => segment.messageId === messageId);
  }

  /** Deltas that carried no identity, still streaming the text this completion names. */
  private unidentifiedStreamingSegment(text: string): Segment | undefined {
    const last = this.segments.at(-1);
    return last?.open && last.messageId === null && text.startsWith(last.text) ? last : undefined;
  }

  private latestAnswer(): Segment | undefined {
    return this.findLastSegment((segment) => !segment.commentary);
  }

  private findLastSegment(predicate: (segment: Segment) => boolean): Segment | undefined {
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      const segment = this.segments[index]!;
      if (predicate(segment)) return segment;
    }
    return undefined;
  }

  /**
   * Complete an answer segment. Only the newest answer can grow: a remainder
   * for an earlier one would land after later text for append-only consumers.
   */
  private extendAnswer(segment: Segment, text: string): ChatChunk[] {
    if (text.length <= segment.text.length || !text.startsWith(segment.text)) return [];
    if (segment !== this.latestAnswer()) return [];
    const remainder = text.slice(segment.text.length);
    segment.text = text;
    return [{ type: "text", text: remainder }];
  }

  private closeSegments(): void {
    for (const segment of this.segments) segment.open = false;
  }

  /**
   * Close the turn's text. A turn that produced commentary but no answer text
   * (for example one that ends waiting for a worker) replies with its latest
   * commentary rather than nothing.
   */
  private settleSegments(): ChatChunk[] {
    this.closeSegments();
    if (this.segments.some((segment) => !segment.commentary)) return [];
    const latest = [...this.segments]
      .reverse()
      .find((segment) => segment.commentary && segment.text);
    if (!latest) return [];
    latest.commentary = false;
    return [{ type: "text", text: latest.text }];
  }

  private startSegment(text: string, open: boolean, messageId: string | null): ChatChunk {
    // Match the separator used by `text` before exposing the next segment to
    // append-only consumers (React and both protocol adapters).
    const separator = this.segments.some((segment) => !segment.commentary) ? "\n\n" : "";
    this.segments.push({ text, open, commentary: false, messageId });
    return { type: "text", text: separator + text };
  }
}

function isCommentary(payload: Record<string, unknown>): boolean {
  return payload.phase === "commentary";
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
