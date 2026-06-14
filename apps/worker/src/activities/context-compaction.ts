import {
  applyContextCompaction,
  getActiveSessionHistoryItems,
  type Database,
} from "@opengeni/db";
import {
  buildCompactionMessages,
  buildSummaryItem,
  planCompaction,
  summarizeForCompaction,
  type CompactionItem,
} from "@opengeni/runtime";
import {
  contextInputBudgetTokens,
  resolveContextCompactionMode,
  type Settings,
} from "@opengeni/config";

export type MaybeCompactResult =
  | { compacted: false; reason: string }
  | { compacted: true; supersededFrom: number; summaryPosition: number };

/**
 * Pre-turn client-side context compaction (the Azure path).
 *
 * Runs BEFORE the model call when the resolved compaction mode is "client".
 * Reads the active history rows + the last turn's actual input tokens, asks the
 * pure planner whether/where to compact, and — when it should — summarizes the
 * orphan-safe prefix into one plain user message via a model call and writes it
 * with applyContextCompaction (supersede prefix rows, insert the summary).
 *
 * Best-effort by design: any failure (planner says no, summarize fails, DB
 * hiccup) returns without compacting and never throws — the turn proceeds with
 * the un-compacted history. The read path's existing sanitizer keeps that safe.
 *
 * The boundary the planner picks is the start of a kept user-message turn, so
 * no tool-call pair straddles the cut. The summary row is inserted at the
 * position immediately before the kept tail (a freed prefix position), so the
 * active read path returns [summary, ...recent tail] in order.
 */
export type CompactionSummarizer = (
  settings: Settings,
  messages: { system: string; user: string },
) => Promise<string | null>;

export async function maybeCompactContext(
  db: Database,
  settings: Settings,
  scope: { accountId: string; workspaceId: string; sessionId: string; turnId?: string | null },
  lastInputTokens: number | null,
  // Injectable for tests; defaults to the real provider-aware model call.
  summarize: CompactionSummarizer = (s, m) => summarizeForCompaction(s, m, { maxOutputTokens: s.contextSummaryMaxTokens }),
): Promise<MaybeCompactResult> {
  if (resolveContextCompactionMode(settings) !== "client") {
    return { compacted: false, reason: "mode_not_client" };
  }

  const active = await getActiveSessionHistoryItems(db, scope.workspaceId, scope.sessionId);
  if (active.length === 0) {
    return { compacted: false, reason: "no_history" };
  }

  const items = active.map((row) => row.item) as CompactionItem[];
  const plan = planCompaction({
    items,
    lastInputTokens,
    inputBudgetTokens: contextInputBudgetTokens(settings),
    softFraction: settings.contextCompactSoftFraction,
    hardFraction: settings.contextCompactHardFraction,
    keepRecentTokens: settings.contextKeepRecentTokens,
  });
  if (!plan.shouldCompact) {
    return { compacted: false, reason: plan.reason };
  }

  const messages = buildCompactionMessages(plan);
  const summaryBody = await summarize(settings, messages);
  if (!summaryBody) {
    return { compacted: false, reason: "summarize_failed" };
  }

  // Boundary is an index into the active rows; map to absolute positions. The
  // kept tail starts at the boundary row's position; the summary takes the
  // position immediately before it (a position inside the just-superseded
  // prefix, guaranteed free and sorting before the tail).
  const boundaryRow = active[plan.boundaryIndex];
  if (!boundaryRow) {
    return { compacted: false, reason: "boundary_out_of_range" };
  }
  const boundaryPosition = boundaryRow.position;
  const summaryPosition = boundaryPosition - 1;
  if (summaryPosition < 0) {
    return { compacted: false, reason: "boundary_at_origin" };
  }

  await applyContextCompaction(db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: scope.turnId ?? null,
    boundaryPosition,
    summaryPosition,
    summaryItem: buildSummaryItem(summaryBody),
  });

  return { compacted: true, supersededFrom: boundaryPosition, summaryPosition };
}
