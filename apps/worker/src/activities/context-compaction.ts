import {
  applyContextCompaction,
  getActiveSessionHistoryItemsPaged,
  recordSkippedContextCompaction,
  type Database,
} from "@opengeni/db";
import {
  SUMMARY_BUFFER_TOKENS,
  buildCompactionReplacementHistory,
  compactionReplacementFingerprint,
  decideCompaction,
  estimateTokens,
  latestCompactionReplacementFingerprint,
  prepareCompactionPromptInput,
  sanitizeHistoryItemsForModel,
  summarizeForCompaction,
  type CompactionItem,
} from "@opengeni/runtime";
import { contextInputBudgetTokens, type Settings } from "@opengeni/config";
import type { SessionEvent } from "@opengeni/contracts";
import { TurnAttemptFencedError } from "./turn-attempt-fenced";

export type MaybeCompactResult =
  | {
      compacted: false;
      reason: string;
      events: SessionEvent[];
      requestConsumed: boolean;
    }
  | {
      compacted: true;
      supersededFrom: number;
      summaryPosition: number;
      signalTokens: number;
      thresholdTokens: number;
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
      replacementFingerprint: string;
      events: SessionEvent[];
    };

/**
 * Durable portable context compaction, following Codex CLI's local path.
 *
 * Runs before a fresh model call and on a same-turn compaction recovery.
 * Reads the active history rows + the most recent provider-reported input
 * tokens, applies the single Codex-parity threshold, and - when it should -
 * summarizes the active history with the Codex checkpoint prompt. The write
 * supersedes the old active rows and inserts replacement active rows:
 * all real user messages plus one summary.
 *
 * Before sampling, a temporary copy is fitted by minimizing old tool outputs
 * and then removing whole oldest work units if necessary. One authoritative
 * provider overflow permits one smaller refit. Other failures propagate. There
 * is no non-model fallback or mutation of canonical history before success.
 *
 * There is no kept assistant/tool tail. Assistant messages,
 * tool calls/results, reasoning, and images stay only in inactive audit rows.
 */
export type CompactionSummarizer = (settings: Settings, input: CompactionItem[]) => Promise<string>;

export async function maybeCompactContext(
  db: Database,
  settings: Settings,
  scope: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
  },
  lastInputTokens: number | null,
  // Injectable for tests; defaults to the real provider-aware model call.
  summarize: CompactionSummarizer = (s, m) =>
    summarizeForCompaction(s, m, {
      maxOutputTokens: SUMMARY_BUFFER_TOKENS,
    }),
  // Operator-forced (the /compact command): bypass the budget trigger and
  // compact now if there is anything to summarize. Structural guards still hold.
  options: {
    force?: boolean;
    clearRequestedCompaction?: boolean;
    trigger?: "auto" | "operator" | "proactive" | "overflow";
  } = {},
): Promise<MaybeCompactResult> {
  // The logical result remains the complete ordered active transcript. Read it
  // in small keyset pages so the Postgres driver never stages a second,
  // transcript-sized JSONB result frame beside the decoded history.
  const active = await getActiveSessionHistoryItemsPaged(db, scope.workspaceId, scope.sessionId);
  if (active.length === 0) {
    let requestConsumed = false;
    if (options.clearRequestedCompaction) {
      const skipped = await recordSkippedContextCompaction(db, {
        ...scope,
        expectedExecutionGeneration: scope.executionGeneration,
        expectedAttemptId: scope.attemptId,
        reason: "no_history",
      });
      if (!skipped.recorded) {
        throw new TurnAttemptFencedError(
          "turn attempt was fenced while consuming an empty context compaction request",
        );
      }
      requestConsumed = true;
      return {
        compacted: false,
        reason: "no_history",
        events: skipped.events,
        requestConsumed,
      };
    }
    return { compacted: false, reason: "no_history", events: [], requestConsumed };
  }

  const items = sanitizeHistoryItemsForModel(active.map((row) => row.item) as CompactionItem[]);
  const decision = decideCompaction({
    items,
    lastInputTokens,
    contextWindowTokens: settings.contextWindowTokens,
    contextReservedOutputTokens: settings.contextReservedOutputTokens,
    contextAutoCompactThresholdTokens: settings.contextAutoCompactThresholdTokens,
    contextCompactionThresholdRatio: settings.contextCompactionThresholdRatio,
    ...(options.force ? { force: true } : {}),
  });
  if (!decision.shouldCompact) {
    return {
      compacted: false,
      reason: decision.reason,
      events: [],
      requestConsumed: false,
    };
  }

  const estimatedTokensBefore = estimateTokens(items);
  const summarized = await summarizeWithCodexOverflowTrimming(summarize, settings, items);
  const summaryBody = summarized.summaryBody;
  const replacementHistory = buildCompactionReplacementHistory(items, summaryBody);
  const estimatedTokensAfter = estimateTokens(replacementHistory);
  const replacementFingerprint = compactionReplacementFingerprint(replacementHistory);
  const previousReplacementFingerprint = latestCompactionReplacementFingerprint(items);
  const summaryItem = replacementHistory.at(-1);
  if (!summaryItem) {
    return {
      compacted: false,
      reason: "compaction produced no replacement history",
      events: [],
      requestConsumed: false,
    };
  }
  if (previousReplacementFingerprint === replacementFingerprint) {
    let requestConsumed = false;
    if (options.clearRequestedCompaction) {
      const skipped = await recordSkippedContextCompaction(db, {
        ...scope,
        expectedExecutionGeneration: scope.executionGeneration,
        expectedAttemptId: scope.attemptId,
        reason: "replacement_unchanged",
      });
      if (!skipped.recorded) {
        throw new TurnAttemptFencedError(
          "turn attempt was fenced while consuming an unchanged context compaction request",
        );
      }
      requestConsumed = true;
      return {
        compacted: false,
        reason: "replacement_unchanged",
        events: skipped.events,
        requestConsumed,
      };
    }
    return {
      compacted: false,
      reason: "replacement_unchanged",
      events: [],
      requestConsumed,
    };
  }
  if (estimatedTokensAfter >= estimatedTokensBefore) {
    let requestConsumed = false;
    if (options.clearRequestedCompaction) {
      const skipped = await recordSkippedContextCompaction(db, {
        ...scope,
        expectedExecutionGeneration: scope.executionGeneration,
        expectedAttemptId: scope.attemptId,
        reason: "replacement_not_smaller",
      });
      if (!skipped.recorded) {
        throw new TurnAttemptFencedError(
          "turn attempt was fenced while consuming a non-shrinking context compaction request",
        );
      }
      requestConsumed = true;
      return {
        compacted: false,
        reason: "replacement_not_smaller",
        events: skipped.events,
        requestConsumed,
      };
    }
    return {
      compacted: false,
      reason: "replacement_not_smaller",
      events: [],
      requestConsumed,
    };
  }
  const applied = await applyContextCompaction(db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    expectedExecutionGeneration: scope.executionGeneration,
    expectedAttemptId: scope.attemptId,
    replacementItems: replacementHistory.slice(0, -1),
    summaryItem: summaryItem as Record<string, unknown>,
    replacementInputTokens: estimatedTokensAfter,
    ...(options.clearRequestedCompaction ? { clearRequestedCompaction: true } : {}),
    eventPayload: {
      trigger: options.trigger ?? "auto",
      estimatedTokensBefore,
      estimatedTokensAfter,
      compactionInputEstimatedTokens: summarized.preparation.estimatedInputTokens,
      compactionInputToolOutputsRewritten: summarized.preparation.rewrittenToolOutputs,
      compactionInputHistoryItemsDropped: summarized.preparation.droppedHistoryItems,
      compactionInputProviderCalls: summarized.providerCalls,
    },
  });
  if (!applied.applied) {
    throw new TurnAttemptFencedError(
      `turn attempt was fenced during context compaction: ${applied.reason}`,
    );
  }

  return {
    compacted: true,
    supersededFrom: applied.supersededFrom,
    summaryPosition: applied.summaryPosition,
    signalTokens: decision.signalTokens,
    thresholdTokens: decision.thresholdTokens,
    estimatedTokensBefore,
    estimatedTokensAfter,
    replacementFingerprint,
    events: applied.events,
  };
}

