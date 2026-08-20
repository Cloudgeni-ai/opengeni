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
 * Dual-write of conversation truth: completed items are reconciled into
 * session_history_items after every model response and at every turn-end path.
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
