import { randomUUID } from "node:crypto";
import { listWorkspaceIdsAfter, reconcileModelCallFacts } from "@opengeni/db";
import type { ControlActivityServices } from "./types";

/** Recent charged calls are rechecked on every run; older gaps use the backfill script. */
export const MODEL_CALL_FACT_RECONCILE_LOOKBACK_MS = 2 * 60 * 60 * 1_000;
/** Skip the newest calls so a live fact write is not raced by its own repair. */
export const MODEL_CALL_FACT_RECONCILE_SETTLE_MS = 10 * 60 * 1_000;
export const MODEL_CALL_FACT_RECONCILE_WORKSPACE_LIMIT = 500;
export const MODEL_CALL_FACT_RECONCILE_RUN_BUDGET_MS = 3 * 60 * 1_000;
const WORKSPACE_PAGE_SIZE = 200;

export type ReconcileRecentModelCallFactsResult = {
  workspaces: number;
  missing: number;
  repaired: number;
  unrepaired: number;
  failedWorkspaces: number;
  budgetExhausted: boolean;
};

export type ModelCallFactReconcilerOptions = {
  now?: () => number;
  runBudgetMs?: number;
  startAfterWorkspaceId?: () => string;
  reconcile?: typeof reconcileModelCallFacts;
  listWorkspaces?: typeof listWorkspaceIdsAfter;
};

/**
 * Rebuild missing Insights call facts for recently charged model calls. Each
 * workspace pass is bounded and idempotent, one failure never stops the rest,
 * and each run starts at a random workspace so a run that exhausts its budget
 * does not starve the same tail of workspaces every time.
 */
export function createModelCallFactReconcilerActivities(
  services: () => Promise<ControlActivityServices>,
  options: ModelCallFactReconcilerOptions = {},
) {
  const now = options.now ?? Date.now;
  const runBudgetMs = options.runBudgetMs ?? MODEL_CALL_FACT_RECONCILE_RUN_BUDGET_MS;
  const startAfterWorkspaceId = options.startAfterWorkspaceId ?? randomUUID;
  const reconcile = options.reconcile ?? reconcileModelCallFacts;
  const listWorkspaces = options.listWorkspaces ?? listWorkspaceIdsAfter;

  async function reconcileRecentModelCallFacts(): Promise<ReconcileRecentModelCallFactsResult> {
    const { db, observability } = await services();
    const startedAt = now();
    const until = new Date(startedAt - MODEL_CALL_FACT_RECONCILE_SETTLE_MS);
    const since = new Date(until.getTime() - MODEL_CALL_FACT_RECONCILE_LOOKBACK_MS);
    const result: ReconcileRecentModelCallFactsResult = {
      workspaces: 0,
      missing: 0,
      repaired: 0,
      unrepaired: 0,
      failedWorkspaces: 0,
      budgetExhausted: false,
    };
    const start = startAfterWorkspaceId();
    let cursor: string | null = start;
    let wrapped = false;
    while (true) {
      const page = await listWorkspaces(db, { afterId: cursor, limit: WORKSPACE_PAGE_SIZE });
      const ids = wrapped ? page.filter((id) => id <= start) : page;
      for (const workspaceId of ids) {
        if (now() - startedAt >= runBudgetMs) {
          result.budgetExhausted = true;
          break;
        }
        result.workspaces += 1;
        try {
          const outcome = await reconcile(db, {
            workspaceId,
            since,
            until,
            limit: MODEL_CALL_FACT_RECONCILE_WORKSPACE_LIMIT,
          });
          result.missing += outcome.missing;
          result.repaired += outcome.repaired;
          result.unrepaired += outcome.unrepaired;
        } catch (error) {
          result.failedWorkspaces += 1;
          observability.warn("model call fact reconciliation failed for a workspace", {
            errorName: error instanceof Error ? error.name : "unknown",
          });
        }
      }
      if (result.budgetExhausted) break;
      if (wrapped && ids.length < page.length) break;
      if (page.length < WORKSPACE_PAGE_SIZE) {
        if (wrapped) break;
        wrapped = true;
        cursor = null;
        continue;
      }
      cursor = page[page.length - 1]!;
    }
    if (result.missing > 0 || result.failedWorkspaces > 0 || result.budgetExhausted) {
      observability.info("model call fact reconciliation", { ...result });
    }
    return result;
  }

  return { reconcileRecentModelCallFacts };
}