async function summarizeWithCodexOverflowTrimming(
  summarize: CompactionSummarizer,
  settings: Settings,
  activeHistory: CompactionItem[],
): Promise<{
  summaryBody: string;
  preparation: ReturnType<typeof prepareCompactionPromptInput>;
  providerCalls: number;
}> {
  // Codex's estimator is intentionally coarse. Keep the explicit checkpoint
  // request below both the effective input window and the raw window minus the
  // requested summary, then leave 15% estimator headroom. This changes only the
  // temporary summarizer input; durable active history remains untouched until
  // applyContextCompaction succeeds under the attempt fence.
  const summaryAwareBudget = Math.max(0, settings.contextWindowTokens - SUMMARY_BUFFER_TOKENS);
  const configuredInputBudget = contextInputBudgetTokens(settings);
  const structuralBudget = Math.min(
    configuredInputBudget > 0 ? configuredInputBudget : summaryAwareBudget,
    summaryAwareBudget,
  );
  const initialBudget = Math.floor(structuralBudget * 0.85);
  let preparation = prepareCompactionPromptInput(activeHistory, initialBudget);
  try {
    return {
      summaryBody: await summarize(settings, preparation.input),
      preparation,
      providerCalls: 1,
    };
  } catch (error) {
    if (!isContextWindowExceeded(error)) throw error;
    // The provider is more authoritative than the byte/4 estimate. Refit once
    // to 70% of both the configured target and the actual prepared estimate;
    // then fail terminally with prior history intact. Never issue one failing
    // request per oldest item. The production incident proved that the
    // provider can count slightly more than twice the byte/4 estimate, so a
    // half-size retry is the smallest honest bound for that observed skew.
    const retryBudget = Math.floor(
      Math.min(initialBudget * 0.5, preparation.estimatedInputTokens * 0.5),
    );
    preparation = prepareCompactionPromptInput(activeHistory, retryBudget);
    return {
      summaryBody: await summarize(settings, preparation.input),
      preparation,
      providerCalls: 2,
    };
  }
}

export function isContextWindowExceeded(error: unknown, seen = new WeakSet<object>()): boolean {
  if (!error || typeof error !== "object") return false;
  if (seen.has(error)) return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const message =
    typeof record.message === "string"
      ? record.message.toLowerCase()
      : error instanceof Error
        ? error.message.toLowerCase()
        : "";
  const direct =
    code === "context_length_exceeded" ||
    code === "context_window_exceeded" ||
    message.includes("context window") ||
    message.includes("maximum context length") ||
    message.includes("too many tokens");
  return (
    direct ||
    isContextWindowExceeded(record.cause, seen) ||
    isContextWindowExceeded(record.error, seen) ||
    isContextWindowExceeded(record.diagnostics, seen)
  );
}
