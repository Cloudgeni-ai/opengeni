import {
  applyContextCompaction,
  getActiveSessionHistoryItems,
  recordSkippedContextCompaction,
  type Database,
} from "@opengeni/db";
import {
  SUMMARY_BUFFER_TOKENS,
  buildCompactionPromptInput,
  buildCompactionReplacementHistory,
  decideCompaction,
  estimateTokens,
  sanitizeHistoryItemsForModel,
  summarizeForCompaction,
  type CompactionItem,
} from "@opengeni/runtime";
import type { Settings } from "@opengeni/config";
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
 * If the summarizer itself exceeds the context window, the oldest prompt item
 * is removed and the same compaction call is retried, exactly like Codex local
 * compaction. Other provider failures propagate. There is no non-model
 * fallback and no silent request-local history trimming.
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
  const active = await getActiveSessionHistoryItems(db, scope.workspaceId, scope.sessionId);
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
  const summaryBody = await summarizeWithCodexOverflowTrimming(summarize, settings, items);
  const replacementHistory = buildCompactionReplacementHistory(items, summaryBody);
  const estimatedTokensAfter = estimateTokens(replacementHistory);
  const summaryItem = replacementHistory.at(-1);
  if (!summaryItem) {
    return {
      compacted: false,
      reason: "compaction produced no replacement history",
      events: [],
      requestConsumed: false,
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
    events: applied.events,
  };
}

async function summarizeWithCodexOverflowTrimming(
  summarize: CompactionSummarizer,
  settings: Settings,
  activeHistory: CompactionItem[],
): Promise<string> {
  const compactionHistory = activeHistory.slice();
  while (true) {
    try {
      return await summarize(settings, buildCompactionPromptInput(compactionHistory));
    } catch (error) {
      if (!isContextWindowExceeded(error) || compactionHistory.length === 0) {
        throw error;
      }
      // Codex removes one oldest history item, keeps the synthesized checkpoint
      // prompt, resets its stream retry count, and samples the summary again.
      compactionHistory.shift();
    }
  }
}

function isContextWindowExceeded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    code === "context_length_exceeded" ||
    code === "context_window_exceeded" ||
    message.includes("context window") ||
    message.includes("maximum context length") ||
    message.includes("too many tokens")
  );
}
