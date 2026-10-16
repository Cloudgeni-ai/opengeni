import { compactLegacySessionContent } from "@opengeni/db";
import type { ControlActivityServices } from "./types";

/** Rows per content kind rewritten by one compaction batch. */
export const SESSION_CONTENT_COMPACTION_ROWS_PER_PASS = 200;
/** Soft budget for one pass; the workflow's activity timeout is 15 minutes. */
export const SESSION_STORAGE_PASS_BUDGET_MS = 10 * 60 * 1_000;

export type MaintainSessionStorageResult = {
  contentCompaction: { scanned: number; compacted: number; skipped: number; failed: number };
};

export type SessionStorageActivityOptions = {
  compactionRowsPerPass?: number;
  compactLegacyContent?: typeof compactLegacySessionContent;
  timeBudgetMs?: number;
  now?: () => number;
};

/**
 * Deployment-wide session storage maintenance: legacy content compaction. It is
 * lossless (the database proves every rewrite) and therefore always on, and it
 * keeps working through its backlog while it makes progress and the pass has
 * budget left. Streamed text deltas need no pass: the turn writer stores each
 * flush's adjacent fragments as one row.
 */
export function createSessionStorageActivities(
  services: () => Promise<ControlActivityServices>,
  options: SessionStorageActivityOptions = {},
) {
  const rowsPerPass = options.compactionRowsPerPass ?? SESSION_CONTENT_COMPACTION_ROWS_PER_PASS;
  const compactLegacyContent = options.compactLegacyContent ?? compactLegacySessionContent;
  const timeBudgetMs = options.timeBudgetMs ?? SESSION_STORAGE_PASS_BUDGET_MS;
  const now = options.now ?? Date.now;

  async function maintainSessionStorage(): Promise<MaintainSessionStorageResult> {
    const { db, observability } = await services();
    const deadline = now() + timeBudgetMs;
    const contentCompaction = { scanned: 0, compacted: 0, skipped: 0, failed: 0 };
    do {
      const batch = await compactLegacyContent(db, {
        maxRows: rowsPerPass,
        onRowError: (candidate, error) =>
          observability.warn("session content compaction failed; row stays in legacy form", {
            kind: candidate.kind,
            workspaceId: candidate.workspaceId,
            sessionId: candidate.sessionId,
            attemptId: candidate.attemptId,
            errorName: error instanceof Error ? error.name : "unknown",
          }),
      });
      contentCompaction.scanned += batch.scanned;
      contentCompaction.compacted += batch.compacted;
      contentCompaction.skipped += batch.skipped;
      contentCompaction.failed += batch.failed;
      // Rows that stay legacy are rescanned first; stop once a batch gains nothing.
      if (batch.compacted === 0) break;
    } while (now() < deadline);
    if (contentCompaction.compacted > 0 || contentCompaction.failed > 0) {
      observability.info("session content compaction pass finished", contentCompaction);
    }

    return { contentCompaction };
  }

  return { maintainSessionStorage };
}
