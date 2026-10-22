import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
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
  /** Workspaces with a durable scan still unfinished at the end of this run. */
  truncatedWorkspaces: number;
  failedWorkspaces: number;
  budgetExhausted: boolean;
};

export type ModelCallFactReconcilerOptions = {
  now?: () => number;
  runBudgetMs?: number;
  startAfterWorkspaceId?: () => string;
  reconcile?: typeof reconcileModelCallFacts;
  listWorkspaces?: typeof listWorkspaceIdsAfter;
  signal?: AbortSignal;
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
    let activity: Context | undefined;
    try {
      activity = Context.current();
    } catch {
      /* Direct invocation has no Temporal context. */
    }
    const callerSignal = options.signal ?? activity?.cancellationSignal;
    callerSignal?.throwIfAborted();
    const deadlineAtMs = Date.now() + runBudgetMs;
    const deadlineError = new Error("Model fact reconciliation run budget exhausted");
    const deadline = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    const timer = setTimeout(() => deadline.abort(deadlineError), Math.max(0, runBudgetMs));
    timer.unref();
    try {
      const until = new Date(startedAt - MODEL_CALL_FACT_RECONCILE_SETTLE_MS);
      const since = new Date(until.getTime() - MODEL_CALL_FACT_RECONCILE_LOOKBACK_MS);
      const result: ReconcileRecentModelCallFactsResult = {
        workspaces: 0,
        missing: 0,
        repaired: 0,
        unrepaired: 0,
        truncatedWorkspaces: 0,
        failedWorkspaces: 0,
        budgetExhausted: false,
      };
      const start = startAfterWorkspaceId();
      let cursor: string | null = start;
      let wrapped = false;
      const pending = new Set<string>();
      const exhausted = () => {
        callerSignal?.throwIfAborted();
        if (deadline.signal.aborted || now() - startedAt >= runBudgetMs) {
          result.budgetExhausted = true;
          return true;
        }
        return false;
      };
      const advance = async (workspaceId: string) => {
        try {
          signal.throwIfAborted();
          activity?.heartbeat({ workspaceId });
          const outcome = await reconcile(db, {
            workspaceId,
            since,
            until,
            limit: MODEL_CALL_FACT_RECONCILE_WORKSPACE_LIMIT,
            signal,
            deadlineAtMs,
          });
          result.missing += outcome.missing;
          result.repaired += outcome.repaired;
          result.unrepaired += outcome.unrepaired;
          if (outcome.truncated) pending.add(workspaceId);
          else pending.delete(workspaceId);
        } catch (error) {
          if (signal.aborted && signal.reason === deadlineError) {
            pending.add(workspaceId);
            result.budgetExhausted = true;
            return;
          }
          signal?.throwIfAborted();
          pending.delete(workspaceId);
          result.failedWorkspaces++;
          observability.warn("model call fact reconciliation failed for a workspace", {
            workspaceId,
            errorName: error instanceof Error ? error.name : "unknown",
          });
        }
      };
      while (true) {
        if (exhausted()) break;
        let page: string[];
        try {
          page = await listWorkspaces(db, {
            afterId: cursor,
            limit: WORKSPACE_PAGE_SIZE,
            signal,
            deadlineAtMs,
          });
        } catch (error) {
          callerSignal?.throwIfAborted();
          if (deadline.signal.aborted) {
            result.budgetExhausted = true;
            break;
          }
          throw error;
        }
        const ids = wrapped ? page.filter((id) => id <= start) : page;
        for (const workspaceId of ids) {
          if (exhausted()) break;
          result.workspaces += 1;
          await advance(workspaceId);
          if (result.budgetExhausted) break;
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
      // Each workspace gets a first page before any gets a second. Continue
      // unfinished scans round-robin within the existing run budget; committed
      // database cursors carry the remainder to the next scheduled invocation.
      while (pending.size && !result.budgetExhausted) {
        for (const workspaceId of [...pending]) {
          if (exhausted()) break;
          await advance(workspaceId);
          if (result.budgetExhausted) break;
        }
      }
      result.truncatedWorkspaces = pending.size;
      if (result.failedWorkspaces > 0 || result.truncatedWorkspaces > 0 || result.budgetExhausted) {
        observability.warn("model call fact reconciliation incomplete", { ...result });
      } else if (result.missing > 0) {
        observability.info("model call fact reconciliation", { ...result });
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  return { reconcileRecentModelCallFacts };
}
