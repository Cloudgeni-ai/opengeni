import { compactLegacySessionContent } from "@opengeni/db";
import type { ControlActivityServices } from "./types";

/** Rows per content kind rewritten by one maintenance pass. */
export const SESSION_CONTENT_COMPACTION_ROWS_PER_PASS = 200;

export type MaintainSessionStorageResult = {
  contentCompaction: { scanned: number; compacted: number; skipped: number; failed: number };
};

export type SessionStorageActivityOptions = {
  compactionRowsPerPass?: number;
  compactLegacyContent?: typeof compactLegacySessionContent;
};

/**
 * Deployment-wide session storage maintenance. Legacy content compaction is
 * lossless (the database proves every rewrite) and therefore always on.
 */
export function createSessionStorageActivities(
  services: () => Promise<ControlActivityServices>,
  options: SessionStorageActivityOptions = {},
) {
  const rowsPerPass = options.compactionRowsPerPass ?? SESSION_CONTENT_COMPACTION_ROWS_PER_PASS;
  const compactLegacyContent = options.compactLegacyContent ?? compactLegacySessionContent;

  async function maintainSessionStorage(): Promise<MaintainSessionStorageResult> {
    const { db, observability } = await services();
    const contentCompaction = await compactLegacyContent(db, {
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
    if (contentCompaction.compacted > 0 || contentCompaction.failed > 0) {
      observability.info("session content compaction pass finished", contentCompaction);
    }
    return { contentCompaction };
  }

  return { maintainSessionStorage };
}
