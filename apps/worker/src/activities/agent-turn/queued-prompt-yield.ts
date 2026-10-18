/**
 * A person's prompt (human or API Send) is queued behind the running turn.
 *
 * Thrown by model-call admission before the next model request leaves the
 * worker, after the previous step's tool results are durable. The stream
 * loop catches it and settles the turn `superseded` with reason
 * `queued_prompt`, so the queued prompt runs next with the full history: it
 * waits at most one model step instead of the whole turn. No request is sent
 * and no history is rewritten; the next turn only appends the prompt.
 */
export class QueuedPromptYieldError extends Error {
  constructor() {
    super("A queued prompt is waiting behind this turn");
    this.name = "QueuedPromptYieldError";
  }
}

/** Find the yield request through SDK/runtime error wrapping. */
export function findQueuedPromptYieldError(
  error: unknown,
  seen = new WeakSet<object>(),
): QueuedPromptYieldError | null {
  if (error instanceof QueuedPromptYieldError) return error;
  if (!error || typeof error !== "object" || seen.has(error)) return null;
  seen.add(error);
  const record = error as Record<string, unknown>;
  return (
    findQueuedPromptYieldError(record.cause, seen) ?? findQueuedPromptYieldError(record.error, seen)
  );
}
