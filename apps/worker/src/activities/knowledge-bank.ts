import { claimDirtyKnowledgeBanks, recordKnowledgeBankSweepResult } from "@opengeni/db";
import { synthesizeKnowledgeBank } from "@opengeni/documents";
import type { ActivityServices } from "./types";

// Bounded per sweep tick; anything unclaimed stays dirty for the next tick.
export const KNOWLEDGE_BANK_SWEEP_BATCH_SIZE = 5;
// A crashed sweep's claim becomes reclaimable after this window.
export const KNOWLEDGE_BANK_SWEEP_RECLAIM_MS = 10 * 60 * 1_000;

export type SweepKnowledgeBanksResult = {
  claimed: number;
  updated: number;
  skipped: number;
  failed: number;
};

export function createKnowledgeBankActivities(services: () => Promise<ActivityServices>) {
  return {
    sweepKnowledgeBanks: async (): Promise<SweepKnowledgeBanksResult> => {
      const { settings, db, observability } = await services();
      const claims = await claimDirtyKnowledgeBanks(db, {
        reclaimMs: KNOWLEDGE_BANK_SWEEP_RECLAIM_MS,
        limit: KNOWLEDGE_BANK_SWEEP_BATCH_SIZE,
      });
      let updated = 0;
      let skipped = 0;
      let failed = 0;
      for (const claim of claims) {
        try {
          const result = await synthesizeKnowledgeBank(db, settings, {
            accountId: claim.accountId,
            workspaceId: claim.workspaceId,
            updatedBy: "sweep",
          });
          if (result.charter) {
            updated += 1;
          } else {
            skipped += 1;
          }
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          // Record the failure and leave the bank dirty so the next tick retries.
          await recordKnowledgeBankSweepResult(db, {
            accountId: claim.accountId,
            workspaceId: claim.workspaceId,
            error: message,
          }).catch(() => undefined);
          observability.warn("knowledge bank sweep failed for workspace; will retry", {
            workspaceId: claim.workspaceId,
            error: message,
          });
        }
      }
      if (claims.length > 0) {
        observability.info("knowledge bank sweep completed", {
          claimed: claims.length,
          updated,
          skipped,
          failed,
        });
      }
      return { claimed: claims.length, updated, skipped, failed };
    },
  };
}
