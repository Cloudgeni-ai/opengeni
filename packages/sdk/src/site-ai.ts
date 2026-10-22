import type { OpenGeniClient } from "./client";
import { ChatTurnFold, asRecord, type ChatTurnTerminal } from "./chat/fold";
import { sessionEventStreamCoveredThrough } from "./stream";
import type { CreateSessionRequest, Session, SessionEvent } from "./types";

/** App-authored input, unchanged: no built-in tasks, prompt templates or UI. */
export type OpenGeniSiteAiRequest = Pick<
  CreateSessionRequest,
  "initialMessage" | "idempotencyKey" | "model" | "reasoningEffort" | "latencyMode"
> & { initialMessage: string };

export type OpenGeniSiteAiResult = {
  sessionId: string;
  turnId: string | null;
  text: string;
  status: "completed" | "pending" | "cancelled";
  /** Cursor for subsequent output. Resuming after it returns a suffix, not earlier text. */
  after: number;
};

export type OpenGeniSiteAiOptions = {
  /** Stops observing, not the underlying work. Use the ordinary session control API to cancel. */
  signal?: AbortSignal;
  /** Retain the handle before waiting for output, including when observation is interrupted. */
  onSession?: (sessionId: string) => void;
  /** Append-only answer text, folded by the same SDK implementation as embedded chat. */
  onText?: (text: string) => void;
};

export type OpenGeniSiteAi = {
  /** Starts an ordinary viewer-owned Site session and returns its first turn's output. */
  run(
    request: OpenGeniSiteAiRequest,
    options?: OpenGeniSiteAiOptions,
  ): Promise<OpenGeniSiteAiResult>;
  /** Observe without sending work. Omit `after` to replay the complete answer;
   * with `after`, text/onText contain only subsequent output. Pass the retained
   * turnId when resuming a pending turn, so another turn cannot settle it. */
  result(
    sessionId: string,
    options?: OpenGeniSiteAiOptions & { after?: number; turnId?: string },
  ): Promise<OpenGeniSiteAiResult>;
};

