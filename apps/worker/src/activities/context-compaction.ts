import {
  applyContextCompaction,
  getActiveSessionHistoryItems,
  nextSessionHistoryPosition,
  type Database,
} from "@opengeni/db";
import {
  SUMMARY_BUFFER_TOKENS,
  buildCompactionPromptInput,
  buildDeterministicFallbackCompactionHistory,
  buildCompactionReplacementHistory,
  decideClientCompaction,
  estimateTokens,
  sanitizeHistoryItemsForModel,
  summarizeForCompaction,
  type CompactionItem,
} from "@opengeni/runtime";
import { resolveContextCompactionMode, type Settings } from "@opengeni/config";

export type MaybeCompactResult =
  | { compacted: false; reason: string }
  | {
      compacted: true;
      supersededFrom: number;
      summaryPosition: number;
      signalTokens: number;
      thresholdTokens: number;
      method: "summary" | "fallback";
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
    };

/**
 * Pre-turn client-side context compaction (the Azure path).
 *
 * Runs BEFORE the model call when the resolved compaction mode is "client".
 * Reads the active history rows + the most recent provider-reported input
 * tokens, applies the single Codex-parity threshold, and - when it should -
 * summarizes the active history with the Codex checkpoint prompt. The write
 * supersedes the old active rows and inserts replacement active rows:
 * all real user messages plus one summary.
 *
 * Required compactions are fail-closed on the summarizer: full rendered
 * transcript, hard-trim rendered retry, then deterministic non-LLM fallback.
 * DB errors still throw to the caller; "compacted:false" is reserved for
 * structural no-ops or impossible shrink, not summarizer failures.
 *
 * There is no kept assistant/tool tail in client mode now. Assistant messages,
 * tool calls/results, reasoning, and images stay only in inactive audit rows.
 */
export type CompactionSummarizerOptions = {
  maxTranscriptTokens?: number;
  attempt: "full" | "hard_trim";
};

export type CompactionSummarizer = (
  settings: Settings,
  input: CompactionItem[],
  options?: CompactionSummarizerOptions,
) => Promise<string | null>;

