import type { SessionEvent, SessionEventToolOutputPreview } from "@opengeni/sdk";
import { useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * Exact reads of tool outputs a step page delivered as bounded previews.
 *
 * A turn's steps are read with `toolOutputs: "preview"`, so a large tool
 * output arrives as its head and tail with an `outputPreview` fact. When a
 * reader expands that row (or its renderer needs the exact output) the row's
 * exact output event is read once, by its sequence, and replaces the preview.
 */

export type ToolOutputReadState = "loading" | "error" | "loaded";

/** One row's exact-output read, as the timeline projection sees it. */
export type ToolOutputRead = {
  state: ToolOutputReadState | "preview";
  load: () => void;
};

export type ToolOutputReader = (
  eventId: string,
  sequence: number,
  turnId: string | null,
) => ToolOutputRead;

/** The exact tool-output events of a page around one sequence. */
export type ToolOutputPageRead = (sequence: number) => Promise<readonly SessionEvent[]>;

type Entry = {
  state: ToolOutputReadState;
  sequence: number;
  turnId: string | null;
  event: SessionEvent | null;
};

/** Exact-output reads in flight at once; the rest wait their turn. */
export const TOOL_OUTPUT_READS_IN_FLIGHT = 4;

const EMPTY_ENTRIES: ReadonlyMap<string, Entry> = new Map();

/** The preview fact of a step-page tool output, or null for an exact one. */
export function toolOutputPreviewFact(payload: unknown): SessionEventToolOutputPreview | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const fact = (payload as Record<string, unknown>).outputPreview;
  if (!fact || typeof fact !== "object" || Array.isArray(fact)) return null;
  const record = fact as Record<string, unknown>;
  if (record.truncated !== true || (record.shape !== "structured" && record.shape !== "text")) {
    return null;
  }
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    truncated: true,
    reason: "tool_output_preview",
    shape: record.shape,
    originalBytes: count(record.originalBytes),
    previewBytes: count(record.previewBytes),
  };
}

/** Whether a session event is a tool output delivered as a preview. */
export function isToolOutputPreviewEvent(event: SessionEvent): boolean {
  return event.type === "agent.toolCall.output" && toolOutputPreviewFact(event.payload) !== null;
}

/**
 * One session's exact-output reads. A new store replaces it when the session
 * or client changes, so a read that settles late lands in a store no one reads.
 */
class ToolOutputReads {
  private entries: ReadonlyMap<string, Entry> = EMPTY_ENTRIES;
  private readonly listeners = new Set<() => void>();
  private readonly queue: string[] = [];
  private inFlight = 0;
  private readonly loads = new Map<string, () => void>();

  constructor(private readonly read: ToolOutputPageRead) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = () => this.entries;

  /** The stable loader for one row, so an open row's effect asks once. */
  loader(eventId: string, sequence: number, turnId: string | null): () => void {
    let load = this.loads.get(eventId);
    if (!load) {
      load = () => this.request(eventId, sequence, turnId);
      this.loads.set(eventId, load);
    }
    return load;
  }

  /**
   * Forget exact outputs of turns whose steps are no longer loaded. They live
   * exactly as long as the step page that delivered their previews, so an
   * open row never loses its exact output to make room for another.
   */
  retainTurns(turns: ReadonlySet<string>): void {
    let next: Map<string, Entry> | null = null;
    for (const [eventId, entry] of this.entries) {
      if (entry.state === "loading" || !entry.turnId || turns.has(entry.turnId)) continue;
      next ??= new Map(this.entries);
      next.delete(eventId);
    }
    if (next) this.commit(next);
  }

  private request(eventId: string, sequence: number, turnId: string | null): void {
    const existing = this.entries.get(eventId);
    if (existing?.state === "loading" || existing?.state === "loaded") return;
    this.commit(
      new Map(this.entries).set(eventId, {
        state: "loading",
        sequence,
        turnId,
        event: null,
      }),
    );
    this.queue.push(eventId);
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < TOOL_OUTPUT_READS_IN_FLIGHT && this.queue.length > 0) {
      const eventId = this.queue.shift()!;
      const entry = this.entries.get(eventId);
      if (!entry || entry.state !== "loading") continue;
      this.inFlight += 1;
      const settle = (event: SessionEvent | null) => {
        this.inFlight -= 1;
        const latest = this.entries.get(eventId);
        if (latest?.state === "loading") {
          this.commit(
            new Map(this.entries).set(eventId, {
              ...latest,
              state: event && !isToolOutputPreviewEvent(event) ? "loaded" : "error",
              event: event && !isToolOutputPreviewEvent(event) ? event : null,
            }),
          );
        }
        this.pump();
      };
      void this.read(entry.sequence).then(
        (events) => settle(events.find((event) => event.id === eventId) ?? null),
        () => settle(null),
      );
    }
  }

  private commit(next: ReadonlyMap<string, Entry>): void {
    this.entries = next;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Reads each requested row's exact output once, a few at a time. `read`
 * identifies the session: reads are forgotten when it changes. Exact outputs
 * are kept only for turns in `turns` (the turns whose steps are loaded).
 */
export function useToolOutputReads(
  read: ToolOutputPageRead,
  turns: ReadonlyMap<string, unknown>,
): {
  /** Exact output events by event id. */
  exact: ReadonlyMap<string, SessionEvent>;
  reader: ToolOutputReader;
} {
  const store = useMemo(() => new ToolOutputReads(read), [read]);
  const entries = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => {
    store.retainTurns(new Set(turns.keys()));
  }, [store, turns]);
  return useMemo(() => {
    const exact = new Map<string, SessionEvent>();
    for (const [eventId, entry] of entries) if (entry.event) exact.set(eventId, entry.event);
    const reader: ToolOutputReader = (eventId, sequence, turnId) => ({
      state: entries.get(eventId)?.state ?? "preview",
      load: store.loader(eventId, sequence, turnId),
    });
    return { exact, reader };
  }, [store, entries]);
}