/** Native create, session state and replayable events; the host remains the authority. */
export function createOpenGeniSiteAi(
  client: Pick<OpenGeniClient, "createSession" | "getSession" | "listEventPage" | "streamEvents">,
  workspaceId: string,
): OpenGeniSiteAi {
  const result: OpenGeniSiteAi["result"] = async (sessionId, options = {}) => {
    options.signal?.throwIfAborted();
    const upstream = new AbortController();
    const onAbort = () => upstream.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cutoff = options.after ?? 0;
    let after = 0;
    let text = "";
    let fold =
      options.turnId || cutoff === 0
        ? new ChatTurnFold(workspaceId, sessionId, options.turnId ?? null)
        : null;
    // Without a retained turn id, select the first turn after the cursor, as
    // live observation does. Keep the prefix only until that turn is known.
    let prefix: SessionEvent[] = [];
    let terminal: ChatTurnTerminal | null = null;
    const pending: { event: SessionEvent | null } = { event: null };
    let stream: ReturnType<OpenGeniClient["streamEvents"]> | undefined;
    let streamAbort: AbortController | undefined;
    const closeStream = () => {
      streamAbort?.abort();
      // Some fetch implementations await request abort in iterator.return().
      // Abort first, and never make result delivery depend on its unwinding.
      if (stream) void Promise.resolve(stream.return(undefined)).catch(() => undefined);
      stream = undefined;
      streamAbort = undefined;
    };
    const onUpstreamAbort = () => streamAbort?.abort(upstream.signal.reason);
    upstream.signal.addEventListener("abort", onUpstreamAbort);
    const emit = (chunks: ReturnType<ChatTurnFold["push"]>["chunks"]) => {
      for (const chunk of chunks)
        if (chunk.type === "text") {
          upstream.signal.throwIfAborted();
          text += chunk.text;
          options.onText?.(chunk.text);
        }
    };
    const selectTurn = (turnId: string | null) => {
      fold = new ChatTurnFold(workspaceId, sessionId, turnId);
      for (const event of prefix) {
        const step = fold.push(event);
        if (step.terminal && step.terminal !== "pending") terminal = step.terminal;
      }
      prefix = [];
    };
    const consume = (event: SessionEvent) => {
      const covered = eventCursor(event);
      if (covered <= after) return;
      after = covered;
      if (!fold) {
        if (covered <= cutoff) {
          prefix.push(event);
          return;
        }
        if (!isTurnOutput(event) && !isWait(event)) return;
        selectTurn(event.turnId ?? lastTurnId(prefix));
      }
      const current = fold!;
      const sameTurn = !event.turnId || !current.turnId || event.turnId === current.turnId;
      if (sameTurn && isWait(event)) {
        if (!current.turnId && event.turnId) current.turnId = event.turnId;
        if (event.type !== "session.status.changed") pending.event = event;
        // A historical wait is not a settlement. Only fold it here when
        // rebuilding text the caller already observed before their cursor.
        if (covered > cutoff) return;
      }
      const step = current.push(event);
      if (covered > cutoff) emit(step.chunks);
      if (step.terminal && step.terminal !== "pending") terminal = step.terminal;
    };
    const reply = (status: ChatTurnTerminal): OpenGeniSiteAiResult => {
      upstream.signal.throwIfAborted();
      if (status === "failed") throw fold!.failureError();
      return {
        sessionId,
        turnId: fold?.turnId ?? null,
        text,
        status:
          status === "pending" ? "pending" : status === "cancelled" ? "cancelled" : "completed",
        after: Math.max(cutoff, after),
      };
    };
    const readSession = () =>
      observe(
        () => client.getSession(workspaceId, sessionId, { fresh: true, signal: upstream.signal }),
        upstream.signal,
      );
    const replayThrough = async (through: number) => {
      while (after < through) {
        const previous = after;
        const page = await observe(
          () =>
            client.listEventPage(workspaceId, sessionId, {
              after,
              before: through + 1,
              direction: "after",
              limit: 200,
              mode: "forensic",
              payloadMode: "full",
            }),
          upstream.signal,
        );
        for (const event of page.events) {
          consume(event);
          if (terminal && after > cutoff) return;
        }
        // Byte-limited short pages are not EOF; follow durable coverage.
        after = Math.max(after, page.nextAfter ?? page.coveredSequence?.last ?? 0);
        if (after <= previous)
          throw new Error("The Site AI event replay did not reach the session cursor.");
      }
    };
    const waiting = (session: Session) =>
      session.status === "requires_action" &&
      (!session.activeTurnId || !fold?.turnId || session.activeTurnId === fold.turnId);
    try {
      let session = await readSession();
      // Reconstruct the exact prefix separately: unlike SSE coalescing, this
      // bounded native page read cannot merge output from both sides of cutoff.
      await replayThrough(Math.min(cutoff, session.lastSequence));
      if (terminal) return reply(terminal);
      for (;;) {
        await replayThrough(session.lastSequence);
        if (terminal) return reply(terminal);
        if (waiting(session)) {
          const fresh = await readSession();
          if (fresh.lastSequence > after) {
            session = fresh;
            continue;
          }
          if (waiting(fresh)) {
            if (!fold) selectTurn(fresh.activeTurnId ?? lastTurnId(prefix));
            else if (!fold.turnId) fold.turnId = fresh.activeTurnId ?? null;
            if (pending.event && eventCursor(pending.event) > cutoff)
              emit(fold!.push(pending.event).chunks);
            return reply("pending");
          }
          session = fresh;
        }
        streamAbort = new AbortController();
        stream = client.streamEvents(workspaceId, sessionId, {
          after: Math.max(cutoff, after),
          signal: streamAbort.signal,
        });
        for (;;) {
          const next = await observe(() => stream!.next(), upstream.signal);
          if (next.done) throw new Error("The Site AI event stream ended before the turn settled.");
          consume(next.value);
          if (terminal) return reply(terminal);
          if (isWait(next.value) && (!next.value.turnId || next.value.turnId === fold?.turnId)) {
            // Reconcile the finite durable tail before declaring a live wait.
            // Reopen from its cursor so buffered SSE overlap cannot repeat text.
            closeStream();
            session = await readSession();
            break;
          }
        }
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      upstream.abort();
      closeStream();
      upstream.signal.removeEventListener("abort", onUpstreamAbort);
    }
  };
  return {
    async run(request, options = {}) {
      options.signal?.throwIfAborted();
      // Pick the message fields rather than forwarding a caller's extra runtime
      // properties. Tools, ownership, credentials and limits belong to the host.
      const session = await client.createSession(workspaceId, {
        initialMessage: request.initialMessage,
        idempotencyKey: request.idempotencyKey ?? crypto.randomUUID(),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort }),
        ...(request.latencyMode === undefined ? {} : { latencyMode: request.latencyMode }),
      });
      options.onSession?.(session.id);
      return await result(session.id, options);
    },
    result,
  };
}

function isWait(event: SessionEvent): boolean {
  return (
    event.type === "session.requiresAction" ||
    event.type === "session.humanInput.requested" ||
    (event.type === "session.status.changed" &&
      asRecord(event.payload).status === "requires_action")
  );
}

function isTurnOutput(event: SessionEvent): boolean {
  return (
    event.type.startsWith("turn.") ||
    event.type.startsWith("agent.") ||
    event.type === "user.message"
  );
}

function lastTurnId(events: SessionEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.turnId && (isTurnOutput(event) || isWait(event))) return event.turnId;
  }
  return null;
}

function eventCursor(event: SessionEvent): number {
  return Math.max(
    event.sequence,
    event.coveredThrough ?? 0,
    sessionEventStreamCoveredThrough(event) ?? 0,
  );
}

/** Event-page reads have no signal option; observation can still stop immediately. */
async function observe<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const value = await Promise.race([read(), aborted]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
