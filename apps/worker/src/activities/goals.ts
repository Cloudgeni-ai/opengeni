import { configuredStaticUsageLimits, type Settings } from "@opengeni/config";
import {
  mergeToolRefs,
  reasoningEffortForMetadata,
  type SessionGoal,
  type ToolRef,
} from "@opengeni/contracts";
import {
  enqueueSessionTurn,
  evaluateGoalContinuation,
  getBillingBalance,
  getSessionGoal,
  recordUsageEvent,
  requireSession,
  setSessionGoalLastContinuationTurn,
  setSessionGoalStatus,
  sumUsageQuantity,
  type Database,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import type {
  ActivityServices,
  MaybeContinueGoalInput,
  MaybeContinueGoalResult,
  PauseGoalForInterruptInput,
} from "./types";

export function createGoalActivities(services: () => Promise<ActivityServices>) {
  async function maybeContinueGoal(input: MaybeContinueGoalInput): Promise<MaybeContinueGoalResult> {
    const { settings, db, bus } = await services();
    // Cheap pre-read: the common goal-less session skips the budget queries.
    const existingGoal = await getSessionGoal(db, input.workspaceId, input.sessionId);
    if (!existingGoal || existingGoal.status !== "active") {
      return { action: "none" };
    }
    // Budget exhaustion pauses the goal visibly instead of failing the
    // session. Computed up front and applied inside the locked decision so a
    // limits pause never consumes continuation budget.
    const budgetBlocked = await goalRunBudgetBlocked(settings, db, input.accountId, input.workspaceId);
    const decision = await evaluateGoalContinuation(db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      defaultMaxAutoContinuations: settings.goalMaxAutoContinuations ?? null,
      noProgressLimit: settings.goalNoProgressLimit,
      budgetBlocked,
    });
    if (decision.decision === "none" || decision.decision === "queue") {
      return { action: decision.decision };
    }
    if (decision.decision === "paused") {
      await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [{
        type: "goal.paused",
        payload: {
          goalId: decision.goal.id,
          actor: "system",
          reason: decision.reason,
          ...(decision.goal.rationale ? { rationale: decision.goal.rationale } : {}),
          autoContinuations: decision.goal.autoContinuations,
          noProgressStreak: decision.goal.noProgressStreak,
        },
      }]);
      return { action: "paused" };
    }
    const session = await requireSession(db, input.workspaceId, input.sessionId);
    // Stop/continue race guard: a concurrent goal_complete/goal_pause/operator
    // PATCH between the locked decision and this synthesis must win. The
    // version check also catches a replace. A pause landing after this point
    // results in at most one already-admitted continuation turn; the next
    // pass sees the non-active goal and stops, and interrupt-driven pauses
    // additionally cancel the claimed turn via the workflow interrupt path.
    const recheck = await getSessionGoal(db, input.workspaceId, input.sessionId);
    if (!recheck || recheck.status !== "active" || recheck.version !== decision.goal.version) {
      return { action: "none" };
    }
    const prompt = goalContinuationPrompt(decision.goal, decision.autoContinuation, decision.cap);
    const [continuationEvent] = await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [{
      type: "goal.continuation",
      payload: {
        goalId: decision.goal.id,
        text: prompt,
        autoContinuation: decision.autoContinuation,
        maxAutoContinuations: decision.cap,
        goalVersion: decision.goal.version,
      },
    }]);
    if (!continuationEvent) {
      throw new Error("failed to append goal continuation trigger event");
    }
    const turn = await enqueueSessionTurn(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      triggerEventId: continuationEvent.id,
      temporalWorkflowId: input.workflowId,
      source: "goal",
      prompt,
      resources: [],
      // Continuations keep the session tool surface and force the first-party
      // server so the goal_complete/goal_pause escape hatches stay reachable.
      tools: goalSessionTools(settings, session.tools),
      model: session.model,
      reasoningEffort: reasoningEffortForMetadata(session.metadata, settings.openaiReasoningEffort),
      sandboxBackend: session.sandboxBackend,
      metadata: { goalId: decision.goal.id, autoContinuation: decision.autoContinuation },
    });
    await setSessionGoalLastContinuationTurn(db, input.workspaceId, input.sessionId, turn.id);
    await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [{
      type: "turn.queued",
      turnId: turn.id,
      payload: { turnId: turn.id, triggerEventId: continuationEvent.id, source: turn.source },
    }]);
    // Continuations count as agent runs for limits/metering parity with
    // user-initiated and scheduled turns.
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "session_turn",
      sourceResourceId: turn.id,
      idempotencyKey: `agent_run.created:goal:${input.workspaceId}:${turn.id}`,
    });
    return { action: "continue" };
  }

  async function pauseGoalForInterrupt(input: PauseGoalForInterruptInput): Promise<void> {
    const { db, bus } = await services();
    await pauseActiveGoalOnInterrupt(db, bus, input.workspaceId, input.sessionId);
  }

  return {
    maybeContinueGoal,
    pauseGoalForInterrupt,
  };
}

