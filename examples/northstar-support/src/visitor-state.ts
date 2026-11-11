import type {
  SupportCase,
  SupportDomainEvent,
  SupportNote,
  SupportReply,
  SupportTicket,
  SupportWorkspaceState,
} from "./types";

/** Newest entries kept per ticket for notes, replies, and activity. */
export const TICKET_HISTORY_LIMIT = 50;
/** Visitors whose changed data is kept; the least recently active start over first. */
export const MAX_VISITOR_STATES = 200;

const encoder = new TextEncoder();

/**
 * The fictional product's data, kept separately for every visitor, so one
 * browser (or its agent) can never read, change, or reset another's: nothing a
 * visitor writes reaches another visitor's page or agent. A visitor reads the
 * shared read-only seed until its first change, so reads never allocate.
 * Product update events reach only the visitor they belong to.
 */
export class VisitorProductStates {
  readonly maxVisitors: number;
  readonly #seed: SupportWorkspaceState;
  readonly #states = new Map<string, SupportWorkspaceState>();
  readonly #streams = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();

  constructor(seed: readonly SupportCase[], maxVisitors = MAX_VISITOR_STATES) {
    this.maxVisitors = maxVisitors;
    // Frozen: a write that skips `writable` throws instead of changing every visitor's data.
    this.#seed = deepFreeze({ revision: 1, cases: structuredClone(seed) as SupportCase[] });
  }

  /** The visitor's data: its own copy once it changed something, otherwise the read-only seed. */
  read(visitorId: string): SupportWorkspaceState {
    const own = this.#states.get(visitorId);
    if (!own) return this.#seed;
    this.#touch(visitorId, own);
    return own;
  }

  /** The visitor's own mutable copy, created from the seed on its first change. */
  writable(visitorId: string): SupportWorkspaceState {
    const own = this.#states.get(visitorId) ?? {
      revision: this.#seed.revision,
      cases: structuredClone(this.#seed.cases),
    };
    this.#touch(visitorId, own);
    while (this.#states.size > this.maxVisitors) {
      const oldest = this.#states.keys().next().value!;
      this.#states.delete(oldest);
      // Its open pages refetch the seed instead of showing data that is gone.
      this.#broadcast(oldest, this.#event("demo.reset", "Demo data expired", "all"));
    }
    return own;
  }

  /** Drop the visitor's changes. Only this visitor starts over. */
  reset(visitorId: string): SupportWorkspaceState {
    this.#states.delete(visitorId);
    return this.#seed;
  }

  /** Deliver product update events for this visitor to `controller` until the returned function runs. */
  subscribe(
    visitorId: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): () => void {
    let streams = this.#streams.get(visitorId);
    if (!streams) {
      streams = new Set();
      this.#streams.set(visitorId, streams);
    }
    streams.add(controller);
    return () => this.#unsubscribe(visitorId, controller);
  }

  /** Record a change to the visitor's data and tell that visitor's open pages. */
  emit(
    visitorId: string,
    state: SupportWorkspaceState,
    type: SupportDomainEvent["type"],
    summary: string,
    ticketId: string,
  ): SupportDomainEvent {
    if (state !== this.#seed) state.revision += 1;
    const event = this.#event(type, summary, ticketId, state.revision);
    this.#broadcast(visitorId, event);
    return event;
  }

  #event(
    type: SupportDomainEvent["type"],
    summary: string,
    ticketId: string,
    revision = this.#seed.revision,
  ): SupportDomainEvent {
    return {
      id: crypto.randomUUID(),
      type,
      ticketId,
      revision,
      summary,
      occurredAt: new Date().toISOString(),
    };
  }

  #broadcast(visitorId: string, event: SupportDomainEvent): void {
    const streams = this.#streams.get(visitorId);
    if (!streams) return;
    const frame = encoder.encode(
      `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
    for (const controller of streams) {
      try {
        controller.enqueue(frame);
      } catch {
        this.#unsubscribe(visitorId, controller);
      }
    }
  }

  #touch(visitorId: string, state: SupportWorkspaceState): void {
    // Re-insert so the Map's order runs from least to most recently active.
    this.#states.delete(visitorId);
    this.#states.set(visitorId, state);
  }

  #unsubscribe(visitorId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    const streams = this.#streams.get(visitorId);
    streams?.delete(controller);
    if (streams?.size === 0) this.#streams.delete(visitorId);
  }
}

export function findCase(state: SupportWorkspaceState, ticketId: string): SupportCase | null {
  return state.cases.find((supportCase) => supportCase.ticket.id === ticketId) ?? null;
}

// History is bounded: each change makes the visitor's open pages refetch all of it.
export function addActivity(ticket: SupportTicket, actor: string, summary: string): void {
  ticket.activity.unshift({
    id: crypto.randomUUID(),
    actor,
    summary,
    createdAt: new Date().toISOString(),
  });
  ticket.activity.splice(TICKET_HISTORY_LIMIT);
}

export function addNote(ticket: SupportTicket, note: SupportNote): void {
  ticket.notes.unshift(note);
  ticket.notes.splice(TICKET_HISTORY_LIMIT);
}

export function addReply(ticket: SupportTicket, reply: SupportReply): void {
  ticket.replies.push(reply);
  ticket.replies.splice(0, ticket.replies.length - TICKET_HISTORY_LIMIT);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
