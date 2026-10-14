import type { SessionEvent } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { settleInterruptedContextCompactionLandmark } from "../context-compaction";
import { safeErrorDiagnostic } from "./errors";
import { turnOperationCancellationFailure } from "./sandbox-provision";

/**
 * Whether a context compaction ended because its own turn attempt was
 * cancelled (graceful worker shutdown, Pause/Steer/Cancel delivery, or any
 * other Temporal activity cancellation) rather than because the provider or
 * summarizer failed.
 *
 * Structural only: the attempt's cancellation signal state or a typed
 * cancellation error. Never classify by error message text.
 */
export function isContextCompactionInterruption(
  error: unknown,
  cancellationSignal: AbortSignal | undefined,
): boolean {
  return cancellationSignal?.aborted === true || turnOperationCancellationFailure(error) !== null;
}

/**
 * Settle an already-started compaction landmark as `interrupted` so the
 * timeline neither sticks on "Compacting…" nor reports a summarization
 * failure that never happened. Best effort: the cancellation is the
 * authoritative outcome and must keep propagating, so a landmark write that
 * loses to a closing control or to a database fault is logged and dropped.
 */
export async function settleContextCompactionInterruption(
  db: Database,
  scope: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
  },
  options: {
    publishLiveEvents?: (events: SessionEvent[]) => Promise<void>;
    observability?: { warn(message: string, fields?: Record<string, unknown>): void };
  },
): Promise<void> {
  try {
    await settleInterruptedContextCompactionLandmark(db, scope, {
      ...(options.publishLiveEvents ? { publishLiveEvents: options.publishLiveEvents } : {}),
    });
  } catch (error) {
    options.observability?.warn("context compaction interruption landmark was not recorded", {
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      ...safeErrorDiagnostic(error),
    });
  }
}