/**
 * A user interrupt is the explicit act of stopping, so it pauses an active
 * goal. Shared by the idle-interrupt activity and `interruptActiveTurn` so the
 * loop never auto-continues a goal the user just stopped. No-op when the
 * session has no goal or it is not active.
 */
export async function pauseActiveGoalOnInterrupt(db: Database, bus: EventBus, workspaceId: string, sessionId: string): Promise<void> {
  const goal = await getSessionGoal(db, workspaceId, sessionId);
  if (!goal || goal.status !== "active") {
    return;
  }
  const { goal: paused, changed } = await setSessionGoalStatus(db, workspaceId, sessionId, {
    status: "paused",
    pausedReason: "user_interrupt",
  });
  if (changed) {
    await appendAndPublishEvents(db, bus, workspaceId, sessionId, [{
      type: "goal.paused",
      payload: {
        goalId: paused.id,
        actor: "user",
        reason: "user_interrupt",
        autoContinuations: paused.autoContinuations,
        noProgressStreak: paused.noProgressStreak,
      },
    }]);
  }
}

export function goalContinuationPrompt(goal: SessionGoal, autoContinuation: number, cap: number | null): string {
  const counter = cap === null ? `${autoContinuation}` : `${autoContinuation}/${cap}`;
  return [
    `[GOAL CONTINUATION ${counter}] The session goal is not done. Goal: ${goal.text}.`,
    `Success criteria: ${goal.successCriteria ?? "none specified"}.`,
    "Continue working toward the goal now. If it is actually complete, call opengeni__goal_complete with concrete evidence.",
    "If you are blocked or continuing is not productive, call opengeni__goal_pause with your rationale.",
    "You may revise the goal with opengeni__goal_update. Do not stop without one of these explicit actions.",
  ].join("\n");
}

/**
 * Goal-bearing sessions/turns must carry the first-party "opengeni" MCP server
 * so the goal tools are reachable; built-in tool refs are not auto-added to
 * empty tool lists anywhere else in the pipeline.
 */
export function goalSessionTools(settings: Settings, tools: ToolRef[]): ToolRef[] {
  if (!settings.mcpServers.some((server) => server.id === "opengeni")) {
    return tools;
  }
  return mergeToolRefs(tools, [{ kind: "mcp", id: "opengeni" }]);
}

/**
 * Non-throwing variant of the scheduled-run admission check: returns a human
 * readable reason when balance or monthly caps block another agent run.
 */
async function goalRunBudgetBlocked(settings: Settings, db: Database, accountId: string, workspaceId: string): Promise<string | null> {
  if (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed") {
    const balance = await getBillingBalance(db, accountId);
    if (balance.balanceMicros <= 0) {
      return "insufficient OpenGeni credits";
    }
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
    if (limits.maxMonthlyCostMicrosPerAccount) {
      const used = await sumUsageQuantity(db, {
        accountId,
        eventType: "model.cost",
        since: startOfUtcMonth(),
      });
      if (used >= limits.maxMonthlyCostMicrosPerAccount) {
        return `monthly model cost limit reached (${limits.maxMonthlyCostMicrosPerAccount} micros)`;
      }
    }
    if (limits.maxMonthlyAgentRunsPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "agent_run.created",
        since: startOfUtcMonth(),
      });
      if (used + 1 > limits.maxMonthlyAgentRunsPerWorkspace) {
        return `monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`;
      }
    }
  }
  return null;
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
