import { appendSessionHistoryItems, upsertSandboxSessionEnvelope } from "@opengeni/db";
import { sandboxStateEntryFromRunState, type OpenGeniRuntime } from "@opengeni/runtime";
import type { Settings } from "@opengeni/config";
import { TurnAttemptFencedError } from "../turn-attempt-fenced";
import type { SharedActivityServices } from "../types";
import { compactGeneratedImageHistory } from "../generated-images";
import { compactRetainedScreenshotHistory } from "../retained-screenshots";
import type { turnInput } from "../run-input";
import { safeErrorDiagnostic } from "./errors";
import { historyRowsToAppend, isModelOrToolProgressHistoryItem } from "./history";
import { runMandatoryHistoryPersistenceStep } from "./quiescence";
import type { TurnMediaArtifacts } from "./media-artifacts";

export type TurnHistorySinkDeps = {
  db: SharedActivityServices["db"];
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  media: TurnMediaArtifacts;
  getTurnId: () => string | undefined;
  getStream: () => Awaited<ReturnType<OpenGeniRuntime["runStream"]>> | undefined;
  getModelRunSettings: () => Settings;
  getExecutionGeneration: () => number;
};

/**
 * Dual-write of conversation truth (issue #35): completed items are reconciled
 * into session_history_items after every model response and at every turn-end
 * path (idempotent on position), and the sandbox recovery envelope is upserted
 * alongside. Best-effort by design: persistence problems must never fail the
 * run.
 *
 * Orphaned-tool-output guard: `stream.state.history` is NOT a plain
 * append-only array — it is a computed getter
 * (`getTurnInput(originalInput, generatedItems)`) that runs the SDK's
 * `dropOrphanToolCalls` on every access, so a `function_call` with no settling
 * result yet is transiently ABSENT from history and a later reconcile sees a
 * DIFFERENT, shorter/reordered list. A blind length watermark with
 * onConflictDoNothing-on-position then freezes the first shape of a position
 * and can persist a `function_call_result` at a tail position while its
 * `function_call` was pruned away in an earlier slice and never written — the
 * orphan that bricks the session. We defend against it at the stream boundary
 * with the turn-scoped pending-tool ledger. A partial parallel batch records
 * raw results but does not call this reconciler. Once every registered call has
 * a result, the SDK history is stable and this scalar append watermark is valid
 * again. The sanitizer remains the final call/result pairing guard for every
 * other reconcile.
 */
export class TurnHistorySink {
  persistedHistoryCount = 0;
  nextHistoryPosition = 0;
  providerArtifactCandidates: Awaited<ReturnType<typeof turnInput>>["providerArtifactCandidates"] =
    {
      knownHistoryItemIds: [],
      historyItemIds: [],
    };

  constructor(private readonly deps: TurnHistorySinkDeps) {}

  reconcileConversationTruth = async (
    options: { skipInputOnlyRows?: boolean; requireDurable?: boolean } = {},
  ) => {
    const { media } = this.deps;
    const stream = this.deps.getStream();
    const turnId = this.deps.getTurnId();
    if (!stream || !turnId) {
      return;
    }
    const durableTurnId = turnId;
    try {
      const rawHistory = (stream.state as { history?: unknown[] }).history;
      if (Array.isArray(rawHistory)) {
        const typedHistory = rawHistory as Array<Record<string, unknown>>;
        await media.retainNativeGeneratedImagesFromHistory(typedHistory);
        const durableHistory = compactGeneratedImageHistory(
          compactRetainedScreenshotHistory(typedHistory, media.retainedScreenshotReceiptsByCallId),
          media.generatedImageReceiptsByProviderItemId,
        );
        const { rows, nextWatermark, nextPosition } = historyRowsToAppend(
          durableHistory,
          this.persistedHistoryCount,
          this.nextHistoryPosition,
          this.deps.getModelRunSettings().modelToolOutputTruncationTokens,
        );
        const hasModelOrToolProgress = rows.some((row) =>
          isModelOrToolProgressHistoryItem(row.item),
        );
        const shouldAppendRows =
          rows.length > 0 && (!options.skipInputOnlyRows || hasModelOrToolProgress);
        if (shouldAppendRows) {
          await runMandatoryHistoryPersistenceStep("history_append", async () => {
            const appended = await appendSessionHistoryItems(this.deps.db, {
              accountId: this.deps.accountId,
              workspaceId: this.deps.workspaceId,
              sessionId: this.deps.sessionId,
              turnId: durableTurnId,
              expectedExecutionGeneration: this.deps.getExecutionGeneration(),
              expectedAttemptId: this.deps.attemptId,
              modelToolOutputTruncationTokens:
                this.deps.getModelRunSettings().modelToolOutputTruncationTokens,
              items: rows,
            });
            if (!appended) {
              throw new TurnAttemptFencedError(
                "turn execution generation was fenced while saving conversation history",
              );
            }
          });
        }
        if (shouldAppendRows || !options.skipInputOnlyRows) {
          this.persistedHistoryCount = nextWatermark;
          this.nextHistoryPosition = nextPosition;
        }
      }
      const envelope = sandboxStateEntryFromRunState(stream.state);
      if (envelope) {
        await runMandatoryHistoryPersistenceStep("sandbox_envelope", () =>
          upsertSandboxSessionEnvelope(this.deps.db, {
            accountId: this.deps.accountId,
            workspaceId: this.deps.workspaceId,
            sessionId: this.deps.sessionId,
            envelope,
          }),
        );
      }
    } catch (persistError) {
      console.error(
        "session history dual-write failed (run unaffected)",
        safeErrorDiagnostic(persistError),
      );
      if (options.requireDurable) throw persistError;
    }
  };
}

export function createTurnHistorySink(deps: TurnHistorySinkDeps): TurnHistorySink {
  return new TurnHistorySink(deps);
}
