import {
  applyContextCompaction,
  getActiveSessionHistoryItems,
  nextSessionHistoryPosition,
  type Database,
} from "@opengeni/db";
import {
  SUMMARY_BUFFER_TOKENS,
  buildCompactionPromptInput,
  buildCompactionReplacementHistory,
  decideClientCompaction,
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
 * Best-effort by design: any failure (planner says no, summarize fails, DB
 * hiccup) returns without compacting and never throws — the turn proceeds with
 * the un-compacted history. The read path's existing sanitizer keeps that safe.
 *
 * There is no kept assistant/tool tail in client mode now. Assistant messages,
 * tool calls/results, reasoning, and images stay only in inactive audit rows.
 */
export type CompactionSummarizer = (
  settings: Settings,
  input: CompactionItem[],
) => Promise<string | null>;

export async function maybeCompactContext(
  db: Database,
  settings: Settings,
  scope: { accountId: string; workspaceId: string; sessionId: string; turnId?: string | null },
  lastInputTokens: number | null,
  // Injectable for tests; defaults to the real provider-aware model call.
  summarize: CompactionSummarizer = (s, m) => summarizeForCompaction(s, m, { maxOutputTokens: SUMMARY_BUFFER_TOKENS }),
  // Operator-forced (the /compact command): bypass the budget trigger and
  // compact now if there is anything to summarize. Structural guards still hold.
  options: { force?: boolean } = {},
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
    ...(options.force ? { force: true } : {}),
  });
  if (!decision.shouldCompact) {
    return { compacted: false, reason: decision.reason };
  }

  const promptInput = buildCompactionPromptInput(items);
  const summaryBody = await summarize(settings, promptInput);
  if (!summaryBody) {
    return { compacted: false, reason: "summarize_failed" };
  }

  const replacementHistory = buildCompactionReplacementHistory(items, summaryBody);
  const summaryItem = replacementHistory.at(-1);
  if (!summaryItem) {
    return { compacted: false, reason: "empty_replacement_history" };
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
  });

  return {
    compacted: true,
    supersededFrom: nextPosition,
    summaryPosition,
    signalTokens: decision.signalTokens,
    thresholdTokens: decision.thresholdTokens,
  };
}
