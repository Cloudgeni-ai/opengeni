import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import { REASONING_EFFORT_LEVELS } from "@opengeni/contracts";
import {
  listWorkspaceIdsAfter,
  recordMissingTurnTimingProfiles,
  TURN_TIMING_CATEGORIES,
  type RecordedTurnTimingProfile,
} from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import type { Settings } from "@opengeni/config";
import { modelMetricProductId } from "./agent-turn/model-usage";
import {
  MODEL_CALL_FACT_RECONCILE_LOOKBACK_MS,
  MODEL_CALL_FACT_RECONCILE_RUN_BUDGET_MS,
  MODEL_CALL_FACT_RECONCILE_SETTLE_MS,
} from "./model-call-fact-reconciler";
import type { ControlActivityServices } from "./types";

const WORKSPACE_PAGE_SIZE = 200;
const TURN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "withdrawn_for_edit",
]);
const REASONING_EFFORTS = new Set<string>(REASONING_EFFORT_LEVELS);

export type RecordRecentTurnTimingProfilesResult = {
  workspaces: number;
  turns: number;
  inserted: number;
  updated: number;
  failedTurns: number;
  failedWorkspaces: number;
  budgetExhausted: boolean;
};

export type TurnTimingProfileActivityOptions = {
  now?: () => number;
  runBudgetMs?: number;
  startAfterWorkspaceId?: () => string;
  record?: typeof recordMissingTurnTimingProfiles;
  listWorkspaces?: typeof listWorkspaceIdsAfter;
  signal?: AbortSignal;
};

/**
 * Dashboard metrics for one newly stored profile: seconds per category and
 * the turn's wall time. Labels stay closed: unknown models, efforts and
 * statuses collapse to one value each.
 */
export function recordTurnTimingMetrics(
  observability: Observability,
  settings: Settings,
  { turn, profile }: RecordedTurnTimingProfile,
): void {
  try {
    const model = modelMetricProductId(settings, profile.provider ?? undefined, turn.model);
    const status = TURN_STATUSES.has(turn.status) ? turn.status : "other";
    const reasoningEffort = REASONING_EFFORTS.has(turn.reasoningEffort)
      ? turn.reasoningEffort
      : "other";
    for (const category of TURN_TIMING_CATEGORIES) {
      const ms = profile.segments[category];
      if (ms <= 0) continue;
      observability.incrementCounter({
        name: "opengeni_turn_timing_seconds_total",
        help: "Wall time of finished agent turns in seconds, by where it went.",
        labels: { category, status, model, reasoning_effort: reasoningEffort },
        amount: ms / 1_000,
      });
    }
    observability.observeHistogram({
      name: "opengeni_turn_wall_seconds",
      help: "Wall time of finished agent turns in seconds, from creation to finish.",
      labels: { status, model },
      value: profile.wallMs / 1_000,
    });
  } catch {
    // Telemetry never fails the sweep.
  }
}

/**
 * Store a timing profile for every recently finished turn that has none. It
 * runs in the control maintenance schedule, reads each turn's event log once
 * after the turn has settled, and adds nothing to a turn's own path. Each run
 * starts at a random workspace, one failure never stops the rest, and turns a
 * run leaves behind are picked up by the next runs within the lookback.
 */
export function createTurnTimingProfileActivities(
  services: () => Promise<ControlActivityServices>,
  options: TurnTimingProfileActivityOptions = {},
) {
  const now = options.now ?? Date.now;
  const runBudgetMs = options.runBudgetMs ?? MODEL_CALL_FACT_RECONCILE_RUN_BUDGET_MS;
  const startAfterWorkspaceId = options.startAfterWorkspaceId ?? randomUUID;
  const record = options.record ?? recordMissingTurnTimingProfiles;
  const listWorkspaces = options.listWorkspaces ?? listWorkspaceIdsAfter;

  async function recordRecentTurnTimingProfiles(): Promise<RecordRecentTurnTimingProfilesResult> {
    const { db, observability, settings } = await services();
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
    const deadlineError = new Error("Turn timing profile run budget exhausted");
    const deadline = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    const timer = setTimeout(() => deadline.abort(deadlineError), Math.max(0, runBudgetMs));
    timer.unref();
    const result: RecordRecentTurnTimingProfilesResult = {
      workspaces: 0,
      turns: 0,
      inserted: 0,
      updated: 0,
      failedTurns: 0,
      failedWorkspaces: 0,
      budgetExhausted: false,
    };
    try {
      // Late events of a just-finished turn land before it is profiled.
      const until = new Date(startedAt - MODEL_CALL_FACT_RECONCILE_SETTLE_MS);
      const since = new Date(until.getTime() - MODEL_CALL_FACT_RECONCILE_LOOKBACK_MS);
      const exhausted = () => {
        callerSignal?.throwIfAborted();
        if (deadline.signal.aborted || now() - startedAt >= runBudgetMs) {
          result.budgetExhausted = true;
          return true;
        }
        return false;
      };
      const profileWorkspace = async (workspaceId: string) => {
        try {
          activity?.heartbeat({ workspaceId });
          const pass = await record(db, {
            workspaceId,
            since,
            until,
            signal,
            onRecorded: (recorded) => {
              if (recorded.inserted) recordTurnTimingMetrics(observability, settings, recorded);
            },
            onError: (error, turnId) =>
              observability.warn("turn timing profile failed for a turn", {
                workspaceId,
                turnId,
                errorName: error instanceof Error ? error.name : "unknown",
              }),
          });
          result.turns += pass.turns;
          result.inserted += pass.inserted;
          result.updated += pass.updated;
          result.failedTurns += pass.failed;
          if (pass.failed > 0) {
            observability.incrementCounter({
              name: "opengeni_turn_timing_profile_failures_total",
              help: "Finished turns whose timing profile could not be computed or stored.",
              amount: pass.failed,
            });
          }
        } catch (error) {
          if (signal.aborted && signal.reason === deadlineError) {
            result.budgetExhausted = true;
            return;
          }
          callerSignal?.throwIfAborted();
          result.failedWorkspaces += 1;
          observability.warn("turn timing profiles failed for a workspace", {
            workspaceId,
            errorName: error instanceof Error ? error.name : "unknown",
          });
        }
      };
      const start = startAfterWorkspaceId();
      let cursor: string | null = start;
      let wrapped = false;
      while (!exhausted()) {
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
          await profileWorkspace(workspaceId);
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
      if (result.failedWorkspaces > 0 || result.failedTurns > 0 || result.budgetExhausted) {
        observability.warn("turn timing profiles incomplete", { ...result });
      } else if (result.inserted > 0) {
        observability.info("turn timing profiles", { ...result });
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  return { recordRecentTurnTimingProfiles };
}