export async function maybeCompactContext(
  db: Database,
  settings: Settings,
  scope: { accountId: string; workspaceId: string; sessionId: string; turnId?: string | null },
  lastInputTokens: number | null,
  // Injectable for tests; defaults to the real provider-aware model call.
  summarize: CompactionSummarizer = (s, m, o) =>
    summarizeForCompaction(s, m, {
      maxOutputTokens: SUMMARY_BUFFER_TOKENS,
      ...(o?.maxTranscriptTokens ? { maxTranscriptTokens: o.maxTranscriptTokens } : {}),
    }),
  // Operator-forced (the /compact command): bypass the budget trigger and
  // compact now if there is anything to summarize. Structural guards still hold.
  options: { force?: boolean; requireShrink?: boolean } = {},
): Promise<MaybeCompactResult> {
  if (resolveContextCompactionMode(settings) !== "client") {
    return { compacted: false, reason: "mode_not_client" };
  }

  const active = await getActiveSessionHistoryItems(db, scope.workspaceId, scope.sessionId);
  if (active.length === 0) {
    return { compacted: false, reason: "no_history" };
  }

  const items = sanitizeHistoryItemsForModel(active.map((row) => row.item) as CompactionItem[]);
  const decision = decideClientCompaction({
    items,
    lastInputTokens,
    contextWindowTokens: settings.contextWindowTokens,
    contextReservedOutputTokens: settings.contextReservedOutputTokens,
    contextClientCompactThresholdTokens: settings.contextClientCompactThresholdTokens,
    contextCompactionThresholdRatio: settings.contextCompactionThresholdRatio,
    ...(options.force ? { force: true } : {}),
  });
  if (!decision.shouldCompact) {
    return { compacted: false, reason: decision.reason };
  }

  const promptInput = buildCompactionPromptInput(items);
  const estimatedTokensBefore = estimateTokens(items);
  // A recovery compaction is allowed to auto-continue only when the ACTIVE
  // model-facing history itself strictly shrinks. `decision.signalTokens` may
  // come from the provider's previous request and include system/tool schema
  // tokens that are not represented in `items`; using max(before, signal) let a
  // replacement GROW the active history while still claiming a successful
  // shrink. The smaller ceiling proves progress against both views and gives
  // repeated compaction resumes a natural, symptom-based loop guard: a
  // successful recovery monotonically reduces a finite active history; a
  // no-shrink attempt stops instead of requeueing.
  const shrinkCeilingTokens = Math.min(
    estimatedTokensBefore,
    decision.signalTokens > 0 ? decision.signalTokens : estimatedTokensBefore,
  );
  const requireShrink = options.requireShrink || decision.reason === "above_threshold";
  let summarizerFailure = "summarizer returned no summary";
  let summaryBody: string | null = null;

  const fullAttempt = await runSummarizerAttempt(summarize, settings, promptInput, {
    attempt: "full",
  });
  if (fullAttempt.summary) {
    summaryBody = fullAttempt.summary;
  } else {
    summarizerFailure = fullAttempt.failure;
    const hardTrimBudget = Math.max(1, Math.floor(Math.max(1, decision.thresholdTokens) * 0.5));
    const retryAttempt = await runSummarizerAttempt(summarize, settings, promptInput, {
      attempt: "hard_trim",
      maxTranscriptTokens: hardTrimBudget,
    });
    if (retryAttempt.summary) {
      summaryBody = retryAttempt.summary;
    } else {
      summarizerFailure = retryAttempt.failure || summarizerFailure;
    }
  }

  let replacementHistory: CompactionItem[] | null = null;
  let method: "summary" | "fallback" = "summary";
  if (summaryBody) {
    const summaryReplacement = buildCompactionReplacementHistory(items, summaryBody);
    const summaryEstimate = estimateTokens(summaryReplacement);
    if (!requireShrink || summaryEstimate < shrinkCeilingTokens) {
      replacementHistory = summaryReplacement;
    } else {
      summarizerFailure = `summary replacement did not reduce active context (${summaryEstimate} >= ${shrinkCeilingTokens})`;
    }
  }

  if (!replacementHistory) {
    method = "fallback";
    const fallbackTargetTokens = Math.max(
      1,
      Math.min(
        Math.max(1, Math.floor(shrinkCeilingTokens * 0.5)),
        Math.max(1, Math.floor(Math.max(1, decision.thresholdTokens) * 0.5)),
      ),
    );
    replacementHistory = buildDeterministicFallbackCompactionHistory({
      items,
      cause: summarizerFailure,
      targetTokens: fallbackTargetTokens,
    });
  }

  const estimatedTokensAfter = estimateTokens(replacementHistory);
  if (requireShrink && estimatedTokensAfter >= shrinkCeilingTokens) {
    return {
      compacted: false,
      reason: `compaction summarization failed: fallback did not reduce active context (${estimatedTokensAfter} >= ${shrinkCeilingTokens})`,
    };
  }

  const summaryItem = replacementHistory.at(-1);
  if (!summaryItem) {
    return { compacted: false, reason: `compaction summarization failed: ${summarizerFailure}` };
  }
  const nextPosition = await nextSessionHistoryPosition(db, scope.workspaceId, scope.sessionId);
  const replacementItems = replacementHistory.slice(0, -1).map((item, index) => ({
    position: nextPosition + index,
    item,
  }));
  const summaryPosition = nextPosition + replacementItems.length;

  await applyContextCompaction(db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: scope.turnId ?? null,
    boundaryPosition: nextPosition,
    replacementItems,
    summaryPosition,
    summaryItem: summaryItem as Record<string, unknown>,
    replacementInputTokens: estimatedTokensAfter,
  });

  return {
    compacted: true,
    supersededFrom: nextPosition,
    summaryPosition,
    signalTokens: decision.signalTokens,
    thresholdTokens: decision.thresholdTokens,
    method,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}

async function runSummarizerAttempt(
  summarize: CompactionSummarizer,
  settings: Settings,
  promptInput: CompactionItem[],
  options: CompactionSummarizerOptions,
): Promise<{ summary: string | null; failure: string }> {
  try {
    const summary = await summarize(settings, promptInput, options);
    if (summary && summary.trim().length > 0) {
      return { summary, failure: "" };
    }
    return { summary: null, failure: "summarizer returned no summary" };
  } catch (error) {
    return { summary: null, failure: error instanceof Error ? error.message : String(error) };
  }
}
