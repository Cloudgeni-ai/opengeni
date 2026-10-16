import type { OpenGeniClient } from "./client";
import { ChatTurnFold } from "./chat/fold";
import type { CreateSessionRequest } from "./types";

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
  run(request: OpenGeniSiteAiRequest, options?: OpenGeniSiteAiOptions): Promise<OpenGeniSiteAiResult>;
  /** Observe without sending work. Omit `after` to replay the complete answer;
   * with `after`, text/onText contain only subsequent output. Pass the retained
   * turnId when resuming a pending turn, so another turn cannot settle it. */
  result(
    sessionId: string,
    options?: OpenGeniSiteAiOptions & { after?: number; turnId?: string },
  ): Promise<OpenGeniSiteAiResult>;
};

/** Native create + native replayable events only; the host remains the authority. */
export function createOpenGeniSiteAi(
  client: Pick<OpenGeniClient, "createSession" | "streamEvents">,
  workspaceId: string,
): OpenGeniSiteAi {
  const result: OpenGeniSiteAi["result"] = async (sessionId, options = {}) => {
    options.signal?.throwIfAborted();
    const fold = new ChatTurnFold(workspaceId, sessionId, options.turnId ?? null);
    let after = options.after ?? 0;
    for await (const event of client.streamEvents(workspaceId, sessionId, {
      after,
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      after = event.coveredThrough ?? event.sequence;
      const step = fold.push(event);
      for (const chunk of step.chunks)
        if (chunk.type === "text") options.onText?.(chunk.text);
      if (step.terminal === "failed") throw fold.failureError();
      // Published-host event views deliberately omit approval/input payloads.
      // The lifecycle event still says the work is waiting, not completed.
      const sameTurn = !event.turnId || !fold.turnId || event.turnId === fold.turnId;
      const pending =
        sameTurn &&
        (event.type === "session.requiresAction" || event.type === "session.humanInput.requested");
      if (step.terminal || pending) {
        const reply = fold.reply(step.terminal ?? "pending");
        return { sessionId, turnId: reply.turnId, text: reply.text, status: reply.status, after };
      }
    }
    options.signal?.throwIfAborted();
    throw new Error("The Site AI event stream ended before the turn settled.");
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
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
        ...(request.latencyMode === undefined ? {} : { latencyMode: request.latencyMode }),
      });
      options.onSession?.(session.id);
      return await result(session.id, options);
    },
    result,
  };
}
