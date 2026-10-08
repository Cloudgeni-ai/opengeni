import {
  compactLegacySessionContent,
  foldSessionTurnDeltas,
  listSessionDeltaFoldCandidates,
} from "@opengeni/db";
import type { ControlActivityServices } from "./types";

/** Rows per content kind rewritten by one compaction batch. */
export const SESSION_CONTENT_COMPACTION_ROWS_PER_PASS = 200;
/** A turn's deltas fold once it has been settled this long. */
export const SESSION_DELTA_FOLD_SETTLE_SECONDS = 10 * 60;
export const SESSION_DELTA_FOLD_TURNS_PER_BATCH = 50;
/** Soft budget for one pass; the workflow's activity timeout is 15 minutes. */
export const SESSION_STORAGE_PASS_BUDGET_MS = 10 * 60 * 1_000;

export type MaintainSessionStorageResult = {
  contentCompaction: { scanned: number; compacted: number; skipped: number; failed: number };
  deltaFolding: {
    turns: number;
    runs: number;
    removedRows: number;
    refused: number;
    failed: number;
  };
};

export type SessionStorageActivityOptions = {
  compactionRowsPerPass?: number;
  compactLegacyContent?: typeof compactLegacySessionContent;
  listFoldCandidates?: typeof listSessionDeltaFoldCandidates;
  foldTurn?: typeof foldSessionTurnDeltas;
  foldTurnsPerBatch?: number;
  foldSettleSeconds?: number;
  timeBudgetMs?: number;
  now?: () => number;
};

/**
 * Deployment-wide session storage maintenance. Both steps are lossless and
 * therefore always on: legacy content compaction (the database proves every
 * rewrite) and folding the streamed deltas of settled turns (each folded row
 * records every original fragment). Each keeps working through its backlog
 * while it makes progress and the pass has budget left.
 */
export function createSessionStorageActivities(
  services: () => Promise<ControlActivityServices>,
  options: SessionStorageActivityOptions = {},
) {
  const rowsPerPass = options.compactionRowsPerPass ?? SESSION_CONTENT_COMPACTION_ROWS_PER_PASS;
  const compactLegacyContent = options.compactLegacyContent ?? compactLegacySessionContent;
  const listFoldCandidates = options.listFoldCandidates ?? listSessionDeltaFoldCandidates;
  const foldTurn = options.foldTurn ?? foldSessionTurnDeltas;
  const foldTurnsPerBatch = options.foldTurnsPerBatch ?? SESSION_DELTA_FOLD_TURNS_PER_BATCH;
  const foldSettleSeconds = options.foldSettleSeconds ?? SESSION_DELTA_FOLD_SETTLE_SECONDS;
  const timeBudgetMs = options.timeBudgetMs ?? SESSION_STORAGE_PASS_BUDGET_MS;
  const now = options.now ?? Date.now;

  async function maintainSessionStorage(): Promise<MaintainSessionStorageResult> {
    const { db, observability } = await services();
    const deadline = now() + timeBudgetMs;
    // Half the budget for compaction, so folding always gets its turn.
    const compactionDeadline = now() + Math.floor(timeBudgetMs / 2);
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
    } while (now() < compactionDeadline);
    if (contentCompaction.compacted > 0 || contentCompaction.failed > 0) {
      observability.info("session content compaction pass finished", contentCompaction);
    }

    const deltaFolding = { turns: 0, runs: 0, removedRows: 0, refused: 0, failed: 0 };
    const attempted = new Set<string>();
    while (now() < deadline) {
      const candidates = (
        await listFoldCandidates(db, {
          settleSeconds: foldSettleSeconds,
          limit: foldTurnsPerBatch + attempted.size,
        })
      ).filter((candidate) => !attempted.has(candidate.turnId));
      if (candidates.length === 0) break;
      for (const candidate of candidates.slice(0, foldTurnsPerBatch)) {
        if (now() >= deadline) break;
        attempted.add(candidate.turnId);
        try {
          const folded = await foldTurn(db, candidate);
          deltaFolding.turns += 1;
          deltaFolding.runs += folded.runs;
          deltaFolding.removedRows += folded.removedRows;
          deltaFolding.refused += folded.refused;
        } catch (error) {
          deltaFolding.failed += 1;
          observability.warn("session delta folding failed; the turn keeps its deltas", {
            workspaceId: candidate.workspaceId,
            sessionId: candidate.sessionId,
            turnId: candidate.turnId,
            errorName: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    }
    if (deltaFolding.removedRows > 0 || deltaFolding.failed > 0) {
      observability.info("session delta folding pass finished", deltaFolding);
    }
    return { contentCompaction, deltaFolding };
  }

  return { maintainSessionStorage };
}
